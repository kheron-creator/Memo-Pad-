// Supabase (shared with Progress Pad) + an IndexedDB offline cache.
import { createClient } from '@supabase/supabase-js';

// Public values (safe in the browser; row-level security protects the data). Vercel env vars override them.
// Never put the service-role key here.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://hiwgaywnfxzeptflxrsi.supabase.co';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhpd2dheXduZnh6ZXB0Zmx4cnNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NDQyNDcsImV4cCI6MjEwMzMyMDI0N30.Kce8oAmx7SSkoytOuGZTaD8jDc84bM2yQ5rqUuw3hxw';
export const configured = !!(url && key);
export const supabase = configured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null;

export const BUCKET = 'memopad-audio';
export const TABLE = 'memopad_memos';
export const FREE_STORAGE = 1024 ** 3; // 1 GB on the free plan
export const MAX_FILE = 50 * 1024 ** 2; // 50 MB per file on the free plan

// ---------- rows <-> tracks ----------
export function rowToTrack(r) {
  return {
    id: r.id, user_id: r.user_id, title: r.title, category: r.category || null, description: r.description || null,
    audio_path: r.audio_path, duration: +r.duration_s || 0,
    peaks: Array.isArray(r.peaks) ? Float32Array.from(r.peaks) : null,
    words: Array.isArray(r.words) ? r.words : [], chapters: Array.isArray(r.chapters) && r.chapters.length ? r.chapters : [{ t: 0, title: 'Start' }],
    is_shared: !!r.is_shared, is_public: r.is_public, added: Date.parse(r.created_at) || Date.now(), updated_at: r.updated_at,
  };
}
const r3 = v => Math.round(v * 1000) / 1000;
export function trackToRow(t, withPeaks) {
  const row = {
    title: (t.title || 'Untitled').slice(0, 200), category: t.category || null, description: t.description || null,
    duration_s: t.duration ? r3(t.duration) : null,
    words: t.words.map(w => ({ text: w.text, start: r3(w.start), end: r3(w.end), ...(w.p ? { p: 1 } : {}) })),
    chapters: t.chapters.map(c => ({ t: r3(c.t), title: c.title })),
    is_shared: !!t.is_shared,
  };
  if (typeof t.is_public === 'boolean') row.is_public = t.is_public; // the column exists once the public-links SQL has run
  if (withPeaks) row.peaks = t.peaks ? Array.from(t.peaks, v => Math.round(v * 100) / 100) : null;
  return row;
}

// ---------- offline cache (IndexedDB) ----------
let dbp;
function db() {
  if (!dbp) dbp = new Promise(res => {
    try {
      const r = indexedDB.open('memopad', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('memos', { keyPath: 'id' }); r.result.createObjectStore('audio'); };
      r.onsuccess = () => res(r.result); r.onerror = r.onblocked = () => res(null); setTimeout(() => res(null), 4000);
    } catch { res(null); }
  });
  return dbp;
}
// never wait forever: on some phones the on-device store can get stuck, and then MemoPad would never load the audio
function req(store, mode, fn) {
  return db().then(d => d && new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; clearTimeout(tm); res(v); } };
    const tm = setTimeout(() => fin(null), mode === 'readonly' ? 4000 : 20000);
    try { const tx = d.transaction(store, mode), q = fn(tx.objectStore(store)); q.onsuccess = () => fin(q.result); q.onerror = () => fin(null); tx.onabort = tx.onerror = () => fin(null); }
    catch { fin(null); }
  }));
}
export const cacheAll = () => req('memos', 'readonly', s => s.getAll()).then(a => a || []);
export function cachePut(t) {
  const { blob, _text, _save, ...rest } = t;
  return req('memos', 'readwrite', s => s.put({ ...rest, peaks: t.peaks ? Array.from(t.peaks) : null }));
}
export const cacheDel = id => Promise.all([req('memos', 'readwrite', s => s.delete(id)), req('audio', 'readwrite', s => s.delete(id))]);
export const audioGet = id => req('audio', 'readonly', s => s.get(id));
export const audioPut = (id, blob) => req('audio', 'readwrite', s => s.put(blob, id));
export const audioDel = id => req('audio', 'readwrite', s => s.delete(id));
export const audioKeys = () => req('audio', 'readonly', s => s.getAllKeys()).then(a => a || []);
export const cacheClear = () => Promise.all([req('memos', 'readwrite', s => s.clear()), req('audio', 'readwrite', s => s.clear())]);
