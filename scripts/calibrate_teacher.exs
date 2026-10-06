#!/usr/bin/env elixir
# Calibrate the Clef-flash teacher per rule, then turn its corpus pre-labels into training rows.
#
# Clef's raw /v1/systemone probabilities are compressed (~0.15-0.7), so distilling them directly
# teaches the student to say ~0.3 for everything. We fit Platt scaling per rule,
# p' = sigmoid(a * logit(p) + b), on teacher scores for a balanced sample of labelled synthetic
# rows, then keep only confident calibrated labels and balance classes per rule.
#
#   elixir scripts/calibrate_teacher.exs [--per-rule 60] [--server http://127.0.0.1:8089]
#
# Reads  data/generated/{val,test}.jsonl, data/generated/teacher_train.soft-all.jsonl
# Writes artifacts/clef-calibration.json, data/generated/teacher_train.jsonl

Mix.install([{:req, "~> 0.7"}, {:yaml_elixir, "~> 2.12"}])

defmodule CalibrateTeacher do
  @confident 0.85

  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [per_rule: :integer, server: :string, calib_gold: :string, source: :string])
    per_rule = Keyword.get(opts, :per_rule, 60)
    server = Keyword.get(opts, :server, "http://127.0.0.1:8089")
    :rand.seed(:exsss, {7, 8, 9})

    questions =
      for path <- Path.wildcard(Path.join(root, "rules/*.yaml")), into: %{} do
        r = YamlElixir.read_from_file!(path)
        {r["id"], r["question"]}
      end

    # Calibrate on real reviewed gold when given (better than synthetic), else on synthetic val/test.
    labelled =
      if gold = opts[:calib_gold] do
        read_jsonl(gold)
      else
        ~w(val test)
        |> Enum.flat_map(&read_jsonl(Path.join(root, "data/generated/#{&1}.jsonl")))
        |> Enum.group_by(&{&1["rule"], &1["label"]})
        |> Enum.flat_map(fn {_, rs} -> rs |> Enum.shuffle() |> Enum.take(div(per_rule, 2)) end)
      end

    IO.puts("scoring #{length(labelled)} labelled synthetic rows with the teacher")
    scored = score(labelled, questions, server)

    params =
      scored
      |> Enum.group_by(&elem(&1, 0))
      |> Map.new(fn {rule, xs} -> {rule, fit(Enum.map(xs, fn {_, p, y} -> {logit(p), y} end))} end)

    report =
      Map.new(params, fn {rule, {a, b}} ->
        xs = for {^rule, p, y} <- scored, do: {calibrate(p, a, b), y}
        {rule, %{a: a, b: b, n: length(xs), acc: acc(xs), brier: brier(xs)}}
      end)

    File.mkdir_p!(Path.join(root, "artifacts"))
    File.write!(Path.join(root, "artifacts/clef-calibration.json"), JSON.encode!(report))
    for {rule, m} <- Enum.sort(report), do: IO.puts("  #{String.pad_trailing(rule, 40)} a=#{r3(m.a)} b=#{r3(m.b)} acc=#{r3(m.acc)} brier=#{r3(m.brier)}")

    write_training_rows(root, params, opts[:source])
  end

  @train_repos ~w(vercel/nextjs-subscription-payments makerkit/nextjs-saas-starter-kit-lite imbhargav5/nextbase-nextjs-supabase-starter
                  usebasejump/basejump devtodollars/mvp-boilerplate ShenSeanChen/launch-mvp-stripe-nextjs-supabase Razikus/supabase-nextjs-template
                  ibelick/zola matiasbattocchia/open-bsp-api supabase/supabase vercel/next.js)

  defp write_training_rows(root, params, source) do
    rows =
      if source do
        # raw pre-labels from the corpus run: keep training repos only, map to training rows (url kept for repo facts)
        for r <- read_jsonl(source), r["repo"] in @train_repos do
          %{"id" => :erlang.phash2({r["url"], r["line"], r["rule"]}) |> Integer.to_string(16), "rule" => r["rule"],
            "family" => "teacher:" <> r["repo"], "framework" => r["kind"], "resource" => r["repo"], "split" => "train",
            "soft" => r["teacher_p"], "label" => 0, "state" => r["state"], "url" => r["url"], "line" => r["line"]}
        end
      else
        read_jsonl(Path.join(root, "data/generated/teacher_train.soft-all.jsonl"))
      end

    confident =
      for r <- rows, {a, b} = Map.get(params, r["rule"], {1.0, 0.0}),
          p = calibrate(r["soft"], a, b), p >= @confident or p <= 1 - @confident do
        label = if p >= 0.5, do: 1, else: 0
        r |> Map.put("label", label) |> Map.put("soft", label) |> Map.put("teacher_calibrated", p)
      end

    balanced =
      confident
      |> Enum.group_by(& &1["rule"])
      |> Enum.flat_map(fn {_rule, rs} ->
        {pos, neg} = Enum.split_with(rs, &(&1["label"] == 1))
        pos ++ Enum.take(Enum.shuffle(neg), max(10, 2 * length(pos)))
      end)

    File.write!(Path.join(root, "data/generated/teacher_train.jsonl"), Enum.map_join(balanced, "", &(JSON.encode!(&1) <> "\n")))
    IO.puts("teacher rows: #{length(rows)} raw -> #{length(confident)} confident -> #{length(balanced)} balanced")
    balanced |> Enum.frequencies_by(&{&1["rule"], &1["label"]}) |> Enum.sort() |> Enum.each(&IO.puts("  #{inspect(&1)}"))
  end

  defp score(rows, questions, server) do
    rows
    |> Task.async_stream(
      fn r ->
        body = %{state: r["state"], questions: %{"q" => questions[r["rule"]]}}
        resp = Req.post!(server <> "/v1/systemone", json: body, receive_timeout: 120_000, retry: :transient)

        case get_in(resp.body, ["answers", "q", "noul"]) do
          p when is_number(p) -> {r["rule"], p, r["label"]}
          _ -> nil
        end
      end,
      max_concurrency: 4, timeout: 180_000, on_timeout: :kill_task)
    |> Enum.flat_map(fn
      {:ok, nil} -> []
      {:ok, x} -> [x]
      {:exit, _} -> []
    end)
  end

  # Logistic regression on one feature (Platt scaling), plain gradient descent.
  defp fit(xs) do
    Enum.reduce(1..3000, {1.0, 0.0}, fn _, {a, b} ->
      {ga, gb} =
        Enum.reduce(xs, {0.0, 0.0}, fn {x, y}, {ga, gb} ->
          e = sigmoid(a * x + b) - y
          {ga + e * x, gb + e}
        end)

      n = length(xs)
      {a - 0.5 * ga / n, b - 0.5 * gb / n}
    end)
  end

  defp calibrate(p, a, b), do: sigmoid(a * logit(p) + b)
  defp logit(p), do: p |> max(1.0e-6) |> min(1 - 1.0e-6) |> then(&:math.log(&1 / (1 - &1)))
  defp sigmoid(z), do: 1 / (1 + :math.exp(-z))
  defp acc(xs), do: Enum.count(xs, fn {p, y} -> (p >= 0.5 and y == 1) or (p < 0.5 and y == 0) end) / max(length(xs), 1)
  defp brier(xs), do: Enum.sum(Enum.map(xs, fn {p, y} -> (p - y) ** 2 end)) / max(length(xs), 1)
  defp r3(x), do: :erlang.float_to_binary(x * 1.0, decimals: 3)
  defp read_jsonl(path), do: path |> File.stream!() |> Enum.map(&JSON.decode!/1)
end

CalibrateTeacher.run(System.argv(), Path.expand("..", __DIR__))
