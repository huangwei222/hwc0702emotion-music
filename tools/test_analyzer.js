/**
 * test_analyzer.js —— 用真实 WAV 离线跑通 music-engine 的 DSP，
 * 输出特征表并导出 features.json 供 calibrate.py 做权重标定。
 * 运行：node tools/test_analyzer.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSamples } from '../js/music-engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a wav');
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size + (size % 2);
  }
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const chans = [];
  for (let c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      chans[c][i] = data.readInt16LE((i * fmt.channels + c) * bytes) / 32768;
    }
  }
  return { channels: chans, sampleRate: fmt.rate };
}

const tracks = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs', 'tracks.json'), 'utf8'));
const out = [];
console.log('id   | 真值 BPM/调式  | 检测 BPM/调式 | ACF  | 质心Hz | 起音/s | RMSdB | 调式分 | VA 检测        | VA 标注       | ms');
console.log('-'.repeat(132));
for (const t of tracks) {
  const wav = decodeWav(fs.readFileSync(path.join(ROOT, t.file)));
  const r = analyzeSamples(wav.channels, wav.sampleRate);
  const va = r.va;
  console.log(
    `${t.id} | ${String(t.truth.bpm).padStart(3)} ${t.truth.mode.padEnd(6)} | ` +
    `${String(r.raw.bpm).padStart(6)} ${r.raw.mode.padEnd(6)}| ${r.raw.tempoConfidence.toFixed(2)} | ` +
    `${String(r.raw.centroidHz).padStart(6)} | ${String(r.raw.onsetDensity).padStart(6)} | ` +
    `${String(r.raw.rmsDb).padStart(5)} | ${String(r.raw.modeScore).padStart(6)} | ` +
    `${va.valence.toFixed(2)},${va.arousal.toFixed(2)} | ` +
    `${t.truth.va[0].toFixed(2)},${t.truth.va[1].toFixed(2)} | ${r.analyzeMs}`
  );
  out.push({ id: t.id, emo: t.truth.emo, features: r.features, raw: r.raw, va: va, truthVa: t.truth.va, truthBpm: t.truth.bpm, truthMode: t.truth.mode });
}
fs.writeFileSync(path.join(ROOT, 'tools', 'features.json'), JSON.stringify(out, null, 2));

// 误差统计
const bpmErr = out.map((o) => Math.abs(o.raw.bpm - o.truthBpm) / o.truthBpm);
const modeOk = out.filter((o) => o.raw.mode === o.truthMode).length;
console.log('-'.repeat(132));
console.log('平均 BPM 相对误差: ' + (bpmErr.reduce((a, b) => a + b, 0) / bpmErr.length * 100).toFixed(1) + '%');
console.log('调式判定准确率: ' + modeOk + '/' + out.length);
