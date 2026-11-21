// Shared text to speech for MemoPad (Create and Reader).
// ElevenLabs voices go through our server function /api/tts (the key stays on Vercel).
// Free voices (Piper) run on the device. Every spoken line is cached on the device, so replays cost nothing.
import { audioGet, audioPut } from './cloud.js';
let piper = null;
const loadPiper = () => (piper ||= import('@diffusionstudio/vits-web'));
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const mem = new Map();
export const cacheKey = (voiceId, text, speed = 1) => `tts:${voiceId}:${hash(text)}:${text.length}${speed !== 1 ? ':s' + speed : ''}`;

// ElevenLabs' own reason, e.g. "quota_exceeded" or "missing_permissions", so problems can be fixed quickly
export function elevenReason(e) {
  try { const d = JSON.parse(e.detail || '{}').detail || {}; return [d.status, d.message].filter(Boolean).join(': ').slice(0, 200); } catch { return String(e.detail || '').slice(0, 200); }
}
async function eleven(text, voice, speed = 1, ctx = {}) {
  const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, speed, prev: ctx.prev || '', next: ctx.next || '' }) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error({ not_configured: 'ElevenLabs is not switched on yet (the API key is missing)', text: 'that line is too long, keep each line under 500 characters' }[e.error] || `ElevenLabs said no (${e.status || r.status}${elevenReason(e) ? ', ' + elevenReason(e) : ''})`);
  }
  return r.blob();
}

// Returns an audio Blob for one line. onDl(fraction) reports the one-time free-voice download.
// speed (ElevenLabs voices only): 0.8 slow, 1 steady, 1.1 upbeat.
// ctx {prev, next}: the lines either side, so ElevenLabs keeps one smooth flow across lines (like its Reader).
export async function speakBlob(text, voiceId, onDl = () => {}, speed = 1, ctx = null) {
  const k = cacheKey(voiceId, text, speed) + (ctx && voiceId.startsWith('el:') ? ':f' : '');
  if (mem.has(k)) return mem.get(k);
  const p = (async () => {
    const hit = await audioGet(k); if (hit) return hit;
    let blob;
    if (voiceId.startsWith('el:')) blob = await eleven(text, voiceId.slice(3), speed, ctx || {});
    else { const T = await loadPiper(); blob = await T.predict({ text, voiceId }, x => { if (x && x.total) onDl(x.loaded / x.total); }); }
    audioPut(k, blob); return blob;
  })();
  mem.set(k, p); p.catch(() => mem.delete(k)); return p;
}
