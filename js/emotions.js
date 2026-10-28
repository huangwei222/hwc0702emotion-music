/**
 * emotions.js —— 情绪常量表与跨模块映射
 *
 * 情绪空间采用 Russell 环形模型（Circumplex Model）：
 *   Valence 效价（不愉快 0 → 愉快 1） × Arousal 唤醒度（平静 0 → 兴奋 1）
 * 人脸 7 类基本情绪（Ekman）与音乐情绪都投影到同一平面，才能做"以情荐曲"。
 */

export const EMOTIONS = {
  happy: {
    cn: '开心', emoji: '😄', color: '#f5a524',
    va: { valence: 0.86, arousal: 0.76 },
    quadrant: '高效价 · 高唤醒',
    feel: '愉悦、明亮、有活力',
    query: 'happy upbeat feel good',
  },
  sad: {
    cn: '悲伤', emoji: '😢', color: '#5b8def',
    va: { valence: 0.16, arousal: 0.24 },
    quadrant: '低效价 · 低唤醒',
    feel: '低落、缓慢、暗淡',
    query: 'sad melancholy piano',
  },
  angry: {
    cn: '愤怒', emoji: '😠', color: '#f2545b',
    va: { valence: 0.20, arousal: 0.88 },
    quadrant: '低效价 · 高唤醒',
    feel: '激烈、紧绷、冲击',
    query: 'aggressive intense rock',
  },
  surprised: {
    cn: '惊讶', emoji: '😲', color: '#a78bfa',
    va: { valence: 0.52, arousal: 0.90 },
    quadrant: '中性偏高效价 · 高唤醒',
    feel: '跳跃、意外、尖锐',
    query: 'surprise electronic experimental',
  },
  neutral: {
    cn: '平静', emoji: '😐', color: '#94a3b8',
    va: { valence: 0.56, arousal: 0.40 },
    quadrant: '中性 · 中低唤醒',
    feel: '安稳、通透、无攻击性',
    query: 'calm chill ambient',
  },
  fearful: {
    cn: '恐惧', emoji: '😨', color: '#14b8a6',
    va: { valence: 0.22, arousal: 0.72 },
    quadrant: '低效价 · 高唤醒',
    feel: '不安、悬疑、压迫',
    query: 'dark tense cinematic',
  },
  disgusted: {
    cn: '厌恶', emoji: '🤢', color: '#84cc16',
    va: { valence: 0.24, arousal: 0.56 },
    quadrant: '低效价 · 中高唤醒',
    feel: '怪诞、摩擦、不协和',
    query: 'quirky dissonant weird',
  },
};

/** face-api 输出顺序无关，这里固定展示与计算顺序 */
export const EMOTION_KEYS = ['happy', 'sad', 'angry', 'surprised', 'neutral', 'fearful', 'disgusted'];

/** 情绪调节（mood regulation）目标：把听者牵引到"舒适区" */
export const REGULATE_TARGET = {
  sad: { valence: 0.64, arousal: 0.46 },
  angry: { valence: 0.52, arousal: 0.30 },
  fearful: { valence: 0.58, arousal: 0.32 },
  disgusted: { valence: 0.60, arousal: 0.42 },
  surprised: { valence: 0.60, arousal: 0.52 },
  happy: { valence: 0.80, arousal: 0.60 },
  neutral: { valence: 0.60, arousal: 0.46 },
};

export const STRATEGIES = {
  mixed: { cn: '混合策略', desc: '70% 情绪共鸣 + 30% 情绪调节，兼顾"懂你"与"照顾你"' },
  congruent: { cn: '情绪共鸣', desc: '纯内容相似：找与你此刻情绪最接近的音乐（共情陪伴）' },
  regulate: { cn: '情绪调节', desc: '按音乐治疗 MOOD 策略，向舒适区牵引（如悲伤时给一点明亮）' },
};

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 把情绪概率分布投影为二维 VA 期望值（用整条分布而非只取最大类，更稳） */
export function probsToVA(probs) {
  let v = 0, a = 0, sum = 0;
  for (const k of EMOTION_KEYS) {
    const p = probs[k] || 0;
    v += p * EMOTIONS[k].va.valence;
    a += p * EMOTIONS[k].va.arousal;
    sum += p;
  }
  if (sum <= 1e-9) return { valence: 0.5, arousal: 0.5 };
  return { valence: v / sum, arousal: a / sum };
}
