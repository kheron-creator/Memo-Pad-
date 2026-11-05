// MP3 encoder worker (lamejs 1.2.1, LGPL-3.0, github.com/zhuker/lamejs). Runs on the device; nothing is uploaded to compress.
importScripts('/lame.js');
self.onmessage = e => {
  const { chs, sr, kbps } = e.data; const enc = new lamejs.Mp3Encoder(chs.length, sr, kbps);
  const toI = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
  const L = toI(chs[0]), R = chs[1] ? toI(chs[1]) : null, out = [], B = 1152 * 32;
  for (let i = 0, n = 0; i < L.length; i += B, n++) { const b = R ? enc.encodeBuffer(L.subarray(i, i + B), R.subarray(i, i + B)) : enc.encodeBuffer(L.subarray(i, i + B)); if (b.length) out.push(b); if (n % 15 === 0) self.postMessage({ type: 'p', p: i / L.length }); }
  const f = enc.flush(); if (f.length) out.push(f); self.postMessage({ type: 'done', out });
};
