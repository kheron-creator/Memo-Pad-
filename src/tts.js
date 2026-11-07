// Shared text to speech for MemoPad (Create and Reader).
// ElevenLabs voices go through our server function /api/tts (the key stays on Vercel).
// Free voices (Piper) run on the device. Every spoken line is cached on the device, so replays cost nothing.
import { audioGet, audioPut } from './cloud.js';
let piper = null;
const loadPiper = () => (piper ||= import('@diffusionstudio/vits-web'));
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const mem = new Map();
export const cacheKey = (voiceId, text) => `tts:${voiceId}:${hash(text)}:${text.length}`;

async function eleven(text, voice) {
  const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error({ not_configured: 'ElevenLabs is not switched on yet (the API key is missing)', text: 'that line is too long, keep each line under 500 characters' }[e.error] || `ElevenLabs said no (${e.status || r.status})`);
  }
  return r.blob();
}

// Returns an audio Blob for one line. onDl(fraction) reports the one-time free-voice download.
export async function speakBlob(text, voiceId, onDl = () => {}) {
  const k = cacheKey(voiceId, text);
  if (mem.has(k)) return mem.get(k);
  const p = (async () => {
    const hit = await audioGet(k); if (hit) return hit;
    let blob;
    if (voiceId.startsWith('el:')) blob = await eleven(text, voiceId.slice(3));
    else { const T = await loadPiper(); blob = await T.predict({ text, voiceId }, x => { if (x && x.total) onDl(x.loaded / x.total); }); }
    audioPut(k, blob); return blob;
  })();
  mem.set(k, p); p.catch(() => mem.delete(k)); return p;
}
