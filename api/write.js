// "Write for me" on MemoPad Create: Claude writes affirmations from the user's own choices.
// Needs ANTHROPIC_API_KEY in Vercel (Production and Preview). Without it the page uses its built-in lines.
// Signed-in MemoPad users only, at most 50 lines per call (the page asks chapter by chapter for 100 or 500).
import Anthropic from '@anthropic-ai/sdk';
export const config = { maxDuration: 90 };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://hiwgaywnfxzeptflxrsi.supabase.co';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhpd2dheXduZnh6ZXB0Zmx4cnNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDQyNDcsImV4cCI6MjEwMzMyMDI0N30.Kce8oAmx7SSkoytOuGZTaD8jDc84bM2yQ5rqUuw3hxw';
const s = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const PERSON = { i: 'Write every line in the first person ("I am…", "I choose…").', you: 'Write every line in the second person, as if a coach is speaking to them ("You are…", "You choose…").', mix: 'Mix first person ("I am…") and second person ("You are…") lines, roughly half and half.' };
const SYSTEM = `You write spoken affirmations for MemoPad, an app by Progress Today. They are read aloud by a voice over a lofi beat.
Rules:
- One affirmation per line, 4 to 16 words, present tense, positive, believable, specific to what the person told you.
- Easy to say out loud: plain words, no emojis, no hashtags, no numbering, no quotation marks.
- Vary how lines start; do not repeat a line or a near-copy of one already listed.
- Keep it warm and encouraging. Never give medical, legal or money advice, and never promise outcomes like cures or guaranteed income.
- If the person's request is unsafe or not something to affirm, write gentle, general self-worth affirmations instead.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'not_configured' });
  let fromHost = ''; try { fromHost = new URL(req.headers.origin || req.headers.referer || '').host; } catch {}
  if (!fromHost || fromHost !== req.headers.host) return res.status(403).json({ error: 'origin' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'sign_in' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) return res.status(401).json({ error: 'sign_in' });

  let b = req.body; if (typeof b === 'string') try { b = JSON.parse(b); } catch { b = {}; }
  const count = Math.min(50, Math.max(3, Math.round(+b?.count || 10)));
  const areas = (Array.isArray(b?.areas) ? b.areas : []).map(x => s(x, 30)).filter(Boolean).slice(0, 6);
  const avoid = (Array.isArray(b?.avoid) ? b.avoid : []).map(x => s(x, 160)).filter(Boolean).slice(-60);
  const ask = [
    `Write exactly ${count} affirmations.`,
    b?.chapter ? `This set is one chapter of a longer track. Chapter theme: ${s(b.chapter, 80)}. Keep every line on that theme while still tied to what they want.` : '',
    `What they want: ${s(b?.goal, 300) || 'to feel confident and make steady progress'}.`,
    s(b?.why, 300) && `Why it matters to them: ${s(b.why, 300)}.`,
    areas.length && `Life areas to cover: ${areas.join(', ')}.`,
    `Feel: ${s(b?.tone, 40) || 'calm and encouraging'}.`,
    PERSON[b?.person] || PERSON.i,
    s(b?.include, 200) && `Weave in these words or ideas where they fit naturally: ${s(b.include, 200)}.`,
    avoid.length && `Already written (do not repeat these):\n${avoid.join('\n')}`,
  ].filter(Boolean).join('\n');

  try {
    const client = new Anthropic();
    const msg = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } } },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: ask }],
    });
    if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'refused' });
    const text = msg.content.filter(x => x.type === 'text').map(x => x.text).join('');
    const lines = (JSON.parse(text).lines || []).map(x => s(x, 200).replace(/^["'“”\d.)\-•\s]+|["'“”]+$/g, '')).filter(Boolean).slice(0, count);
    return res.status(200).json({ lines });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'busy' });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: 'bad_key' });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: 'claude', status: e.status, detail: s(e.message, 300) });
    return res.status(500).json({ error: 'failed', detail: s(e?.message, 200) });
  }
}
