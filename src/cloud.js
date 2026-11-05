// Supabase (shared with Progress Pad) + an IndexedDB offline cache.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
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
    is_shared: !!r.is_shared, added: Date.parse(r.created_at) || Date.now(), updated_at: r.updated_at,
  };
}
const r3 = v => Math.round(v * 1000) / 1000;
export function trackToRow(t, withPeaks) {
  const row = {
    title: (t.title || 'Untitled').slice(0, 200), category: t.category || null, description: t.description || null,
    duration_s: t.duration ? r3(t.duration) : null,
    words: t.words.map(w => ({ text: w.text, start: r3(w.start), end: r3(w.end) })),
    chapters: t.chapters.map(c => ({ t: r3(c.t), title: c.title })),
    is_shared: !!t.is_shared,
  };
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
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
function req(store, mode, fn) {
  return db().then(d => d && new Promise(res => {
    try { const q = fn(d.transaction(store, mode).objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }
    catch { res(null); }
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
export const cacheClear = () => Promise.all([req('memos', 'readwrite', s => s.clear()), req('audio', 'readwrite', s => s.clear())]);
