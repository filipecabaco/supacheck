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
                                "gold": {r["rule"]: {"false": 1 - float(target), "true": float(target)}}}) + "\n")
            n += 1
    return json.dumps({"rows": n, "path": out})


def finetune(cfg):
    from laya.train import TrainConfig, finetune as laya_finetune

    cfg = _cfg(cfg)
    tc = TrainConfig(
        epochs=int(cfg.get("epochs", 3)), micro_batch=int(cfg.get("micro_batch", 4)), grad_accum=int(cfg.get("grad_accum", 8)),
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
