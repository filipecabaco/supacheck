#!/usr/bin/env elixir
# Find and shallow-clone permissively licensed GitHub repos with real Supabase usage, for
# training data (mutations / candidates). Never includes the gold-evaluation repos.
#
#   elixir scripts/corpus_discover.exs --scratch DIR [--max 150] [--min-stars 3] [--max-mb 150]
# Writes DIR/manifest.jsonl (repo, sha, licence, stars) and clones DIR/owner__repo.

defmodule CorpusDiscover do
  @licenses ~w(mit apache-2.0 bsd-3-clause bsd-2-clause unlicense)
  @queries [
    "topic:supabase", "topic:supabase-js", "topic:nextjs-supabase", "supabase nextjs", "supabase rls",
    "supabase edge functions", "supabase migrations", "supabase starter", "supabase saas", "supabase sveltekit",
    "supabase expo", "supabase remix", "supabase vite react", "supabase auth ssr"
  ]
  # Gold evaluation repos (manifest) are excluded so evaluation stays independent.
  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [scratch: :string, max: :integer, min_stars: :integer, max_mb: :integer])
    scratch = Keyword.fetch!(opts, :scratch)
    max = Keyword.get(opts, :max, 150)
    min_stars = Keyword.get(opts, :min_stars, 3)
    max_kb = Keyword.get(opts, :max_mb, 150) * 1024
    File.mkdir_p!(scratch)

    excluded =
      Path.join(root, "data/gold/manifest.jsonl")
      |> File.stream!()
      |> Enum.map(&(JSON.decode!(&1)["url"] |> String.split("/") |> Enum.slice(3, 2) |> Enum.join("/") |> String.downcase()))
      |> MapSet.new()

    candidates =
      for q <- @queries, lic <- @licenses do
        # search API allows ~30 requests/minute: pace sequentially and back off on 403
        Process.sleep(2_500)
        search(["search", "repos", q, "--license", lic, "--stars", ">=#{min_stars}", "--limit", "100",
                "--json", "fullName,stargazersCount,license,isFork,isArchived,size,updatedAt"], 3)
      end
      |> List.flatten()
      |> Enum.uniq_by(& &1["fullName"])
      |> Enum.reject(&(&1["isFork"] or &1["isArchived"] or &1["size"] > max_kb))
      |> Enum.reject(&MapSet.member?(excluded, String.downcase(&1["fullName"])))
      # scanners / audit kits / fixture collections contain deliberately vulnerable code: never training "originals"
      |> Enum.reject(&String.match?(String.downcase(&1["fullName"]), ~r/inspect|scanner|audit|vuln|pentest|fixture|ctf|exploit|lint/))
      |> Enum.sort_by(& &1["stargazersCount"], :desc)

    IO.puts("#{length(candidates)} permissive candidates; cloning and keeping those with Supabase usage (max #{max})")

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
      {:ok, %{repo: name, sha: String.trim(sha), license: get_in(repo, ["license", "key"]), stars: repo["stargazersCount"]}}
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
