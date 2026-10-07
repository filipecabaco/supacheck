#!/usr/bin/env elixir
# Shallow-fetch every gold-set repo at the exact commit its labels point to, so eval-gold.ts can build the
# same repo-wide facts (grants, RLS, import graph) for every item. Repos already present at that commit in
# one of the --reuse dirs are skipped.
#
#   elixir scripts/gold_clones.exs --out artifacts/gold-clones [--reuse artifacts/corpus4]
# then: CORPUS=artifacts/gold-clones CORPUS2=artifacts/corpus4 pnpm tsx src/eval-gold.ts <artifact>

defmodule GoldClones do
  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [out: :string, reuse: :keep])
    out = Path.expand(Keyword.fetch!(opts, :out), root)
    reuse = opts |> Keyword.get_values(:reuse) |> Enum.map(&Path.expand(&1, root))
    File.mkdir_p!(out)

    wanted =
      root |> Path.join("data/gold/manifest.jsonl") |> File.stream!() |> Enum.reject(&(String.trim(&1) == ""))
      |> Enum.map(&(JSON.decode!(&1)["url"] |> String.split("/")))
      |> Enum.map(fn [_, _, _, owner, repo, _, sha | _] -> {"#{owner}/#{repo}", sha} end)
      |> Enum.uniq()

    todo = Enum.reject(wanted, fn {repo, sha} -> Enum.any?([out | reuse], &at_commit?(dir(&1, repo), sha)) end)
    IO.puts("#{length(wanted)} gold repos, #{length(wanted) - length(todo)} already present, fetching #{length(todo)}")

    results =
      todo
      |> Task.async_stream(fn {repo, sha} -> {repo, fetch(dir(out, repo), repo, sha)} end,
           max_concurrency: 6, timeout: 300_000, on_timeout: :kill_task)
      |> Enum.map(fn {:ok, r} -> r; {:exit, _} -> {:timeout, :error} end)

    failed = for {repo, {:error, why}} <- results, do: "#{repo}: #{why}"
    IO.puts("fetched #{length(results) - length(failed)}, failed #{length(failed)}")
    Enum.each(failed, &IO.puts("  " <> &1))
  end

  defp dir(base, repo), do: Path.join(base, String.replace(repo, "/", "__"))

  defp at_commit?(dir, sha) do
    File.dir?(dir) and
      match?({head, 0} when binary_part(head, 0, 7) == binary_part(sha, 0, 7),
             System.cmd("git", ["-C", dir, "rev-parse", "HEAD"], stderr_to_stdout: true))
  end

  # GitHub serves any reachable commit by sha, so a depth-1 fetch of that commit is enough
  defp fetch(dir, repo, sha) do
    File.rm_rf!(dir)
    File.mkdir_p!(dir)
    git = &System.cmd("git", ["-C", dir | &1], stderr_to_stdout: true)

    with {_, 0} <- git.(["init", "--quiet"]),
         {_, 0} <- git.(["fetch", "--quiet", "--depth", "1", "https://github.com/#{repo}.git", sha]),
         {_, 0} <- git.(["checkout", "--quiet", "FETCH_HEAD"]) do
      :ok
    else
      {msg, _} ->
        File.rm_rf!(dir)
        {:error, msg |> String.trim() |> String.split("\n") |> List.last() |> String.slice(0, 120)}
    end
  end
end

GoldClones.run(System.argv(), Path.expand("..", __DIR__))
