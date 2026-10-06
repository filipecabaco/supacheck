#!/usr/bin/env elixir
# Zero-shot typed-decision baseline (Laya) on the synthetic test split and the real-code gold set.
#
#   elixir scripts/eval_typed.exs [--subfolder typed-decisions] [--limit 800]
#   (run `pnpm tsx src/eval-gold.ts <artifact>` in cli/ first to refresh data/gold/cache/states.jsonl)

Mix.install([{:pythonx, "~> 0.4.10"}, {:table_rex, "~> 4.1"}])

defmodule EvalTyped do
  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: [model: :string, subfolder: :string, limit: :integer])
    Pythonx.uv_init(File.read!(Path.join(root, "training/pyproject.toml")))

    cfg = %{
      "model" => Keyword.get(opts, :model, "convaiinnovations/laya"),
      "subfolder" => Keyword.get(opts, :subfolder, ""),
      "rules_dir" => Path.join(root, "rules"),
      "data_dir" => Path.join(root, "data/generated"),
      "gold_states" => Path.join(root, "data/gold/cache/states.jsonl"),
      "limit" => Keyword.get(opts, :limit, 800)
    }

    {result, _} =
      Pythonx.eval(
        """
        import sys
        sys.path.insert(0, training_dir.decode())
        import typed
        typed.eval_laya(cfg)
        """,
        %{"training_dir" => Path.join(root, "training"), "cfg" => cfg}
      )

    report = result |> Pythonx.decode() |> JSON.decode!()
    name = if cfg["subfolder"] == "", do: "laya-zero-shot", else: "laya-#{cfg["subfolder"]}-zero-shot"
    out = Path.join([root, "artifacts", name])
    File.mkdir_p!(out)
    File.write!(Path.join(out, "report.json"), JSON.encode!(report))

    rows =
      for {rule, m} <- Enum.sort(report["test"]),
          do: [rule, m["n"], m["pos"], fmt(m["auprc"]), fmt(m["ece"]), fmt(m["acc@0.5"])]

    IO.puts(TableRex.quick_render!(rows, ["rule (synthetic test)", "n", "pos", "AUPRC", "ECE", "acc@.5"]))
    if g = report["gold"], do: IO.puts("gold: n=#{g["n"]} tp=#{g["tp"]} fp=#{g["fp"]} fn=#{g["fn"]} precision=#{fmt(g["precision"])} recall=#{fmt(g["recall"])}")
  end

  defp fmt(nil), do: "-"
  defp fmt(x) when is_float(x), do: :erlang.float_to_binary(x, decimals: 3)
  defp fmt(x), do: to_string(x)
end

EvalTyped.run(System.argv(), Path.expand("..", __DIR__))
