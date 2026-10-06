"""Zero-shot typed-decision baselines (Laya checkpoints) on the same splits as the heads models."""
import glob
import json
import os
import random

import numpy as np
import yaml
from sklearn.metrics import average_precision_score

from heads import _cfg, _ece, read_jsonl


def _questions(rules_dir):
    out = {}
    for path in glob.glob(os.path.join(rules_dir, "*.yaml")):
        rule = yaml.safe_load(open(path))
        out[rule["id"]] = rule["question"]
    return out


def _summarise(items):
    by_rule = {}
    for rule, p, y in items:
        by_rule.setdefault(rule, []).append((p, y))
    report = {}
    for rule, xs in sorted(by_rule.items()):
        p = [a for a, _ in xs]
        y = [b for _, b in xs]
        entry = {"n": len(y), "pos": sum(y), "ece": _ece(p, y),
                 "acc@0.5": float(np.mean([(a >= 0.5) == b for a, b in xs]))}
        if len(set(y)) == 2:
            entry["auprc"] = float(average_precision_score(y, p))
        report[rule] = entry
    return report


def eval_laya(cfg):
    import laya

    cfg = _cfg(cfg)
    kwargs = {"subfolder": cfg["subfolder"]} if cfg.get("subfolder") else {}
    agent = laya.load(cfg.get("model", "convaiinnovations/laya"), **kwargs)
    questions = _questions(cfg["rules_dir"])

    test = read_jsonl(os.path.join(cfg["data_dir"], "test.jsonl"))
    random.seed(0)
    random.shuffle(test)
    test = test[: int(cfg.get("limit", 800))]

    def p_true(state, rule):
        ans = agent.predict(state, {rule: questions[rule]})["answers"][rule]
        return float(ans["noul"])

    synthetic = [(r["rule"], p_true(r["state"], r["rule"]), r["label"]) for r in test]
    report = {"model": cfg.get("model"), "subfolder": cfg.get("subfolder"), "test": _summarise(synthetic)}

    gold_path = cfg.get("gold_states")
    if gold_path and os.path.exists(gold_path):
        gold = [(r["rule"], p_true(r["state"], r["rule"]), r["label"]) for r in read_jsonl(gold_path)]
        tp = sum(1 for _, p, y in gold if p >= 0.5 and y == 1)
        fp = sum(1 for _, p, y in gold if p >= 0.5 and y == 0)
        fn = sum(1 for _, p, y in gold if p < 0.5 and y == 1)
        report["gold"] = {"n": len(gold), "tp": tp, "fp": fp, "fn": fn,
                          "precision": tp / (tp + fp) if tp + fp else None,
                          "recall": tp / (tp + fn) if tp + fn else None}
    return json.dumps(report)
