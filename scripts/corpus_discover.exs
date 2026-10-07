#!/usr/bin/env elixir
# Find and shallow-clone permissively licensed GitHub repos with real Supabase usage, for
# training data (mutations / candidates). Never includes the gold-evaluation repos.
#
#   elixir scripts/corpus_discover.exs --scratch DIR [--max 150] [--min-stars 3] [--max-mb 150] [--code] [--exclude-seen]
#     --code: find repos by code search for the rule patterns; --exclude-seen: skip trained-on and reviewed repos
#     --eval-only (with --code): also keep unlicensed repos, tagged eval_only: gold labels only, never training data
# Writes DIR/manifest.jsonl (repo, sha, licence, stars) and clones DIR/owner__repo.

defmodule CorpusDiscover do
  @licenses ~w(mit apache-2.0 bsd-3-clause bsd-2-clause unlicense)
  @queries [
    "topic:supabase", "topic:supabase-js", "topic:nextjs-supabase", "supabase nextjs", "supabase rls",
    "supabase edge functions", "supabase migrations", "supabase starter", "supabase saas", "supabase sveltekit",
    "supabase expo", "supabase remix", "supabase vite react", "supabase auth ssr"
  ]
  # --code: code search for the patterns the model rules judge, so new repos bring chunks those rules are
  # actually asked about (repo search alone keeps returning the repos already trained on or reviewed)
  @code_queries [
    {"security definer auth.uid", "sql"}, {"security definer search_path", "sql"},
    {"raw_user_meta_data create policy", "sql"}, {"user_metadata role policy", "sql"},
    {"for select using true", "sql"}, {"create policy to authenticated", "sql"},
    {"getSession createServerClient", "ts"}, {"SUPABASE_SERVICE_ROLE_KEY req.json", "ts"}
  ]

  # Gold evaluation repos (manifest) are excluded so evaluation stays independent; --exclude-seen also drops
  # repos already trained on (mutations) or queued for review, so a new corpus only brings unseen code.
  def run(argv, root) do
    {opts, _} =
      OptionParser.parse!(argv, strict: [scratch: :string, max: :integer, min_stars: :integer, max_mb: :integer, code: :boolean, exclude_seen: :boolean, eval_only: :boolean])

    scratch = Keyword.fetch!(opts, :scratch)
    max = Keyword.get(opts, :max, 150)
    min_stars = Keyword.get(opts, :min_stars, 3)
    max_kb = Keyword.get(opts, :max_mb, 150) * 1024
    File.mkdir_p!(scratch)

    excluded = MapSet.new(gold_repos(root) ++ if(opts[:exclude_seen], do: seen_repos(root), else: []))

    candidates =
      if(opts[:code], do: code_candidates(min_stars, !!opts[:eval_only]), else: repo_candidates(min_stars))
      |> List.flatten()
      |> Enum.uniq_by(& &1["fullName"])
      |> Enum.reject(&(&1["isFork"] or &1["isArchived"] or &1["size"] > max_kb))
      |> Enum.reject(&MapSet.member?(excluded, String.downcase(&1["fullName"])))
      # scanners / audit kits / fixture collections contain deliberately vulnerable code: never training "originals"
      |> Enum.reject(&String.match?(String.downcase(&1["fullName"]), ~r/inspect|scanner|audit|vuln|pentest|fixture|ctf|exploit|lint/))
      |> Enum.sort_by(& &1["stargazersCount"], :desc)

    IO.puts("#{length(candidates)} candidates; cloning and keeping those with Supabase usage (max #{max})")

    kept =
      candidates
      # clone only the top candidates by stars; about half pass the Supabase-usage filter
      |> Enum.take(max * 2)
      |> Task.async_stream(&clone(&1, scratch), max_concurrency: 6, timeout: 180_000, on_timeout: :kill_task)
      |> Enum.flat_map(fn {:ok, {:ok, row}} -> [row]; _ -> [] end)
      |> Enum.take(max)

    File.write!(Path.join(scratch, "manifest.jsonl"), Enum.map_join(kept, "", &(JSON.encode!(&1) <> "\n")))
    IO.puts("kept #{length(kept)} repos with Supabase usage → #{scratch}")
  end

  defp repo_candidates(min_stars) do
    for q <- @queries, lic <- @licenses do
      # search API allows ~30 requests/minute: pace sequentially and back off on 403
      Process.sleep(2_500)
      search(["search", "repos", q, "--license", lic, "--stars", ">=#{min_stars}", "--limit", "100",
              "--json", "fullName,stargazersCount,license,isFork,isArchived,size,updatedAt"], 3)
    end
  end

  # Code search has no licence or star filter, so each hit's repo is looked up and reshaped like a repo-search row.
  # eval_only: keep repos without a permissive licence too; clone/3 tags them so they are never used for training
  defp code_candidates(min_stars, eval_only) do
    @code_queries
    |> Enum.flat_map(fn {q, ext} ->
      # code search allows ~10 requests/minute
      Process.sleep(7_000)
      search(["search", "code", q, "--extension", ext, "--limit", "100", "--json", "repository"], 3)
    end)
    |> Enum.map(& &1["repository"]["nameWithOwner"])
    |> Enum.uniq()
    |> Task.async_stream(&repo_info/1, max_concurrency: 6, timeout: 30_000, on_timeout: :kill_task)
    |> Enum.flat_map(fn {:ok, %{} = row} -> [row]; _ -> [] end)
    |> Enum.filter(&(&1["stargazersCount"] >= min_stars and (eval_only or get_in(&1, ["license", "key"]) in @licenses)))
  end

  defp repo_info(name) do
    case System.cmd("gh", ["api", "repos/#{name}"], stderr_to_stdout: true) do
      {out, 0} ->
        r = JSON.decode!(out)
        %{"fullName" => r["full_name"], "stargazersCount" => r["stargazers_count"], "license" => %{"key" => get_in(r, ["license", "key"])},
          "isFork" => r["fork"], "isArchived" => r["archived"], "size" => r["size"]}

      _ ->
        nil
    end
  end

  defp gold_repos(root), do: root |> Path.join("data/gold/manifest.jsonl") |> url_repos()

  defp seen_repos(root) do
    trained =
      root |> Path.join("data/generated/mutations.jsonl") |> File.stream!()
      |> Enum.map(&(JSON.decode!(&1)["resource"] |> String.replace("__", "/", global: false) |> String.downcase()))

    url_repos(Path.join(root, "data/gold/review.jsonl")) ++ trained
  end

  defp url_repos(path) do
    path |> File.stream!() |> Enum.reject(&(String.trim(&1) == ""))
    |> Enum.map(&(JSON.decode!(&1)["url"] |> String.split("/") |> Enum.slice(3, 2) |> Enum.join("/") |> String.downcase()))
  end

  defp search(args, retries) do
    case System.cmd("gh", args, stderr_to_stdout: true) do
      {out, 0} -> JSON.decode!(out)
      {_, _} when retries > 0 -> Process.sleep(65_000) && search(args, retries - 1)
      {out, _} -> IO.warn("search failed: #{String.slice(out, 0, 120)}") && []
    end
  end

  defp clone(repo, scratch) do
    name = repo["fullName"]
    dir = Path.join(scratch, String.replace(name, "/", "__"))
    unless File.dir?(dir), do: System.cmd("git", ["clone", "--depth", "1", "--quiet", "https://github.com/#{name}.git", dir], stderr_to_stdout: true)

    if File.dir?(dir) and supabase?(dir) do
      {sha, 0} = System.cmd("git", ["-C", dir, "rev-parse", "HEAD"])
      license = get_in(repo, ["license", "key"])
      {:ok, %{repo: name, sha: String.trim(sha), license: license, stars: repo["stargazersCount"], eval_only: license not in @licenses}}
    else
      File.rm_rf(dir)
      :skip
    end
  end

  # Keep repos that actually use Supabase: migrations / policies or supabase-js calls.
  defp supabase?(dir) do
    {out, _} = System.cmd("grep", ["-rlE", "--include=*.sql", "--include=*.ts", "--include=*.tsx", "--exclude-dir=node_modules",
                                   "create policy|security definer|@supabase/(supabase-js|ssr)", dir], stderr_to_stdout: true)
    out |> String.split("\n", trim: true) |> length() >= 3
  end
end

CorpusDiscover.run(System.argv(), Path.expand("..", __DIR__))
