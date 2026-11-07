// ElevenLabs text to speech for MemoPad Create. Runs on Vercel so the API key never reaches the browser.
// Needs the Vercel environment variable ELEVENLABS_API_KEY. Only signed-in MemoPad users can call it,
// only with the voices listed here, and only short texts (one affirmation line at a time).
const VOICES = {
  JBFqnCBsd6RMkjVDRZzb: 'George', Xb7hH8MSUJpSbSDYk0k2: 'Alice', EXAVITQu4vr4xnSDxMaL: 'Sarah',
  nPczCjzI2devNBz1zQrb: 'Brian', SAz9YHcvj6GT2YYXdXww: 'River', bIHbv24MWmeRgasZH58o: 'Will',
};
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://hiwgaywnfxzeptflxrsi.supabase.co';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhpd2dheXduZnh6ZXB0Zmx4cnNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDQyNDcsImV4cCI6MjEwMzMyMDI0N30.Kce8oAmx7SSkoytOuGZTaD8jDc84bM2yQ5rqUuw3hxw';
const MAX_CHARS = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'sign_in' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) return res.status(401).json({ error: 'sign_in' });
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
