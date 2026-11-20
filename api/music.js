// ElevenLabs Music for MemoPad Create: makes a short instrumental beat (it loops under the voice).
// Uses the same Vercel environment variable as /api/tts (ELEVENLABS_API_KEY).
// Music costs more credits than speech, so only signed-in MemoPad users can ask for it,
// the prompt is kept short, and every beat is instrumental and about 90 seconds long.
export const config = { maxDuration: 120 };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://hiwgaywnfxzeptflxrsi.supabase.co';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhpd2dheXduZnh6ZXB0Zmx4cnNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDQyNDcsImV4cCI6MjEwMzMyMDI0N30.Kce8oAmx7SSkoytOuGZTaD8jDc84bM2yQ5rqUuw3hxw';
const LENGTH_MS = 90000;
const MAX_PROMPT = 300;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  const from = req.headers.origin || req.headers.referer || '';
  let fromHost = ''; try { fromHost = new URL(from).host; } catch {}
  if (!fromHost || fromHost !== req.headers.host) return res.status(403).json({ error: 'origin' });
  // signed-in users only: check the Supabase session token with Supabase itself
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'sign_in' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) return res.status(401).json({ error: 'sign_in' });
  let body = req.body; if (typeof body === 'string') try { body = JSON.parse(body); } catch { body = {}; }
  const ask = String(body?.prompt || '').trim().slice(0, MAX_PROMPT);
  if (!ask) return res.status(400).json({ error: 'prompt' });
  const prompt = `${ask}. Instrumental only, no vocals. Calm and steady, made to loop under spoken affirmations, gentle dynamics, no sudden drops.`;
  const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ prompt, music_length_ms: LENGTH_MS, model_id: 'music_v1', force_instrumental: true }),
  });
  if (!r.ok) { const detail = await r.text().catch(() => ''); return res.status(502).json({ error: 'elevenlabs', status: r.status, detail: detail.slice(0, 300) }); }
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}
