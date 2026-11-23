// Read the words out of a document someone uploads: Word (.docx), PDF, RTF, plain text, Markdown or a web page.
import { docxText } from './docx.js';

export const DOC_ACCEPT = '.txt,.md,.markdown,.docx,.pdf,.rtf,.html,.htm,text/plain,text/markdown,application/pdf,application/rtf,text/rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function pdfText(file) {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/build/pdf.min.mjs'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n), tc = await page.getTextContent(); let line = '', lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? Math.round(it.transform[5]) : lastY;
      if (lastY !== null && y !== lastY && line.trim()) { out.push(line.trim()); line = ''; }
      line += it.str + (it.hasEOL ? '\n' : ''); lastY = y;
      if (it.hasEOL) { out.push(line.trim()); line = ''; }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.filter(Boolean).join('\n');
}
function rtfText(s) {
  // drop header groups (fonts, colours, styles, info, hidden \* parts), keeping the body text
  let out = '', depth = 0, skip = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '{' || s[i + 1] === '}' || s[i + 1] === '\\')) { if (!skip) out += s[i + 1]; i++; continue; }
    if (c === '{') { depth++; if (!skip && /^\{\\(\*|fonttbl|colortbl|stylesheet|info|listtable|listoverridetable|pict|header|footer)/.test(s.slice(i, i + 22))) skip = depth; continue; }
    if (c === '}') { if (skip === depth) skip = 0; depth--; continue; }
    if (!skip) out += c;
  }
  const cp = b => new TextDecoder('windows-1252').decode(new Uint8Array([b]));
  return out.replace(/\\par[d]?\b ?/g, '\n').replace(/\\(line|tab)\b ?/g, m => m.startsWith('\\line') ? '\n' : ' ')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/\\u(-?\d+) ?\??/g, (_, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n)).replace(/\\[a-z]+-?\d* ?/gi, '');
}
const htmlText = s => new DOMParser().parseFromString(s.replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '$&\n'), 'text/html').body.textContent || '';
// One affirmation (or prayer) per line, whatever the text came from:
// - any kind of line break counts (Windows, old Mac, iPhone Notes' line separators)
// - a line that was only wrapped (no end punctuation, next line starts in lower case) is joined back up
// - list numbers and bullets are dropped
const END = /[.!?:;…"”'’)\]]$/;
export function splitLines(text) {
  const raw = String(text || '').replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, '\n').replace(/\u00a0/g, ' ').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  const out = [];
  for (const l of raw) {
    if (!l) { out.push(''); continue; }
    const prev = out[out.length - 1];
    if (prev && !prev.startsWith('#') && !END.test(prev) && /^[a-z(,]/.test(l)) out[out.length - 1] = prev + ' ' + l;
    else out.push(l);
  }
  return out.map(l => l.replace(/^(?:[-*•●▪◦–·]\s*|\d{1,4}[.)](?:\s+|(?=[A-Za-z])))/, '').trim()).filter(Boolean);
}
const tidy = t => splitLines(t).join('\n');

export async function readDoc(f) {
  const n = f.name.toLowerCase();
  let t;
  if (/\.docx$/.test(n)) t = await docxText(f);
  else if (/\.pdf$/.test(n) || f.type === 'application/pdf') t = await pdfText(f);
  else if (/\.rtf$/.test(n) || /rtf/.test(f.type)) t = rtfText(await f.text());
  else if (/\.html?$/.test(n)) t = htmlText(await f.text());
  else if (/\.(pages|doc|odt|gdoc)$/.test(n)) throw new Error(`MemoPad can't open ${n.split('.').pop()} files yet. Save it as Word (.docx) or PDF and upload that`);
  else t = await f.text();
  t = tidy(t);
  if (!t) throw new Error('no words found in that file. If it is a scanned PDF, copy the text and paste it in instead');
  return t;
}

/* ---------- book-style intro, then one affirmation per line ----------
   Like ElevenReader: a document that opens with prose (an introduction, a story, a chapter opening)
   is read as flowing paragraphs, sentence by sentence, said once. The lines that follow are
   affirmations, one per line, and these are the ones that repeat. */
const sentencesIn = t => (t.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || [t]).map(s => s.trim()).filter(Boolean);
const isLong = t => t.length > 180 || (t.length > 90 && sentencesIn(t).filter(s => s.length > 12).length >= 3);
const isShort = t => t.length <= 140 && sentencesIn(t).length <= 2;
export function splitSentences(t) {
  const out = [];
  for (const s of t.split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)) {
    // keep tiny pieces ("Mr.", "Ps. 23:1.") with the sentence that follows
    const last = out[out.length - 1];
    if (last && (last.length < 12 || /\b(?:Mr|Mrs|Ms|Dr|St|Ps|Rev|Prov|Gen|Matt|Rom|vs|etc|e\.g|i\.e)\.$/i.test(last))) out[out.length - 1] += ' ' + s; else out.push(s);
  }
  return out.map(s => s.trim()).filter(Boolean);
}
// lines: from splitLines. Returns [{head:true,text}] or [{text, intro:true, para, end}] or [{text}]
export function structure(lines) {
  const L = lines.map(t => ({ t, head: /^#+\s*/.test(t) }));
  const runAt = i => { let n = 0; for (let k = i; k < L.length && !L[k].head && isShort(L[k].t); k++) n++; return n; };
  const prose = new Set();
  // the opening, up to the first run of three or more short lines, is the intro if it holds real prose
  let s = L.findIndex((x, i) => !x.head && runAt(i) >= 3);
  if (s > 0) { const pre = L.slice(0, s).map((x, i) => i).filter(i => !L[i].head); if (pre.some(i => isLong(L[i].t))) pre.forEach(i => prose.add(i)); }
  // a later chapter can open with prose too, before its own run of affirmations
  if (s >= 0) for (let h = s; h < L.length; h++) {
    if (!L[h].head) continue;
    let k = h + 1; const lead = [];
    while (k < L.length && !L[k].head && isLong(L[k].t)) lead.push(k++);
    if (lead.length && runAt(k) >= 3) lead.forEach(i => prose.add(i));
  }
  const out = []; let para = 0;
  L.forEach((x, i) => {
    const text = x.head ? x.t.replace(/^#+\s*/, '') : x.t;
    if (x.head) out.push({ head: true, text });
    else if (prose.has(i)) { const ss = splitSentences(text); para++; ss.forEach((t, j) => out.push({ text: t, intro: true, para, end: j === ss.length - 1 })); }
    else out.push({ text });
  });
  return out;
}
