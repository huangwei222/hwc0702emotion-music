/** diag_tempo.js —— 打印引擎内部 ACF 与倍频决策，便于人工核对 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSamples } from '../js/music-engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function decodeWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels));
  const chans = [];
  for (let c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) chans[c][i] = data.readInt16LE((i * fmt.channels + c) * bytes) / 32768;
  return { channels: chans, sampleRate: fmt.rate };
}

const tracks = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs', 'tracks.json'), 'utf8'));
for (const t of tracks) {
  const wav = decodeWav(fs.readFileSync(path.join(ROOT, t.file)));
  const r = analyzeSamples(wav.channels, wav.sampleRate, true);
  const d = r.debug;
  const rows = [];
  for (let lag = 5; lag <= 24; lag++) {
    const v = d.acf[lag] || 0;
    rows.push(lag + ':' + v.toFixed(2));
  }
  console.log(t.id + ' 真值' + String(t.truth.bpm).padStart(4) + ' 检测' + String(r.raw.bpm).padStart(6) +
    ' best=' + d.bestLag + ' beat=' + d.beatLag + ' | ' + rows.join(' '));
}
