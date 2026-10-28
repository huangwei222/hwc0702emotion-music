# -*- coding: utf-8 -*-
"""
calibrate.py —— 用 12 首标注曲目的特征做非负最小二乘（NNLS），
标定「音乐特征 → 二维情绪坐标 (Valence, Arousal)」的线性权重。

约束：系数非负（除 bias），保证映射方向符合音乐心理学先验——
速度越快 / 越亮 / 越响 / 起音越密 → 唤醒度越高；大调性越强 → 效价越高。
输出可直接粘贴到 js/music-engine.js 的 VA_MODEL。
"""
import json
import os

import numpy as np
from scipy.optimize import nnls

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = json.load(open(os.path.join(ROOT, "tools", "features.json"), encoding="utf-8"))

KEYS = ["bpmN", "brightN", "energyN", "onsetN", "modeN", "tonalityN", "highN"]
X = np.array([[1.0] + [d["features"][k] for k in KEYS] for d in data])
VA = np.array([d["truthVa"] for d in data])


def fit(col):
    y = VA[:, col]
    # 对特征取非负约束；bias 允许为负（用中心化技巧实现）
    w, _ = nnls(X[:, 1:], y)
    bias = float(np.mean(y - X[:, 1:] @ w))
    pred = X[:, 1:] @ w + bias
    ss_res = float(np.sum((y - pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1 - ss_res / ss_tot
    return bias, w, pred, r2


for name, col in (("arousal", 1), ("valence", 0)):
    bias, w, pred, r2 = fit(col)
    print(f"\n=== {name}  R2={r2:.3f}  bias={bias:+.3f}")
    print("  " + "  ".join(f"{k}={v:.3f}" for k, v in zip(KEYS, w)))
    print("  " + "  ".join(f"{d['id']}:{p:.2f}/{t:.2f}" for d, p, t in zip(data, pred, VA[:, col])))
    # 输出可直接粘贴的对象字面量（保留两位小数）
    jb = {k: round(float(v), 3) for k, v in zip(KEYS, w)}
    print("  JS: { bias: %.3f, %s }" % (bias, ", ".join(f"{k[:-1]}... " for k in [])) if False else "")
    print("  JS: { bias: %.3f, bpm: %.3f, bright: %.3f, energy: %.3f, onset: %.3f, mode: %.3f, tonality: %.3f, high: %.3f }"
          % (bias, jb["bpmN"], jb["brightN"], jb["energyN"], jb["onsetN"], jb["modeN"], jb["tonalityN"], jb["highN"]))
