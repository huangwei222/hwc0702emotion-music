/**
 * recommender.js —— 推荐策略（内容相似 + MMR 多样性 + 在线反馈画像）
 *
 * ① 目标情绪：把 7 类人脸情绪分布投影为 VA 期望，再按策略混合"调节目标"；
 * ② 内容匹配：加权欧氏距离（效价权重 > 唤醒度权重，因为调式对情绪的影响更直接）；
 * ③ 多样性重排：MMR（Maximal Marginal Relevance），避免推荐 6 首几乎一样的歌；
 * ④ 在线学习：Rocchio 式画像更新，喜欢/跳过即时改变画像坐标。
 */
import { EMOTIONS, REGULATE_TARGET, probsToVA, clamp01 } from './emotions.js';

const W_V = 1.0;
const W_A = 0.8;
const NORM = Math.sqrt(W_V + W_A);

/** 加权欧氏距离，归一化到 0-1 */
export function vaDistance(a, b) {
  const dv = a.valence - b.valence;
  const da = a.arousal - b.arousal;
  return Math.sqrt(W_V * dv * dv + W_A * da * da) / NORM;
}

export function vaSimilarity(a, b) {
  return 1 - vaDistance(a, b);
}

/** 依策略计算推荐目标点 */
export function computeTarget(probs, label, strategy) {
  const cong = probsToVA(probs);
  const reg = REGULATE_TARGET[label] || cong;
  let mix = 0.3;
  if (strategy === 'congruent') mix = 0;
  else if (strategy === 'regulate') mix = 0.75;
  return {
    valence: clamp01((1 - mix) * cong.valence + mix * reg.valence),
    arousal: clamp01((1 - mix) * cong.arousal + mix * reg.arousal),
    congruent: cong,
    regulate: reg,
    mix,
  };
}

/**
 * 主推荐函数
 * @param {object} o
 * @param {Array} o.tracks 曲库（含 va）
 * @param {{valence:number,arousal:number}} o.target
 * @param {Map|object} o.feedback id → +1(喜欢) / -1(跳过)
 * @param {{va:object,weight:number}} o.profile 用户画像
 * @param {number} o.topK
 * @param {number} o.lambda MMR 相关性权重（0.72 = 7 成相关性 + 3 成多样性）
 */
export function recommend({ tracks, target, feedback = {}, profile = null, topK = 6, lambda = 0.72, filter = null }) {
  const pool = tracks.filter((t) => t.va && (!filter || filter(t)));
  const scored = pool.map((t) => {
    const sim = vaSimilarity(target, t.va);
    let score = sim;
    if (profile && profile.weight > 0.05) {
      score = 0.78 * sim + 0.22 * vaSimilarity(profile.va, t.va);
    }
    const fb = feedback[t.id] || 0;
    score += 0.09 * fb;                       // 反馈微调
    return { track: t, sim, score };
  });

  const picked = [];
  const rest = scored.slice();
  while (picked.length < Math.min(topK, rest.length)) {
    let bestI = -1, bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, vaSimilarity(c.track.va, p.track.va));
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestI = i; }
    }
    picked.push(rest.splice(bestI, 1)[0]);
  }

  // MMR 决定"选哪 6 首"，展示顺序再按匹配度降序，避免出现 71%→69%→72% 的观感
  return picked
    .map((p) => ({
      ...p.track,
      similarity: p.sim,
      match: Math.round(clamp01(p.sim) * 100),
      reason: buildReason(p.track, target, p.sim),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/** 生成可读的推荐理由（引用真实特征值，而不是套话） */
function buildReason(track, target, sim) {
  const va = track.va;
  const raw = track.analysis && track.analysis.raw;
  const dV = va.valence - target.valence;
  const dA = va.arousal - target.arousal;

  let tone;
  if (Math.abs(dV) < 0.12 && Math.abs(dA) < 0.12) tone = '情绪坐标与目标几乎重合';
  else if (dV > 0.12 && dA > 0.12) tone = '比目标更明亮、更有推力';
  else if (dV > 0.12) tone = '比目标更明朗但节奏更缓';
  else if (dV < -0.12 && dA > 0.12) tone = '色调更暗、张力更强';
  else if (dV < -0.12) tone = '色调更暗、更内敛';
  else tone = '层次更接近目标的唤醒水平';

  if (!raw) {
    const extra = [track.genre, track.mood].filter(Boolean).join(' · ');
    return `${tone}；${extra || '在线曲目'}（VA 先验，点播后可离线复算）；VA 距离 ${(1 - sim).toFixed(2)}`;
  }

  const tempo = raw.bpm >= 120 ? '快板' : raw.bpm >= 90 ? '中板' : '慢板';
  const bright = raw.centroidHz >= 1400 ? '明亮' : raw.centroidHz >= 700 ? '中性' : '暗色';
  return `${tempo}${raw.mode === 'major' ? '大调' : '小调'} · ${bright}音色（BPM ${Math.round(raw.bpm)}，质心 ${raw.centroidHz}Hz）；${tone}；VA 距离 ${(1 - sim).toFixed(2)}`;
}

/** Rocchio 式画像更新：喜欢则靠近，跳过则远离 */
export function updateProfile(profile, trackVA, liked) {
  const eta = liked ? 0.35 : 0.18;
  const sign = liked ? 1 : -1;
  const next = {
    valence: clamp01(profile.va.valence + sign * eta * (trackVA.valence - profile.va.valence)),
    arousal: clamp01(profile.va.arousal + sign * eta * (trackVA.arousal - profile.va.arousal)),
  };
  return { va: next, weight: clamp01(profile.weight + 0.12) };
}

export { EMOTIONS };
