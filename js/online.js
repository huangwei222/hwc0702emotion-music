/**
 * online.js —— 在线曲库接入（Audius 开放 API，免申请 Key、支持 CORS）
 *
 * 说明：在线曲目没有本地音频文件，先用"情绪关键词 → VA 先验"做粗排；
 * 一旦用户点播，再用同一套本地旋律分析算法对其实时分析，替换掉先验值。
 */

const API = 'https://api.audius.co/v1';
const APP = 'EmotionMusicDemo';

const MOOD_PRIOR = [
  // 关键词命中 → VA 先验（用于在线结果粗排）
  [['happy', 'upbeat', 'joy', 'sunny', 'feel good', 'party', 'summer'], { valence: 0.84, arousal: 0.76 }],
  [['sad', 'melancholy', 'lonely', 'tears', 'sorrow'], { valence: 0.18, arousal: 0.26 }],
  [['angry', 'rage', 'aggressive', 'heavy', 'metal', 'hardcore'], { valence: 0.22, arousal: 0.88 }],
  [['surprise', 'experimental', 'glitch', 'weird', 'trippy'], { valence: 0.5, arousal: 0.86 }],
  [['calm', 'chill', 'ambient', 'lofi', 'sleep', 'peaceful'], { valence: 0.58, arousal: 0.34 }],
  [['dark', 'tense', 'horror', 'cinematic', 'eerie'], { valence: 0.22, arousal: 0.68 }],
];

export function priorFromText(text, seed = 0) {
  const s = (text || '').toLowerCase();
  let va = { valence: 0.5, arousal: 0.5 };
  for (const [words, v] of MOOD_PRIOR) {
    if (words.some((w) => s.includes(w))) { va = v; break; }
  }
  // 轻微抖动，避免所有在线结果挤在同一个点
  const j = ((seed * 37) % 11) / 100 - 0.05;
  return {
    valence: Math.min(0.95, Math.max(0.05, va.valence + j)),
    arousal: Math.min(0.95, Math.max(0.05, va.arousal - j * 0.6)),
  };
}

function toTrack(t, i) {
  const moodText = [t.mood, t.genre, t.title].filter(Boolean).join(' ');
  const va = priorFromText(moodText, i + 1);
  return {
    id: 'online-' + t.id,
    onlineId: t.id,
    title: t.title,
    artist: (t.user && t.user.name) || 'Audius Artist',
    source: 'online',
    url: `${API}/tracks/${t.id}/stream?app_name=${APP}`,
    artwork: t.artwork ? t.artwork['150x150'] || t.artwork['480x480'] || '' : '',
    duration: Number(t.duration) || 0,
    genre: t.genre || '',
    mood: t.mood || '',
    va,
    vaEstimated: true,
    analysis: null,
  };
}

/** 单次检索请求 */
async function request(query, limit) {
  const url = `${API}/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}&app_name=${APP}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    return (json.data || []).filter((t) => t.is_streamable !== false);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 情绪关键词搜索在线曲目。
 *
 * Audius 的 search 是多词"同时命中"语义，词越多命中越少：
 * 实测 'happy upbeat feel good' 返回 0 条，'happy upbeat' 返回 4 条。
 * 所以按"从长到短"逐级退让，累加去重，够 2 条就停，
 * 避免某个情绪因为关键词写得太细而整条链路空转。
 */
export async function searchOnline(query, limit = 5) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  const ladder = [];
  for (let n = words.length; n >= 1; n--) ladder.push(words.slice(0, n).join(' '));

  const seen = new Set();
  const out = [];
  let lastErr = null;

  for (const q of ladder) {
    let list;
    try {
      list = await request(q, limit);
    } catch (e) {
      lastErr = e;
      continue;
    }
    for (const t of list) {
      const key = t.id || t.track_id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(toTrack(t, out.length));
    }
    if (out.length >= Math.min(limit, 2)) break;
  }

  if (!out.length && lastErr) throw lastErr;
  return out.slice(0, limit);
}

/** 在线曲目也走本地算法：拉流 → 解码 → 同一套 DSP 分析 */
export async function analyzeOnlineTrack(track, analyzeUrlFn) {
  const analysis = await analyzeUrlFn(track.url);
  return analysis;
}
