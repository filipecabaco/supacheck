"""Shared encoder + one binary head per rule, driven from Elixir via Pythonx.

Each training row labels exactly one rule; every other rule's head is masked out of the
loss, so "not applicable" never counts as a negative.
"""
import json
import math
import os
import random
import time

import numpy as np
import torch
from safetensors.torch import load_file, save_file
from sklearn.metrics import average_precision_score
from transformers import AutoModel, AutoTokenizer


def _s(x):
    return x.decode() if isinstance(x, bytes) else x


def _cfg(cfg):
    return {_s(k): _s(v) for k, v in cfg.items()}


def _device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


class Heads(torch.nn.Module):
    def __init__(self, base, n_rules, attn_impl=None):
        super().__init__()
        kwargs = {"trust_remote_code": True}
        if attn_impl:
            kwargs["attn_implementation"] = attn_impl
        if "ModernBERT" in base or "modernbert" in base:
            kwargs["reference_compile"] = False
        self.encoder = AutoModel.from_pretrained(base, **kwargs)
        hidden = self.encoder.config.hidden_size
        self.dropout = torch.nn.Dropout(0.1)
        self.heads = torch.nn.Linear(hidden, n_rules)

    def forward(self, input_ids, attention_mask):
        out = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        h = out.last_hidden_state
        m = attention_mask.unsqueeze(-1).to(h.dtype)
        pooled = (h * m).sum(1) / m.sum(1).clamp(min=1.0)
        return self.heads(self.dropout(pooled))


class Calibrated(torch.nn.Module):
    """Export wrapper: probabilities per rule, temperatures baked in."""

    def __init__(self, model, temps):
        super().__init__()
        self.model = model
        self.register_buffer("temps", torch.tensor(temps, dtype=torch.float32))

    def forward(self, input_ids, attention_mask):
        return torch.sigmoid(self.model(input_ids, attention_mask) / self.temps)


def _batches(rows, tok, rule_idx, max_len, batch_size, shuffle):
    order = sorted(range(len(rows)), key=lambda i: len(rows[i]["state"]))
    chunks = [order[i:i + batch_size] for i in range(0, len(order), batch_size)]
    if shuffle:
        random.shuffle(chunks)
    for chunk in chunks:
        batch = [rows[i] for i in chunk]
        enc = tok([r["state"] for r in batch], truncation=True, max_length=max_len,
                  padding=True, return_tensors="pt")
        rule = torch.tensor([rule_idx[r["rule"]] for r in batch])
        target = torch.tensor([float(r.get("soft", r["label"])) for r in batch])
        yield enc, rule, target, batch


def _logits(model, rows, tok, rule_idx, max_len, device, batch_size=32):
    model.eval()
    out = []
    with torch.no_grad():
        for enc, rule, _t, batch in _batches(rows, tok, rule_idx, max_len, batch_size, False):
            z = model(enc["input_ids"].to(device), enc["attention_mask"].to(device)).float().cpu()
            sel = z[torch.arange(len(batch)), rule]
            out.extend(zip(batch, sel.tolist()))
    return out


def _fit_temperature(z, y):
    if len(z) < 10 or len(set(y)) < 2:
        return 1.0
    z = torch.tensor(z)
    y = torch.tensor(y, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(z / log_t.exp(), y)
        loss.backward()
        return loss

    opt.step(closure)
    return float(min(max(log_t.exp().item(), 0.05), 20.0))


def _ece(p, y, bins=10):
    p, y = np.asarray(p), np.asarray(y)
    ece = 0.0
    for lo in np.linspace(0, 1, bins, endpoint=False):
        m = (p >= lo) & (p < lo + 1 / bins)
        if m.any():
            ece += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(ece)


def _threshold_for_precision(p, y, target=0.9):
    """Lowest threshold whose precision >= target (maximises recall). None if unreachable."""
    pairs = sorted(zip(p, y), reverse=True)
    best, tp, fp = None, 0, 0
    for prob, label in pairs:
        tp += label
        fp += 1 - label
        if tp and tp / (tp + fp) >= target:
            best = prob
    return best


def _prf(p, y, thr):
    if thr is None:
        return None, 0.0
    pred = [int(x >= thr) for x in p]
    tp = sum(a and b for a, b in zip(pred, y))
    fp = sum(a and not b for a, b in zip(pred, y))
    fn = sum((not a) and b for a, b in zip(pred, y))
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else 0.0
    return precision, recall


def metrics_for(scored, temps, rule_idx, thresholds=None):
    by_rule = {}
    for row, z in scored:
        by_rule.setdefault(row["rule"], []).append((z, row["label"]))
    report = {}
    for rule, items in sorted(by_rule.items()):
        t = temps[rule_idx[rule]]
        p = [1 / (1 + math.exp(-z / t)) for z, _ in items]
        y = [label for _, label in items]
        entry = {"n": len(y), "pos": sum(y)}
        if len(set(y)) == 2:
            entry["auprc"] = float(average_precision_score(y, p))
        entry["ece"] = _ece(p, y)
        entry["acc@0.5"] = float(np.mean([(a >= 0.5) == b for a, b in zip(p, y)]))
        oracle = _threshold_for_precision(p, y)
        entry["oracle_recall@p0.9"] = _prf(p, y, oracle)[1]
        if thresholds is not None:
            prec, rec = _prf(p, y, thresholds.get(rule))
            entry["threshold"] = thresholds.get(rule)
            entry["precision@thr"] = prec
            entry["recall@thr"] = rec
        report[rule] = entry
    return report


def train(cfg):
    cfg = _cfg(cfg)
    seed = int(cfg.get("seed", 0))
    random.seed(seed)
    torch.manual_seed(seed)

    data_dir, out_dir, base = cfg["data_dir"], cfg["out_dir"], cfg["base"]
    max_len = int(cfg.get("max_len", 512))
    epochs = int(cfg.get("epochs", 3))
    batch_size = int(cfg.get("batch_size", 16))
    limit = int(cfg.get("limit", 0))
    os.makedirs(out_dir, exist_ok=True)

    train_rows = read_jsonl(os.path.join(data_dir, "train.jsonl"))
    val_rows = read_jsonl(os.path.join(data_dir, "val.jsonl"))
    test_rows = read_jsonl(os.path.join(data_dir, "test.jsonl"))
    if limit:
        random.shuffle(train_rows)
        train_rows = train_rows[:limit]
    teacher_path = os.path.join(data_dir, "teacher_train.jsonl")
    if str(cfg.get("with_teacher", "")) in ("1", "true", "True") and os.path.exists(teacher_path):
        teacher = read_jsonl(teacher_path)
        print(f"adding {len(teacher)} teacher-labelled rows (soft targets)", flush=True)
        train_rows = train_rows + teacher
        mutations_path = os.path.join(data_dir, "mutations.jsonl")
        if os.path.exists(mutations_path):
            mutations = read_jsonl(mutations_path)
            print(f"adding {len(mutations)} real-code mutation rows", flush=True)
            train_rows = train_rows + mutations
    rules = sorted({r["rule"] for r in train_rows + val_rows + test_rows})
    rule_idx = {r: i for i, r in enumerate(rules)}

    device = _device()
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    model = Heads(base, len(rules)).to(device)

    head_params = list(model.heads.parameters())
    enc_params = [p for n, p in model.named_parameters() if not n.startswith("heads.")]
    opt = torch.optim.AdamW([
        {"params": enc_params, "lr": float(cfg.get("encoder_lr", 3e-5))},
        {"params": head_params, "lr": float(cfg.get("head_lr", 1e-3))},
    ], weight_decay=0.01)
    steps = epochs * math.ceil(len(train_rows) / batch_size)
    warmup = max(1, int(0.06 * steps))
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warmup) * max(0.0, (steps - s) / max(1, steps - warmup)))

    log = []
    t0 = time.time()
    step = 0
    for epoch in range(epochs):
        model.train()
        running = 0.0
        for enc, rule, target, batch in _batches(train_rows, tok, rule_idx, max_len, batch_size, True):
            z = model(enc["input_ids"].to(device), enc["attention_mask"].to(device))
            sel = z[torch.arange(len(batch), device=device), rule.to(device)]
            loss = torch.nn.functional.binary_cross_entropy_with_logits(sel, target.to(device))
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            running += loss.item()
            step += 1
            if step % 50 == 0:
                # variable-length batches make the MPS allocator cache grow unbounded
                if device == "mps":
                    torch.mps.empty_cache()
                print(f"epoch {epoch} step {step}/{steps} loss {running / 50:.4f} "
                      f"elapsed {time.time() - t0:.0f}s", flush=True)
                log.append({"step": step, "loss": running / 50})
                running = 0.0

    train_seconds = time.time() - t0

    val_scored = _logits(model, val_rows, tok, rule_idx, max_len, device)
    temps = []
    for rule in rules:
        items = [(z, row["label"]) for row, z in val_scored if row["rule"] == rule]
        temps.append(_fit_temperature([z for z, _ in items], [y for _, y in items]))

    thresholds = {}
    for rule in rules:
        t = temps[rule_idx[rule]]
        items = [(1 / (1 + math.exp(-z / t)), row["label"]) for row, z in val_scored if row["rule"] == rule]
        # Floor at 0.5: on a perfectly separable val split the precision-target search picks
        # a near-zero threshold, which flags everything on real code.
        t = _threshold_for_precision([p for p, _ in items], [y for _, y in items])
        thresholds[rule] = max(0.5, t) if t is not None else 0.5

    test_scored = _logits(model, test_rows, tok, rule_idx, max_len, device)
    report = {
        "base": base,
        "with_teacher": str(cfg.get("with_teacher", "")),
        "train_rows": len(train_rows),
        "epochs": epochs,
        "train_seconds": round(train_seconds, 1),
        "device": device,
        "val": metrics_for(val_scored, temps, rule_idx),
        "test": metrics_for(test_scored, temps, rule_idx, thresholds),
    }

    save_file({k: v.contiguous().cpu() for k, v in model.state_dict().items()},
              os.path.join(out_dir, "model.safetensors"))
    tok.save_pretrained(out_dir)
    with open(os.path.join(out_dir, "supacheck.json"), "w") as f:
        json.dump({"base": base, "rules": rules, "temperatures": temps, "thresholds": thresholds,
                   "max_len": max_len, "pooling": "mean"}, f, indent=2)
    with open(os.path.join(out_dir, "report.json"), "w") as f:
        json.dump(report | {"loss_log": log}, f, indent=2)
    return json.dumps(report)


def export_onnx(cfg):
    cfg = _cfg(cfg)
    out_dir = cfg["out_dir"]
    with open(os.path.join(out_dir, "supacheck.json")) as f:
        meta = json.load(f)
    model = Heads(meta["base"], len(meta["rules"]), attn_impl="eager")
    model.load_state_dict(load_file(os.path.join(out_dir, "model.safetensors")))
    wrapped = Calibrated(model, meta["temperatures"]).eval()

    tok = AutoTokenizer.from_pretrained(out_dir, trust_remote_code=True)
    enc = tok(["Language: TypeScript.\n---\nconst x = 1"], return_tensors="pt")
    path = os.path.join(out_dir, "model.onnx")
    torch.onnx.export(
        wrapped, (enc["input_ids"], enc["attention_mask"]), path,
        input_names=["input_ids", "attention_mask"], output_names=["probs"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
                      "probs": {0: "batch"}},
        opset_version=17, dynamo=False,
    )
    return path


def bench_onnx(cfg):
    """CPU latency of the exported graph at a fixed token length (single thread pool default)."""
    import onnxruntime as ort

    cfg = _cfg(cfg)
    out_dir = cfg["out_dir"]
    tokens = int(cfg.get("tokens", 512))
    sess = ort.InferenceSession(os.path.join(out_dir, "model.onnx"), providers=["CPUExecutionProvider"])
    ids = np.random.randint(100, 1000, size=(1, tokens), dtype=np.int64)
    mask = np.ones_like(ids)
    for _ in range(3):
        sess.run(None, {"input_ids": ids, "attention_mask": mask})
    times = []
    for _ in range(int(cfg.get("runs", 20))):
        t = time.perf_counter()
        sess.run(None, {"input_ids": ids, "attention_mask": mask})
        times.append((time.perf_counter() - t) * 1000)
    size_mb = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)
                  if f.startswith("model.onnx")) / 1e6
    return json.dumps({"tokens": tokens, "median_ms": float(np.median(times)),
                       "p90_ms": float(np.percentile(times, 90)), "onnx_mb": round(size_mb, 1)})
