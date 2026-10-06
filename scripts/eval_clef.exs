#!/usr/bin/env elixir
# Zero-shot Clef-flash (via llama-server /v1/systemone) on the real-code gold set and a sample
# of the synthetic test split, using the same rule questions as every other typed baseline.
#
#   llama-server -m models/Clef-Flash-Q8_0.gguf --port 8089 --parallel 4 -c 32768
#   elixir scripts/eval_clef.exs [--server http://127.0.0.1:8089] [--limit 400]
#   Jev (hosted, evaluation only): elixir scripts/eval_clef.exs --jev --limit 1
#     reads JEV_API_KEY from .env.local; server https://api.typesafe.ai, model jev-latest

Mix.install([{:req, "~> 0.7"}, {:yaml_elixir, "~> 2.12"}])

defmodule EvalClef do
  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [server: :string, limit: :integer, jev: :boolean])
    jev = opts[:jev]
    server = Keyword.get(opts, :server, if(jev, do: "https://api.typesafe.ai", else: "http://127.0.0.1:8089"))
    Process.put(:req_extra, if(jev, do: [auth: {:bearer, env_key(root, "JEV_API_KEY")}], else: []))
    Process.put(:model, if(jev, do: "jev-latest"))
    limit = Keyword.get(opts, :limit, 400)

    questions =
      for path <- Path.wildcard(Path.join(root, "rules/*.yaml")), into: %{} do
        r = YamlElixir.read_from_file!(path)
        {r["id"], r["question"]}
      end

    gold = read_jsonl(Path.join(root, "data/gold/cache/states.jsonl"))
    test = read_jsonl(Path.join(root, "data/generated/test.jsonl")) |> Enum.shuffle() |> Enum.take(limit)
    :rand.seed(:exsss, {1, 2, 3})

    gold_scored = score(gold, questions, server)
    test_scored = score(test, questions, server)

    report = %{"gold" => confusion(gold_scored), "test" => per_rule(test_scored)}
    out = Path.join(root, if(jev, do: "artifacts/jev-zero-shot", else: "artifacts/clef-flash-zero-shot"))
    File.mkdir_p!(out)
    File.write!(Path.join(out, "report.json"), JSON.encode!(report))

    IO.puts("gold (real code): #{inspect(report["gold"])}")
    for {rule, m} <- Enum.sort(report["test"]), do: IO.puts("  #{String.pad_trailing(rule, 40)} #{inspect(m)}")
  end

  defp score(rows, questions, server) do
    extra = Process.get(:req_extra, [])
    model = Process.get(:model)

    rows
    |> Task.async_stream(
      fn r ->
        body = %{state: r["state"], questions: %{"q" => questions[r["rule"]]}}
        body = if model, do: Map.put(body, :model, model), else: body
        resp = Req.post!(server <> "/v1/systemone", [json: body, receive_timeout: 120_000, retry: :transient] ++ extra)
        # A failed request has no score. Never let it reach a comparison: nil >= 0.5 is true in Erlang term order.
        case get_in(resp.body, ["answers", "q", "noul"]) do
          p when is_number(p) -> {r["rule"], p, r["label"]}
          _ -> {:error, resp.status}
        end
      end,
      max_concurrency: 4, timeout: 180_000)
    |> Enum.map(fn {:ok, x} -> x end)
    |> Enum.split_with(&match?({:error, _}, &1))
    |> then(fn {errors, ok} ->
      if errors != [], do: IO.warn("#{length(errors)} requests failed and were excluded")
      ok
    end)
  end

  defp confusion(scored, thr \\ 0.5) do
    c = Enum.frequencies_by(scored, fn {_, p, y} -> {p >= thr, y == 1} end)
    tp = c[{true, true}] || 0
    fp = c[{true, false}] || 0
    fn_ = c[{false, true}] || 0
    tn = c[{false, false}] || 0
    %{n: length(scored), tp: tp, fp: fp, fn: fn_, tn: tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn_)}
  end

  defp per_rule(scored) do
    scored
    |> Enum.group_by(&elem(&1, 0))
    |> Map.new(fn {rule, xs} ->
      c = confusion(xs)
      acc = ratio(c.tp + c.tn, c.n)
      {rule, Map.put(c, :acc, acc)}
    end)
  end

  defp ratio(_, 0), do: nil
  defp ratio(a, b), do: Float.round(a / b, 3)

  # Secrets come from the git-ignored .env.local (or the environment), never from code.
  defp env_key(root, name) do
    System.get_env(name) ||
      Path.join(root, ".env.local") |> File.read!() |> String.split("\n")
      |> Enum.find_value(fn line -> with [^name, v] <- String.split(line, "=", parts: 2), do: String.trim(v), else: (_ -> nil) end)
  end

  defp read_jsonl(path), do: path |> File.stream!() |> Enum.map(&JSON.decode!/1)
end

EvalClef.run(System.argv(), Path.expand("..", __DIR__))
