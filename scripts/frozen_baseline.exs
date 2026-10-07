#!/usr/bin/env elixir
# Frozen-encoder baseline for the supacheck gold set, Elixir-native (Ortex + Tokenizers + Scholar).
#
# Embeds each code chunk ("state", no question) once with a frozen Laya/ModernBERT-large ONNX encoder,
# pools last_hidden_state (masked mean and CLS), then fits one small classifier per rule and scores the
# gold set with the exact protocol of training/laya_ft.py `evaluate`:
#   * repo-level split: calibration = repos listed with source "v6-calibration" in review.jsonl, plus
#     repos whose 31-hash % 5 < 2; everything else is test,
#   * per-rule threshold = lowest calibration score whose cumulative precision >= 0.9 (floored at
#     0.05), else 0.5,
#   * AUROC / precision / recall pooled over all test items, tp/fp/fn/tn per rule.
#
# Variants: syn (synthetic laya_train.jsonl, <= --syn-per-rule balanced per rule), cal (gold
# calibration split only; thresholds from grouped-by-repo out-of-fold scores, never test), syn+cal (real rows repeated
# to roughly match the synthetic count).
#
#   elixir scripts/frozen_baseline.exs [--max-len 1024] [--concurrency 9] [--syn-per-rule 500]
#                                      [--encoders base,supacheck] [--fit-concurrency 9]
#
# Embeddings are cached per encoder/split/max-len in artifacts/frozen-embeddings/ keyed by sha256 of the
# state, so reruns (or bigger --syn-per-rule) only embed what is missing. CPU only.

Mix.install(
  [
    {:ortex, "~> 0.1.10"},
    {:tokenizers, "~> 0.5.1"},
    {:scholar, "~> 0.5.0"},
    {:exla, "~> 1.0"},
    # ortex 0.1.10 pins nx ~> 0.6 but runs fine on nx 1.0 (needed by scholar 0.5).
    {:nx, "~> 1.0", override: true}
  ],
  config: [nx: [default_backend: EXLA.Backend, default_defn_options: [compiler: EXLA]]],
  system_env: [{"EXLA_TARGET", "cpu"}]
)

defmodule FrozenBaseline do
  alias Scholar.Linear.LogisticRegression, as: LR
  alias Scholar.Neighbors.KNNClassifier, as: KNN

  @root Path.expand("..", __DIR__)
  @switches [max_len: :integer, concurrency: :integer, syn_per_rule: :integer, encoders: :string, fit_concurrency: :integer]
  @encoders %{"base" => "artifacts/laya-base-onnx", "supacheck" => "artifacts/laya-supacheck-onnx"}
  @dim 1024
  @folds 5

  def run(argv) do
    {opts, _} = OptionParser.parse!(argv, strict: @switches)
    cores = System.schedulers_online()
    max_len = opts[:max_len] || 1024
    conc = opts[:concurrency] || div(cores, 2)
    fit_conc = opts[:fit_concurrency] || div(cores, 2)
    syn_n = opts[:syn_per_rule] || 500
    encoders = String.split(opts[:encoders] || "base,supacheck", ",")

    {gold, rules} = load_gold()
    syn = load_synthetic(rules, syn_n)
    log("gold #{length(gold)} items (calib #{Enum.count(gold, & &1.calib)}, test #{Enum.count(gold, &(!&1.calib))}); synthetic #{length(syn)} items")

    timings =
      for enc <- encoders, into: %{} do
        {enc, Enum.map([{"gold", gold}, {"synthetic", syn}], fn {split, items} -> {split, embed_split(enc, split, items, max_len, conc)} end) |> Map.new()}
      end

    results =
      for enc <- encoders, pool <- [:mean, :cls], variant <- [:syn, :cal, :syn_cal] do
        {enc, pool, variant}
      end
      |> Enum.flat_map(fn {enc, pool, variant} ->
        emb = load_cache(enc, "gold", max_len) |> Map.merge(load_cache(enc, "synthetic", max_len))
        classifiers(pool) |> Enum.map(&{enc, pool, variant, &1, emb})
      end)
      |> evaluate_all(gold, syn, rules, fit_conc)

    laya = File.read!(Path.join(@root, "artifacts/laya-supacheck/gold_report.json")) |> JSON.decode!()
    print_table(results, laya)
    write_report(results, laya, timings, %{max_len: max_len, concurrency: conc, syn_per_rule: syn_n, cores: cores})
  end

  # ---------------------------------------------------------------- data

  defp load_gold do
    rules = questioned_rules()
    review = read_jsonl("data/gold/review.jsonl")
    calib_only = for r <- review, r["source"] == "v6-calibration", into: MapSet.new(), do: repo(r["url"])
    eval_only = eval_only_repos()

    gold =
      read_jsonl("data/gold/cache/states.jsonl")
      |> Enum.filter(&MapSet.member?(rules, &1["rule"]))
      |> Enum.map(fn r ->
        %{rule: r["rule"], label: r["label"], state: r["state"], repo: repo(r["url"]), key: key(r["state"]),
          calib: calib?(repo(r["url"]), calib_only), eval_only: MapSet.member?(eval_only, repo(r["url"]))}
      end)

    {gold, rules}
  end

  defp eval_only_repos do
    path = Path.join(@root, "data/gold/eval-only-repos.txt")
    if File.exists?(path), do: path |> File.read!() |> String.split("\n", trim: true) |> MapSet.new(), else: MapSet.new()
  end

  # Rules that have a `question:` (same filter as laya_ft._questions).
  defp questioned_rules do
    for path <- Path.wildcard(Path.join(@root, "rules/*.yaml")),
        body = File.read!(path),
        Regex.match?(~r/^question:/m, body),
        [_, id] <- [Regex.run(~r/^id:\s*"?([^"\s]+)"?/m, body)],
        into: MapSet.new(),
        do: id
  end

  defp repo(url), do: url |> String.split("/") |> Enum.slice(3, 2) |> Enum.join("/")

  # Mirror of laya_ft._is_calib: h = (h * 31 + ord(c)) & 0xFFFFFFFF; calib if h % 5 < 2.
  defp calib?(repo, calib_only) do
    MapSet.member?(calib_only, repo) or
      rem(Enum.reduce(String.to_charlist(repo), 0, fn c, h -> Bitwise.band(h * 31 + c, 0xFFFFFFFF) end), 5) < 2
  end

  defp load_synthetic(rules, n) do
    :rand.seed(:exsss, {20_261_007, 1, 2})

    read_jsonl("data/generated/laya_train.jsonl")
    |> Enum.map(fn r ->
      [rule] = Map.keys(r["questions"])
      %{rule: rule, label: if(r["gold"][rule]["probabilities"]["true"] >= 0.5, do: 1, else: 0), state: r["state"], key: key(r["state"])}
    end)
    |> Enum.filter(&MapSet.member?(rules, &1.rule))
    |> Enum.uniq_by(&{&1.rule, &1.key})
    |> Enum.group_by(& &1.rule)
    |> Enum.flat_map(fn {_rule, rows} -> balanced_sample(rows, n) end)
  end

  defp balanced_sample(rows, n) do
    {pos, neg} = rows |> Enum.shuffle() |> Enum.split_with(&(&1.label == 1))
    half = div(n, 2)
    take_pos = min(length(pos), max(half, n - length(neg)))
    take_neg = min(length(neg), n - take_pos)
    Enum.take(pos, take_pos) ++ Enum.take(neg, take_neg)
  end

  defp read_jsonl(rel), do: Path.join(@root, rel) |> File.stream!() |> Enum.map(&JSON.decode!/1)
  defp key(state), do: :crypto.hash(:sha256, state) |> binary_part(0, 16)

  # ---------------------------------------------------------------- embeddings

  defp cache_path(enc, split, max_len), do: Path.join(@root, "artifacts/frozen-embeddings/#{enc}-#{split}-#{max_len}.bin")

  defp load_cache(enc, split, max_len) do
    case File.read(cache_path(enc, split, max_len)) do
      {:ok, bin} -> :erlang.binary_to_term(bin)
      _ -> %{}
    end
  end

  defp embed_split(enc, split, items, max_len, conc) do
    cache = load_cache(enc, split, max_len)
    todo = items |> Enum.uniq_by(& &1.key) |> Enum.reject(&Map.has_key?(cache, &1.key))

    if todo == [] do
      log("#{enc}/#{split}: #{map_size(cache)} cached, nothing to embed")
      %{embedded: 0, seconds: 0.0}
    else
      dir = Path.join(@root, Map.fetch!(@encoders, enc))
      {:ok, tok} = Tokenizers.Tokenizer.from_file(Path.join(dir, "tokenizer.json"))
      tok = Tokenizers.Tokenizer.set_truncation(tok, max_length: max_len)
      model = Ortex.load(Path.join(dir, "encoder.onnx"), [:cpu])
      log("#{enc}/#{split}: embedding #{length(todo)} items (max_len #{max_len}, concurrency #{conc})")
      t0 = System.monotonic_time(:millisecond)
      total = length(todo)

      {fresh, tokens} =
        todo
        |> Task.async_stream(&{&1.key, embed(model, tok, &1.state)}, max_concurrency: conc, timeout: :infinity, ordered: false)
        |> Stream.with_index(1)
        |> Enum.reduce({%{}, 0}, fn {{:ok, {k, {v, n}}}, i}, {acc, toks} ->
          if rem(i, 100) == 0, do: progress(enc, split, i, total, t0)
          {Map.put(acc, k, v), toks + n}
        end)

      secs = (System.monotonic_time(:millisecond) - t0) / 1000
      merged = Map.merge(cache, fresh)
      File.mkdir_p!(Path.dirname(cache_path(enc, split, max_len)))
      File.write!(cache_path(enc, split, max_len), :erlang.term_to_binary(merged))
      log("#{enc}/#{split}: #{total} items in #{Float.round(secs, 1)}s = #{Float.round(total / secs, 2)} items/s, #{round(tokens / secs)} tokens/s")
      %{embedded: total, seconds: secs, items_per_s: total / secs, tokens: tokens}
    end
  end

  defp progress(enc, split, i, total, t0) do
    secs = (System.monotonic_time(:millisecond) - t0) / 1000
    log("  #{enc}/#{split} #{i}/#{total} (#{Float.round(i / secs, 2)} items/s, eta #{round((total - i) / (i / secs))}s)")
  end

  # One state -> {%{mean: f32 binary, cls: f32 binary}, n_tokens}. Batch of 1, so the mask is all ones
  # and masked-mean == mean over the sequence; parallelism comes from concurrent sessions runs.
  defp embed(model, tok, state) do
    {:ok, enc} = Tokenizers.Tokenizer.encode(tok, state)
    ids = Tokenizers.Encoding.get_u32_ids(enc) |> Nx.from_binary(:u32, backend: Nx.BinaryBackend) |> Nx.as_type(:s64)
    mask = Tokenizers.Encoding.get_u32_attention_mask(enc) |> Nx.from_binary(:u32, backend: Nx.BinaryBackend) |> Nx.as_type(:s64)
    n = Nx.size(ids)
    {hidden} = Ortex.run(model, {Nx.reshape(ids, {1, n}), Nx.reshape(mask, {1, n})})
    h = hidden |> Nx.backend_transfer(Nx.BinaryBackend) |> Nx.reshape({n, @dim})
    m = Nx.reshape(mask, {n, 1}) |> Nx.as_type(:f32)
    mean = Nx.divide(Nx.sum(Nx.multiply(h, m), axes: [0]), Nx.sum(m))
    {%{mean: Nx.to_binary(Nx.as_type(mean, :f32)), cls: Nx.to_binary(h[0])}, n}
  end

  # ---------------------------------------------------------------- classifiers

  defp classifiers(:mean), do: [{:lr, 0.01}, {:lr, 0.1}, {:lr, 1.0}, {:knn, 7}]
  defp classifiers(:cls), do: [{:lr, 0.1}]

  defp clf_name({:lr, a}), do: "logreg(alpha=#{a})"
  defp clf_name({:knn, k}), do: "knn(k=#{k})"

  defp evaluate_all(configs, gold, syn, rules, fit_conc) do
    jobs = for {enc, pool, variant, clf, emb} <- configs, rule <- Enum.sort(rules), do: {enc, pool, variant, clf, emb, rule}
    log("fitting #{length(jobs)} per-rule jobs (#{length(configs)} configs), concurrency #{fit_conc}")
    t0 = System.monotonic_time(:millisecond)

    scores =
      jobs
      |> Task.async_stream(fn {enc, pool, variant, clf, emb, rule} -> {{enc, pool, variant, clf}, score_rule(emb, pool, variant, clf, rule, gold, syn)} end,
        max_concurrency: fit_conc, timeout: :infinity)
      |> Enum.reduce(%{}, fn {:ok, {cfg, s}}, acc -> Map.update(acc, cfg, s, &Map.merge(&1, s)) end)

    log("fits done in #{Float.round((System.monotonic_time(:millisecond) - t0) / 1000, 1)}s")

    for {enc, pool, variant, clf, _} <- configs do
      cfg = {enc, pool, variant, clf}
      Map.merge(%{encoder: enc, pool: pool, variant: variant, classifier: clf_name(clf)}, protocol(gold, Map.fetch!(scores, cfg)))
    end
  end

  # Returns %{gold_key_rule => p} for every gold item of `rule`. Calibration items get scores from a
  # model that never saw them (out-of-fold when calibration is in the training set).
  defp score_rule(emb, pool, variant, clf, rule, gold, syn) do
    g = Enum.filter(gold, &(&1.rule == rule))
    {cal, test} = Enum.split_with(g, & &1.calib)
    s = if variant in [:syn, :syn_cal], do: Enum.filter(syn, &(&1.rule == rule)), else: []

    if variant == :syn do
      fit_predict(emb, pool, clf, s, cal ++ test)
    else
      folds = Enum.group_by(cal, &:erlang.phash2(&1.repo, @folds))
      # eval-only repos (no permissive licence) are scored and used for thresholds, never fitted on
      trainable = Enum.reject(cal, & &1.eval_only)

      oof =
        Enum.reduce(folds, %{}, fn {f, held}, acc ->
          train = s ++ upweight(Enum.reject(trainable, &(:erlang.phash2(&1.repo, @folds) == f)), s)
          Map.merge(acc, fit_predict(emb, pool, clf, train, held))
        end)

      Map.merge(oof, fit_predict(emb, pool, clf, s ++ upweight(trainable, s), test))
    end
  end

  # In syn+cal, repeat the few real rows so they weigh about as much as the synthetic ones.
  defp upweight([], _syn), do: []
  defp upweight(real, syn), do: List.duplicate(real, max(1, div(length(syn), length(real)))) |> List.flatten()

  defp fit_predict(_emb, _pool, _clf, _train, []), do: %{}
  # nothing trainable in this fold (e.g. only eval-only repos): no signal, score at the prior
  defp fit_predict(_emb, _pool, _clf, [], score), do: Map.new(score, &{{&1.key, &1.rule}, 0.5})

  defp fit_predict(emb, pool, clf, train, score) do
    ys = Enum.map(train, & &1.label)
    out_keys = Enum.map(score, &{&1.key, &1.rule})

    probs =
      cond do
        train == [] -> List.duplicate(0.5, length(score))
        Enum.uniq(ys) |> length() == 1 -> List.duplicate(hd(ys) * 1.0, length(score))
        true -> do_fit(clf, matrix(emb, pool, train), Nx.tensor(ys, type: :s64), matrix(emb, pool, score))
      end

    Enum.zip(out_keys, probs) |> Map.new()
  end

  defp do_fit({:lr, alpha}, x, y, xs) do
    {x, xs} = standardize(x, xs)
    model = LR.fit(x, y, num_classes: 2, alpha: alpha, max_iterations: 500)
    LR.predict_probability(model, xs)[[.., 1]] |> Nx.to_flat_list()
  end

  defp do_fit({:knn, k}, x, y, xs) do
    k = min(k, Nx.axis_size(x, 0))
    model = KNN.fit(l2(x), y, num_classes: 2, num_neighbors: k)
    KNN.predict_probability(model, l2(xs))[[.., 1]] |> Nx.to_flat_list()
  end

  # Feature scaling uses training rows only.
  defp standardize(x, xs) do
    mu = Nx.mean(x, axes: [0])
    sd = Nx.standard_deviation(x, axes: [0]) |> Nx.add(1.0e-6)
    {Nx.divide(Nx.subtract(x, mu), sd), Nx.divide(Nx.subtract(xs, mu), sd)}
  end

  defp l2(x), do: Nx.divide(x, Nx.add(Nx.sqrt(Nx.sum(Nx.pow(x, 2), axes: [1], keep_axes: true)), 1.0e-9))

  defp matrix(emb, pool, items) do
    items
    |> Enum.map(&Map.fetch!(Map.fetch!(emb, &1.key), pool))
    |> IO.iodata_to_binary()
    |> Nx.from_binary(:f32)
    |> Nx.reshape({length(items), @dim})
  end

  # ---------------------------------------------------------------- laya_ft.evaluate protocol

  defp protocol(gold, scores) do
    scored = Enum.map(gold, &Map.put(&1, :p, Map.fetch!(scores, {&1.key, &1.rule})))
    rules = scored |> Enum.map(& &1.rule) |> Enum.uniq()

    thr =
      Map.new(rules, fn rule ->
        best =
          scored
          |> Enum.filter(&(&1.calib and &1.rule == rule))
          |> Enum.sort_by(&(-&1.p))
          |> Enum.reduce({0, 0, nil}, fn s, {tp, fp, best} ->
            {tp, fp} = {tp + s.label, fp + 1 - s.label}
            {tp, fp, if(tp > 0 and tp / (tp + fp) >= 0.9, do: s.p, else: best)}
          end)
          |> elem(2)

        {rule, if(best, do: max(best, 0.05), else: 0.5)}
      end)

    calib = Enum.filter(scored, & &1.calib)
    test = Enum.reject(scored, & &1.calib)
    c = counts(test, thr)

    per_rule =
      test |> Enum.group_by(& &1.rule) |> Map.new(fn {rule, rs} -> {rule, counts(rs, thr)} end)

    %{
      test_items: length(test),
      auroc: auroc(test),
      calib_auroc: auroc(calib),
      precision: ratio(c.tp, c.tp + c.fp),
      recall: ratio(c.tp, c.tp + c.fn),
      thresholds: thr,
      per_rule: per_rule
    }
  end

  defp counts(items, thr) do
    Enum.reduce(items, %{tp: 0, fp: 0, fn: 0, tn: 0}, fn s, acc ->
      k = case {s.p >= thr[s.rule], s.label} do
        {true, 1} -> :tp
        {true, 0} -> :fp
        {false, 1} -> :fn
        {false, 0} -> :tn
      end
      Map.update!(acc, k, &(&1 + 1))
    end)
  end

  defp ratio(_, 0), do: nil
  defp ratio(a, b), do: a / b

  # Rank-based AUROC with average ranks for ties (= sklearn roc_auc_score).
  defp auroc(items) do
    npos = Enum.count(items, &(&1.label == 1))
    nneg = length(items) - npos

    if npos == 0 or nneg == 0 do
      nil
    else
      ranked =
        items
        |> Enum.sort_by(& &1.p)
        |> Enum.chunk_by(& &1.p)
        |> Enum.reduce({1, []}, fn grp, {r, acc} ->
          avg = r + (length(grp) - 1) / 2
          {r + length(grp), Enum.map(grp, &{&1.label, avg}) ++ acc}
        end)
        |> elem(1)

      pos_rank_sum = ranked |> Enum.filter(&(elem(&1, 0) == 1)) |> Enum.map(&elem(&1, 1)) |> Enum.sum()
      (pos_rank_sum - npos * (npos + 1) / 2) / (npos * nneg)
    end
  end

  # ---------------------------------------------------------------- output

  defp print_table(results, laya) do
    IO.puts("\nencoder    pool  variant  classifier          cal_AUROC  AUROC   P      R      tp/fp/fn")
    IO.puts(String.duplicate("-", 92))

    IO.puts(row("laya-ft", "-", "laya", "fine-tuned head", nil, laya["auroc"], laya["precision"], laya["recall"], sum_counts(laya["per_rule"])))

    for r <- results do
      IO.puts(row(r.encoder, r.pool, r.variant, r.classifier, r.calib_auroc, r.auroc, r.precision, r.recall, sum_counts(r.per_rule)))
    end

    IO.puts("\nRules reaching precision >= 0.9 on test with tp >= 3:")

    for r <- results, {rule, c} <- r.per_rule, c.tp >= 3, c.tp / (c.tp + c.fp) >= 0.9 do
      IO.puts("  #{r.encoder}/#{r.pool}/#{r.variant}/#{r.classifier}: #{rule} tp=#{c.tp} fp=#{c.fp} fn=#{c.fn} tn=#{c.tn}")
    end
  end

  defp sum_counts(per_rule) do
    Enum.reduce(Map.values(per_rule), {0, 0, 0}, fn c, {tp, fp, fn_} ->
      {tp + get(c, :tp), fp + get(c, :fp), fn_ + get(c, :fn)}
    end)
  end

  defp get(c, k), do: Map.get(c, k) || Map.get(c, Atom.to_string(k))

  defp row(enc, pool, variant, clf, cal, auc, p, r, {tp, fp, fn_}) do
    [pad(enc, 10), pad(pool, 5), pad(variant, 8), pad(clf, 19), pad(fmt(cal), 10), pad(fmt(auc), 7), pad(fmt(p), 6), pad(fmt(r), 6), "#{tp}/#{fp}/#{fn_}"]
    |> Enum.join(" ")
  end

  defp pad(v, n), do: String.pad_trailing(to_string(v), n)
  defp fmt(nil), do: "-"
  defp fmt(x), do: :erlang.float_to_binary(x * 1.0, decimals: 3)

  defp write_report(results, laya, timings, settings) do
    out = Path.join(@root, "artifacts/frozen-baseline/report.json")
    File.mkdir_p!(Path.dirname(out))

    report = %{
      settings: settings,
      protocol: "training/laya_ft.py evaluate: repo split via _is_calib, per-rule threshold = lowest calibration score with precision >= 0.9 (min 0.05) else 0.5; metrics on test repos only",
      embedding_timings: timings,
      laya_finetuned: laya,
      results: Enum.map(results, &Map.update!(&1, :pool, fn p -> Atom.to_string(p) end))
    }

    File.write!(out, JSON.encode!(report))
    log("wrote #{out}")
  end

  defp log(msg), do: IO.puts(:stderr, "[#{Time.utc_now() |> Time.truncate(:second)}] #{msg}")
end

FrozenBaseline.run(System.argv())
