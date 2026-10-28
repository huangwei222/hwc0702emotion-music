/**
 * tune.js —— 参数网格实验：用 12 首标注曲目挑选
 *  ① 色度提取参数（频段 / 压缩 / 是否只取局部峰）→ 调式判定准确率
 *  ② 测速参数（自相关谐波加权 / 节奏先验）→ BPM 相对误差
 * 运行：node tools/tune.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { FFT, hannWindow, toMono, resample } from '../js/dsp.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ANA_SR = 11025, FRAME = 2048, HOP = 512, ENV_RATE = ANA_SR / HOP;

function decodeWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const chans = [];
  for (let c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) chans[c][i] = data.readInt16LE((i * fmt.channels + c) * bytes) / 32768;
  return { channels: chans, sampleRate: fmt.rate };
}

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const pearson = (a, b) => {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / (Math.sqrt(da * db) + 1e-12);
};

// ---------------- 预计算每首曲目的幅度谱帧 ----------------
const tracks = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs', 'tracks.json'), 'utf8'));
const fft = new FFT(FRAME);
const win = hannWindow(FRAME);
const binHz = ANA_SR / FRAME;

function prep(t) {
  const wav = decodeWav(fs.readFileSync(path.join(ROOT, t.file)));
  const x = resample(toMono(wav.channels), wav.sampleRate, ANA_SR);
  const half = FRAME / 2;
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const mags = [];
  const flux = [];
  let prev = new Float32Array(half);
  for (let start = 0; start + FRAME <= x.length; start += HOP) {
    for (let i = 0; i < FRAME; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    const mag = new Float32Array(half);
    let f = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const d = m - prev[k];
      if (d > 0) f += d;
    }
    prev = mag;
    mags.push(mag);
    flux.push(f);
  }
  return { mags, flux, dur: x.length / ANA_SR };
}

const prepared = tracks.map((t) => ({ t, ...prep(t) }));
console.log('frames/曲:', prepared[0].mags.length);

// ---------------- 色度变体 ----------------
function chromaOf(mags, { lo, hi, compress, peaksOnly }) {
  const ch = new Float64Array(12);
  for (const mag of mags) {
    let frameMax = 0;
    for (let k = 1; k < mag.length; k++) frameMax = Math.max(frameMax, mag[k]);
    for (let k = 2; k < mag.length - 1; k++) {
      const f = k * binHz;
      if (f < lo || f > hi) continue;
      let m = mag[k];
      if (m <= frameMax * 0.06) continue;
      if (peaksOnly && !(m >= mag[k - 1] && m >= mag[k + 1])) continue;
      if (compress) m = Math.log1p(m * 60);
      const pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
      ch[pc] += m;
    }
  }
  return ch;
}

const chromaVariants = [
  { name: 'A 80-3000 全bin 线性', lo: 80, hi: 3000, compress: false, peaksOnly: false },
  { name: 'B 180-1800 全bin 线性', lo: 180, hi: 1800, compress: false, peaksOnly: false },
  { name: 'C 180-1800 局部峰 线性', lo: 180, hi: 1800, compress: false, peaksOnly: true },
  { name: 'D 180-1800 局部峰 log', lo: 180, hi: 1800, compress: true, peaksOnly: true },
  { name: 'E 120-2000 局部峰 log', lo: 120, hi: 2000, compress: true, peaksOnly: true },
  { name: 'F 200-1600 局部峰 log', lo: 200, hi: 1600, compress: true, peaksOnly: true },
];

console.log('\n=== 调式判定实验 ===');
for (const v of chromaVariants) {
  let ok = 0;
  const detail = [];
  for (const p of prepared) {
    const ch = chromaOf(p.mags, v);
    let bm = -2, bn = -2, km = 0, kn = 0;
    for (let r = 0; r < 12; r++) {
      const rot = [];
      for (let i = 0; i < 12; i++) rot.push(ch[(i + r) % 12]);
      const cm = pearson(rot, KK_MAJOR), cn = pearson(rot, KK_MINOR);
      if (cm > bm) { bm = cm; km = r; }
      if (cn > bn) { bn = cn; kn = r; }
    }
    const major = bm > bn;
    const good = (major ? 'major' : 'minor') === p.t.truth.mode;
    if (good) ok++;
    detail.push(`${p.t.id}:${major ? 'M' : 'm'}${good ? '' : '✗'}(${(bm - bn).toFixed(2)})`);
  }
  console.log(`${v.name.padEnd(22)} 准确率 ${ok}/12  ${detail.join(' ')}`);
}

// ---------------- 测速变体 ----------------
function onsetEnv(flux, w = 9, k = 1.15) {
  const n = flux.length, acc = new Float64Array(n), env = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += flux[i];
    if (i >= w) s -= flux[i - w];
    const lm = s / Math.min(i + 1, w);
    env[i] = Math.max(0, flux[i] - lm * k);
  }
  const mx = Math.max(...env, 1e-9);
  for (let i = 0; i < n; i++) env[i] /= mx;
  return env;
}

function tempoOf(env, { harm2, harm3, priorCenter, priorSigma }) {
  const minLag = Math.max(2, Math.floor((60 * ENV_RATE) / 190));
  const maxLag = Math.min(env.length - 2, Math.ceil((60 * ENV_RATE) / 55));
  const acf = new Float64Array(maxLag + 2);
  let e0 = 0;
  for (let i = 0; i < env.length; i++) e0 += env[i] * env[i];
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    acf[lag] = s / (e0 + 1e-9);
  }
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sc = acf[lag];
    if (harm2 && lag * 2 <= maxLag) sc += harm2 * acf[lag * 2];
    if (harm3 && lag * 3 <= maxLag) sc += harm3 * acf[lag * 3];
    const bpm = (60 * ENV_RATE) / lag;
    sc *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorCenter) / priorSigma, 2));
    if (sc > best) { best = sc; bestLag = lag; }
  }
  let bpm = (60 * ENV_RATE) / bestLag;
  while (bpm < 55) bpm *= 2;
  while (bpm > 190) bpm /= 2;
  return bpm;
}

const tempoVariants = [
  { name: 'T1 现状 h2=.55 h3=.25 σ.82@112', harm2: 0.55, harm3: 0.25, priorCenter: 112, priorSigma: 0.82 },
  { name: 'T2 纯ACF σ1.0@112', harm2: 0, harm3: 0, priorCenter: 112, priorSigma: 1.0 },
  { name: 'T3 纯ACF σ1.2@105', harm2: 0, harm3: 0, priorCenter: 105, priorSigma: 1.2 },
  { name: 'T4 h2=.35 σ1.1@105', harm2: 0.35, harm3: 0, priorCenter: 105, priorSigma: 1.1 },
  { name: 'T5 h2=.25 h3=.15 σ1.2@100', harm2: 0.25, harm3: 0.15, priorCenter: 100, priorSigma: 1.2 },
  { name: 'T6 纯ACF 无先验', harm2: 0, harm3: 0, priorCenter: 112, priorSigma: 99 },
];

console.log('\n=== 测速实验 ===');
for (const v of tempoVariants) {
  const errs = [];
  const det = [];
  for (const p of prepared) {
    const env = onsetEnv(p.flux);
    const bpm = tempoOf(env, v);
    const e = Math.abs(bpm - p.t.truth.bpm) / p.t.truth.bpm;
    errs.push(e);
    det.push(`${p.t.id}:${Math.round(bpm)}${e < 0.04 ? '' : '✗'}`);
  }
  const mape = (errs.reduce((a, b) => a + b, 0) / errs.length) * 100;
  console.log(`${v.name.padEnd(30)} MAPE ${mape.toFixed(1)}%  ${det.join(' ')}`);
}
