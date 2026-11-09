// ElevenLabs text to speech for MemoPad Create. Runs on Vercel so the API key never reaches the browser.
// Needs the Vercel environment variable ELEVENLABS_API_KEY. No sign-in needed: it only answers requests
// from MemoPad's own pages, only with the voices listed here, and only short texts (one affirmation line at a time).
const VOICES = {
  JBFqnCBsd6RMkjVDRZzb: 'George', Xb7hH8MSUJpSbSDYk0k2: 'Alice', EXAVITQu4vr4xnSDxMaL: 'Sarah',
  nPczCjzI2devNBz1zQrb: 'Brian', SAz9YHcvj6GT2YYXdXww: 'River', bIHbv24MWmeRgasZH58o: 'Will',
};
const MAX_CHARS = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  // Only our own pages (same site) may use it, so other websites can't spend the credits.
  const from = req.headers.origin || req.headers.referer || '';
  let fromHost = ''; try { fromHost = new URL(from).host; } catch {}
  if (!fromHost || fromHost !== req.headers.host) return res.status(403).json({ error: 'origin' });
  let body = req.body; if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = {}; }
  const text = String(body?.text || '').trim(), voice = String(body?.voice || '');
  if (!VOICES[voice]) return res.status(400).json({ error: 'voice' });
  if (!text || text.length > MAX_CHARS) return res.status(400).json({ error: 'text', max: MAX_CHARS });
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.6, similarity_boost: 0.75 } }),
  });
  if (!r.ok) { const detail = await r.text().catch(() => ''); return res.status(502).json({ error: 'elevenlabs', status: r.status, detail: detail.slice(0, 300) }); }
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}
