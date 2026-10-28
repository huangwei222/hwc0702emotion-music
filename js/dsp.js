/**
 * dsp.js —— 轻量级信号处理工具
 * 只用纯 JS 实现（不依赖 Web Audio / DOM），因此既能在浏览器里跑，
 * 也能在 Node 里直接跑（便于离线标定与回归测试）。
 */

/** 汉宁窗（周期型），返回 Float32Array */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * 迭代式基-2 Cooley–Tukey FFT，复杂度 O(N log N)
 * 查表法预计算旋转因子与位反转表，单帧开销最小化。
 */
export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be power of 2');
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** 原地正变换，输入为实部数组 re 与虚部数组 im（长度 n） */
  forward(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tpre = re[l] * this.cos[k] + im[l] * this.sin[k];
          const tpim = -re[l] * this.sin[k] + im[l] * this.cos[k];
          re[l] = re[j] - tpre;
          im[l] = im[j] - tpim;
          re[j] += tpre;
          im[j] += tpim;
        }
      }
    }
  }
}

/** 多声道下混为单声道 */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  }
  return out;
}

/**
 * 线性插值重采样到目标采样率（分析用，11025Hz 足够覆盖 5.5kHz 以内特征，
 * 且把 FFT 计算量降到 44.1kHz 的 1/4）
 */
export function resample(samples, srcRate, dstRate) {
  if (srcRate === dstRate) return samples;
  const ratio = dstRate / srcRate;
  const n = Math.max(1, Math.floor(samples.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i / ratio;
    const i0 = pos | 0;
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const mean = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
};
