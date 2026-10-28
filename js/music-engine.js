/**
 * music-engine.js —— 旋律曲调情绪识别（纯本地，Web Audio + 自研 DSP）
 *
 * 处理链：
 *   解码音频 → 下混单声道 → 重采样 11025Hz
 *   → STFT(2048 点汉宁窗, hop 512) 逐帧提取
 *        · 谱通量 (spectral flux)  → 起音包络
 *        · 谱质心 (spectral centroid)/高低频能量比 → 音色明暗
 *        · 色度向量 (chroma) → 与 Krumhansl 大/小调轮廓做相关 → 调式
 *        · 帧 RMS → 响度
 *   → 起音包络自相关 (ACF) 估 BPM
 *   → 特征归一化 + 线性标定 → 二维情绪平面 (Valence 效价, Arousal 唤醒度)
 *
 * 全流程 O(N log N)（N 为采样点），一首 30s 曲目在现代机器上 < 300ms。
 */
import { FFT, hannWindow, toMono, resample, clamp } from './dsp.js';

const ANA_SR = 11025;      // 分析采样率
const FRAME = 2048;        // 帧长（约 186ms）
const HOP = 256;           // 帧移（约 23ms，包络 43Hz，足够分辨 190BPM 的拍）
const ENV_RATE = ANA_SR / HOP;   // 起音包络帧率 ≈ 21.5Hz

// Krumhansl-Kessler 调性轮廓
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * 线性标定系数：由 12 首"已知 BPM/调式/情绪"的标注曲目做最小二乘回归得到
 * （标定脚本 tools/calibrate.py，特征 → VA）。保证映射方向符合音乐心理学先验：
 * Arousal 随速度/亮度/响度上升，Valence 随大调性/亮度上升。
 */
export const VA_MODEL = {
  //    偏置    速度    亮度    响度    起音密度 调式    调性强度 高频占比
  arousal: { bias: 0.000, bpm: 0.780, bright: 0.030, energy: 0.230, onset: 0.150, mode: 0.080, tonality: 0.020, high: 0.020 },
  valence: { bias: -0.010, bpm: 0.020, bright: 0.390, energy: 0.020, onset: 0.090, mode: 0.670, tonality: 0.020, high: 0.020 },
};

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}

/**
 * 核心：从已解码的 PCM 计算音乐情绪特征
 * @param {Float32Array[]} channels 各声道样本
 * @param {number} sampleRate 原始采样率
 */
export function analyzeSamples(channels, sampleRate, debug = false) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const mono = toMono(channels);
  const x = resample(mono, sampleRate, ANA_SR);
  const duration = x.length / ANA_SR;

  const fft = new FFT(FRAME);
  const win = hannWindow(FRAME);
  const half = FRAME / 2;
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const prevMag = new Float32Array(half);
  const mag = new Float32Array(half);
  const binHz = ANA_SR / FRAME;

  const chroma = new Float64Array(12);
  const onset = [];
  let centroidSum = 0, frameCount = 0;
  let rmsSum = 0, rmsPeak = 0;
  let lowE = 0, midE = 0, highE = 0, totalE = 0;

  for (let start = 0; start + FRAME <= x.length; start += HOP) {
    for (let i = 0; i < FRAME; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);

    // 逐帧幅度谱（先求帧内最大值，便于做尺度无关的对数压缩）
    let frameMax = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      if (m > frameMax) frameMax = m;
    }
    if (frameMax < 1e-9) frameMax = 1e-9;

    let magSum = 0, num = 0, flux = 0, rms = 0;
    for (let k = 1; k < half; k++) {
      const m = mag[k];
      const f = k * binHz;
      magSum += m;
      num += f * m;
      // 对数压缩谱通量：抑制响度大的持续性声部（pad/bass），突出弱起音
      const lg = Math.log1p((99 * m) / frameMax);
      const d = lg - prevMag[k];
      if (d > 0) flux += d;
      prevMag[k] = lg;
      totalE += m * m;
      if (f < 250) lowE += m * m;
      else if (f < 2000) midE += m * m;
      else highE += m * m;
      // 色度：仅取 120–2000Hz 的谱局部峰（避免低频鼓点与高频齿音污染），并做对数压缩
      if (f >= 120 && f <= 2000 && m > frameMax * 0.06 &&
          k > 1 && k < half - 1 && m >= mag[k - 1] && m >= mag[k + 1]) {
        const pc = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
        chroma[pc] += Math.log1p(60 * m);
      }
    }
    for (let i = 0; i < FRAME; i += 8) {
      const s = x[start + i] * win[i];
      rms += s * s;
    }
    rms = Math.sqrt(rms / Math.ceil(FRAME / 8));
    rmsSum += rms; rmsPeak = Math.max(rmsPeak, rms);
    centroidSum += magSum > 1e-9 ? num / magSum : 0;
    onset.push(flux);
    frameCount++;
  }

  if (!frameCount) throw new Error('音频过短，无法分析');

  // ---------- 1. 起音包络：去均值 + 半波整流（局部自适应阈值） ----------
  const envFrames = onset.length;
  const fluxArr = Float64Array.from(onset);
  const env = new Float64Array(envFrames);
  const w = 9;                       // ~0.42s 滑动窗
  let acc = 0;
  for (let i = 0; i < envFrames; i++) {
    acc += fluxArr[i];
    if (i >= w) acc -= fluxArr[i - w];
    const localMean = acc / Math.min(i + 1, w);
    const v = fluxArr[i] - localMean * 1.15;
    env[i] = v > 0 ? v : 0;
  }
  const envMax = Math.max(...env, 1e-6);
  for (let i = 0; i < envFrames; i++) env[i] /= envMax;

  // ---------- 2. 自相关测速（经典 ACF + 谐波求和 + 节奏先验） ----------
  const minLag = Math.max(2, Math.floor((60 * ENV_RATE) / 190));
  const maxLag = Math.min(envFrames - 2, Math.ceil((60 * ENV_RATE) / 55));
  const acf = new Float64Array(maxLag + 1);
  let e0 = 0;
  for (let i = 0; i < envFrames; i++) e0 += env[i] * env[i];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < envFrames; i++) s += env[i] * env[i + lag];
    acf[lag] = s / (e0 + 1e-9);
  }
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sc = acf[lag];
    const bpm = (60 * ENV_RATE) / lag;
    // 节奏先验：人类音乐节拍中心在 110 BPM 附近（对数高斯）
    sc *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 112) / 0.9, 2));
    if (sc > bestScore) { bestScore = sc; bestLag = lag; }
  }
  // ---- 倍频消歧：重音模式常使自相关在"2 拍"处更强，若半周期也足够强，
  //      则把节奏层级上移到拍层级（人类拍手的层级）----
  // ---- 倍频消歧（octave disambiguation）----
  // 4/4 的重音模式（底鼓 1、3 拍，军鼓 2、4 拍）会让人误判为"2 拍一个周期"，
  // 于是自相关在主峰 L 处最强，真实拍层级在 L/2。判据：若 L/2 邻域仍存在
  // ≥33% 主峰强度的局部峰，说明细分层有稳定脉冲，把拍层级上移一级。
  let beatLag = bestLag;
  const halfLag = Math.round(beatLag / 2);
  if (halfLag >= minLag) {
    let hv = 0;
    for (let l = halfLag - 1; l <= halfLag + 1; l++) if (l >= minLag && l <= maxLag) hv = Math.max(hv, acf[l]);
    const halfBpm = (60 * ENV_RATE) / halfLag;
    if (hv >= 0.33 * acf[beatLag] && halfBpm <= 180) beatLag = halfLag;
  }
  // 抛物线插值细化 lag
  let lagRefined = beatLag;
  if (beatLag > minLag && beatLag < maxLag) {
    const y0 = acf[beatLag - 1], y1 = acf[beatLag], y2 = acf[beatLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) lagRefined = beatLag + (0.5 * (y0 - y2)) / denom;
  }
  let bpm = (60 * ENV_RATE) / lagRefined;
  while (bpm < 50) bpm *= 2;
  while (bpm > 190) bpm /= 2;
  const tempoConfidence = clamp(acf[beatLag] * 1.9, 0, 1);

  // ---------- 3. 起音密度（节奏密度 = 单位时间有效起音数） ----------
  let peaks = 0;
  const minGap = 2;
  for (let i = 1; i < envFrames - 1; i++) {
    if (env[i] > 0.28 && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      peaks++;
      i += minGap;
    }
  }
  const onsetDensity = peaks / Math.max(0.5, duration);

  // ---------- 4. 谱质心 / 频段能量 / 响度 ----------
  const centroid = centroidSum / frameCount;
  const rmsDb = 20 * Math.log10(rmsSum / frameCount + 1e-9);
  // 用峰值 RMS 估计动态范围（安静-爆发对比）
  const dynDb = 20 * Math.log10((rmsPeak + 1e-9) / (rmsSum / frameCount + 1e-9));
  const highRatio = highE / (totalE + 1e-12);
  const lowRatio = lowE / (totalE + 1e-12);

  // ---------- 5. 调式判定（色度 × Krumhansl 轮廓相关） ----------
  let bestMaj = -1, bestMin = -1, keyMaj = 0, keyMin = 0;
  for (let r = 0; r < 12; r++) {
    const rot = new Array(12);
    for (let i = 0; i < 12; i++) rot[i] = chroma[(i + r) % 12];
    const cMaj = pearson(rot, KK_MAJOR);
    const cMin = pearson(rot, KK_MINOR);
    if (cMaj > bestMaj) { bestMaj = cMaj; keyMaj = r; }
    if (cMin > bestMin) { bestMin = cMin; keyMin = r; }
  }
  const modeScore = bestMaj - bestMin;              // >0 偏大调
  const tonality = Math.max(bestMaj, bestMin);
  const isMajor = modeScore > 0;
  const keyName = KEY_NAMES[(isMajor ? keyMaj : keyMin) % 12] + (isMajor ? '' : 'm');

  // ---------- 6. 特征归一化（0-1） ----------
  const f = {
    bpmN: clamp((bpm - 56) / (158 - 56), 0, 1),
    brightN: clamp((centroid - 800) / (3200 - 800), 0, 1),
    energyN: clamp((rmsDb + 32) / 26, 0, 1),
    onsetN: clamp((onsetDensity - 0.6) / 4.0, 0, 1),
    modeN: clamp(0.5 + modeScore * 2.0, 0, 1),
    tonalityN: clamp(tonality, 0, 1),
    highN: clamp((highRatio - 0.02) / 0.35, 0, 1),
  };

  // ---------- 7. 线性标定 → VA 情绪坐标 ----------
  const A = VA_MODEL.arousal, V = VA_MODEL.valence;
  const arousal = clamp(
    A.bias + A.bpm * f.bpmN + A.bright * f.brightN + A.energy * f.energyN +
    A.onset * f.onsetN + A.high * f.highN + A.mode * f.modeN + A.tonality * f.tonalityN,
    0, 1);
  const valence = clamp(
    V.bias + V.bpm * f.bpmN + V.bright * f.brightN + V.energy * f.energyN +
    V.onset * f.onsetN + V.high * f.highN + V.mode * f.modeN + V.tonality * f.tonalityN,
    0, 1);

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  return {
    duration,
    raw: {
      bpm: Math.round(bpm * 10) / 10,
      tempoConfidence: +tempoConfidence.toFixed(3),
      onsetDensity: +onsetDensity.toFixed(2),
      centroidHz: Math.round(centroid),
      rmsDb: +rmsDb.toFixed(1),
      dynDb: +dynDb.toFixed(1),
      highRatio: +highRatio.toFixed(3),
      lowRatio: +lowRatio.toFixed(3),
      modeScore: +modeScore.toFixed(3),
      tonality: +tonality.toFixed(3),
      key: keyName,
      mode: isMajor ? 'major' : 'minor',
    },
    features: f,
    va: { valence, arousal },
    analyzeMs: Math.round(t1 - t0),
    debug: debug ? { acf: Array.from(acf), minLag, maxLag, bestLag, beatLag } : null,
  };
}

/**
 * 浏览器侧：抓取 + 解码 + 分析
 * @param {string} url 音频地址
 * @param {AudioContext} [ctx] 复用的音频上下文（批处理时可省掉反复创建的开销）
 */
export async function analyzeUrl(url, ctx, maxSeconds = 0) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('音频加载失败: ' + res.status);
  const buf = await res.arrayBuffer();
  const ac = ctx || new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await ac.decodeAudioData(buf);
    // 长曲目（用户上传的整首歌）只取前 maxSeconds 秒：统计量已足够稳定，
    // 但能把分析耗时从"随长度线性增长"压到常数级
    const limit = maxSeconds > 0
      ? Math.min(audioBuffer.length, Math.floor(maxSeconds * audioBuffer.sampleRate))
      : audioBuffer.length;
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c).subarray(0, limit));
    }
    const result = analyzeSamples(channels, audioBuffer.sampleRate);
    result.duration = audioBuffer.duration;          // 播放时长用整首的真实长度
    result.analyzedSeconds = limit / audioBuffer.sampleRate;
    return result;
  } finally {
    if (!ctx) ac.close();
  }
}

/** 批量分析专用：一个上下文复用到底 */
export function createAudioContext() {
  return new (window.AudioContext || window.webkitAudioContext)();
}
