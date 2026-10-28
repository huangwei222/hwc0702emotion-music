/**
 * face-engine.js —— 本地人脸情绪识别引擎（不联网、不上传任何画面）
 *
 * 三级流水线（经典且高效）：
 *   ① 人脸检测：TinyFaceDetector —— 基于深度可分离卷积的轻量 SSD，
 *      在 416×416 输入上回归 anchor 偏移 + 置信度，再做 NMS。单帧 20-60ms。
 *   ② 68 点关键点：tiny landmark 回归网络，用于计算几何特征（AU 近似）。
 *   ③ 表情分类：FaceExpressionNet（mini-Xception，FER 数据集训练）输出 7 类 softmax。
 *
 * 两个后处理让结果"稳"：
 *   · 晚期融合（late fusion）：CNN 概率 0.78 + 几何规则 0.22，几何规则可纠正
 *     CNN 在侧脸/低光下的系统性偏移；
 *   · 时序平滑：指数滑动平均 EMA + 主导类滞回（hysteresis），避免标签抖动。
 */
import { EMOTION_KEYS, EMOTIONS, clamp01 } from './emotions.js';

const faceapi = () => window.faceapi;

const IDX = {
  jaw: [0, 16],
  browL: [17, 21], browR: [22, 26],
  eyeL: 36, eyeR: 42,
  mouthOuter: [48, 59], mouthInner: [60, 67],
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);

/** 由 68 点关键点计算可解释的几何特征（单位：相对人脸尺度） */
export function geometryFeatures(pos) {
  const p = pos;
  const interocular = dist(p[36], p[45]) + 1e-6;

  // 眼睛纵横比 EAR（Soukupová & Čech, 2016）
  const ear = (i) => (dist(p[i + 1], p[i + 5]) + dist(p[i + 2], p[i + 4])) / (2 * dist(p[i], p[i + 3]) + 1e-6);

  const browYL = avg([17, 18, 19, 20, 21].map((i) => p[i].y));
  const browYR = avg([22, 23, 24, 25, 26].map((i) => p[i].y));
  const eyeYL = avg([37, 38, 43, 44].map((i) => p[i].y));
  const eyeYR = avg([43, 44, 46, 47].map((i) => p[i].y));

  const mouthW = dist(p[48], p[54]);
  const mouthOpen = dist(p[62], p[66]);
  const lipCenterY = (p[51].y + p[57].y) / 2;
  const cornerY = (p[48].y + p[54].y) / 2;

  return {
    ear: (ear(36) + ear(42)) / 2,
    browHeight: ((eyeYL - browYL) + (eyeYR - browYR)) / 2 / interocular,
    innerBrowGap: dist(p[21], p[22]) / interocular,
    mouthWidth: mouthW / interocular,
    mouthOpen: mouthOpen / interocular,
    smile: (lipCenterY - cornerY) / interocular,   // >0：嘴角上扬
    interocular,
  };
}

/** 几何规则 → 7 类分数（可解释的"人工规则"，用于与 CNN 融合） */
export function geometryScores(g) {
  const smileN = clamp01((g.smile + 0.01) / 0.16);
  const openN = clamp01((g.mouthOpen - 0.05) / 0.45);
  const raiseN = clamp01((g.browHeight - 0.30) / 0.22);
  const knitN = clamp01((0.62 - g.innerBrowGap) / 0.28);
  const wideN = clamp01((g.ear - 0.26) / 0.16);
  const wideMouthN = clamp01((g.mouthWidth - 1.05) / 0.30);
  const pressN = clamp01(1 - openN * 1.2);

  const s = {
    happy: 0.62 * smileN + 0.24 * wideMouthN + 0.14 * (0.5 + 0.5 * openN),
    sad: 0.42 * (1 - smileN) * (1 - wideN) + 0.34 * raiseN * 0.6 + 0.24 * pressN * 0.8,
    angry: 0.52 * knitN + 0.28 * pressN + 0.20 * (1 - smileN) * knitN,
    surprised: 0.46 * raiseN + 0.32 * wideN + 0.22 * openN,
    fearful: 0.40 * raiseN + 0.30 * wideN + 0.30 * openN,
    disgusted: 0.50 * knitN + 0.28 * pressN + 0.22 * (1 - smileN),
    neutral: 0.55 * (1 - Math.max(smileN, raiseN, knitN, openN)),
  };
  // 归一化成概率分布
  let sum = 0;
  for (const k of EMOTION_KEYS) sum += s[k];
  const out = {};
  for (const k of EMOTION_KEYS) out[k] = s[k] / (sum || 1);
  return out;
}

export class FaceEmotionEngine {
  constructor(opts = {}) {
    this.inputSize = opts.inputSize || 416;
    this.scoreThreshold = opts.scoreThreshold || 0.35;
    this.cnnWeight = opts.cnnWeight ?? 0.78;     // 晚期融合权重
    this.emaAlpha = opts.emaAlpha ?? 0.55;       // 时序平滑系数
    this.ready = false;
    this.backend = 'unknown';
    this.smoothed = null;
    this.stableLabel = null;
    this._missStreak = 0;
    this.inferMs = 0;
  }

  async init(modelPath = 'models') {
    const fa = faceapi();
    if (!fa) throw new Error('face-api.js 未加载');
    try {
      if (fa.tf && fa.tf.setBackend) {
        await fa.tf.setBackend('webgl');
        await fa.tf.ready();
        this.backend = fa.tf.getBackend();
      }
    } catch (e) {
      this.backend = 'cpu';
    }
    // 没有 WebGL 时（老显卡 / 虚拟机 / 无头环境）降到 320，避免单帧上百毫秒以上
    // CPU 后端阈值保持 0.4：试过 0.35，能把最后一张演示脸也检出，
    // 但那张会被高置信度错判成"开心"——比明确说"未检出"更伤可信度，故不放宽。
    if (this.backend !== 'webgl') { this.inputSize = Math.min(this.inputSize, 224); this.scoreThreshold = 0.4; }
    await fa.nets.tinyFaceDetector.loadFromUri(modelPath);
    await fa.nets.faceLandmark68TinyNet.loadFromUri(modelPath);
    await fa.nets.faceExpressionNet.loadFromUri(modelPath);
    this.options = new fa.TinyFaceDetectorOptions({
      inputSize: this.inputSize,
      scoreThreshold: this.scoreThreshold,
    });
    this.ready = true;
    return this;
  }

  /**
   * 可用识别档位（已按算力上限裁剪）
   * CPU 后端跑 416 会让单帧飙到秒级，所以上限压到 320；WebGL 才放开 416。
   */
  qualityOptions() {
    // 两套参数而不是"统一裁剪"，否则 CPU 上 high 与 balanced 会撞成同一个尺寸，档位形同虚设
    return this.backend === 'webgl'
      ? [
        { key: 'high', cn: '高精度', size: 416 },
        { key: 'balanced', cn: '均衡', size: 320 },
        { key: 'fast', cn: '快速', size: 224 },
      ]
      : [
        { key: 'high', cn: '高精度', size: 320 },
        { key: 'balanced', cn: '均衡', size: 256 },
        { key: 'fast', cn: '快速', size: 192 },
      ];
  }

  /**
   * 切换识别档位：只改检测输入尺寸，模型权重与融合参数不动。
   * 尺寸一变，之前的 EMA 平滑状态就不可比了，必须清空重新收敛。
   */
  setQuality(key) {
    const opts = this.qualityOptions();
    const opt = opts.find((o) => o.key === key) || opts[1];
    this.inputSize = opt.size;
    this.quality = opt.key;
    this.reset();
    if (this.ready) {
      const fa = faceapi();
      this.options = new fa.TinyFaceDetectorOptions({
        inputSize: this.inputSize,
        scoreThreshold: this.scoreThreshold,
      });
    }
    return opt;
  }

  reset() {
    this.smoothed = null;    this.stableLabel = null;
    this._missStreak = 0;
  }

  /**
   * 单帧识别
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} input
   * @param {{smooth?:boolean}} opts smooth=false 时按静态图片处理（不做 EMA）
   */
  async detect(input, opts = {}) {
    const fa = faceapi();
    const smooth = opts.smooth !== false;
    const t0 = performance.now();
    const res = await fa
      .detectSingleFace(input, this.options)
      .withFaceLandmarks(true)
      .withFaceExpressions();
    this.inferMs = performance.now() - t0;

    if (!res) {
      this._missStreak++;
      if (this._missStreak > 2) this.reset();
      return { found: false, ms: this.inferMs };
    }
    this._missStreak = 0;

    const cnn = {};
    for (const k of EMOTION_KEYS) cnn[k] = res.expressions[k] || 0;

    const geo = geometryFeatures(res.landmarks.positions);
    const geoProb = geometryScores(geo);

    // 晚期融合
    const fused = {};
    let sum = 0;
    for (const k of EMOTION_KEYS) {
      fused[k] = this.cnnWeight * cnn[k] + (1 - this.cnnWeight) * geoProb[k];
      sum += fused[k];
    }
    for (const k of EMOTION_KEYS) fused[k] /= sum || 1;

    // 时序平滑
    if (!smooth || !this.smoothed) {
      this.smoothed = { ...fused };
    } else {
      const a = this.emaAlpha;
      const next = {};
      let s2 = 0;
      for (const k of EMOTION_KEYS) {
        next[k] = a * fused[k] + (1 - a) * this.smoothed[k];
        s2 += next[k];
      }
      for (const k of EMOTION_KEYS) next[k] /= s2 || 1;
      this.smoothed = next;
    }

    // 主导类 + 滞回（新类需超过当前类 0.10 才切换）
    let top = EMOTION_KEYS[0];
    for (const k of EMOTION_KEYS) if (this.smoothed[k] > this.smoothed[top]) top = k;
    if (!this.stableLabel) this.stableLabel = top;
    else if (top !== this.stableLabel && this.smoothed[top] > this.smoothed[this.stableLabel] + 0.10) {
      this.stableLabel = top;
    }

    const box = res.detection.box;
    return {
      found: true,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      landmarks: res.landmarks.positions.map((p) => ({ x: p.x, y: p.y })),
      score: res.detection.score,
      cnn,
      geo,
      geoProb,
      fused,
      probs: this.smoothed,
      label: this.stableLabel,
      confidence: this.smoothed[this.stableLabel],
      ms: this.inferMs,
      naturalWidth: input.videoWidth || input.naturalWidth || input.width,
      naturalHeight: input.videoHeight || input.naturalHeight || input.height,
    };
  }
}

export { EMOTIONS, EMOTION_KEYS };
