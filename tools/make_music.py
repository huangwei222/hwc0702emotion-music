# -*- coding: utf-8 -*-
"""
本地演示曲库生成器
------------------
用加法合成 + 噪声打击乐，生成若干首 BPM / 调式明确的短曲，
便于验证前端「旋律曲调情绪分析算法」（谱通量起音、自相关测速、
色度调式判定、谱质心亮度）是否算得准。

输出：songs/<id>.wav (22050Hz / 16bit / mono) + songs/tracks.json
"""
import json
import os
import wave

import numpy as np

SR = 22050
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "songs")

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]
PENTA = [0, 2, 4, 7, 9]

HARM_PRESETS = {
    # name: (harmonic amplitudes, detune layers)
    "lead": ([1.0, 0.42, 0.18, 0.09, 0.04], 1),
    "soft": ([1.0, 0.28, 0.10, 0.03], 1),
    "bell": ([1.0, 0.55, 0.30, 0.16, 0.10, 0.06], 1),
    "pad": ([1.0, 0.55, 0.38, 0.26, 0.18, 0.13, 0.09, 0.06], 3),
    "dist": ([1.0, 0.80, 0.62, 0.50, 0.40, 0.32, 0.26, 0.21, 0.17], 2),
    "bass": ([1.0, 0.30, 0.10], 1),
}


def midi2freq(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def env(n, a=0.01, d=0.12, s=0.65, r=0.25, sr=SR):
    """ADSR 包络（样本级），a/d/r 单位为秒。"""
    a_n = max(1, int(a * sr))
    d_n = max(1, int(d * sr))
    r_n = max(1, int(r * sr))
    s_n = max(0, n - a_n - d_n - r_n)
    if a_n + d_n + r_n > n:                      # 短音符按比例压缩
        k = n / float(a_n + d_n + r_n)
        a_n, d_n, r_n = int(a_n * k), int(d_n * k), int(r_n * k)
        s_n = 0
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(s_n, s),
        np.linspace(s, 0, r_n),
    ])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)))
    return e[:n]


def tone(freq, dur, kind="lead", amp=1.0, sr=SR, vib=0.0, bright=1.0):
    """加法合成单音。bright 越小高频泛音越弱（越暗）。"""
    n = max(2, int(dur * sr))
    t = np.arange(n) / sr
    harms, layers = HARM_PRESETS.get(kind, HARM_PRESETS["lead"])
    if vib > 0:
        f_inst = freq * (1.0 + vib * np.sin(2 * np.pi * 5.2 * t))
        phase = 2 * np.pi * np.cumsum(f_inst) / sr
    else:
        phase = 2 * np.pi * freq * t
    out = np.zeros(n)
    for li in range(layers):
        det = 1.0 if layers == 1 else 1.0 + (li - (layers - 1) / 2.0) * 0.0035
        for hi, ha in enumerate(harms, start=1):
            g = ha * (bright ** (hi - 1))
            if g < 0.004:
                continue
            out += g * np.sin(phase * hi * det + li * 0.7)
    out /= max(1.0, layers * sum(harms[:4]))
    out *= env(n, a=0.012 if kind != "pad" else 0.30,
               d=0.10 if kind != "pad" else 0.5,
               s=0.70 if kind != "pad" else 0.85,
               r=min(0.35, dur * 0.45))
    return out * amp


def add(buf, sig, start):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def kick(dur=0.32, amp=0.95):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 45 + 105 * np.exp(-t * 26)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)
    click = np.random.default_rng(1).normal(0, 0.25, n) * np.exp(-t * 190)
    return (body * 0.95 + click * 0.35) * amp


def snare(dur=0.22, amp=0.55, seed=2):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.random.default_rng(seed).normal(0, 1, n)
    noise = noise - 0.85 * np.roll(noise, 1)            # 一阶高通，噪声更"沙"
    body = np.sin(2 * np.pi * 185 * t) * 0.4
    return (noise * np.exp(-t * 26) * 0.7 + body * np.exp(-t * 34)) * amp


def hat(dur=0.07, amp=0.22, seed=3):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.random.default_rng(seed).normal(0, 1, n)
    noise = noise - 0.92 * np.roll(noise, 1)
    return noise * np.exp(-t * 95) * amp


def reverb(x, taps=((0.091, 0.24), (0.173, 0.17), (0.257, 0.11))):
    """廉价多抽头反馈延迟，模拟空间感。O(N)。"""
    y = x.copy()
    for delay, g in taps:
        d = int(delay * SR)
        y[d:] += g * x[:-d]
    return y


def build(cfg):
    rng = np.random.default_rng(cfg["seed"])
    bpm = cfg["bpm"]
    beat = 60.0 / bpm
    bar = 4 * beat
    bars = cfg["bars"]
    total = int(bars * bar * SR) + SR // 2
    buf = np.zeros(total)

    key = cfg["key"]
    prog = cfg["prog"]                       # [(根偏移, 三音, 五音), ...] 每小节一个和弦
    scale = cfg["scale"]
    style = cfg["style"]

    # 1) Pad / 和弦垫
    for b in range(bars):
        tri = prog[b % len(prog)]
        chord_midi = [key + tri[0], key + tri[1], key + tri[2]]
        dur = bar * 0.98
        for ci, m in enumerate(chord_midi):
            sig = tone(midi2freq(m), dur, "pad", amp=cfg["pad_amp"] / 3.0,
                       bright=cfg["bright"], vib=0.001)
            add(buf, sig, b * bar + ci * 0.004)

    # 2) Bass
    if cfg["bass_amp"] > 0:
        for b in range(bars):
            root = key + prog[b % len(prog)][0] - 12
            patt = [0.0, 1.0, 2.0, 3.0] if style in ("pop", "dance", "rock") else [0.0, 2.5]
            for pos in patt:
                d = beat * (0.85 if style in ("pop", "dance", "rock") else 1.6)
                add(buf, tone(midi2freq(root), d, "bass",
                              amp=cfg["bass_amp"], bright=0.8), b * bar + pos * beat)

    # 3) 主旋律（每两小节一句，音符取自音阶 / 和弦音）
    if cfg["lead_amp"] > 0:
        rhythm_pool = cfg["rhythm"]
        oct_base = 12
        for b in range(0, bars, 2):
            t0 = b * bar
            steps = rhythm_pool[b // 2 % len(rhythm_pool)]
            for dur_beats, deg in steps:
                if deg is None:
                    t0 += dur_beats * beat
                    continue
                m = key + oct_base + (scale[deg % len(scale)] + 12 * (deg // len(scale)))
                jitter = rng.integers(-1, 2) if cfg["jitter"] else 0
                add(buf, tone(midi2freq(m + jitter * 0), max(0.09, dur_beats * beat * 0.94),
                              cfg["lead_kind"], amp=cfg["lead_amp"],
                              bright=cfg["bright"], vib=cfg["vib"]),
                    t0 + jitter * 0.006)
                t0 += dur_beats * beat
            if t0 < (b + 2) * bar:
                pass

    # 4) 打击乐
    pat = cfg["drums"]      # dict: kick/snare/hat 的 16 分格字符串（X 强 / x 中 / o 轻）
    if pat:
        for b in range(bars):
            for step, ch in enumerate(pat.get("kick", "")):
                if ch in "xXo":
                    amp = {"X": 0.9, "x": 0.62, "o": 0.3}[ch]
                    add(buf, kick(amp=amp), b * bar + step * beat / 4)
            for step, ch in enumerate(pat.get("snare", "")):
                if ch in "xXo":
                    amp = {"X": 0.5, "x": 0.3, "o": 0.15}[ch]
                    add(buf, snare(amp=amp, seed=step + b), b * bar + step * beat / 4)
            for step, ch in enumerate(pat.get("hat", "")):
                if ch in "xXo":
                    amp = {"X": 0.26, "x": 0.13, "o": 0.07}[ch]
                    add(buf, hat(amp=amp, seed=step + 7 * b), b * bar + step * beat / 4)

    # 5) 母带：混响 -> 软削波 -> 归一化 -> 淡入淡出
    y = reverb(buf)
    y = np.tanh(y * cfg["drive"]) / np.tanh(cfg["drive"])
    peak = np.max(np.abs(y)) or 1.0
    y = y / peak * 0.89
    fade = int(0.02 * SR)
    y[:fade] *= np.linspace(0, 1, fade)
    tail = int(0.6 * SR)
    y[-tail:] *= np.linspace(1, 0, tail)
    return y


def write_wav(path, y):
    data = np.clip(y, -1, 1)
    pcm = (data * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- 曲目配置
D_POP = {"kick": "X.......x.......", "snare": "....X.......X...", "hat": "..x...x...x...x."}
D_DANCE = {"kick": "X...X...X...X...", "snare": "....X.......X...", "hat": "x.x.x.x.x.x.x.x."}
D_ROCK = {"kick": "X..x..X.x..x....", "snare": "....X.......X...", "hat": "x.x.x.x.x.x.x.x."}
D_SOFT = {"kick": "X...............", "snare": "", "hat": "................"}
D_PULSE = {"kick": "o...o...o...o...", "snare": "", "hat": ""}          # 每拍一次轻脉冲，给慢歌一个可检测的脉搏
D_LOFI = {"kick": "o...o...o...o...", "snare": "........o.......", "hat": "....o.......o..."}
D_DARK = {"kick": "o...o...o...o...", "snare": "........o.......", "hat": ""}


def T(track_id, title, bpm, key, scale, prog, style, drums, lead_kind,
      lead_amp, pad_amp, bass_amp, bright, drive, rhythm, emo, va, genre, tags, seed):
    return dict(id=track_id, title=title, bpm=bpm, key=key, scale=scale, prog=prog,
                style=style, drums=drums, lead_kind=lead_kind, lead_amp=lead_amp,
                pad_amp=pad_amp, bass_amp=bass_amp, bright=bright, drive=drive,
                rhythm=rhythm, bars=12, seed=seed, emo=emo, va=va, genre=genre, tags=tags,
                vib=0.0025, jitter=0)


R_HAPPY = [
    [(0.5, 0), (0.5, 2), (1.0, 4), (1.0, 2), (1.0, 4)],
    [(0.5, 4), (0.5, 5), (1.0, 7), (1.0, 5), (1.0, 4)],
    [(0.5, 2), (0.5, 4), (0.5, 5), (0.5, 4), (1.0, 2), (1.0, 0)],
]
R_SAD = [
    [(1.5, 0), (0.5, 2), (2.0, 4)],
    [(1.0, 4), (1.0, 2), (2.0, 0)],
    [(2.0, 2), (2.0, 0)],
]
R_ANGRY = [
    [(0.25, 0), (0.25, 0), (0.5, 3), (1.0, 4), (1.0, 3), (1.0, 0)],
    [(0.25, 4), (0.25, 3), (0.5, 4), (1.0, 5), (1.0, 4), (1.0, 2)],
]
R_CALM = [
    [(2.0, 0), (2.0, 2)],
    [(2.0, 4), (2.0, 2)],
]
R_ODD = [
    [(0.5, 0), (0.25, 1), (0.25, 0), (1.0, 3), (1.0, 1), (1.0, 5)],
    [(0.25, 5), (0.75, 4), (1.0, 1), (2.0, 6)],
]

TRACKS = [
    T("t01", "晨光 Sunrise Pop", 124, 60, MAJOR, [(0, 4, 7), (5, 9, 12), (9, 12, 16), (7, 11, 14)],
      "pop", D_POP, "lead", 0.55, 0.30, 0.55, 0.86, 1.2, R_HAPPY,
      "happy", [0.88, 0.78], "Pop", ["明亮", "大调", "轻快"], 11),
    T("t02", "跃动脉冲 Dance Pulse", 128, 67, MAJOR, [(0, 4, 7), (7, 11, 14), (9, 12, 16), (5, 9, 12)],
      "dance", D_DANCE, "lead", 0.52, 0.34, 0.60, 0.94, 1.6, R_HAPPY,
      "happy", [0.85, 0.93], "EDM", ["四踩", "大调", "高能"], 12),
    T("t03", "雨窗 Rain Window", 66, 57, MINOR, [(0, 3, 7), (8, 12, 15), (5, 8, 12), (10, 14, 17)],
      "soft", D_LOFI, "soft", 0.30, 0.34, 0.36, 0.42, 1.0, R_SAD,
      "sad", [0.16, 0.24], "Lo-fi", ["小调", "慢速", "暗淡"], 13),
    T("t04", "空房间 Empty Room", 58, 50, MINOR, [(0, 3, 7), (5, 8, 12), (3, 7, 10), (0, 3, 7)],
      "soft", D_PULSE, "pad", 0.22, 0.36, 0.30, 0.30, 1.0, R_CALM,
      "sad", [0.10, 0.16], "Ambient", ["极慢", "小调", "空灵"], 14),
    T("t05", "铁怒 Iron Rage", 152, 52, MINOR, [(0, 3, 7), (0, 3, 7), (8, 12, 15), (10, 14, 17)],
      "rock", D_ROCK, "dist", 0.62, 0.32, 0.62, 0.98, 3.2, R_ANGRY,
      "angry", [0.14, 0.95], "Metal", ["失真", "快速", "强节奏"], 15),
    T("t06", "风暴驱动 Storm Drive", 144, 53, MINOR, [(0, 3, 7), (1, 5, 8), (0, 3, 7), (10, 14, 17)],
      "rock", D_ROCK, "dist", 0.58, 0.30, 0.60, 0.92, 2.8, R_ANGRY,
      "angry", [0.20, 0.88], "Rock", ["小调", "半音冲突", "高能"], 16),
    T("t07", "静电惊雷 Static Shock", 138, 61, MAJOR, [(0, 4, 7), (1, 5, 8), (2, 6, 9), (11, 15, 18)],
      "dance", D_DANCE, "bell", 0.55, 0.30, 0.52, 1.0, 2.0, R_ODD,
      "surprised", [0.50, 0.88], "Electro", ["离调", "跳跃", "尖锐"], 17),
    T("t08", "玻璃漂流 Glass Drift", 72, 65, MAJOR, [(0, 4, 7), (9, 12, 16), (5, 9, 12), (7, 11, 14)],
      "soft", D_PULSE, "bell", 0.34, 0.32, 0.26, 0.72, 1.0, R_CALM,
      "neutral", [0.55, 0.38], "Chill", ["中速", "大调", "通透"], 18),
    T("t09", "静湖 Still Lake", 64, 60, MAJOR, [(0, 4, 7), (5, 9, 12), (7, 11, 14), (0, 4, 7)],
      "soft", D_PULSE, "soft", 0.26, 0.38, 0.24, 0.40, 1.0, R_CALM,
      "neutral", [0.62, 0.20], "Ambient", ["慢速", "柔和", "低亮"], 19),
    T("t10", "夜行 Night Walk", 96, 59, MINOR, [(0, 3, 7), (1, 5, 8), (6, 9, 13), (0, 3, 7)],
      "soft", D_DARK, "pad", 0.34, 0.36, 0.42, 0.36, 1.2, R_ODD,
      "fearful", [0.22, 0.55], "Dark Ambient", ["三全音", "不稳定", "压迫"], 20),
    T("t11", "酸柠檬 Sour Lemon", 108, 64, PENTA, [(0, 3, 6), (0, 3, 6), (1, 4, 7), (0, 3, 6)],
      "pop", D_POP, "pluck" if False else "bell", 0.44, 0.30, 0.48, 0.80, 1.6, R_ODD,
      "disgusted", [0.26, 0.55], "Quirky", ["减和弦", "摩擦感", "怪诞"], 21),
    T("t12", "霓虹天空 Neon Sky", 118, 62, MAJOR, [(0, 4, 7), (5, 9, 12), (2, 5, 9), (7, 11, 14)],
      "pop", D_POP, "lead", 0.54, 0.32, 0.55, 0.90, 1.4, R_HAPPY,
      "happy", [0.80, 0.72], "Synthpop", ["明亮", "大调", "律动"], 22),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = []
    for cfg in TRACKS:
        y = build(cfg)
        path = os.path.join(OUT_DIR, cfg["id"] + ".wav")
        write_wav(path, y)
        meta.append({
            "id": cfg["id"],
            "title": cfg["title"],
            "artist": "Local Synth Lab",
            "file": "songs/%s.wav" % cfg["id"],
            "duration": round(len(y) / SR, 2),
            "sizeKB": round(os.path.getsize(path) / 1024),
            # 生成时已知的“真值”，用于校验前端分析结果
            "truth": {"bpm": cfg["bpm"], "mode": "major" if cfg["scale"] is MAJOR else "minor",
                      "emo": cfg["emo"], "va": cfg["va"]},
            "genre": cfg["genre"],
            "tags": cfg["tags"],
        })
        print("ok", cfg["id"], meta[-1]["duration"], "s", meta[-1]["sizeKB"], "KB")

    with open(os.path.join(OUT_DIR, "tracks.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("total tracks:", len(meta))


if __name__ == "__main__":
    main()
