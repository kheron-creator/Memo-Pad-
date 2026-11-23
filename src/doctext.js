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
// tidy: drop list numbers and bullets, keep one affirmation per line
const tidy = t => t.replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*(?:[-*•●▪◦–]\s*|\d{1,4}[.)](?:\s+|(?=[A-Za-z])))/, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

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
