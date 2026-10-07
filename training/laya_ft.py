"""Fine-tune a Laya typed-decision checkpoint on the supacheck corpus, and evaluate it on the gold set.

Rows become Laya's `{state, questions, expected}` format with one question per row (the rule's
noul question from rules/<id>.yaml, neutral A/B labels). Training data: synthetic templates +
real-code mutations (permissive repos). Gold (data/gold) is never trained on.
"""
import glob
import json
import os
import random

import numpy as np
import yaml
from sklearn.metrics import roc_auc_score

from heads import _cfg, read_jsonl


def _questions(rules_dir):
    out = {}
    for path in glob.glob(os.path.join(rules_dir, "*.yaml")):
        rule = yaml.safe_load(open(path))
        if rule.get("question"):
            out[rule["id"]] = rule["question"]
    return out


def build_typed(cfg):
    cfg = _cfg(cfg)
    qs = _questions(cfg["rules_dir"])
    rows = []
    for name in ("train.jsonl", "mutations.jsonl"):
        path = os.path.join(cfg["data_dir"], name)
        if os.path.exists(path):
            rows += read_jsonl(path)
    random.seed(0)
    random.shuffle(rows)
    out = os.path.join(cfg["data_dir"], "laya_train.jsonl")
    n = 0
    with open(out, "w") as f:
        for r in rows:
            q = qs.get(r["rule"])
            if not q:
                continue
            target = r.get("soft", r["label"])
            f.write(json.dumps({"state": r["state"], "questions": {r["rule"]: q},
                                "gold": {r["rule"]: {"probabilities": {"false": 1 - float(target), "true": float(target)}}}}) + "\n")
            n += 1
    return json.dumps({"rows": n, "path": out})


def _release_mps_cache(every=20):
    """Variable-length batches make MPS cache buffers per shape until the driver runs out (OOM at
    ~16 GiB live / 47 GiB "other"). Wrap laya's forward to hand the cache back every `every` steps."""
    import torch
    import laya.train as lt

    if not torch.backends.mps.is_available() or getattr(lt._forward, "_supacheck_wrapped", False):
        return
    inner, calls = lt._forward, [0]

    def forward(*args, **kwargs):
        calls[0] += 1
        if calls[0] % every == 0:
            torch.mps.empty_cache()
        return inner(*args, **kwargs)

    forward._supacheck_wrapped = True
    lt._forward = forward

    # MPS compiles and keeps a graph per input shape; padding each batch to its own longest item gives
    # hundreds of lengths and memory climbs to the limit (~65 GB by step 400). Bucket lengths to
    # multiples of 128 so only a handful of shapes ever exist. Pad positions are masked, so math is unchanged.
    collate = lt.collate_items

    def bucketed(batch, pad_id, *args, **kwargs):
        res = collate(batch, pad_id, *args, **kwargs)
        if res is None or "layout" in res:
            return res
        n, length = res["input_ids"].shape
        extra = -length % 128
        if extra:
            res["input_ids"] = torch.cat([res["input_ids"], torch.full((n, extra), pad_id, dtype=res["input_ids"].dtype)], 1)
            res["attention_mask"] = torch.cat([res["attention_mask"], torch.zeros((n, extra), dtype=res["attention_mask"].dtype)], 1)
        return res

    lt.collate_items = bucketed


def finetune(cfg):
    from laya.train import TrainConfig, finetune as laya_finetune

    cfg = _cfg(cfg)
    _release_mps_cache()
    micro = int(cfg.get("micro_batch", 2))
    tc = TrainConfig(
        # effective batch stays 32 whatever the micro batch (smaller micro batches fit MPS memory)
        epochs=int(cfg.get("epochs", 3)), micro_batch=micro, grad_accum=int(cfg.get("grad_accum", max(1, 32 // micro))),
        loss="soft-ce", max_len=int(cfg.get("max_len", 1024)), head_max_len=int(cfg.get("head_max_len", 256)),
        gradient_checkpointing=True, log_every=50,
    )
    summary = laya_finetune(cfg["data"], cfg.get("base", "typed-decisions"), cfg["out_dir"], tc)
    return json.dumps(summary, default=str)


def _is_calib(url, calib_only):
    repo = "/".join(url.split("/")[3:5])
    if repo in calib_only:
        return True
    h = 0
    for c in repo:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return h % 5 < 2


def evaluate(cfg):
    """Gold evaluation with the same repo-level split as cli/src/eval-gold.ts: thresholds tuned on
    calibration repos (lowest giving precision >= 0.9, else 0.5), scored on held-out test repos."""
    import laya

    cfg = _cfg(cfg)
    agent = laya.load(cfg["model_dir"])
    qs = _questions(cfg["rules_dir"])
    review = read_jsonl(cfg["review"])
    calib_only = {"/".join(r["url"].split("/")[3:5]) for r in review if r.get("source") == "v6-calibration"}
    rows = [r for r in read_jsonl(cfg["states"]) if r["rule"] in qs]
    scored = []
    for r in rows:
        ans = agent.predict(r["state"], {r["rule"]: qs[r["rule"]]})["answers"][r["rule"]]
        scored.append({**r, "p": float(ans["noul"]), "calib": _is_calib(r["url"], calib_only)})

    thr = {}
    for rule in {s["rule"] for s in scored}:
        cal = sorted([s for s in scored if s["calib"] and s["rule"] == rule], key=lambda s: -s["p"])
        tp = fp = 0
        best = None
        for s in cal:
            tp += s["label"]
            fp += 1 - s["label"]
            if tp and tp / (tp + fp) >= 0.9:
                best = s["p"]
        thr[rule] = max(best, 0.05) if best is not None else 0.5

    test = [s for s in scored if not s["calib"]]
    y = [s["label"] for s in test]
    p = [s["p"] for s in test]
    pred = [int(s["p"] >= thr[s["rule"]]) for s in test]
    tp = sum(a and b for a, b in zip(pred, y))
    fp = sum(a and not b for a, b in zip(pred, y))
    fn = sum((not a) and b for a, b in zip(pred, y))
    per_rule = {}
    for rule in sorted({s["rule"] for s in test}):
        rs = [s for s in test if s["rule"] == rule]
        rp = [int(s["p"] >= thr[rule]) for s in rs]
        ry = [s["label"] for s in rs]
        per_rule[rule] = {"tp": sum(a and b for a, b in zip(rp, ry)), "fp": sum(a and not b for a, b in zip(rp, ry)),
                          "fn": sum((not a) and b for a, b in zip(rp, ry)), "tn": sum((not a) and (not b) for a, b in zip(rp, ry))}
    return json.dumps({
        "model": cfg["model_dir"], "test_items": len(test),
        "auroc": float(roc_auc_score(y, p)) if len(set(y)) == 2 else None,
        "precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None,
        "thresholds": thr, "per_rule": per_rule,
    })


def export_onnx(cfg):
    """Export a laya-python checkpoint (model.safetensors + rl_agent_config.json + tokenizer/ + encoder/)
    to the split ONNX layout laya-ts loads: encoder.onnx (input_ids, attention_mask -> last_hidden_state)
    and head.onnx (hidden_states, marker_pos, marker_mask, qtype[n,1], attention_mask -> logits,
    act_logits), plus rl_agent_config.json, tokenizer.json and supacheck.json (rules + thresholds from
    gold_report.json).

    The laya 0.3.28 wheel ships no exporter (its ONNXAgent reads a single fused laya.onnx); this is a
    port of upstream laya-ts/scripts/export_onnx.py @ a4a8921. Each graph is one self-contained file
    (no .onnx.data sidecar): fp32 ModernBERT-large is ~1.6GB, under protobuf's 2GB cap."""
    import shutil

    import onnxruntime as ort
    import torch
    from laya.common import build_model
    from safetensors.torch import load_file

    cfg = _cfg(cfg)
    src, out = cfg["model_dir"], cfg["out_dir"]
    seq, verify_len = int(cfg.get("seq_len", 16)), int(cfg.get("verify_len", 512))
    with open(os.path.join(src, "rl_agent_config.json")) as f:
        agent_cfg = json.load(f)
    enc_dir = os.path.join(src, "encoder")
    model = build_model(agent_cfg, encoder_dir=enc_dir if os.path.exists(enc_dir) else None, pretrained=False)
    model.load_state_dict(load_file(os.path.join(src, "model.safetensors")), strict=True)
    model.encoder.config.reference_compile = False
    model.eval().float()

    class EncoderOnly(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.encoder = m.encoder

        def forward(self, input_ids, attention_mask):
            return self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    class HeadOnly(torch.nn.Module):
        """DecisionModel.forward after the encoder (type_emb + head transformer + scorer + act_head)."""

        def __init__(self, m):
            super().__init__()
            self.head, self.type_emb, self.scorer, self.act_head = m.head, m.type_emb, m.scorer, m.act_head

        def forward(self, hidden_states, marker_pos, marker_mask, qtype, attention_mask):
            h = hidden_states + self.type_emb(qtype.squeeze(-1))[:, None, :]
            if self.head is not None:
                pad = attention_mask == 0
                for layer in self.head.layers:
                    h = layer(h, src_key_padding_mask=pad)
            idx = marker_pos.clamp(min=0)[:, :, None].expand(-1, -1, h.size(-1))
            logits = self.scorer(torch.gather(h, 1, idx)).squeeze(-1).float().masked_fill(~marker_mask, -1e4)
            p = torch.softmax(logits, -1)
            k = marker_mask.sum(-1).clamp(min=2).float()
            ent = -(p * torch.log(p.clamp_min(1e-9))).sum(-1) / torch.log(k)
            top2 = p.topk(2, -1).values
            feats = torch.stack([top2[:, 0], top2[:, 0] - top2[:, 1], ent, k / 255.0], -1)
            return logits, self.act_head(torch.cat([h[:, 0].float(), feats], -1))

    enc, head = EncoderOnly(model).eval(), HeadOnly(model).eval()

    def dummies(batch, length):
        ids = torch.ones(batch, length, dtype=torch.long)
        att = torch.ones(batch, length, dtype=torch.long)
        pos = torch.tensor([[1, 2]] * batch, dtype=torch.long)
        mask = torch.tensor([[True, True]] * batch)
        qt = torch.tensor([[2]] * batch, dtype=torch.long)
        with torch.inference_mode():
            hidden = enc(ids, att)
            logits, act = head(hidden, pos, mask, qt, att)
        return (ids, att), (hidden, pos, mask, qt, att), logits, act

    os.makedirs(out, exist_ok=True)
    enc_path, head_path = os.path.join(out, "encoder.onnx"), os.path.join(out, "head.onnx")
    # Batch 2 dummies: tracing at batch 1 lets dynamo bake batch=1 into a head reshape. Dim.DYNAMIC (not
    # a fixed range) because ModernBERT's trace adds a `batch != 1` guard that a min=1 range rejects; the
    # batch-1 check below confirms the graph still runs there.
    B = S = K = torch.export.Dim.DYNAMIC
    enc_in, head_in, _, _ = dummies(2, seq)
    torch.onnx.export(enc, enc_in, enc_path, input_names=["input_ids", "attention_mask"],
                      output_names=["last_hidden_state"], dynamic_shapes=({0: B, 1: S}, {0: B, 1: S}),
                      opset_version=18, external_data=False)
    torch.onnx.export(head, head_in, head_path,
                      input_names=["hidden_states", "marker_pos", "marker_mask", "qtype", "attention_mask"],
                      output_names=["logits", "act_logits"],
                      dynamic_shapes=({0: B, 1: S}, {0: B, 1: K}, {0: B, 1: K}, {0: B}, {0: B, 1: S}),
                      opset_version=18, external_data=False)

    # torch vs onnxruntime at batch 1 and 2, short and past ModernBERT's 128-token sliding window.
    e_sess = ort.InferenceSession(enc_path, providers=["CPUExecutionProvider"])
    h_sess = ort.InferenceSession(head_path, providers=["CPUExecutionProvider"])
    worst = 0.0
    for batch, length in ((1, seq), (2, seq), (2, verify_len)):
        (ids, att), (_, pos, mask, qt, _), ref_logits, ref_act = dummies(batch, length)
        (hidden,) = e_sess.run(None, {"input_ids": ids.numpy(), "attention_mask": att.numpy()})
        logits, act = h_sess.run(None, {"hidden_states": hidden, "marker_pos": pos.numpy(), "marker_mask": mask.numpy(),
                                        "qtype": qt.numpy(), "attention_mask": att.numpy()})
        sm = lambda x: np.exp(x - x.max(-1, keepdims=True)) / np.exp(x - x.max(-1, keepdims=True)).sum(-1, keepdims=True)
        diff = max(float(np.abs(sm(logits) - sm(ref_logits.numpy())).max()), float(np.abs(sm(act) - sm(ref_act.numpy())).max()))
        if diff > 1e-3:
            raise RuntimeError(f"onnx export verification failed at batch {batch} len {length}: prob diff {diff:.2e}")
        worst = max(worst, diff)

    shutil.copy(os.path.join(src, "rl_agent_config.json"), os.path.join(out, "rl_agent_config.json"))
    tok = os.path.join(src, "tokenizer.json")
    shutil.copy(tok if os.path.exists(tok) else os.path.join(src, "tokenizer", "tokenizer.json"), os.path.join(out, "tokenizer.json"))
    report_path = os.path.join(src, "gold_report.json")
    report = json.load(open(report_path)) if os.path.exists(report_path) else {}
    thresholds = report.get("thresholds", {})
    rules = sorted(set(thresholds) | set(report.get("per_rule", {})) or _questions(cfg.get("rules_dir", "")))
    with open(os.path.join(out, "supacheck.json"), "w") as f:
        json.dump({"rules": rules, "thresholds": {r: thresholds.get(r, 0.5) for r in rules}}, f, indent=2)
    sizes = {n: os.path.getsize(os.path.join(out, n)) for n in sorted(os.listdir(out))}
    return json.dumps({"out_dir": out, "max_prob_diff": worst, "rules": len(rules), "sizes": sizes})
