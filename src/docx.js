// Tiny .docx text reader (no library): a .docx is a zip; we inflate word/document.xml and keep one line per paragraph.
export async function docxText(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a Word file');
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    if (name === 'word/document.xml') {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = buf.subarray(start, start + size);
      const raw = method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const xml = new TextDecoder().decode(raw);
      return xml.replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('no text found in that Word file');
}
