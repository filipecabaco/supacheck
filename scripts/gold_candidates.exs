#!/usr/bin/env elixir
# Build gold-set review candidates from permissively licensed real repos.
#
#   1. shallow-clone repos (pinned to the commit we record) into the scratch dir
#   2. chunk them with the CLI (`supacheck chunks`), keeping chunks where a spike rule applies
#   3. pre-label each (chunk, rule) with Clef-flash via llama-server's /v1/systemone
#   4. write data/gold/review.jsonl: a per-rule balanced sample (confident yes / confident no /
#      uncertain) for human confirmation. Only URLs, lines and labels are committed, never code.
#
#   llama-server -m models/Clef-Flash-Q8_0.gguf --port 8089 --parallel 4 -c 32768   # in another shell
#   elixir scripts/gold_candidates.exs [--scratch DIR] [--per-rule 30] [--server http://127.0.0.1:8089]

Mix.install([{:req, "~> 0.7"}, {:yaml_elixir, "~> 2.12"}])

defmodule GoldCandidates do
  # {repo, sparse paths or nil}. MIT / Apache-2.0 / Unlicense only (field-survey.md §5).
  @repos [
    {"vercel/nextjs-subscription-payments", nil},
    {"KolbySisk/next-supabase-stripe-starter", nil},
    {"makerkit/nextjs-saas-starter-kit-lite", nil},
    {"imbhargav5/nextbase-nextjs-supabase-starter", nil},
    {"usebasejump/basejump", nil},
    {"scosman/CMSaasStarter", nil},
    {"devtodollars/mvp-boilerplate", nil},
    {"ShenSeanChen/launch-mvp-stripe-nextjs-supabase", nil},
    {"Razikus/supabase-nextjs-template", nil},
    {"ArnasDon/wacrm", nil},
    {"guillermoscript/lms-front", nil},
    {"creatorai-app/creatorai", nil},
    {"marmelab/atomic-crm", nil},
    {"geeks-accelerator/in-bed-ai", nil},
    {"ibelick/zola", nil},
    {"theaiautomators/insights-lm-public", nil},
    {"martinpawluszek/gtm-radar", nil},
    {"Jundev66/CoreBiz", nil},
    {"matiasbattocchia/open-bsp-api", nil},
    {"supabase/supabase", ["examples/user-management", "examples/auth", "examples/edge-functions/supabase/functions", "examples/slack-clone", "examples/todo-list"]},
    {"vercel/next.js", ["examples/with-supabase"]}
  ]

  # Gold review comes only from these repos; teacher labels from the rest may train the student.
  @eval_repos ~w(KolbySisk/next-supabase-stripe-starter guillermoscript/lms-front ArnasDon/wacrm
                 theaiautomators/insights-lm-public martinpawluszek/gtm-radar creatorai-app/creatorai
                 marmelab/atomic-crm scosman/CMSaasStarter geeks-accelerator/in-bed-ai Jundev66/CoreBiz)

  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [scratch: :string, per_rule: :integer, server: :string, skip_clone: :boolean, clone_only: :boolean, reselect: :boolean])
    scratch = Keyword.get(opts, :scratch, Path.join(System.tmp_dir!(), "supacheck-corpus"))
    per_rule = Keyword.get(opts, :per_rule, 30)
    server = Keyword.get(opts, :server, "http://127.0.0.1:8089")
    questions = load_questions(Path.join(root, "rules"))

    File.mkdir_p!(scratch)

    if opts[:reselect] do
      labelled = Path.join(scratch, "prelabelled.jsonl") |> File.stream!() |> Enum.map(&JSON.decode!/1)
      write_review(root, labelled, per_rule)
      System.halt(0)
    end

    repos = if opts[:skip_clone], do: existing(scratch), else: Enum.map(@repos, &clone(&1, scratch))

    if opts[:clone_only] do
      Enum.each(repos, fn {repo, sha, _} -> IO.puts("#{repo} @ #{sha}") end)
      System.halt(0)
    end

    chunks =
      repos
      |> Enum.flat_map(fn {repo, sha, dir} -> chunk(root, repo, sha, dir) end)
      |> Enum.reject(&(byte_size(&1["state"]) > 20_000))
      |> Enum.flat_map(fn c -> Enum.map(c["rules"], &Map.put(c, "rule", &1)) end)

    IO.puts("#{length(chunks)} (chunk, rule) pairs from #{length(repos)} repos; pre-labelling with #{server}")

    labelled =
      chunks
      |> Task.async_stream(&prelabel(&1, questions, server), max_concurrency: 4, timeout: 120_000, on_timeout: :kill_task)
      |> Enum.flat_map(fn
        {:ok, {:ok, row}} -> [row]
        {:ok, {:error, reason}} -> IO.warn("prelabel failed: #{inspect(reason)}") && []
        {:exit, reason} -> IO.warn("prelabel crashed: #{inspect(reason)}") && []
      end)

    File.write!(Path.join(scratch, "prelabelled.jsonl"), Enum.map_join(labelled, "", &(JSON.encode!(&1) <> "\n")))
    {_eval_rows, train_rows} = Enum.split_with(labelled, &(&1["repo"] in @eval_repos))
    write_teacher_train(root, train_rows)
    write_review(root, labelled, per_rule)
    summarise(labelled)
  end

  defp write_review(root, labelled, per_rule) do
    review =
      labelled
      |> Enum.filter(&(&1["repo"] in @eval_repos))
      |> select(per_rule)
      |> Enum.map(&Map.delete(&1, "state"))

    out = Path.join(root, "data/gold/review.jsonl")
    File.write!(out, Enum.map_join(review, "", &(JSON.encode!(&1) <> "\n")))
    IO.puts("wrote #{length(review)} review candidates to #{out}")
  end

  defp load_questions(dir) do
    for path <- Path.wildcard(Path.join(dir, "*.yaml")), into: %{} do
      rule = YamlElixir.read_from_file!(path)
      {rule["id"], rule["question"]}
    end
  end

  defp clone({repo, sparse}, scratch) do
    dir = Path.join(scratch, String.replace(repo, "/", "__"))

    unless File.dir?(dir) do
      url = "https://github.com/#{repo}.git"

      if sparse do
        git!(["clone", "--depth", "1", "--filter=blob:none", "--sparse", url, dir])
        git!(["-C", dir, "sparse-checkout", "set" | sparse])
      else
        git!(["clone", "--depth", "1", url, dir])
      end
    end

    {repo, String.trim(git!(["-C", dir, "rev-parse", "HEAD"])), dir}
  end

  defp existing(scratch) do
    for dir <- File.ls!(scratch), File.dir?(Path.join(scratch, dir)), File.dir?(Path.join([scratch, dir, ".git"])) do
      path = Path.join(scratch, dir)
      {String.replace(dir, "__", "/"), String.trim(git!(["-C", path, "rev-parse", "HEAD"])), path}
    end
  end

  defp git!(args) do
    case System.cmd("git", args, stderr_to_stdout: true) do
      {out, 0} -> out
      {out, code} -> raise "git #{Enum.join(args, " ")} failed (#{code}): #{out}"
    end
  end

  defp chunk(root, repo, sha, dir) do
    {out, status} =
      System.cmd("mise", ["exec", "--", "npx", "tsx", "src/cli.ts", "chunks", dir, "--strip-prefix", dir],
        cd: Path.join(root, "cli"), stderr_to_stdout: false)

    if status != 0, do: IO.warn("chunking #{repo} exited #{status}; keeping complete lines only")

    for line <- String.split(out, "\n", trim: true), String.starts_with?(line, "{"), match?({:ok, _}, JSON.decode(line)) do
      line
      |> JSON.decode!()
      |> Map.merge(%{"repo" => repo, "sha" => sha, "url" => "https://github.com/#{repo}/blob/#{sha}/#{JSON.decode!(line)["file"]}"})
    end
  end

  defp prelabel(c, questions, server) do
    body = %{state: c["state"], questions: %{c["rule"] => questions[c["rule"]]}}

    case Req.post(server <> "/v1/systemone", json: body, receive_timeout: 110_000, retry: :transient) do
      {:ok, %{status: 200, body: %{"answers" => answers}}} ->
        answer = answers[c["rule"]]
        {:ok, c |> Map.drop(["rules"]) |> Map.merge(%{"teacher_p" => answer["noul"]})}

      {:ok, resp} ->
        {:error, {resp.status, resp.body}}

      {:error, e} ->
        {:error, e}
    end
  end

  # Soft teacher targets for distillation; label is only used for metrics. data/generated is git-ignored.
  defp write_teacher_train(root, rows) do
    out = Path.join(root, "data/generated/teacher_train.jsonl")

    lines =
      for r <- rows do
        JSON.encode!(%{
          id: :erlang.phash2({r["url"], r["line"], r["rule"]}) |> Integer.to_string(16),
          rule: r["rule"], family: "teacher:" <> r["repo"], framework: r["kind"], resource: r["repo"],
          label: if(r["teacher_p"] >= 0.5, do: 1, else: 0), soft: r["teacher_p"], split: "train",
          state: r["state"]
        }) <> "\n"
      end

    File.write!(out, Enum.join(lines))
    IO.puts("wrote #{length(rows)} teacher-labelled training rows to #{out}")
  end

  # Per rule: confident positives, confident negatives and the most uncertain, so review
  # covers both precision and recall instead of only what the teacher already believes.
  defp select(rows, per_rule) do
    rows
    |> Enum.group_by(& &1["rule"])
    |> Enum.flat_map(fn {_rule, rs} ->
      # at most 4 per repo per rule, so one big repo can't dominate the gold set
      rs = rs |> Enum.group_by(& &1["repo"]) |> Enum.flat_map(fn {_, xs} -> spread(xs, 4) end)
      third = div(per_rule, 3)
      sorted = Enum.sort_by(rs, & &1["teacher_p"], :desc)
      uncertain = Enum.sort_by(rs, &abs(&1["teacher_p"] - 0.5)) |> Enum.take(third)

      (Enum.take(sorted, third) ++ Enum.take(Enum.reverse(sorted), third) ++ uncertain)
      |> Enum.uniq_by(&{&1["url"], &1["line"], &1["rule"]})
    end)
    |> Enum.map(&Map.merge(&1, %{"label" => nil, "reviewer" => nil, "note" => ""}))
  end

  # Keep the extremes and the middle of a repo's teacher scores rather than an arbitrary slice.
  defp spread(xs, n) when length(xs) <= n, do: xs

  defp spread(xs, n) do
    sorted = Enum.sort_by(xs, & &1["teacher_p"])
    step = (length(sorted) - 1) / (n - 1)
    for i <- 0..(n - 1), do: Enum.at(sorted, round(i * step))
  end

  defp summarise(rows) do
    for {rule, rs} <- Enum.group_by(rows, & &1["rule"]) |> Enum.sort() do
      pos = Enum.count(rs, &(&1["teacher_p"] >= 0.5))
      IO.puts("  #{String.pad_trailing(rule, 40)} #{length(rs)} chunks, teacher says yes on #{pos}")
    end
  end
end

GoldCandidates.run(System.argv(), Path.expand("..", __DIR__))
