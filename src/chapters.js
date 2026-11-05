// Chapters from a transcript.
// 1) Spoken section headings, as used in Progress Today affirmation tracks:
//    "An organised kitchen and meals. 201 to 250." or "Decluttering 101 to 150" or "An organised mind 1-50".
// 2) Otherwise: split at pauses and sentence ends, and name each chapter by the words that make it different.

const clean = s => (s || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const intOf = s => (/^\d{1,4}[.,]?$/.test(s) ? parseInt(s, 10) : NaN);
const isNum = s => /^[-–]?\d+([.,:-]\d*)?[.,]?$/.test(s);
const endsSentence = s => /[.!?]["')\]]?$/.test(s);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// back-scan from word index i-1 to collect a short heading title
function titleBefore(words, i) {
  const out = []; let j = i - 1;
  while (j >= 0 && out.length < 9) {
    const t = words[j].text;
    if (isNum(t)) break;
    if (out.length && endsSentence(t)) break; // the previous affirmation ended here
    out.unshift(t); j--;
    if (j >= 0 && words[j + 1].start - words[j].end > 1.6) break; // a long pause before the title
  }
  const title = out.join(' ').replace(/[.,;:!?]+$/, '').trim();
  return title && /\p{L}/u.test(title) ? { title: cap(title), start: words[j + 1].start } : null;
}

export function headingChapters(words) {
  const found = [];
  for (let i = 1; i < words.length; i++) {
    const a = intOf(words[i].text), n1 = words[i + 1]?.text || '', n2 = words[i + 2]?.text || '';
    if (isNaN(a)) continue;
    let b = NaN;
    if (/^to$/i.test(n1)) b = intOf(clean(n2) + '');
    else if (/^[-–]\d+[.,]?$/.test(n1)) b = parseInt(n1.slice(1), 10);
    const range = !isNaN(b) && b > a && b - a >= 9 && (a === 1 || a % 10 === 1); // blocks start at 1, 101, 151…
    // a block start said without the "to" (e.g. "An organised family life. 551"): N ends in 01 or 51, said without a full stop
    const bare = !range && /^\d+$/.test(words[i].text) && a > 1 && (a % 50 === 1) && endsSentence(words[i - 1].text);
    if (!range && !bare) continue;
    const h = titleBefore(words, i);
    if (!h || h.title.split(/\s+/).length > 8) continue;
    if (/^(part|chapter)$/i.test(h.title)) continue;
    found.push({ t: Math.max(0, h.start - 0.3), title: h.title });
  }
  // headings said back to back (e.g. "Part 1 Mind… 1-250. An organised mind 1-50"): keep the more specific, later one
  const out = [];
  for (const c of found) { if (out.length && c.t - out[out.length - 1].t < 15) out[out.length - 1] = c; else out.push(c); }
  return out;
}

const STOP = new Set(('a an and are as at be because been being but by can do does don\'t for from get has have i i\'m in into is it it\'s its just keep keeps let like make makes me more my myself no not of on one or our out so than that the their them then there these they this to up us we what when where which who will with without you your yours am im ive i\'ve every each all very things thing time way day well also feel feels always never someone organized organised organize organise organizing organising organization organisation music upbeat'
).split(' '));
function keywordTitles(words, chs) {
  const tok = w => (/^[\[(]/.test(w.text) ? '' : clean(w.text).toLowerCase().replace(/'s$/, ''));
  const df = new Map(), per = chs.map(() => new Map());
  chs.forEach((c, k) => {
    const end = chs[k + 1]?.t ?? Infinity;
    for (const w of words) { if (w.start < c.t || w.start >= end) continue; const t = tok(w); if (t.length < 4 || STOP.has(t) || /\d/.test(t)) continue; per[k].set(t, (per[k].get(t) || 0) + 1); }
    per[k].forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
  });
  return chs.map((c, k) => {
    const n = chs.length;
    const top = [...per[k]].map(([t, f]) => [t, f * Math.log(1 + n / (df.get(t) || 1))]).sort((a, b) => b[1] - a[1]).map(x => x[0]).filter((t, i, arr) => !arr.slice(0, i).some(u => u.replace(/s$/, '') === t.replace(/s$/, ''))).slice(0, 2).map(cap);
    return top.length ? top.join(' · ') : c.title;
  });
}

// A heading the transcript missed leaves one chapter much longer than the rest: split it at sentence ends
// and name the new parts by their key words (for example "Children · School").
function splitLong(words, chs) {
  const total = words[words.length - 1].end;
  const lens = chs.map((c, k) => (chs[k + 1]?.t ?? total) - c.t).filter((_, k) => k > 0);
  if (lens.length < 3) return chs;
  const med = [...lens].sort((a, b) => a - b)[Math.floor(lens.length * 0.3)]; // a typical block
  const out = [];
  chs.forEach((c, k) => {
    out.push(c);
    const end = chs[k + 1]?.t ?? total, len = end - c.t;
    if (k === 0 || len < med * 1.7) return;
    const parts = Math.round(len / med);
    for (let q = 1; q < parts; q++) {
      const target = c.t + len * q / parts; let best = -1, bd = Infinity;
      for (let i = 1; i < words.length; i++) { const w = words[i]; if (w.start < c.t + 30 || w.start > end - 30) continue; if (!endsSentence(words[i - 1].text)) continue; const d = Math.abs(w.start - target); if (d < bd) { bd = d; best = i; } }
      if (best > 0 && bd < len / parts / 2) out.push({ t: Math.max(0, words[best].start - 0.2), title: '', auto: true });
    }
  });
  const names = keywordTitles(words, out);
  return out.map((c, k) => (c.auto ? { t: c.t, title: names[k] } : c));
}

export function transcriptChapters(words) {
  if (!words.length) return [{ t: 0, title: 'Start' }];
  const heads = headingChapters(words);
  if (heads.length >= 2) {
    let out = heads[0].t > 20 ? [{ t: 0, title: 'Introduction' }, ...heads] : heads.map((c, i) => (i ? c : { ...c, t: 0 }));
    out = splitLong(words, out);
    return out;
  }
  // fallback: pauses and sentence ends, spaced by track length
  const total = words[words.length - 1].end || 0, minLen = Math.max(25, total / 24);
  const out = [{ t: 0, title: 'Start' }];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end, since = words[i].start - out[out.length - 1].t, endS = endsSentence(words[i - 1].text);
    if ((gap > 1.6 && since > Math.max(12, minLen * 0.6)) || (endS && since > minLen * 1.8) || (gap > 0.7 && endS && since > minLen)) out.push({ t: Math.max(0, words[i].start - 0.2), title: '' });
  }
  const names = keywordTitles(words, out);
  return out.map((c, k) => ({ t: c.t, title: names[k] || `Part ${k + 1}` }));
}
