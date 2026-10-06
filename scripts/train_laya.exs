#!/usr/bin/env elixir
# Fine-tune Laya (typed-decision model) on the supacheck corpus, then evaluate on the gold set.
# Python (laya / torch) runs in-process via Pythonx; code in training/laya_ft.py.
#
#   elixir scripts/train_laya.exs --name laya-supacheck [--base typed-decisions] [--epochs 3]
#   elixir scripts/train_laya.exs --name laya-supacheck --eval-only
#   elixir scripts/train_laya.exs --eval-model typed-decisions        # zero-shot baseline

Mix.install([{:pythonx, "~> 0.4.10"}])

defmodule TrainLaya do
  @switches [name: :string, base: :string, epochs: :integer, eval_only: :boolean, eval_model: :string, micro_batch: :integer]

  def run(argv, root) do
    {opts, _} = OptionParser.parse!(argv, strict: @switches)
    Pythonx.uv_init(File.read!(Path.join(root, "training/pyproject.toml")))
    {_, globals} = Pythonx.eval("import sys\nsys.path.insert(0, d.decode())\nimport laya_ft", %{"d" => Path.join(root, "training")})

    opts |> mode(root) |> execute(opts, globals, root)
  end

  # What to do is decided once, from the flags; each mode is a plain data tuple.
  defp mode(opts, root) do
    cond do
      model = opts[:eval_model] -> {:eval, model}
      opts[:eval_only] -> {:eval, artifact_dir(opts, root)}
      true -> {:train, artifact_dir(opts, root)}
    end
  end

  defp artifact_dir(opts, root), do: Path.join([root, "artifacts", Keyword.fetch!(opts, :name)])

  defp execute({:train, out_dir}, opts, g, root) do
    %{"rows" => rows, "path" => path} =
      call(g, "laya_ft.build_typed(cfg)", %{"data_dir" => Path.join(root, "data/generated"), "rules_dir" => Path.join(root, "rules")})

    IO.puts("typed training rows: #{rows}")

    summary =
      call(g, "laya_ft.finetune(cfg)", %{
        "data" => path,
        "base" => Keyword.get(opts, :base, "typed-decisions"),
        "out_dir" => out_dir,
        "epochs" => Keyword.get(opts, :epochs, 3),
        "micro_batch" => Keyword.get(opts, :micro_batch, 4)
      })

    IO.puts("finetune: #{inspect(summary, limit: 20)}")
    execute({:eval, out_dir}, opts, g, root)
  end

  defp execute({:eval, model}, _opts, g, root) do
    report =
      call(g, "laya_ft.evaluate(cfg)", %{
        "model_dir" => model,
        "rules_dir" => Path.join(root, "rules"),
        "states" => Path.join(root, "data/gold/cache/states.jsonl"),
        "review" => Path.join(root, "data/gold/review.jsonl")
      })

    print(report)
    # only local checkpoints get a report file (hub aliases like "typed-decisions" don't)
    if File.dir?(model), do: File.write!(Path.join(model, "gold_report.json"), JSON.encode!(report))
  end

  defp print(%{"test_items" => n, "auroc" => auroc, "precision" => p, "recall" => r, "per_rule" => per_rule}) do
    IO.puts("held-out: items #{n} auroc #{fmt(auroc)} precision #{fmt(p)} recall #{fmt(r)}")

    for {rule, %{"tp" => tp, "fp" => fp, "fn" => fn_, "tn" => tn}} <- Enum.sort(per_rule),
        do: IO.puts("  #{String.pad_trailing(rule, 40)} tp/fp/fn/tn #{tp}/#{fp}/#{fn_}/#{tn}")
  end

  defp call(g, expr, cfg) do
    {result, _} = Pythonx.eval(expr, Map.put(g, "cfg", cfg))
    result |> Pythonx.decode() |> JSON.decode!()
  end

  defp fmt(nil), do: "-"
  defp fmt(x), do: :erlang.float_to_binary(x * 1.0, decimals: 3)
end

TrainLaya.run(System.argv(), Path.expand("..", __DIR__))
