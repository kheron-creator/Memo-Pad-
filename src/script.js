// A written script pasted by the user: its exact words become the transcript, timed to the voice,
// and its heading lines become the chapters.

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const RANGE = /\(?\s*\d+\s*(?:to|–|—|-)\s*\d+\s*\)?\.?/i;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// heading lines: short, not a numbered affirmation, and not a full sentence (unless it carries a range like "201–250")
function headingOf(line) {
  const l = line.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '');
  if (!l || /^\d+\s*[.)]\s/.test(l) || /^[-•*]\s/.test(l)) return null;
  const words = l.split(/\s+/);
  if (words.length > 10) return null;
  const hasRange = RANGE.test(l);
  if (/[.!?]$/.test(l.replace(RANGE, '').trim()) && !hasRange) return null;
  const title = l.replace(RANGE, '').replace(/[\s:.,;–—-]+$/, '').trim();
  return title && /\p{L}/u.test(title) ? cap(title) : null;
}

export function parseScript(text) {
  const words = [], headings = [];
  text.replace(/\r/g, '').split('\n').forEach(line => {
    const ws = line.trim().split(/\s+/).filter(Boolean); if (!ws.length) return;
    const h = headingOf(line); if (h) headings.push({ i: words.length, title: h });
    ws.forEach((w, k) => words.push({ text: w, p: k === 0 }));
  });
  return { words, headings };
}

// Match script words to the speech-recognised words.
// 1) anchors: 4-word phrases that appear exactly once in both, kept in order (longest increasing run);
// 2) between anchors, match word pairs greedily; 3) fill the rest evenly.
export function alignToAsr(script, asr) {
  const out = script.map(w => ({ text: w.text, p: w.p, start: NaN, end: NaN }));
  const sn = out.map(w => norm(w.text)), an = asr.map(w => norm(w.text));
  const sIdx = sn.map((x, i) => i).filter(i => sn[i]), aIdx = an.map((x, i) => i).filter(i => an[i]); // skip punctuation-only tokens
  const grams = (idx, arr) => { const m = new Map(); for (let q = 0; q + 3 < idx.length; q++) { const g = arr[idx[q]] + ' ' + arr[idx[q + 1]] + ' ' + arr[idx[q + 2]] + ' ' + arr[idx[q + 3]]; m.set(g, m.has(g) ? -1 : q); } return m; };
  const gs = grams(sIdx, sn), ga = grams(aIdx, an);
  const pairs = [];
  gs.forEach((q, g) => { if (q >= 0) { const r = ga.get(g); if (r != null && r >= 0) pairs.push([q, r]); } });
  pairs.sort((a, b) => a[0] - b[0]);
  // longest increasing subsequence on the asr position
  const tails = [], prev = new Array(pairs.length), tailIdx = [];
  pairs.forEach((p, n) => { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < p[1]) lo = m + 1; else hi = m; } tails[lo] = p[1]; tailIdx[lo] = n; prev[n] = lo ? tailIdx[lo - 1] : -1; });
  const chain = []; for (let n = tailIdx[tails.length - 1] ?? -1; n >= 0; n = prev[n]) chain.unshift(pairs[n]);
  const set = (si, ai) => { out[si].start = asr[ai].start; out[si].end = asr[ai].end; };
  chain.forEach(([q, r]) => { for (let d = 0; d < 4; d++) set(sIdx[q + d], aIdx[r + d]); });
  // greedy pairs between anchors
  const bounds = [[-1, -1], ...chain.map(([q, r]) => [q + 3, r + 3]), [sIdx.length, aIdx.length]];
  for (let b = 0; b + 1 < bounds.length; b++) {
    let a = bounds[b][1] + 1; const aEnd = bounds[b + 1][1] - (b + 1 < bounds.length - 1 ? 0 : 0);
    for (let q = bounds[b][0] + 1; q < Math.min(bounds[b + 1][0] - (b + 1 < bounds.length - 1 ? 3 : 0), sIdx.length); q++) {
      for (let r = a; r < Math.min(aEnd, a + 25); r++) {
        if (an[aIdx[r]] === sn[sIdx[q]] && (q + 1 >= sIdx.length || r + 1 >= aIdx.length || an[aIdx[r + 1]] === sn[sIdx[q + 1]])) { set(sIdx[q], aIdx[r]); a = r + 1; break; }
      }
    }
  }
  const total = asr.length ? asr[asr.length - 1].end : 0;
  fillGaps(out, 0, total);
  return out;
}
function fillGaps(out, t0, t1) {
  let i = 0;
  while (i < out.length) {
    if (!isNaN(out[i].start)) { i++; continue; }
    let k = i; while (k < out.length && isNaN(out[k].start)) k++;
    const a = i ? out[i - 1].end : t0, b = k < out.length ? out[k].start : t1, n = k - i, step = Math.max(0, b - a) / n;
    for (let q = 0; q < n; q++) { out[i + q].start = a + step * q; out[i + q].end = a + step * (q + 0.9); }
    i = k;
  }
}

// No transcript yet: spread the words over the parts of the waveform that have sound.
export function spreadOverVoice(script, peaks, duration, bps) {
  const voiced = []; if (peaks) for (let i = 0; i < peaks.length; i++) if (peaks[i] > 0.1) voiced.push(i / bps);
  const wt = script.map(w => w.text.length + 2), tot = wt.reduce((a, b) => a + b, 0) || 1; let acc = 0;
  return script.map((w, i) => {
    const f0 = acc / tot; acc += wt[i]; const f1 = acc / tot;
    const at = f => voiced.length ? voiced[Math.floor(f * (voiced.length - 1))] : f * duration;
    return { text: w.text, p: w.p, start: at(f0), end: Math.max(at(f0) + 0.1, at(f1)) };
  });
}

export function scriptChapters(timed, headings) {
  if (headings.length < 2) return null;
  const raw = headings.map(h => ({ t: Math.max(0, (timed[h.i]?.start || 0) - 0.3), title: h.title }));
  const out = [];
  for (const c of raw) { if (out.length && c.t - out[out.length - 1].t < 8) out[out.length - 1] = c; else out.push(c); }
  if (out[0].t > 20) out.unshift({ t: 0, title: 'Introduction' }); else out[0] = { ...out[0], t: 0 };
  return out;
}
