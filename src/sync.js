// Display timing for the live transcript. Speech recognition often stretches a word back over the pause
// before it, so the word lights up too early. Using the waveform, move such a word's start to where the
// sound actually rises again. The saved words never change; this only affects when each word lights up.
export function displayStarts(words, peaks, bps) {
  const st = words.map(w => w.start);
  if (!peaks || !peaks.length) return st;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], len = w.end - w.start;
    if (!(len > 0.45)) continue;
    const a = Math.max(0, Math.floor(w.start * bps)), b = Math.min(peaks.length - 1, Math.ceil(w.end * bps));
    if (b - a < 4) continue;
    let mn = Infinity, mi = a, mx = 0;
    for (let k = a; k <= b; k++) { if (peaks[k] < mn) { mn = peaks[k]; mi = k; } mx = Math.max(mx, peaks[k]); }
    if (mx - mn < 0.15 || mi === a && peaks[a] > mn + 0.02) continue; // no clear pause inside the word
    const thr = mn + (mx - mn) * 0.45;
    let k = mi; while (k <= b && peaks[k] < thr) k++;
    const t = Math.min(k / bps - 0.06, w.end - 0.2);
    if (t > st[i]) st[i] = t;
  }
  return st;
}
