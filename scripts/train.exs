#!/usr/bin/env elixir
# Train a shared-encoder + per-rule-heads model, calibrate, evaluate, export ONNX, bench CPU.
# Python (torch/transformers) runs in-process via Pythonx; code lives in training/heads.py.
#
#   elixir scripts/train.exs --base answerdotai/ModernBERT-base --name modernbert-base
#   elixir scripts/train.exs --base jinaai/jina-embeddings-v2-base-code --name jina-code --epochs 3
#   elixir scripts/train.exs ... --limit 500        # quick smoke run
#   elixir scripts/train.exs --name modernbert-base --skip-train   # export + bench only

Mix.install([{:pythonx, "~> 0.4.10"}, {:table_rex, "~> 4.1"}])

defmodule Train do
  def run(argv, root) do
    {opts, _} =
      OptionParser.parse!(argv,
        strict: [
          base: :string,
          name: :string,
          epochs: :integer,
          batch_size: :integer,
          max_len: :integer,
          limit: :integer,
          skip_train: :boolean,
          with_teacher: :boolean,
          skip_export: :boolean
        ]
      )

    name = Keyword.fetch!(opts, :name)
    out_dir = Path.join([root, "artifacts", name])

    Pythonx.uv_init(File.read!(Path.join(root, "training/pyproject.toml")))

    {_, globals} =
      Pythonx.eval(
        """
        import sys
        sys.path.insert(0, training_dir.decode())
        import heads
        """,
        %{"training_dir" => Path.join(root, "training")}
      )

    unless opts[:skip_train] do
      cfg = %{
        "base" => Keyword.fetch!(opts, :base),
        "data_dir" => Path.join(root, "data/generated"),
        "out_dir" => out_dir,
        "epochs" => Keyword.get(opts, :epochs, 3),
        "batch_size" => Keyword.get(opts, :batch_size, 16),
        "max_len" => Keyword.get(opts, :max_len, 512),
        "limit" => Keyword.get(opts, :limit, 0),
        "with_teacher" => if(opts[:with_teacher], do: "1", else: "")
      }

      report = call(globals, "heads.train(cfg)", cfg)
      print_report(report)
    end

    unless opts[:skip_export] do
      path = call(globals, "heads.export_onnx(cfg)", %{"out_dir" => out_dir})
      IO.puts("exported #{path}")

      for tokens <- [256, 512] do
        bench = call(globals, "heads.bench_onnx(cfg)", %{"out_dir" => out_dir, "tokens" => tokens})
        IO.puts("onnx cpu @#{bench["tokens"]} tokens: median #{fmt(bench["median_ms"])} ms, p90 #{fmt(bench["p90_ms"])} ms, #{bench["onnx_mb"]} MB")
      end
    end
  end

  defp call(globals, expr, cfg) do
    {result, _} = Pythonx.eval(expr, Map.put(globals, "cfg", cfg))

    case Pythonx.decode(result) do
      json when is_binary(json) ->
        case JSON.decode(json) do
          {:ok, decoded} -> decoded
          _ -> json
        end

      other ->
        other
    end
  end

  defp print_report(report) do
    IO.puts("\nbase #{report["base"]} | rows #{report["train_rows"]} | #{report["epochs"]} epochs | #{report["train_seconds"]}s on #{report["device"]}")

    rows =
      for {rule, m} <- Enum.sort(report["test"]) do
        [rule, m["n"], m["pos"], fmt(m["auprc"]), fmt(m["ece"]), fmt(m["acc@0.5"]),
         fmt(m["precision@thr"]), fmt(m["recall@thr"]), fmt(m["oracle_recall@p0.9"])]
      end

    TableRex.quick_render!(rows, ["rule (test)", "n", "pos", "AUPRC", "ECE", "acc@.5", "P@thr", "R@thr", "R@P.9 oracle"])
    |> IO.puts()
  end

  defp fmt(nil), do: "-"
  defp fmt(x) when is_float(x), do: :erlang.float_to_binary(x, decimals: 3)
  defp fmt(x), do: to_string(x)
end

Train.run(System.argv(), Path.expand("..", __DIR__))
