import './style.css';
import {
  supabase, configured, BUCKET, TABLE, FREE_STORAGE, MAX_FILE,
  rowToTrack, trackToRow, cacheAll, cachePut, cacheDel, audioGet, audioPut, audioDel, audioKeys, cacheClear,
} from './cloud.js';
import { transcriptChapters } from './chapters.js';
import { parseScript, alignToAsr, spreadOverVoice, scriptChapters } from './script.js';
import { displayStarts } from './sync.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const THEMES = {
  pt: ['#25DD5F', '#FFB000', '#EB7100', '#E10195'],
  cool: ['#B3D5DD', '#5197A8', '#25DD5F', '#FFCD5E'],
  rainbow: ['#00E5FF', '#25DD5F', '#FFE600', '#FF8A00', '#E10195', '#9B5CFF'],
};
// chapters lead with amber; green is kept for playing / active states
const CHAP_COLS = ['#FFB000', '#E10195', '#5197A8', '#EB7100', '#FFCD5E', '#B3D5DD'];
const DEFAULT_CATS = ['Confidence', 'Tasks', 'Mornings', 'Mindset', 'Gratitude'];
const BPS = 20; // waveform bars per second
const MB = 1048576;
let theme = localStorage.getItem('vma.theme') || 'pt', model = localStorage.getItem('vma.model') || (matchMedia('(pointer:coarse)').matches ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-base.en');
let tracks = [], cur = null; // {id,user_id,title,category,audio_path,duration,peaks,words,chapters,is_shared,added,blob?}
let mode = 'wave';
let user = null;
let catFilter = '';
let srcUrl = null;

// ---------- helpers ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = n => String(n).padStart(2, '0');
// the big clock: minutes and seconds (hours too on long tracks)
const clockFmt = s => { s = Math.floor(Math.max(0, s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`; };
const short = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`; };
function lerpCol(cols, f) { f = clamp(f, 0, 1) * (cols.length - 1); const i = Math.min(cols.length - 2, Math.floor(f)), k = f - i; const a = hex(cols[i]), b = hex(cols[i + 1]); return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(',')})`; }
function hex(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function status(t, err) { const s = $('status'); s.textContent = t || ''; s.className = 'status' + (err ? ' err' : ''); }
let toastT;
function toast(t, warn, ms = 4200, action) {
  const el = $('toast'); el.textContent = t; el.className = 'toast show' + (warn ? ' warn' : '');
  if (action) { const b = document.createElement('button'); b.className = 'tact'; b.textContent = action.label; b.onclick = () => { el.className = 'toast'; clearTimeout(toastT); action.run(); }; el.append(' ', b); }
  clearTimeout(toastT); toastT = setTimeout(() => el.className = 'toast', ms);
}
const mb = b => (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
const isOwn = t => !!(t && user && t.user_id === user.id);
const norm = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newAC = () => new (window.AudioContext || window.webkitAudioContext)();
// decode straight to a lower sample rate: far less memory for long recordings on phones
async function decodeAt(blob, sr) {
  const O = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!O) return decode(blob);
  try { return await new O(1, 1, sr).decodeAudioData(await blob.arrayBuffer()); } catch { return decode(blob); }
}
function fileDuration(f) {
  return new Promise(res => { const a = document.createElement('audio'), u = URL.createObjectURL(f); let done = false; const fin = v => { if (done) return; done = true; URL.revokeObjectURL(u); res(v); };
    a.preload = 'metadata'; a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : 0); a.onerror = () => fin(0); setTimeout(() => fin(0), 8000); a.src = u; });
}
async function decode(blob) { const ac = newAC(); try { return await ac.decodeAudioData(await blob.arrayBuffer()); } finally { ac.close && ac.close(); } }

// ---------- saving (Supabase is the source of truth, IndexedDB is the offline cache) ----------
function save(t = cur, now) {
  if (!t || !isOwn(t)) return Promise.resolve();
  cachePut(t);
  clearTimeout(t._save);
  const run = async () => {
    const { error } = await supabase.from(TABLE).update(trackToRow(t, false)).eq('id', t.id);
    if (error) { status('Could not save to MemoPad: ' + error.message, true); throw error; }
  };
  if (now) return run();
  t._save = setTimeout(() => run().catch(() => {}), 700);
  return Promise.resolve();
}

// ---------- sign in ----------
function showAuth(msg) {
  $('app').hidden = true; $('auth').hidden = false;
  if (msg) { $('authMsg').textContent = msg; $('authMsg').className = 'authmsg'; }
}
$('authForm').onsubmit = async e => {
  e.preventDefault();
  const m = $('authMsg'); m.className = 'authmsg ok'; m.textContent = 'Signing in…'; $('authGo').disabled = true;
  const { error } = await supabase.auth.signInWithPassword({ email: $('authEmail').value.trim(), password: $('authPass').value });
  $('authGo').disabled = false;
  if (error) { m.className = 'authmsg'; m.textContent = /invalid/i.test(error.message) ? 'That email and password did not match. Try again.' : error.message; }
  else m.textContent = '';
};
$('authGoogle').onclick = async () => {
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/' } });
  if (error) { $('authMsg').className = 'authmsg'; $('authMsg').textContent = error.message; }
};
$('signOut').onclick = async () => {
  if (!confirm('Sign out of MemoPad on this device?')) return;
  audio.pause(); await supabase.auth.signOut(); await cacheClear(); location.reload();
};

// ---------- start ----------
async function start(u) {
  if (user && user.id === u.id) return;
  user = u;
  $('auth').hidden = true; $('app').hidden = false;
  $('whoTxt').textContent = u.email || 'Signed in'; $('whoSide').textContent = u.email || '';
  // instant: show the offline cache, then refresh from Supabase
  const cached = (await cacheAll()).filter(t => t.user_id === u.id || t.is_shared);
  tracks = cached.map(t => ({ ...t, peaks: t.peaks ? Float32Array.from(t.peaks) : null })).sort((a, b) => b.added - a.added);
  loadPlaylists(); loadFavs(); loadStats(); loadPP(); offline = new Set(await audioKeys());
  renderCats(); renderLib(); if (!openDeep()) { if (tracks[0]) select(tracks[0]); else showEmpty(); }
  requestAnimationFrame(loop);
  await refresh();
  syncListens();
  importSharedPlaylist();
  if (sessionStorage.getItem('mp.deep') && !openDeep()) { sessionStorage.removeItem('mp.deep'); toast('That memo is not shared with you, or it was removed.', true); }
  refreshStorage();
}
// light list first; the big parts (transcript, waveform, script) only for memos that changed since this device saw them
const LIGHT = 'id,user_id,title,category,audio_path,duration_s,chapters,is_shared,is_public,created_at,updated_at';
async function refresh() {
  const { data, error } = await supabase.from(TABLE).select(LIGHT).order('created_at', { ascending: false });
  if (error) { if (!tracks.length) status('Offline. Showing what is saved on this device.'); return; }
  const prev = new Map(tracks.map(t => [t.id, t]));
  const need = data.filter(r => { const p = prev.get(r.id); return !p || p.updated_at !== r.updated_at; }).map(r => r.id);
  const heavy = new Map();
  if (need.length) {
    const h = await supabase.from(TABLE).select('id,words,peaks,description').in('id', need);
    if (h.error) { if (!tracks.length) status('Could not load your memos. Check your connection.', true); return; }
    h.data.forEach(r => heavy.set(r.id, r));
  }
  const changed = new Set(need);
  const fresh = data.map(r => {
    const p = prev.get(r.id);
    if (!changed.has(r.id)) { const t = rowToTrack({ ...r, words: p.words, peaks: null, description: p.description }); t.peaks = p.peaks; t.blob = p.blob; return t; }
    const t = rowToTrack({ ...r, ...heavy.get(r.id) }); if (p) { t.blob = p.blob; if (!t.peaks && p.peaks) t.peaks = p.peaks; } return t;
  });
  // keep the selected object if it still exists, so playback isn't interrupted
  const curId = cur && cur.id;
  if (cur) { const f = fresh.find(t => t.id === curId); if (f && f.updated_at === cur.updated_at) fresh[fresh.indexOf(f)] = cur; else if (f) { Object.assign(cur, f); fresh[fresh.indexOf(f)] = cur; } }
  const gone = tracks.filter(t => !fresh.some(f => f.id === t.id));
  gone.forEach(t => cacheDel(t.id));
  tracks = fresh; tracks.forEach(t => { if (changed.has(t.id)) cachePut(t); });
  renderCats(); renderLib();
  if (!curId || !tracks.some(t => t.id === curId)) { cur = null; tracks[0] ? select(tracks[0]) : showEmpty(); }
  else if (changed.has(curId)) { renderChapters(); renderTranscript(); drawOverview(); updateMain(); }
}

// ---------- storage meter ----------
let storageUsed = 0;
let orphans = [];
$('orphBtn').onclick = async () => {
  // check again against the database before removing anything
  const { data, error } = await supabase.from(TABLE).select('audio_path').eq('user_id', user.id);
  if (error) { toast('Could not check your memos: ' + error.message, true); return; }
  const used = new Set(data.map(r => r.audio_path));
  const del = orphans.map(f => `${user.id}/${f.name}`).filter(p => !used.has(p));
  if (!del.length) { refreshStorage(); return; }
  const r = await supabase.storage.from(BUCKET).remove(del);
  if (r.error) { toast('Could not remove them: ' + r.error.message, true); return; }
  toast(`Removed ${del.length} leftover file${del.length === 1 ? '' : 's'}.`); refreshStorage();
};
async function refreshStorage() {
  let used = null; // add up my own audio files
  const l = await supabase.storage.from(BUCKET).list(user.id, { limit: 1000 });
  if (!l.error && Array.isArray(l.data)) used = l.data.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  if (used == null) { $('storeTxt').textContent = 'Storage use is not available offline.'; return; }
  storageUsed = used;
  // files with no memo (left behind by an upload that stopped half way), older than an hour
  const hour = Date.now() - 3600e3, paths = new Set(tracks.map(t => t.audio_path)), pend = new Set([...pendingDel.keys()]);
  orphans = (l.data || []).filter(f => f.id && !paths.has(`${user.id}/${f.name}`) && !pend.has(f.name.replace(/\.\w+$/, '')) && Date.parse(f.created_at || 0) < hour);
  const ob = $('orphBtn'); ob.hidden = !orphans.length;
  if (orphans.length) ob.textContent = `Remove ${orphans.length} leftover file${orphans.length === 1 ? '' : 's'} (${mb(orphans.reduce((a, f) => a + (f.metadata?.size || 0), 0))})`;
  const pct = used / FREE_STORAGE * 100, warn = pct >= 70;
  $('storeBar').style.width = Math.min(100, pct).toFixed(1) + '%'; $('storeBar').classList.toggle('warn', warn);
  $('storeTxt').textContent = `${mb(used)} of 1 GB used (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)${warn ? ' · nearly full' : ''}`;
  $('storeTxt').classList.toggle('warn', warn);
  if (warn && !sessionStorage.getItem('mp.warned')) { sessionStorage.setItem('mp.warned', '1'); toast(`MemoPad storage is ${Math.round(pct)}% full (${mb(used)} of 1 GB). Delete old memos or compress more to make room.`, true, 7000); }
}

// ---------- adding audio ----------
$('drop').onclick = e => { if (e.target.id !== 'chooseBtn') $('file').click(); };
$('chooseBtn').onclick = $('browse').onclick = () => $('file').click();
$('libSearchBtn').onclick = () => { const w = $('libSearch'); w.hidden = !w.hidden; if (!w.hidden) $('libq').focus(); else if ($('libq').value) { $('libq').value = ''; renderLib(); } };
$('file').onchange = e => { queueFiles([...e.target.files]); e.target.value = ''; };
let dragN = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragN++; document.body.classList.add('dragging'); $('drop').classList.add('over'); });
addEventListener('dragleave', e => { e.preventDefault(); if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dragging'); $('drop').classList.remove('over'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragN = 0; document.body.classList.remove('dragging'); $('drop').classList.remove('over');
  if (!user) return;
  const files = [...e.dataTransfer.files];
  files.filter(f => /\.(srt|vtt)$/i.test(f.name)).forEach(f => f.text().then(importSRT));
  queueFiles(files.filter(f => /^(audio|video)\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm)$/i.test(f.name)));
});
let queue = Promise.resolve();
function queueFiles(files) { files.forEach(f => { queue = queue.then(() => addFile(f)).catch(() => {}); }); closeLib(); }

// Every upload is compressed on this device first (Standard preset), then stored in Supabase.
async function addFile(f, preCompressed) {
  if (!navigator.onLine) { toast('You are offline. Connect to the internet to add audio.', true); return; }
  const before = f.size, base = f.name.replace(/\.[^.]+$/, '');
  uploading(true);
  try {
    status(`Reading ${f.name}…`); prog(3);
    const d0 = preCompressed ? 0 : await fileDuration(f), p = settingsFor('standard', d0, 49);
    if (lowPower && d0 > 1800) p.sr = Math.min(p.sr, 22050); // long recordings on a phone: keep memory low
    let ab;
    try { ab = preCompressed ? await decodeAt(f, 8000) : await decodeAt(f, p.sr); }
    catch (err) { throw new Error(before > 60 * MB ? `${f.name} is too long for this device to read in one go. Try adding it on a computer, or split it into parts under about 60 minutes` : `could not read the audio in ${f.name}`); }
    let out = f;
    if (!preCompressed) {
      status(`Compressing ${mb(before)}…`);
      if (!d0) Object.assign(p, settingsFor('standard', ab.duration, 49), lowPower && ab.duration > 1800 ? { sr: Math.min(p.sr, 22050) } : {});
      const blob = await compress(ab, p, { trim: $('cvTrim').checked, norm: $('cvNorm').checked, fmt: 'mp3' }, x => { prog(5 + 70 * x); status(`Compressing ${mb(before)}… ${Math.round(x * 100)}%`); });
      out = new File([blob], base + '.mp3', { type: 'audio/mpeg' });
      if (out.size >= before && /mpeg|mp3/.test(f.type + f.name)) { out = f; }
      else { ab = null; ab = await decodeAt(out, 8000); } // only needed for the waveform and length
    }
    if (out.size > MAX_FILE) throw new Error(`it is still ${mb(out.size)} after compressing. The free plan allows up to 50 MB per file. Try the Voice memo preset or "Fit under a size" in Convert or compress`);
    if (storageUsed && storageUsed + out.size > FREE_STORAGE) throw new Error('MemoPad storage is full (1 GB). Delete some memos first');
    const t = {
      id: crypto.randomUUID(), user_id: user.id, title: base.replace(/[_]+/g, ' ').trim() || 'Untitled', category: catFilter || null, description: null,
      duration: ab.duration, peaks: computePeaks(ab), words: [], chapters: [], is_shared: false, added: Date.now(), blob: out,
    };
    t.chapters = silenceChapters(t.peaks, ab.duration);
    const ext = out.type === 'audio/wav' ? 'wav' : 'mp3';
    t.audio_path = `${user.id}/${t.id}.${ext}`;
    status(`Uploading ${mb(out.size)}…`); prog(80);
    const up = await supabase.storage.from(BUCKET).upload(t.audio_path, out, { contentType: out.type || 'audio/mpeg', upsert: false });
    if (up.error) throw new Error('upload failed: ' + up.error.message);
    const ins = await supabase.from(TABLE).insert({ id: t.id, user_id: user.id, audio_path: t.audio_path, ...trackToRow(t, true) }).select().single();
    if (ins.error) { await supabase.storage.from(BUCKET).remove([t.audio_path]); throw new Error('could not save: ' + ins.error.message); }
    t.updated_at = ins.data.updated_at; t.added = Date.parse(ins.data.created_at) || t.added;
    tracks.unshift(t); cachePut(t); audioPut(t.id, out);
    renderCats(); renderLib(); cur = null; await select(t);
    prog(null); status('');
    const saved = Math.max(0, Math.round((1 - out.size / before) * 100));
    toast(out === f ? `Added "${t.title}" (${mb(out.size)}).` : `Compressed ${mb(before)} → ${mb(out.size)}${saved ? ` (${saved}% smaller)` : ''}. Saved to MemoPad ✓`);
    storageUsed += out.size; refreshStorage();
    enqueueTranscribe(t, true);
  } catch (err) {
    prog(null); status('');
    toast(`Could not add ${f.name}: ${err.message || err}.`, true, 8000);
  } finally { uploading(false); }
}
let upBusy = false;
function uploading(on) { upBusy = on; updateMain(); }

function computePeaks(ab) {
  const ch = ab.getChannelData(0), ch2 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null, n = Math.max(1, Math.ceil(ab.duration * BPS)), step = Math.max(1, Math.floor(ch.length / n)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = i * step; j < (i + 1) * step && j < ch.length; j += 4) { const v = ch2 ? (ch[j] + ch2[j]) / 2 : ch[j]; s += v * v; c++; } out[i] = Math.sqrt(s / (c || 1)); }
  let mx = 0; for (const v of out) mx = Math.max(mx, v); for (let i = 0; i < n; i++) out[i] = Math.pow(out[i] / (mx || 1), 0.7);
  return out;
}
// chapters from pauses, before any transcript exists
function silenceChapters(p, dur) {
  const chs = [{ t: 0, title: 'Start' }], thr = 0.08; let run = 0;
  for (let i = 0; i < p.length; i++) { if (p[i] < thr) run++; else { if (run >= BPS * 1.4) { const t = i / BPS - 0.15; if (t - chs[chs.length - 1].t >= 15 && dur - t > 5) chs.push({ t, title: 'Part ' + (chs.length + 1) }); } run = 0; } }
  if (chs.length === 1 && dur > 90) { for (let t = 60; t < dur - 10; t += 60) chs.push({ t, title: 'Part ' + (chs.length + 1) }); }
  return chs;
}

// ---------- library ----------
function allCats() {
  const custom = JSON.parse(localStorage.getItem('mp.cats') || '[]');
  const used = tracks.map(t => t.category).filter(Boolean);
  return [...new Set([...DEFAULT_CATS, ...custom, ...used])];
}
function renderCats() {
  const C = $('cats'); C.innerHTML = '';
  ['', LOVED, ...allCats()].forEach(c => {
    const b = document.createElement('button'); b.textContent = c === LOVED ? '♥ Loved' : c || 'All'; b.className = (c === catFilter ? 'on' : '') + (c === LOVED ? ' lovedcat' : '');
    b.onclick = () => { catFilter = c; renderCats(); renderLib(); }; C.appendChild(b);
  });
}
$('libq').addEventListener('input', () => renderLib());
function textOf(t) { if (t._text == null) t._text = norm(t.words.map(w => w.text).join(' ')); return t._text; }
// ---------- Voice Memos style: tap a memo to open a small player right in the list ----------
let libFold = false, foldT = 0;
// once a memo is playing, its box folds down to a slim row with a progress line (tap the row to open it again)
audio.addEventListener('play', () => { clearTimeout(foldT); foldT = setTimeout(() => { if (!audio.paused && !libFold && document.querySelector('#lib .vexp:not(.vpk)')) { libFold = true; renderLib(); } }, 1500); });
const IC = {
  heart: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.4 0 5.6 3.4 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  heartOn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.4 0 5.6 3.4 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  wave: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="3" y="10" width="2" height="4" rx="1"/><rect x="7" y="7" width="2" height="10" rx="1"/><rect x="11" y="4" width="2" height="16" rx="1"/><rect x="15" y="8" width="2" height="8" rx="1"/><rect x="19" y="10.5" width="2" height="3" rx="1"/></svg>',
  back: '<svg viewBox="0 0 52 52" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M26 9a17 17 0 1 1-15.6 10.2"/><path d="M26 3v12l-8-6z" fill="currentColor" stroke="none"/><text x="26" y="33" font-size="15" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="Poppins">15</text></svg>',
  fwd: '<svg viewBox="0 0 52 52" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M26 9a17 17 0 1 0 15.6 10.2"/><path d="M26 3v12l8-6z" fill="currentColor" stroke="none"/><text x="26" y="33" font-size="15" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="Poppins">15</text></svg>',
  play: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>',
  bin: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};
// the ⋯ menu on an open memo, like Voice Memos
function libMoreBtn(t, row) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'vmore'; b.title = 'More options'; b.setAttribute('aria-label', 'More options');
  b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  b.onclick = e => { e.stopPropagation(); const open = row.querySelector('.vmenu'); if (open) { open.remove(); return; } row.appendChild(libMenu(t, row)); };
  return b;
}
function libMenu(t, row) {
  const m = document.createElement('div'); m.className = 'vmenu'; const own = isOwn(t), hasTx = t.words.length > 0;
  const items = [
    own && ['Rename', '✎', () => renameInList(t, row)],
    hasTx && ['Favourite this line', '☆', () => { const sn = nowSentence(); if (sn) toggleFav(sn[0], sn[1]); }],
    hasTx && ['Copy transcript', '⧉', () => copyText(t.words.map(w => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'))],
    ['Edit in the full player', '〰', () => closeLib()],
    ['Share', '↗', () => $('shareBtn').click()],
    ['Add to a playlist', '+', () => openAddPl({ m: t.id, label: t.title })],
    own && ['Delete', '🗑', () => deleteTrack(t), 'del'],
  ].filter(Boolean);
  items.forEach(([label, ic, run, cls]) => { const x = document.createElement('button'); x.type = 'button'; if (cls) x.className = cls; x.innerHTML = `<span>${label}</span><i>${ic}</i>`; x.onclick = e => { e.stopPropagation(); m.remove(); run(); }; m.appendChild(x); });
  m.addEventListener('click', e => e.stopPropagation());
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target) && !e.target.closest('.vmore')) { m.remove(); document.removeEventListener('pointerdown', off, true); } }, true));
  return m;
}
function renameInList(t, row) {
  const nm = row.querySelector('.nm'); if (!nm) return; libEditing = true; nm.contentEditable = 'true'; nm.classList.add('editing'); nm.focus();
  const r = document.createRange(); r.selectNodeContents(nm); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const stop = e => e.stopPropagation(); nm.addEventListener('click', stop);
  nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } if (e.key === 'Escape') { nm.textContent = t.title; nm.blur(); } });
  nm.addEventListener('blur', () => { nm.contentEditable = 'false'; nm.removeEventListener('click', stop); const v = nm.textContent.trim(); libEditing = false; if (v && v !== t.title) { t.title = v; if (t === cur) $('ttl').textContent = v; save(t); toast('Renamed ✓', false, 1500); } renderLib(); }, { once: true });
}
function libRowPlayer(t) {
  const x = document.createElement('div'); x.className = 'vexp';
  x.innerHTML = `<div class="vbar"><i></i><b></b></div><div class="vtimes"><span class="vnow">0:00</span><span class="vrem">-${short(t.duration)}</span></div>
    <div class="vctl"><button type="button" class="vb vwave" title="Open the full player" aria-label="Open the full player">${IC.wave}</button><span class="vmid"><button type="button" class="vb" data-a="back" aria-label="Back 15 seconds">${IC.back}</button><button type="button" class="vb vplay" data-a="play" aria-label="Play">${audio.paused ? IC.play : IC.pause}</button><button type="button" class="vb" data-a="fwd" aria-label="Forward 15 seconds">${IC.fwd}</button></span>${isOwn(t) ? `<button type="button" class="vb vbin" title="Delete" aria-label="Delete ${esc(t.title)}">${IC.bin}</button>` : '<span class="vb"></span>'}</div>`;
  x.addEventListener('click', e => e.stopPropagation());
  x.querySelector('.vwave').onclick = () => closeLib();
  x.querySelector('[data-a=back]').onclick = () => jump(-15);
  x.querySelector('[data-a=fwd]').onclick = () => jump(15);
  x.querySelector('.vplay').onclick = () => togglePlay();
  x.querySelector('.vbin')?.addEventListener('click', () => deleteTrack(t));
  const bar = x.querySelector('.vbar'); let dragging = false;
  const seek = e => { const r = bar.getBoundingClientRect(); audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * dur(); updateLibRow(); };
  bar.addEventListener('pointerdown', e => { dragging = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', e => dragging && seek(e));
  bar.addEventListener('pointerup', () => dragging = false);
  return x;
}
function updateLibRow() {
  const th = document.querySelector('#lib .vthin i'); if (th && cur) th.style.width = clamp((audio.currentTime || 0) / (dur() || 1), 0, 1) * 100 + '%';
  const x = document.querySelector('#lib .vexp:not(.vpk)'); if (!x || !cur) return;
  const t = audio.currentTime || 0, D = dur() || 1, pc = clamp(t / D, 0, 1) * 100 + '%';
  x.querySelector('.vbar i').style.width = pc; x.querySelector('.vbar b').style.left = pc;
  x.querySelector('.vnow').textContent = short(t); x.querySelector('.vrem').textContent = '-' + short(Math.max(0, D - t));
}

// the memo you played most recently sits at the top of the list
const recentKey = () => 'mp.recent.' + (user ? user.id : 'x');
let _recent = null, recentSnap = null; // the list order only changes when you pick another memo, so the one playing stays put
function recentMap() { if (!_recent) { try { _recent = JSON.parse(localStorage.getItem(recentKey())) || {}; } catch { _recent = {}; } } return _recent; }
function markRecent(t) { if (!t) return; const R = recentMap(); R[t.id] = Date.now(); try { localStorage.setItem(recentKey(), JSON.stringify(R)); } catch {} }
let libEditing = false, peek = null, peekT = 0;
const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches; // peek: a memo opened in the list while another keeps playing
// the drop-down for a memo you tapped while another is playing: the music only changes when you press Play
// get the audio ready while the memo is dropped down, so pressing Play starts it straight away (Safari and iPhone only allow sound right inside the tap)
function prepAudio(t) {
  if (t._readyUrl || t._prepping || t === cur) return;
  t._prepping = (async () => {
    try {
      const blob = t.blob || await audioGet(t.id);
      if (blob) { t.blob = blob; t._readyUrl = URL.createObjectURL(blob); return; }
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(t.audio_path, 3600);
      if (data) { t._readyUrl = data.signedUrl; t._readyAt = Date.now(); }
    } catch { /* falls back to the normal load */ } finally { t._prepping = null; }
  })();
}
// a dropped-down memo that isn't playing yet: the same player as usual; the current memo keeps playing until you press Play
function peekBox(t) {
  const x = document.createElement('div'); x.className = 'vexp vpk';
  const D = t.duration || 0, saved = +localStorage.getItem('mp.pos.' + t.id) || 0;
  let st = saved >= 5 && saved < D - 10 ? saved : 0;
  x.innerHTML = `<div class="vbar"><i></i><b></b></div><div class="vtimes"><span class="vnow"></span><span class="vrem"></span></div>
    <div class="vctl"><button type="button" class="vb vwave" title="Open in the full player" aria-label="Open in the full player">${IC.wave}</button><span class="vmid"><button type="button" class="vb" data-a="back" aria-label="Back 15 seconds">${IC.back}</button><button type="button" class="vb vplay" data-a="play" aria-label="Play ${esc(t.title)}">${IC.play}</button><button type="button" class="vb" data-a="fwd" aria-label="Forward 15 seconds">${IC.fwd}</button></span>${isOwn(t) ? `<button type="button" class="vb vbin" title="Delete" aria-label="Delete ${esc(t.title)}">${IC.bin}</button>` : '<span class="vb"></span>'}</div>`;
  const show = () => { const pc = (D ? clamp(st / D, 0, 1) * 100 : 0) + '%'; x.querySelector('.vbar i').style.width = pc; x.querySelector('.vbar b').style.left = pc; x.querySelector('.vnow').textContent = short(st); x.querySelector('.vrem').textContent = '-' + short(Math.max(0, D - st)); };
  show(); prepAudio(t);
  x.addEventListener('click', e => e.stopPropagation());
  const go = open => {
    clearTimeout(peekT); peek = null; stopPlaylist(); libFold = false; skipResume = true;
    if (t._readyUrl && Date.now() - (t._readyAt || Date.now()) > 3000e3) t._readyUrl = null; // signed links last an hour
    const ready = !!t._readyUrl;
    const p = select(t); // with the audio ready, this swaps the track right now, inside your tap
    if (ready) playFrom(st); else p.then(() => { if (cur === t) playFrom(st); });
    if (open) closeLib();
    renderLib();
  };
  x.querySelector('.vplay').onclick = () => go(false);
  x.querySelector('.vwave').onclick = () => go(true);
  x.querySelector('[data-a=back]').onclick = () => { st = Math.max(0, st - 15); show(); };
  x.querySelector('[data-a=fwd]').onclick = () => { st = Math.min(Math.max(0, D - 1), st + 15); show(); };
  x.querySelector('.vbin')?.addEventListener('click', () => { peek = null; deleteTrack(t); });
  const bar = x.querySelector('.vbar'); let dragging = false;
  const seek = e => { const r = bar.getBoundingClientRect(); st = clamp((e.clientX - r.left) / r.width, 0, 1) * D; show(); };
  bar.addEventListener('pointerdown', e => { dragging = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', e => dragging && seek(e));
  bar.addEventListener('pointerup', () => dragging = false);
  return x;
}
function renderLib() {
  if (libEditing || document.querySelector('#lib .vmenu')) return;
  const L = $('lib'); L.innerHTML = '';
  const q = norm($('libq').value.trim());
  const ok = t => (!catFilter || (catFilter === LOVED ? isLoved(t) : t.category === catFilter)) && (!q || norm(t.title).includes(q) || textOf(t).includes(q));
  const R = recentSnap || (recentSnap = { ...recentMap() }), byRecent = (a, b) => (R[b.id] || 0) - (R[a.id] || 0);
  const mine = tracks.filter(t => isOwn(t) && ok(t)).sort(byRecent), shared = tracks.filter(t => !isOwn(t) && ok(t)).sort(byRecent);
  const when = ms => { const d = new Date(ms), now = new Date(), day = 864e5, d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= d0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`; if (ms >= d0 - day) return 'Yesterday';
    if (ms >= d0 - 6 * day) return d.toLocaleDateString(undefined, { weekday: 'long' }); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  const txIcon = '<svg class="txi" viewBox="0 0 28 28" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 6h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-5 4v-4H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M10 11.5h2.5v2.5c0 1.4-.8 2.3-2 2.6M15.5 11.5H18v2.5c0 1.4-.8 2.3-2 2.6" stroke-width="1.8"/></svg>';
  const section = (title, list) => {
    if (!list.length) return; if (title) { const h = document.createElement('h4'); h.textContent = title; L.appendChild(h); }
    list.forEach(t => {
      const d = document.createElement('div'); d._t = t; d.className = 'item vm' + (t === cur ? ' on' : '') + (t === cur && !audio.paused ? ' playing' : '');
      const tags = [t.category ? `<span class="cat">${esc(t.category)}</span>` : '', isOwn(t) && t.is_public ? '<span class="sh">public</span>' : '', offline.has(t.id) ? '<span class="sh">offline</span>' : '', txing === t ? '<span class="sh">transcribing…</span>' : txQueue.includes(t) ? '<span class="sh">waiting</span>' : ''].join('');
      d.innerHTML = `<div class="vmain"><div class="nm">${esc(t.title)}</div><div class="mt"><span>${when(t.added)}</span>${playsOf(t) ? `<span class="plays" title="Times played">▶ ${playsOf(t)}</span>` : ''}${t.words.length ? txIcon : ''}${tags}</div></div><button type="button" class="vlove${isLoved(t) ? ' on' : ''}" aria-label="${isLoved(t) ? 'Remove from Loved' : 'Love this memo'}" title="${isLoved(t) ? 'Remove from Loved' : 'Love this memo'}">${isLoved(t) ? IC.heartOn : IC.heart}</button><div class="vdur">${short(t.duration)}</div>`;
      d.querySelector('.vlove').onclick = e => { e.stopPropagation(); toggleLove(t); };
      // with a mouse: hover over another memo to drop it down (nothing stops playing)
      if (canHover) {
        d.addEventListener('mouseenter', () => { clearTimeout(peekT); if (t !== cur && peek !== t) { peek = t; libFold = true; renderLib(); } });
        d.addEventListener('mouseleave', () => { clearTimeout(peekT); peekT = setTimeout(() => { if (peek === t) { peek = null; renderLib(); } }, 350); });
      }
      d.onclick = e => {
        if (canHover && t !== cur && peek === t && !audio.paused) return; // already dropped down by hovering
        // like iPhone Voice Memos: tap opens the memo (press play yourself); tap the open one to fold it
        if (t === cur) { libFold = !libFold; peek = null; renderLib(); return; }
        // something is playing: don't stop it, just drop down this memo with a Play button
        if (!audio.paused) { peek = peek === t ? null : t; if (peek) libFold = true; renderLib(); return; }
        peek = null; stopPlaylist(); libFold = false; select(t); renderLib();
      };
      const acts = document.createElement('div'); acts.className = 'vacts';
      { const a = document.createElement('button'); a.className = 'idel iadd'; a.title = 'Add to a playlist'; a.setAttribute('aria-label', 'Add ' + t.title + ' to a playlist'); a.textContent = '+'; a.onclick = e => { e.stopPropagation(); openAddPl({ m: t.id, label: t.title }); }; acts.appendChild(a); }
      if (isOwn(t)) { const x = document.createElement('button'); x.className = 'idel'; x.title = 'Delete'; x.setAttribute('aria-label', 'Delete ' + t.title); x.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>'; x.onclick = e => { e.stopPropagation(); deleteTrack(t); }; acts.appendChild(x); }
      d.appendChild(acts);
      if (t === cur && !libFold) { d.appendChild(libMoreBtn(t, d)); d.appendChild(libRowPlayer(t)); }
      else if (t === cur) { const th = document.createElement('div'); th.className = 'vthin'; th.innerHTML = '<i></i>'; d.appendChild(th); }
      if (t === peek && t !== cur) d.appendChild(peekBox(t));
      L.appendChild(d);
    });
  };
  section('', mine);
  section('Shared with you', shared);
  renderFavs(L, q);
  renderPlaylists(L, q);
  if (!mine.length && !shared.length && !L.querySelector('.pl, .fav')) L.innerHTML = `<div class="none">${catFilter === LOVED && !q ? 'No loved memos yet. Tap the ♡ next to a memo to add it here.' : tracks.length ? 'Nothing matches.' : 'No memos yet. Add your first one above.'}</div>`;
}
function showEmpty() { cur = null; $('emptycard').style.display = 'flex'; setSrc(null); $('clist').innerHTML = ''; drawOverview(); }
function setSrc(u) { if (srcUrl && srcUrl.startsWith('blob:')) URL.revokeObjectURL(srcUrl); srcUrl = u; if (u) audio.src = u; else audio.removeAttribute('src'); }

async function select(t) {
  if (cur === t) return; savePos(true); recentSnap = { ...recentMap() }; cur = t; playCounted = null; playSecs = 0; audio.pause(); setSrc(null); stopRep();
  const own = isOwn(t);
  document.body.classList.toggle('readonly', !own);
  $('ttl').contentEditable = own ? 'true' : 'false';
  $('emptycard').style.display = 'none'; $('ttl').textContent = t.title;
  const d = new Date(t.added); $('sub').textContent = `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}   ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  renderMeta();
  search.q = ''; $('q').value = ''; $('sbar').classList.remove('has'); $('sbar').classList.add('mini'); $('qc').textContent = '';
  status(t._txMsg || ''); prog(null); renderLib(); renderChapters(); renderTranscript(); drawOverview(); updateMain();
  await loadAudio(t);
  if (own && !t.words.length && navigator.onLine) enqueueTranscribe(t, true); // like Voice Memos: no transcript yet, so start one
}
// cached copy first (works offline), otherwise a signed URL from the private bucket
async function loadAudio(t) {
  if (t._readyUrl) { const u = t._readyUrl; t._readyUrl = null; setSrc(u); audio.playbackRate = speed(); resumeAt(t); return; }
  const blob = t.blob || await audioGet(t.id);
  if (cur !== t) return;
  if (blob) { t.blob = blob; setSrc(URL.createObjectURL(blob)); audio.playbackRate = speed(); resumeAt(t); return; }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(t.audio_path, 3600);
  if (cur !== t) return;
  if (error) { status('Could not load this audio. Check your connection.', true); return; }
  setSrc(data.signedUrl); audio.playbackRate = speed(); resumeAt(t);
  // the audio streams; the whole file is only downloaded when you choose Save for offline (saves data and keeps it quick)
}
// resume where you left off: each memo remembers its spot
let skipResume = false;
function resumeAt(t) {
  if (skipResume) { skipResume = false; return; }
  if (pl) return;
  const p = +localStorage.getItem('mp.pos.' + t.id) || 0; if (p < 5 || p > (t.duration || 1e9) - 10) return;
  const go = () => { if (cur === t && pendingSeek == null && audio.currentTime < 1) { audio.currentTime = p; toast('Carrying on from ' + short(p) + '.', false, 2500); } };
  audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
}
let posSaved = 0;
function savePos(force) {
  if (!cur || !audio.src || !audio.duration) return; const now = performance.now(); if (!force && now - posSaved < 4000) return; posSaved = now;
  const t = audio.currentTime; if (t > audio.duration - 10) localStorage.removeItem('mp.pos.' + cur.id); else localStorage.setItem('mp.pos.' + cur.id, t.toFixed(1));
}
audio.addEventListener('timeupdate', () => savePos(false));
audio.addEventListener('pause', () => savePos(true));
audio.addEventListener('ended', () => {
  if (cur) localStorage.removeItem('mp.pos.' + cur.id);
  if (pl) { nextInPlaylist(); return; }
  if (sleep.chapter) return; // the sleep timer said stop here
  // carry on with the next memo down your list
  const order = [...document.querySelectorAll('#lib .item.vm')].map(el => el._t).filter(Boolean), i = order.indexOf(cur), n = order[i + 1];
  if (n) { toast('Up next: ' + n.title, false, 2500); select(n).then(() => audio.play().catch(() => {})); }
});
addEventListener('pagehide', () => savePos(true));

// sleep timer: fades out gently, then pauses
const sleep = { end: 0, chapter: false, timer: 0 };
function setSleep(v) {
  clearInterval(sleep.timer); sleep.end = 0; sleep.chapter = v === 'ch'; audio.volume = 1;
  if (v !== 'off' && v !== 'ch') sleep.end = Date.now() + +v * 60000;
  if (v !== 'off') sleep.timer = setInterval(sleepTick, 500);
  document.querySelectorAll('#sleep button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  sleepLabel(); if (v !== 'off') toast(v === 'ch' ? 'Stopping at the end of this chapter.' : `Stopping in ${v} minutes.`, false, 2500);
}
function sleepLabel() {
  const el = $('sleepLeft'); if (!el) return;
  el.textContent = sleep.end ? short(Math.max(0, (sleep.end - Date.now()) / 1000)) + ' left' : sleep.chapter ? 'end of chapter' : '';
}
function sleepTick() {
  sleepLabel();
  let left = Infinity;
  if (sleep.end) left = (sleep.end - Date.now()) / 1000;
  else if (sleep.chapter && cur) { const k = chapterAt(audio.currentTime), end = cur.chapters[k + 1]?.t ?? cur.duration; left = (end - audio.currentTime) / (audio.playbackRate || 1); }
  if (audio.paused && sleep.end) return;
  audio.volume = left < 8 ? Math.max(0, left / 8) : 1;
  if (left <= 0.15) { audio.pause(); audio.volume = 1; setSleep('off'); toast('Sleep timer: paused. Sleep well.', false, 3000); }
}
document.querySelectorAll('#sleep button').forEach(b => b.onclick = () => setSleep(b.dataset.v));

async function getBlob(t) {
  if (t.blob) return t.blob;
  const c = await audioGet(t.id); if (c) return t.blob = c;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(t.audio_path, 600);
  if (error) throw error;
  const b = await (await fetch(data.signedUrl)).blob(); t.blob = b; keepOffline(t, b); return b;
}
const speed = () => +document.querySelector('#speed .on').dataset.v;
function renderMeta() {
  const t = cur; if (!t) return; const own = isOwn(t);
  $('catBtn').textContent = t.category || (own ? 'Add category' : 'No category');
  $('catBtn').disabled = !own; $('catBtn').hidden = !own && !t.category;
  $('shareWrap').hidden = !own; $('shareTog').checked = !!t.is_shared;
  $('roTag').hidden = own;
  renderLove();
}
$('ttl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('ttl').addEventListener('blur', () => { if (!cur || !isOwn(cur)) return; const v = $('ttl').textContent.trim(); if (!v) { $('ttl').textContent = cur.title; return; } if (v !== cur.title) { cur.title = v; save(); renderLib(); } });
// share: a link that opens this memo, a chapter, or the current moment
const linkFor = (t, sec) => `${location.origin}/${t.is_public ? 'listen.html?id' : '?m'}=${t.id}${sec > 0 ? '&t=' + (Math.round(sec * 10) / 10) : ''}`;
$('shareBtn').onclick = () => {
  if (!cur) return; const k = chapterAt(audio.currentTime), c = cur.chapters[k];
  $('pubRow').hidden = !isOwn(cur); $('pubTog').checked = !!cur.is_public; shareLeadText();
  $('shChap').hidden = !(c && cur.chapters.length > 1); if (c) $('shChap').textContent = `This chapter: ${c.title}`;
  $('shHere').textContent = `From right now (${short(audio.currentTime)})`;
  $('shDlg').classList.add('open');
};
function shareLeadText() {
  $('shLead').textContent = cur.is_public ? 'Public: anyone with the link can listen and read along, no sign-up needed.' : isOwn(cur) && !cur.is_shared ? 'Turn on "Share to MemoPad" first, or only you can open the link. People need to be signed in to MemoPad to listen.' : 'People need to be signed in to MemoPad to listen.';
}
$('pubTog').onchange = async () => {
  const t = cur, on = $('pubTog').checked; if (!t || !isOwn(t)) return;
  const { error } = await supabase.from(TABLE).update({ is_public: on }).eq('id', t.id);
  if (error) { $('pubTog').checked = !on; toast(/is_public/.test(error.message) ? 'Public links need the one-time Supabase setup first.' : 'Could not change it: ' + error.message, true, 6000); return; }
  t.is_public = on; cachePut(t); shareLeadText(); renderLib(); toast(on ? 'Public link on. Anyone with the link can listen.' : 'Public link off. Old public links stop working.');
};
async function shareLink(url, title) {
  $('shDlg').classList.remove('open');
  if (navigator.share) { try { await navigator.share({ title, text: `${title} on MemoPad`, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it anywhere to share.'); } catch { prompt('Copy this link:', url); }
}
$('shMemo').onclick = () => shareLink(linkFor(cur, 0), cur.title);
$('shChap').onclick = () => { const c = cur.chapters[chapterAt(audio.currentTime)]; shareLink(linkFor(cur, c.t), `${cur.title} · ${c.title}`); };
$('shHere').onclick = () => shareLink(linkFor(cur, audio.currentTime), cur.title);
$('shClose').onclick = () => $('shDlg').classList.remove('open');
$('shDlg').addEventListener('click', e => { if (e.target.id === 'shDlg') $('shDlg').classList.remove('open'); });
// opening a shared link: remember it through sign in, then jump there
const deep = (() => { const q = new URLSearchParams(location.search); if (q.get('m')) { sessionStorage.setItem('mp.deep', JSON.stringify({ m: q.get('m'), t: +q.get('t') || 0 })); history.replaceState(null, '', '/'); } try { return JSON.parse(sessionStorage.getItem('mp.deep')); } catch { return null; } })();
function openDeep() {
  const d = deep && JSON.parse(sessionStorage.getItem('mp.deep') || 'null'); if (!d) return false;
  const t = tracks.find(x => x.id === d.m); if (!t) return false;
  sessionStorage.removeItem('mp.deep'); pl = null; cur = null; skipResume = true; select(t);
  const go = () => { if (cur === t) audio.currentTime = d.t; };
  setTimeout(() => audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true }), 0);
  return true;
}
$('shareTog').onchange = () => {
  if (!cur || !isOwn(cur)) return; cur.is_shared = $('shareTog').checked; save(cur, true).then(() => toast(cur.is_shared ? 'Shared to MemoPad. Signed-in Progress Today users can play it, but not edit it.' : 'Now private. Only you can play it.'), () => { cur.is_shared = !cur.is_shared; $('shareTog').checked = cur.is_shared; });
  renderLib();
};
// category picker
$('loveBtn').onclick = () => toggleLove(cur);
$('catBtn').onclick = () => { if (!cur || !isOwn(cur)) return; renderCatPick(); $('catDlg').classList.add('open'); };
function renderCatPick() {
  const P = $('catPick'); P.innerHTML = '';
  [...allCats(), ''].forEach(c => { const b = document.createElement('button'); b.textContent = c || 'None'; b.className = (cur.category || '') === c ? 'on' : ''; b.onclick = () => setCat(c); P.appendChild(b); });
}
function setCat(c) { cur.category = c || null; save(cur, true).catch(() => {}); renderMeta(); renderCats(); renderLib(); $('catDlg').classList.remove('open'); }
$('newCatGo').onclick = () => {
  const v = $('newCat').value.trim().replace(/\s+/g, ' '); if (!v) return;
  const custom = JSON.parse(localStorage.getItem('mp.cats') || '[]'); if (!allCats().includes(v)) { custom.push(v); localStorage.setItem('mp.cats', JSON.stringify(custom)); }
  $('newCat').value = ''; setCat(v);
};
$('newCat').addEventListener('keydown', e => { if (e.key === 'Enter') $('newCatGo').click(); });
$('catClose').onclick = () => $('catDlg').classList.remove('open');
$('catDlg').onclick = e => { if (e.target.id === 'catDlg') $('catDlg').classList.remove('open'); };
// delete
// delete with a 10 second Undo: the memo disappears at once, and is only removed for good afterwards
const pendingDel = new Map();
function deleteTrack(t) {
  if (!t || !isOwn(t) || pendingDel.has(t.id)) return; $('pop').classList.remove('open');
  const at = tracks.indexOf(t), wasCur = cur === t;
  tracks = tracks.filter(x => x !== t);
  if (wasCur) { audio.pause(); cur = null; tracks[0] ? select(tracks[0]) : showEmpty(); }
  renderCats(); renderLib();
  const timer = setTimeout(() => finishDelete(t), 10000);
  pendingDel.set(t.id, timer);
  toast(`Deleted "${t.title}".`, false, 10000, { label: 'UNDO', run: () => {
    clearTimeout(timer); pendingDel.delete(t.id);
    tracks.splice(Math.min(at, tracks.length), 0, t); renderCats(); renderLib(); if (wasCur) { cur = null; select(t); }
  } });
}
async function finishDelete(t) {
  pendingDel.delete(t.id);
  const st = await supabase.storage.from(BUCKET).remove([t.audio_path]);
  const del = await supabase.from(TABLE).delete().eq('id', t.id);
  if (del.error || st.error) { tracks.push(t); renderCats(); renderLib(); toast('Could not delete: ' + (del.error || st.error).message, true); return; }
  cacheDel(t.id); localStorage.removeItem('mp.pos.' + t.id); refreshStorage();
}
// leaving the page before the 10 seconds are up keeps the memo (nothing is lost by accident)
$('delBtn').onclick = () => deleteTrack(cur);

// library drawer on phones and tablets
function openLib() { document.body.classList.add('libopen'); }
function closeLib() { document.body.classList.remove('libopen'); }
$('moreBtn').onclick = () => { if (innerWidth <= 1180) openLib(); else $('file').click(); };
$('closeSide').onclick = $('scrim').onclick = closeLib;

// ---------- transport ----------
function togglePlay() { if (!cur || !audio.src) return; if (audio.paused) audio.play().catch(err => status('Tap play again to start (' + err.message + ').', true)); else audio.pause(); }
$('play').onclick = togglePlay;
audio.onplay = () => { markRecent(cur); $('playIcon').setAttribute('d', 'M16 10 h10 v44 h-10 Z M38 10 h10 v44 h-10 Z'); $('play').classList.add('on'); renderLib(); };
audio.onpause = () => { $('playIcon').setAttribute('d', 'M18 10 L54 32 L18 54 Z'); $('play').classList.remove('on'); renderLib(); };
audio.onerror = () => { if (cur && audio.src) status('This audio could not play. Check your connection and try again.', true); };
const jump = d => { if (cur) audio.currentTime = clamp(audio.currentTime + d, 0, audio.duration || cur.duration); };
$('back').onclick = () => jump(-15); $('fwd').onclick = () => jump(15);
// skip through chapters like songs
function prevChapter() { if (!cur) return; const t = audio.currentTime, k = chapterAt(t); if (k < 0) return; const c = cur.chapters[k]; playFrom((t - c.t > 3 || k === 0) ? c.t : cur.chapters[k - 1].t); }
function nextChapter() { if (!cur) return; const k = chapterAt(audio.currentTime); const n = cur.chapters[k + 1]; if (n) playFrom(n.t); }
// one press = next/previous affirmation; two quick presses = next/previous chapter
function prevAff() { const t = audio.currentTime, [j] = sentenceAt(Math.max(0, activeWord(t))); const [pj] = t - sentStart(j) > 1.5 ? [j] : sentenceAt(Math.max(0, j - 1)); audio.currentTime = sentStart(pj); }
function nextAff() { const [, e] = sentenceAt(Math.max(0, activeWord(audio.currentTime))); if (e + 1 < cur.words.length) audio.currentTime = sentStart(sentenceAt(e + 1)[0]); }
// presses in a row: 1 = affirmation, 2 = chapter, 3 = memo (hold the button on screen to change memo too)
let skipMem = { at: 0, dir: 0, t: 0, n: 0 };
async function skipMemo(dir) {
  if (pl) { if (dir > 0) nextInPlaylist(); else { pl.i = Math.max(0, pl.i - 1); playItem(); } return; }
  const list = [...tracks.filter(t => isOwn(t)), ...tracks.filter(t => !isOwn(t))]; if (!list.length) return;
  const i = list.indexOf(cur), t = list[(i + dir + list.length) % list.length]; if (!t || t === cur) return;
  await select(t); audio.play().catch(() => {}); toast((dir > 0 ? 'Next memo: ' : 'Previous memo: ') + t.title, false, 1800);
}
function skip(dir) {
  if (!cur) return; const n = Date.now();
  const steps = cur.words.length ? ['aff', 'ch', 'memo'] : (cur.chapters.length > 1 ? ['ch', 'memo'] : ['memo']);
  const chain = n - skipMem.at < 550 && skipMem.dir === dir ? skipMem.n + 1 : 0;
  if (chain === 0) skipMem.t = audio.currentTime;
  skipMem.at = n; skipMem.dir = dir; skipMem.n = chain;
  const step = steps[Math.min(chain, steps.length - 1)];
  if (chain && step === steps[chain - 1]) return; // already at the last level
  if (step === 'memo') { skipMem.at = 0; skipMemo(dir); return; }
  if (chain) audio.currentTime = skipMem.t;
  if (step === 'ch') { dir > 0 ? nextChapter() : prevChapter(); if (chain) toast(dir > 0 ? 'Next chapter (press again for next memo)' : 'Previous chapter (press again for previous memo)', false, 1400); }
  else dir > 0 ? nextAff() : prevAff();
}
function holdable(el, dir) {
  let t = 0, held = false;
  el.addEventListener('pointerdown', () => { held = false; t = setTimeout(() => { held = true; skipMemo(dir); }, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(e => el.addEventListener(e, () => clearTimeout(t)));
  el.addEventListener('click', e => { e.stopPropagation(); if (held) { held = false; return; } skip(dir); if (typeof rPoke === 'function' && !$('reader').hidden) rPoke(); });
  el.addEventListener('contextmenu', e => e.preventDefault());
}
holdable($('prevCh'), -1); holdable($('nextCh'), 1);
$('chapnow').onclick = () => { const el = document.querySelector('.chaps'); if (innerWidth <= 820) el.scrollIntoView({ behavior: 'smooth' }); };
// lock screen and headphone controls (iPhone shows the chapter as the track name)
const ms = navigator.mediaSession;
function updateMediaSession() {
  if (!ms || !cur) return;
  const k = chapterAt(audio.currentTime), ch = cur.chapters[k];
  try { ms.metadata = new MediaMetadata({ title: ch && cur.chapters.length > 1 ? ch.title : cur.title, artist: cur.chapters.length > 1 ? cur.title : 'MemoPad', album: 'MemoPad · Progress Today', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch { /* older browsers */ }
}
if (ms) {
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
  set('play', () => audio.play()); set('pause', () => audio.pause());
  set('previoustrack', () => skip(-1)); set('nexttrack', () => skip(1));
  set('seekbackward', () => jump(-15)); set('seekforward', () => jump(15));
  set('seekto', e => { if (e.seekTime != null) audio.currentTime = e.seekTime; });
}
addEventListener('keydown', e => {
  if (!user || $('app').hidden) return;
  if (e.target.closest('input,[contenteditable=true]')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') jump(e.shiftKey ? -5 : -15);
  else if (e.key === 'ArrowRight') jump(e.shiftKey ? 5 : 15);
  else if (e.key === 't' || e.key === 'T') setMode(mode === 'wave' ? 'tx' : 'wave');
  else if (e.key === 'c' || e.key === 'C') addChapter();
  else if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) { e.preventDefault(); setMode('tx'); $('q').focus(); }
});
document.querySelectorAll('#speed button').forEach(b => b.onclick = () => { document.querySelectorAll('#speed button').forEach(x => x.classList.toggle('on', x === b)); audio.playbackRate = +b.dataset.v; });
document.querySelectorAll('#theme button').forEach(b => { b.classList.toggle('on', b.dataset.v === theme); b.onclick = () => { theme = b.dataset.v; localStorage.setItem('vma.theme', theme); document.querySelectorAll('#theme button').forEach(x => x.classList.toggle('on', x === b)); drawOverview(); }; });
document.querySelectorAll('#model button').forEach(b => { b.classList.toggle('on', b.dataset.v === model); b.onclick = () => { model = b.dataset.v; localStorage.setItem('vma.model', model); document.querySelectorAll('#model button').forEach(x => x.classList.toggle('on', x === b)); }; });
$('setBtn').onclick = e => { e.stopPropagation(); $('pop').classList.toggle('open'); if ($('pop').classList.contains('open') && user) refreshStorage(); };
document.addEventListener('click', e => { if (!e.target.closest('#pop,#setBtn')) $('pop').classList.remove('open'); });

// ---------- view switching ----------
function setMode(m) { mode = m; $('waveWrap').style.display = m === 'wave' ? 'flex' : 'none'; $('tx').style.display = m === 'tx' ? 'block' : 'none'; $('txBtn').classList.toggle('on', m === 'tx'); $('sbar').style.display = m === 'tx' ? 'flex' : 'none'; if (m === 'tx') scrollToActive(true); }
$('txBtn').onclick = () => setMode(mode === 'wave' ? 'tx' : 'wave');
setMode('wave');

// ---------- waveform ----------
const wv = $('wave'), wx = wv.getContext('2d'), ru = $('ruler'), rx = ru.getContext('2d');
let drag = null;
function sizeCanvas(c) { const r = c.getBoundingClientRect(), d = devicePixelRatio || 1; if (c.width !== Math.round(r.width * d) || c.height !== Math.round(r.height * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); } return d; }
const PX_PER_SEC = () => wv.width / 7.5; // about 7.5 seconds visible, like a voice memo
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); ctx.fill(); }
// ---------- visualiser styles (driven by the memo's own sound levels, so it works with the screen locked or in the car) ----------
let vizStyle = (v => v === 'black' ? 'time' : ['wave', 'bars', 'circle', 'time'].includes(v) ? v : 'wave')(localStorage.getItem('mp.viz')), vizEnv = 0, vizHist = new Array(64).fill(0);
function setViz(v) { vizStyle = v; localStorage.setItem('mp.viz', v); $('waveWrap').classList.toggle('viz', v !== 'wave'); document.querySelectorAll('#vizSw button, #vfSw button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
document.querySelectorAll('#vizSw button, #vfSw button').forEach(b => b.onclick = e => { e.stopPropagation(); setViz(b.dataset.v); });
setViz(vizStyle);
function level(t) { if (!cur || !cur.peaks) return 0; const p = cur.peaks, i = Math.floor(t * BPS); let m = 0, n = 0; for (let j = i - 1; j <= i + 1; j++) if (p[j] != null) { m += p[j]; n++; } return n ? m / n : 0; }
function drawMiniWave(d, cv, wx, t, cols) {
  if (!cur || !cur.peaks) return; const W = cv.width, H = cv.height, p = cur.peaks, pps = W / 9, bw = pps / BPS, mid = H / 2;
  const i0 = Math.max(0, Math.floor((t - W / 2 / pps) * BPS)), i1 = Math.min(p.length, Math.ceil((t + W / 2 / pps) * BPS) + 1);
  for (let i = i0; i < i1; i++) { const x = W / 2 + (i / BPS - t) * pps, v = p[i], h = Math.max(2 * d, v * H * 0.5), w = Math.max(1.5 * d, bw * 0.42); wx.fillStyle = lerpCol(cols, v * 0.75 + (i / p.length) * 0.25); wx.globalAlpha = i / BPS <= t ? 1 : 0.4; rrect(wx, x - w / 2, mid - h / 2, w, h, w / 2); }
  wx.globalAlpha = 1; wx.fillStyle = '#5AA9FF'; wx.fillRect(W / 2 - d, mid - H * 0.3, 2 * d, H * 0.6);
}
// live sound analysis: a silent twin of the player feeds an analyser, so the main audio
// is never routed through Web Audio (that keeps lock screen and car playback safe)
let an = null;
const vizOn = () => ((vizStyle !== 'wave' && mode === 'wave') || !$('vFull').hidden);
function anEnsure() {
  if (an) return an;
  try {
    const el = new Audio(); el.crossOrigin = 'anonymous'; el.preload = 'auto'; el.playsInline = true; el.setAttribute('playsinline', '');
    const ac = new (window.AudioContext || window.webkitAudioContext)(), src = ac.createMediaElementSource(el), a = ac.createAnalyser(), g = ac.createGain();
    a.fftSize = 512; a.smoothingTimeConstant = 0.72; g.gain.value = 0; src.connect(a); a.connect(g); g.connect(ac.destination);
    an = { el, ac, a, data: new Uint8Array(a.frequencyBinCount), url: '' };
  } catch { an = { dead: true }; }
  return an;
}
function anSync(gesture) {
  if (gesture && vizOn() && cur) { // unlock the twin and the audio context inside a tap, so it can start later by itself
    const A = anEnsure(); if (A.dead) return;
    if (A.ac.state !== 'running') A.ac.resume().catch(() => {});
    const u = audio.currentSrc || audio.src; if (u && A.url !== u) { A.url = u; A.el.src = u; }
    if (!A.started && !A.pending && u) { A.pending = true; A.el.play().then(() => { A.started = true; A.pending = false; if (audio.paused) A.el.pause(); }).catch(() => { A.pending = false; }); }
  }
  if (!vizOn() || !cur || audio.paused || document.hidden) { if (an && an.el && !an.el.paused && !an.pending) an.el.pause(); return; }
  const A = anEnsure(); if (A.dead) return;
  const u = audio.currentSrc || audio.src; if (u && A.url !== u) { A.url = u; A.el.src = u; }
  A.el.playbackRate = audio.playbackRate || 1;
  if (A.el.readyState >= 1 && Math.abs(A.el.currentTime - audio.currentTime) > 0.3) A.el.currentTime = audio.currentTime;
  if (A.el.paused && A.started && !A.pending) { A.pending = true; A.el.play().then(() => { A.pending = false; }).catch(() => { A.pending = false; }); }
}
addEventListener('pointerdown', () => anSync(true), true);
addEventListener('keydown', () => anSync(true), true);
function anLevels() {
  if (!an || an.dead || !an.el || an.el.paused || an.ac.state !== 'running') return null;
  an.a.getByteFrequencyData(an.data); let s = 0; for (let i = 2; i < 120; i++) s += an.data[i];
  return s > 0 ? an.data : null;
}
// 32 bands spread across the voice and music range (roughly 80 Hz to 8 kHz)
const BANDS = Array.from({ length: 33 }, (_, k) => Math.round(2 + Math.pow(k / 32, 1.7) * 92));
// ---------- Listen Time view: all time in a glowing ring, with today / this week / this month on glass ----------
const hm = s => { const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
const NEON = ['#ff2d95', '#ff7a3d', '#ffd23f', '#25dd5f', '#00e5ff', '#7c4dff', '#ff2d95'];
function listenTotals() {
  const days = (typeof stats === 'object' && stats.days) || {}, now = new Date(), today = dayOf(now), month = today.slice(0, 7);
  const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // weeks start on Monday
  let week = 0; for (let i = 0; i < 7; i++) { const x = new Date(mon); x.setDate(mon.getDate() + i); week += days[dayOf(x)] || 0; }
  let mo = 0, all = 0; for (const [k, v] of Object.entries(days)) { all += v; if (k.startsWith(month)) mo += v; }
  return { today: days[today] || 0, week, month: mo, all };
}
function glow(wx, x, y, r, col, a) { const g = wx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col + Math.round(a * 255).toString(16).padStart(2, '0')); g.addColorStop(1, col + '00'); wx.fillStyle = g; wx.fillRect(x - r, y - r, r * 2, r * 2); }
function drawListenTime(cv, wx, d, band, e, now) {
  const W = cv.width, H = cv.height, M = Math.min(W, H), L = listenTotals(), font = (w, px) => `${w} ${Math.round(px)}px Poppins, system-ui, sans-serif`;
  wx.fillStyle = '#05050a'; wx.fillRect(0, 0, W, H);
  // drifting colour glows that breathe with the sound
  const b = 0.22 + e * 0.35;
  glow(wx, W * (0.2 + 0.08 * Math.sin(now * 0.3)), H * (0.25 + 0.06 * Math.cos(now * 0.4)), M * 0.75, '#ff2d95', b);
  glow(wx, W * (0.82 + 0.06 * Math.cos(now * 0.35)), H * (0.7 + 0.08 * Math.sin(now * 0.27)), M * 0.8, '#00e5ff', b * 0.85);
  glow(wx, W * 0.5, H * (0.95 + 0.04 * Math.sin(now * 0.5)), M * 0.6, '#7c4dff', b * 0.8);
  // the ring
  const cx = W / 2, cy = H * 0.4, r0 = M * 0.2 + e * M * 0.02, N = 90, rot = now * 0.15;
  wx.lineCap = 'round'; wx.lineWidth = Math.max(2.5 * d, (2 * Math.PI * r0 / N) * 0.5);
  wx.shadowBlur = 14 * d;
  for (let k = 0; k < N; k++) {
    const a = k / N * Math.PI * 2 - Math.PI / 2 + rot, kk = k < N / 2 ? k : N - k, len = band(kk % 32) * M * 0.14 + 3 * d, col = lerpCol(NEON, k / N);
    wx.strokeStyle = col; wx.shadowColor = col; wx.beginPath();
    wx.moveTo(cx + Math.cos(a) * (r0 + 4 * d), cy + Math.sin(a) * (r0 + 4 * d)); wx.lineTo(cx + Math.cos(a) * (r0 + 4 * d + len), cy + Math.sin(a) * (r0 + 4 * d + len)); wx.stroke();
  }
  wx.shadowBlur = 0;
  // glass disc
  const g = wx.createLinearGradient(cx, cy - r0, cx, cy + r0); g.addColorStop(0, '#ffffff2e'); g.addColorStop(1, '#ffffff08');
  wx.fillStyle = g; wx.beginPath(); wx.arc(cx, cy, r0, 0, 7); wx.fill();
  wx.strokeStyle = '#ffffff40'; wx.lineWidth = 1.2 * d; wx.stroke();
  wx.textAlign = 'center'; wx.textBaseline = 'middle';
  wx.fillStyle = '#ffffffb0'; wx.font = font(600, r0 * 0.15); wx.fillText('ALL TIME', cx, cy - r0 * 0.3);
  wx.fillStyle = '#fff'; wx.shadowColor = '#ff2d95'; wx.shadowBlur = 18 * d; wx.font = font(700, r0 * (hm(L.all).length > 6 ? 0.36 : 0.44)); wx.fillText(hm(L.all), cx, cy + r0 * 0.08); wx.shadowBlur = 0;
  wx.fillStyle = '#ffffff80'; wx.font = font(600, r0 * 0.12); wx.fillText('listening', cx, cy + r0 * 0.42);
  // glass tiles
  const tiles = [[L.today, 'Today', '#ff7a3d'], [L.week, 'This week', '#00e5ff'], [L.month, 'This month', '#b388ff']];
  const pad = W * 0.05, gap = W * 0.03, tw = (W - pad * 2 - gap * 2) / 3, th = Math.min(H * 0.17, tw * 0.62), ty = Math.min(H - th - H * 0.05, cy + r0 + M * 0.2);
  tiles.forEach(([v, lab, col], i) => {
    const x = pad + i * (tw + gap), rad = Math.min(16 * d, th * 0.25);
    const tg = wx.createLinearGradient(x, ty, x, ty + th); tg.addColorStop(0, '#ffffff22'); tg.addColorStop(1, '#ffffff0a');
    wx.fillStyle = tg; rrect(wx, x, ty, tw, th, rad);
    wx.strokeStyle = '#ffffff33'; wx.lineWidth = 1 * d; wx.beginPath(); wx.roundRect ? wx.roundRect(x, ty, tw, th, rad) : wx.rect(x, ty, tw, th); wx.stroke();
    wx.fillStyle = col; rrect(wx, x + tw * 0.3, ty + 2 * d, tw * 0.4, 2.5 * d, 2 * d); // a little neon edge
    wx.fillStyle = '#fff'; wx.shadowColor = col; wx.shadowBlur = 12 * d; wx.font = font(700, Math.min(th * 0.32, tw * 0.2)); wx.fillText(hm(v), x + tw / 2, ty + th * 0.45); wx.shadowBlur = 0;
    wx.fillStyle = '#ffffffa0'; wx.font = font(600, Math.min(th * 0.15, tw * 0.1)); wx.fillText(lab, x + tw / 2, ty + th * 0.76);
  });
  wx.textBaseline = 'alphabetic';
}
function drawViz(d, cv = wv, wx = cv.getContext('2d'), style = vizStyle) {
  anSync(false); const F = anLevels();
  const W = cv.width, H = cv.height, t = audio.currentTime || 0, cols = THEMES[theme], now = performance.now() / 1000;
  let live = null;
  if (F) { live = []; let tot = 0; for (let k = 0; k < 32; k++) { let m = 0; for (let i = BANDS[k]; i < Math.max(BANDS[k] + 1, BANDS[k + 1]); i++) m = Math.max(m, F[i]); const v = Math.pow(m / 255, 1.6) * (1 + k / 40); live.push(v); tot += v; } live.avg = tot / 32; }
  const playing = cur && !audio.paused, target = live ? Math.min(1, live.avg * 1.6) : playing ? Math.min(1, level(t) * 1.25) : 0.06 + 0.03 * Math.sin(now * 1.6);
  vizEnv += (target - vizEnv) * (target > vizEnv ? 0.45 : 0.12);
  vizHist.unshift(vizEnv); vizHist.length = 64;
  wx.clearRect(0, 0, W, H); wx.fillStyle = '#0b0b0d'; wx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, M = Math.min(W, H), e = vizEnv;
  const band = live ? (k => Math.max(0.03, Math.min(1, live[k % 32] * 1.15))) : k => { const N = 32, f = k / N; return Math.max(0.03, e * (0.5 + 0.5 * Math.sin(k * 0.9 + now * 4.2 + vizHist[k % 64] * 7)) * (1 - f * 0.55) + vizHist[Math.min(63, k)] * 0.25); };
  if (style === 'time') { drawListenTime(cv, wx, d, band, e, now); return; } // your listening totals, moving with the sound
  if (style === 'bars') {
    const N = 32, gap = 3 * d, bw = Math.min(18 * d, (W * 0.86 / (N * 2)) - gap), x0 = cx - (N * (bw + gap));
    for (let k = 0; k < N; k++) {
      const h = Math.max(4 * d, band(k) * H * 0.8), col = lerpCol(cols, k / N);
      wx.fillStyle = col;
      rrect(wx, cx + k * (bw + gap) + gap / 2, cy - h / 2, bw, h, bw / 2);
      rrect(wx, cx - (k + 1) * (bw + gap) + gap / 2, cy - h / 2, bw, h, bw / 2);
    }
  } else if (style === 'circle') {
    const N = 72, r0 = M * 0.17 + e * M * 0.04;
    wx.lineCap = 'round'; wx.lineWidth = Math.max(3 * d, (2 * Math.PI * r0 / N) * 0.55);
    for (let k = 0; k < N; k++) {
      const a = k / N * Math.PI * 2 - Math.PI / 2, kk = k < N / 2 ? k : N - k, len = band(kk % 32) * M * 0.2 + 3 * d;
      wx.strokeStyle = lerpCol(cols, kk / (N / 2)); wx.beginPath();
      wx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); wx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); wx.stroke();
    }
    wx.fillStyle = '#ffffff10'; wx.beginPath(); wx.arc(cx, cy, r0 - 6 * d, 0, 7); wx.fill();
  }
  if (style === 'wave') drawMiniWave(d, cv, wx, t, cols);
  if (cv === wv && cur && cur.chapters.length > 1) { const k = chapterAt(t); if (k >= 0) { wx.font = `600 ${13 * d}px Poppins`; wx.textAlign = 'center'; wx.fillStyle = '#8e8e93'; wx.fillText(cur.chapters[k].title.toUpperCase().slice(0, 40), cx, H - 14 * d); wx.textAlign = 'start'; } }
}
// full screen visualiser with the affirmation you're hearing
const vfc = $('vfCanvas'); let vfShown = -1, vfHideT = 0;
function vfPoke() { $('vFull').classList.add('ctl'); clearTimeout(vfHideT); vfHideT = setTimeout(() => { if (!audio.paused) $('vFull').classList.remove('ctl'); }, 3500); }
function openVizFull() { if (!cur) return; $('vFull').hidden = false; vfShown = -1; vfPoke(); goFull($('vFull')); try { navigator.wakeLock?.request('screen').then(w => { vfWake = w; }).catch(() => {}); } catch {} }
let vfWake = null;
function closeVizFull() { $('vFull').hidden = true; exitFull(); try { vfWake && vfWake.release(); } catch {} vfWake = null; }
function drawVizFull() {
  if ($('vFull').hidden || !cur) return; const d = sizeCanvas(vfc), t = audio.currentTime || 0;
  drawViz(d, vfc, vfc.getContext('2d'), vizStyle);
  $('vfPlay').classList.toggle('on', !audio.paused);
  if (cur.words.length) { const a = Math.max(0, activeWord(t)), [j, e] = sentenceAt(a); if (j !== vfShown) { vfShown = j; const R = $('vfSent'); R.innerHTML = ''; for (let i = j; i <= e; i++) { const sp = document.createElement('span'); sp.className = 'rw'; sp.dataset.i = i; sp.textContent = cur.words[i].text; R.append(sp, ' '); } } $('vfSent').querySelectorAll('.rw').forEach(sp => { const i = +sp.dataset.i; sp.classList.toggle('past', i < a); sp.classList.toggle('now', i === a); }); }
  else if (vfShown !== -2) { vfShown = -2; $('vfSent').textContent = cur.title; }
}
function drawWave() {
  drawVizFull(); if (!$('vFull').hidden) return;
  if (mode !== 'wave') return;
  if (vizStyle !== 'wave') { drawViz(sizeCanvas(wv)); return; }
  const d = sizeCanvas(wv); sizeCanvas(ru); const W = wv.width, H = wv.height, t = audio.currentTime || 0, pps = PX_PER_SEC(), cols = THEMES[theme];
  wx.clearRect(0, 0, W, H); wx.fillStyle = '#36363b'; wx.fillRect(0, 0, W, H);
  if (!cur || !cur.peaks) return;
  const p = cur.peaks, bw = pps / BPS, i0 = Math.max(0, Math.floor((t - W / 2 / pps) * BPS)), i1 = Math.min(p.length, Math.ceil((t + W / 2 / pps) * BPS) + 1), mid = H / 2;
  cur.chapters.forEach((c, k) => {
    const x = W / 2 + (c.t - t) * pps; if (x < -2 || x > W + 2) return; wx.fillStyle = CHAP_COLS[k % CHAP_COLS.length]; wx.globalAlpha = .85; wx.fillRect(x - 1 * d, 0, 2 * d, H); wx.globalAlpha = 1;
    wx.font = `600 ${12 * d}px Poppins`; wx.fillStyle = CHAP_COLS[k % CHAP_COLS.length]; wx.fillText(c.title.slice(0, 26), x + 6 * d, 18 * d);
  });
  for (let i = i0; i < i1; i++) {
    const x = W / 2 + (i / BPS - t) * pps, v = p[i], played = i / BPS <= t;
    const h = Math.max(2 * d, v * H * 0.78);
    wx.fillStyle = lerpCol(cols, (v * 0.75 + ((i / p.length) * 0.25))); wx.globalAlpha = played ? 1 : 0.42;
    const w = Math.max(1.5 * d, bw * 0.42); rrect(wx, x - w / 2, mid - h / 2, w, h, w / 2);
  }
  wx.globalAlpha = 1;
  wx.strokeStyle = '#5AA9FF'; wx.lineWidth = 2 * d; wx.beginPath(); wx.moveTo(W / 2, 8 * d); wx.lineTo(W / 2, H); wx.stroke();
  wx.fillStyle = '#5AA9FF'; wx.beginPath(); wx.arc(W / 2, 8 * d, 6 * d, 0, 7); wx.fill();
  const RW = ru.width, RH = ru.height; rx.clearRect(0, 0, RW, RH); rx.strokeStyle = '#666'; rx.fillStyle = '#8e8e93'; rx.lineWidth = 1 * d; rx.font = `500 ${13 * d}px Poppins`; rx.textAlign = 'center';
  const s0 = Math.floor(t - W / 2 / pps), s1 = Math.ceil(t + W / 2 / pps);
  for (let s = s0 * 4; s <= s1 * 4; s++) { const sec = s / 4; if (sec < 0) continue; const x = W / 2 + (sec - t) * pps; const major = s % 4 === 0; rx.beginPath(); rx.moveTo(x, 0); rx.lineTo(x, (major ? 9 : 5) * d); rx.stroke(); if (major) rx.fillText(short(sec), x, 26 * d); }
  rx.fillStyle = '#5AA9FF'; rx.beginPath(); rx.arc(W / 2, 3 * d, 6 * d, 0, 7); rx.fill();
}
const dur = () => (cur && (cur.duration || audio.duration)) || 0;
wv.addEventListener('pointerdown', e => { if (!cur) return; drag = { x: e.clientX, t: audio.currentTime, was: !audio.paused }; audio.pause(); wv.setPointerCapture(e.pointerId); });
wv.addEventListener('pointermove', e => { if (!drag) return; const d = devicePixelRatio || 1; audio.currentTime = clamp(drag.t - (e.clientX - drag.x) * d / PX_PER_SEC(), 0, dur()); });
const endDrag = e => { if (!drag) return; if (e.type === 'pointerup' && Math.abs(e.clientX - drag.x) < 3) { const r = wv.getBoundingClientRect(); const d = devicePixelRatio || 1; audio.currentTime = clamp(audio.currentTime + ((e.clientX - r.left) * d - wv.width / 2) / PX_PER_SEC(), 0, dur()); } if (drag.was) audio.play().catch(() => {}); drag = null; };
wv.addEventListener('pointerup', endDrag); wv.addEventListener('pointercancel', endDrag);
wv.addEventListener('wheel', e => { if (!cur) return; e.preventDefault(); audio.currentTime = clamp(audio.currentTime + (e.deltaX || e.deltaY) * 0.01, 0, dur()); }, { passive: false });

// overview strip with chapter colours
const ov = $('ov'), ox = ov.getContext('2d');
function drawOverview() {
  const d = sizeCanvas(ov), W = ov.width, H = ov.height; ox.clearRect(0, 0, W, H);
  if (!cur || !cur.peaks) return; const p = cur.peaks, n = Math.floor(W / (3 * d)), cols = THEMES[theme], t = audio.currentTime || 0, du = cur.duration || 1;
  cur.chapters.forEach((c, k) => { const x0 = c.t / du * W, x1 = (cur.chapters[k + 1]?.t ?? du) / du * W; ox.fillStyle = CHAP_COLS[k % CHAP_COLS.length]; ox.globalAlpha = .13; ox.fillRect(x0, 0, x1 - x0, H); ox.globalAlpha = 1; ox.fillRect(x0, 0, 2 * d, H); });
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / n * p.length), b = Math.max(a + 1, Math.floor((i + 1) / n * p.length)); let m = 0; for (let j = a; j < b; j++) m = Math.max(m, p[j] || 0);
    const x = i * 3 * d, h = Math.max(1.5 * d, m * H * 0.8); ox.fillStyle = lerpCol(cols, i / n); ox.globalAlpha = (i / n * du <= t) ? 1 : 0.4; ox.fillRect(x, (H - h) / 2, 2 * d, h);
  }
  ox.globalAlpha = 1; ox.fillStyle = '#fff'; ox.fillRect(t / du * W - 1 * d, 0, 2 * d, H);
}
$('ovWrap').addEventListener('pointerdown', e => { if (!cur) return; const r = ov.getBoundingClientRect(); audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * dur(); });

// ---------- chapters ----------
// tapping a chapter jumps there and plays
// works from silence too: starts playback straight away (iPhone needs that inside the tap), then lands on the spot once the audio is ready
let pendingSeek = null;
function seekTo(t) {
  if (!cur) return; pendingSeek = t;
  try { audio.currentTime = t; } catch { /* not loaded yet */ }
  if (audio.readyState >= 1 && Math.abs(audio.currentTime - t) < 0.5) { pendingSeek = null; return; }
  const land = () => { if (pendingSeek == null) return; const want = pendingSeek; pendingSeek = null; audio.currentTime = want; };
  audio.addEventListener('loadedmetadata', land, { once: true }); audio.addEventListener('canplay', land, { once: true });
}
function playFrom(t) {
  if (!cur || !audio.src) return;
  seekTo(t);
  if (audio.paused) audio.play().catch(err => status('Tap play again to start (' + err.message + ').', true));
}
function chapterAt(t) { if (!cur) return -1; let k = -1; cur.chapters.forEach((c, i) => { if (c.t <= t + 0.01) k = i; }); return k; }
function renderChapters() {
  const L = $('clist'); L.innerHTML = ''; if (!cur) return; const own = isOwn(cur);
  cur.chapters.sort((a, b) => a.t - b.t);
  cur.chapters.forEach((c, k) => {
    const d = document.createElement('div'); d.className = 'chap'; d.style.setProperty('--c', CHAP_COLS[k % CHAP_COLS.length]); d.dataset.k = k;
    d.innerHTML = `<div class="n">${k + 1}</div><div style="flex:1;min-width:0"><div class="t"></div><div class="tm">${short(c.t)}</div></div><button class="del add" title="Add to a playlist">+</button>${own ? '<button class="del" title="Delete">✕</button>' : ''}`;
    const tt = d.querySelector('.t'); tt.textContent = c.title;
    d.querySelector('.add').onclick = e => { e.stopPropagation(); const nx = cur.chapters[k + 1]; openAddPl({ m: cur.id, t0: c.t, t1: nx ? nx.t : null, label: `${cur.title} · ${c.title}` }); };
    d.onclick = () => { if (tt.isContentEditable) return; playFrom(c.t); };
    if (own) {
      tt.ondblclick = e => { e && e.stopPropagation && e.stopPropagation(); tt.contentEditable = 'true'; tt.focus(); document.getSelection().selectAllChildren(tt); };
      tt.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); tt.blur(); } };
      tt.onblur = () => { tt.contentEditable = 'false'; c.title = tt.textContent.trim() || c.title; save(); renderTranscript(); renderLib(); };
      d.querySelector('.del:not(.add)').onclick = e => { e.stopPropagation(); cur.chapters.splice(k, 1); if (!cur.chapters.length) cur.chapters.push({ t: 0, title: 'Start' }); save(); renderChapters(); renderTranscript(); drawOverview(); renderLib(); };
    }
    L.appendChild(d);
  });
  lastChap = -2;
}
function addChapter() {
  if (!cur || !isOwn(cur)) return; const t = audio.currentTime; if (cur.chapters.some(c => Math.abs(c.t - t) < 1)) return;
  const w = cur.words.find(w => w.start >= t - 0.3); const title = w ? cur.words.slice(cur.words.indexOf(w), cur.words.indexOf(w) + 5).map(x => x.text).join(' ').replace(/[,.;:!?]+$/, '') : 'Chapter at ' + short(t);
  cur.chapters.push({ t, title }); save(); renderChapters(); renderTranscript(); drawOverview(); renderLib();
  const k = cur.chapters.findIndex(c => c.t === t); const el = $('clist').querySelector(`[data-k="${k}"] .t`); if (el && el.ondblclick) el.ondblclick(new Event('dblclick'));
}
$('addch').onclick = addChapter;
// ---------- transcript ----------
let wordEls = [];
function renderTranscript() {
  const T = $('tx'); T.innerHTML = ''; wordEls = [];
  if (!cur) return;
  dispSt = [];
  if (!cur.words.length) {
    T.innerHTML = (txing === cur || txQueue.includes(cur))
      ? `<div class="empty">Transcribing in the background…<br>The words will appear here and light up as it plays.</div>`
      : isOwn(cur)
      ? `<div class="empty">No transcript yet.<br>Press <b>TRANSCRIBE</b> to turn the audio into text that lights up as it plays.<br><br><span style="font-size:15px">Runs privately on your device. The first time it downloads a speech model.${lowPower && cur.duration > 600 ? '<br>Long tracks transcribe best on a computer. Or paste your written script in Settings.' : ''}</span></div>`
      : `<div class="empty">No transcript for this memo yet.</div>`;
    return;
  }
  const chStarts = cur.chapters.map(c => c.t); let ci = 0, p = null; const hasLines = cur.words.some(w => w.p);
  const frag = document.createDocumentFragment();
  cur.words.forEach((w, i) => {
    const prev = cur.words[i - 1];
    while (ci < chStarts.length && chStarts[ci] <= w.start + 0.25) { const h = document.createElement('div'); h.className = 'ch'; const c = cur.chapters[ci]; h.textContent = `${ci + 1}. ${c.title}`; h.onclick = () => playFrom(c.t); frag.appendChild(h); p = null; ci++; }
    if (!p || (hasLines ? w.p : (prev && w.start - prev.end > 1.1 && /[.!?]$/.test(prev.text)))) { p = document.createElement('p'); frag.appendChild(p); }
    const s = document.createElement('span'); s.className = 'w'; s.textContent = w.text; s.onclick = () => { audio.currentTime = Math.max(0, w.start - 0.05); showRepBar(i); };
    p.appendChild(s); p.appendChild(document.createTextNode(' ')); wordEls.push(s);
  });
  T.appendChild(frag);
  dispSt = displayStarts(cur.words, cur.peaks, BPS); markFavs();
  lastW = -2; applySearch(false);
}
let lastW = -2, lastChap = -2, dispSt = [];
// a word lights up just as it is heard (the small lead covers the screen's own delay)
function activeWord(t) { const W = dispSt; t += 0.06; let lo = 0, hi = W.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
function updateTranscript() {
  if (!cur || !cur.words.length || mode !== 'tx') return; const t = audio.currentTime; const a = activeWord(t);
  if (a === lastW) return;
  const lo = Math.min(a, lastW), hi = Math.max(a, lastW);
  if (lastW < -1 || Math.abs(a - lastW) > 60) { wordEls.forEach((el, i) => { el.classList.toggle('past', i < a); el.classList.toggle('now', i === a); }); }
  else for (let i = Math.max(0, lo); i <= hi; i++) { const el = wordEls[i]; if (!el) continue; el.classList.toggle('past', i < a); el.classList.toggle('now', i === a); }
  lastW = a; scrollToActive(false);
}
let userScrollUntil = 0;
$('tx').addEventListener('wheel', () => userScrollUntil = performance.now() + 3500, { passive: true });
$('tx').addEventListener('touchmove', () => userScrollUntil = performance.now() + 3500, { passive: true });
function scrollToActive(force) {
  if (mode !== 'tx' || lastW < 0) return; if (!force && performance.now() < userScrollUntil) return; const el = wordEls[lastW]; if (!el) return; const T = $('tx');
  const y = el.offsetTop - T.clientHeight * 0.3; if (force || Math.abs(T.scrollTop - y) > T.clientHeight * 0.12) T.scrollTo({ top: y, behavior: force ? 'auto' : 'smooth' });
}

// ---------- search in the transcript ----------
const search = { q: '', hits: [], i: -1 };
$('q').addEventListener('input', () => { search.q = $('q').value.trim(); $('sbar').classList.toggle('has', !!search.q); applySearch(true); });
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') closeSearch(); });
$('qn').onclick = () => step(1); $('qp').onclick = () => step(-1);
// the search bar stays a small icon until you need it
function closeSearch() { $('q').value = ''; search.q = ''; $('sbar').classList.remove('has'); $('sbar').classList.add('mini'); applySearch(false); $('q').blur(); }
$('sOpen').onclick = () => { $('sbar').classList.remove('mini'); $('q').focus(); };
$('sClose').onclick = closeSearch;
$('q').addEventListener('blur', () => setTimeout(() => { if (!$('q').value.trim() && document.activeElement !== $('q')) $('sbar').classList.add('mini'); }, 150));
function applySearch(jumpFirst) {
  wordEls.forEach(el => el.classList.remove('hit', 'cur')); search.hits = []; search.i = -1;
  if (!search.q || !cur) { $('qc').textContent = ''; return; }
  if (!cur.words.length) { $('qc').textContent = 'no text'; return; }
  const qs = norm(search.q).split(/\s+/).filter(Boolean), W = cur.words.map(w => norm(w.text));
  for (let i = 0; i < W.length; i++) {
    let ok = true; for (let k = 0; k < qs.length; k++) { const w = W[i + k]; if (w === undefined) { ok = false; break; } if (k === qs.length - 1 ? !w.startsWith(qs[k]) : w !== qs[k]) { ok = false; break; } }
    if (ok) { search.hits.push(i); for (let k = 0; k < qs.length; k++) wordEls[i + k]?.classList.add('hit'); }
  }
  $('qc').textContent = search.hits.length ? `${search.hits.length}` : '0';
  if (jumpFirst && search.hits.length) { if (mode !== 'tx') setMode('tx'); const t = audio.currentTime; const k = search.hits.findIndex(i => cur.words[i].start >= t - 0.5); go(k < 0 ? 0 : k, false); }
}
function step(d) { if (!search.hits.length) return; if (mode !== 'tx') setMode('tx'); go((search.i + d + search.hits.length) % search.hits.length, true); }
function go(k, seek) {
  wordEls.forEach(el => el.classList.remove('cur')); search.i = k; const i = search.hits[k]; const n = norm(search.q).split(/\s+/).filter(Boolean).length;
  for (let j = 0; j < n; j++) wordEls[i + j]?.classList.add('cur'); $('qc').textContent = `${k + 1}/${search.hits.length}`;
  const el = wordEls[i]; const T = $('tx'); T.scrollTop = el.offsetTop - T.clientHeight * 0.3; userScrollUntil = performance.now() + 2500; if (seek) audio.currentTime = Math.max(0, cur.words[i].start - 0.3);
}

// ---------- transcription (Whisper, runs in the browser) ----------
const workerSrc = `
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
let asr=null, cur='', dev='wasm';
async function load(m,d){ asr=await pipeline('automatic-speech-recognition', m, { device:d, progress_callback:p=>self.postMessage({type:'progress',p}) }); cur=m; dev=d; }
self.onmessage=async e=>{
  const { audio, model } = e.data;
  try{
    let d='wasm'; try{ if(navigator.gpu && await navigator.gpu.requestAdapter()) d='webgpu'; }catch(_){}
    if(!asr||cur!==model){ try{ await load(model,d); }catch(err){ if(d!=='wasm') await load(model,'wasm'); else throw err; } }
    self.postMessage({type:'status',text:'Listening...'});
    const o={chunk_length_s:30,stride_length_s:5}; let out, mode='word';
    try{ out=await asr(audio,{...o,return_timestamps:'word'}); }catch(err){ mode='segment'; out=await asr(audio,{...o,return_timestamps:true}); }
    self.postMessage({type:'done',mode,chunks:out.chunks||[]});
  }catch(err){ self.postMessage({type:'error',message:String(err&&err.message||err)}); }
};`;
let worker = null, txing = null; // the memo being transcribed right now
const txQueue = [];
const busyFor = t => !!t && txing === t;
function updateMain() {
  // the big button is always ☆ FAVOURITE: the line you're hearing, or (no transcript yet) the chapter you're in
  const b = $('mainBtn'); b.disabled = !cur; b.classList.add('fav');
  if (!cur) { b.textContent = '☆ FAVOURITE'; return; }
  let on = false;
  if (cur.words.length) { const sn = nowSentence(); on = !!sn && favIndex(sn[0], sn[1]) >= 0; }
  else { const mo = curMoment(); on = !!mo && favIndex(mo.j, mo.k) >= 0; }
  b.textContent = on ? '★ FAVOURITED' : '☆ FAVOURITE';
}
// no transcript: favourite the chapter you're in, or the half minute around now
function curMoment() {
  if (!cur) return null; const t = audio.currentTime || 0;
  if (cur.chapters.length > 1) { const k = Math.max(0, chapterAt(t)), c = cur.chapters[k], n = cur.chapters[k + 1]; return { j: 'ch', k, t0: c.t, t1: n ? n.t : (cur.duration || c.t + 60), text: c.title }; }
  const t0 = Math.max(0, Math.floor((t - 5) / 30) * 30); return { j: 'at', k: t0, t0, t1: t0 + 30, text: `${cur.title} at ${short(t0)}` };
}
function toggleMoment() {
  const mo = curMoment(); if (!mo) return; const x = favIndex(mo.j, mo.k);
  if (x >= 0) { favs.splice(x, 1); toast('Removed from favourites.', false, 2000); }
  else { favs.unshift({ m: cur.id, ...mo }); toast('Saved to favourites ★', false, 2000); }
  localStorage.setItem(favKey(), JSON.stringify(favs)); renderLib(); if ($('favDlg').classList.contains('open')) renderFavDlg(); updateMain();
}
$('mainBtn').onclick = () => { if (!cur) return; if (cur.words.length) { const sn = nowSentence(); if (sn) toggleFav(sn[0], sn[1]); updateMain(); return; } toggleMoment(); };
function prog(p) { $('prog').style.display = p == null ? 'none' : 'block'; $('prog').firstChild.style.width = (p || 0) + '%'; }
// automatic transcription, like Voice Memos: every new memo joins a queue and is transcribed in the background
// phones and small tablets: transcribing a long track by itself can freeze the app, so only short ones run automatically
const lowPower = matchMedia('(pointer:coarse)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4);
function enqueueTranscribe(t, auto, force) {
  if (!t || !isOwn(t) || (t.words.length && !force) || txing === t || txQueue.includes(t)) return;
  if (auto && (t._txFailed || (lowPower && t.duration > 600))) return;
  txQueue.push(t); renderLib(); updateMain(); pumpTx(auto);
}
async function pumpTx(auto) {
  if (txing || !txQueue.length) return;
  const t = txQueue.shift(); txing = t; renderLib(); updateMain(); if (cur === t) renderTranscript();
  try { await transcribe(t, auto); } catch { /* reported in transcribe */ }
  txing = null; renderLib(); updateMain(); pumpTx(true);
}
function transcribe(t, auto) {
  return new Promise(async resolve => {
    const here = () => cur === t; // only show progress for the memo on screen
    const st = (m, err) => { t._txMsg = m; if (here()) status(m, err); };
    const pg = p => { if (here()) prog(p); };
    let fake = null;
    const finish = () => { clearInterval(fake); t._txMsg = ''; pg(null); resolve(); };
    const fail = msg => { t._txFailed = true; finish(); if (here()) status('Transcription failed (' + msg + '). Press TRANSCRIBE to try again. The first run needs internet to download the speech model.', true); else toast(`Could not transcribe "${t.title}": ${msg}`, true); };
    try {
      st('Preparing audio for the transcript…'); pg(3);
      // decode straight to 16 kHz mono: a fraction of the memory of full quality, so phones cope better
      const ab = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await (await getBlob(t)).arrayBuffer());
      let pcm = ab.getChannelData(0);
      if (ab.numberOfChannels > 1) { const r = ab.getChannelData(1), m = new Float32Array(pcm.length); for (let i = 0; i < m.length; i++) m[i] = (pcm[i] + r[i]) / 2; pcm = m; } else pcm = pcm.slice();
      if (!worker) worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })), { type: 'module' });
      const files = {};
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress' && m.p.status === 'progress' && m.p.total) { files[m.p.file] = [m.p.loaded, m.p.total]; const L = Object.values(files).reduce((a, b) => a + b[0], 0), T = Object.values(files).reduce((a, b) => a + b[1], 0); pg(5 + 60 * L / T); st(`Downloading the speech model, first time only: ${(L / 1e6).toFixed(0)} of ${(T / 1e6).toFixed(0)} MB`); }
        if (m.type === 'status') {
          const mins = Math.max(1, Math.round(ab.duration / 60 / 3));
          st(`Transcribing… about ${mins} minute${mins === 1 ? '' : 's'}. You can keep listening.`); let p = 66; fake = setInterval(() => { p = Math.min(96, p + 0.4); pg(p); }, 500);
        }
        if (m.type === 'done') {
          let list = []; if (m.mode === 'word') list = m.chunks.map(c => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
          else m.chunks.forEach(c => list.push(...spread(c.text, c.timestamp[0], c.timestamp[1] ?? c.timestamp[0] + 3)));
          setWords(t, list.filter(w => w.text && !/^[\[(].*[\])]$/.test(w.text)), true);
          finish();
          const msg = t.words.length ? `Transcript ready: ${t.words.length} words in ${t.chapters.length} chapters ✓` : 'No speech found in this track.';
          if (here()) { status(msg); setTimeout(() => { if (!t._txMsg) status(''); }, 4000); if (!auto) setMode('tx'); }
          else if (t.words.length) toast(`"${t.title}" is transcribed ✓`);
        }
        if (m.type === 'error') fail(m.message);
      };
      worker.onerror = e => fail(e.message || 'could not start');
      st('Loading the speech model…'); worker.postMessage({ audio: pcm, model }, [pcm.buffer]);
    } catch (err) { fail(err.message || String(err)); }
  });
}
// fromAsr: words came from speech recognition. If the memo has a written script, use the script's words, timed to these.
function setWords(t, list, fromAsr) {
  if (!isOwn(t)) return;
  let words = list.map(w => ({ text: w.text, start: +w.start, end: +w.end, ...(w.p ? { p: 1 } : {}) })).sort((a, b) => a.start - b.start);
  let chapters = null;
  if (fromAsr && t.description) {
    const sc = parseScript(t.description);
    if (sc.words.length) { words = alignToAsr(sc.words, words).map(w => ({ text: w.text, start: w.start, end: w.end, ...(w.p ? { p: 1 } : {}) })); chapters = scriptChapters(words, sc.headings); }
  }
  t.words = words; t._text = null; t.chapters = chapters || transcriptChapters(t.words); save(t, true).catch(() => {}); renderLib();
  if (cur === t) { renderChapters(); renderTranscript(); drawOverview(); updateMain(); }
}
// paste the written script: exact words, timed to the voice; heading lines become chapters
function applyScript(t, text) {
  const sc = parseScript(text); if (!sc.words.length) return;
  t.description = text.trim();
  let timed, how;
  if (t.words.length) { timed = alignToAsr(sc.words, t.words); how = 'matched to the voice'; }
  else { timed = spreadOverVoice(sc.words, t.peaks, t.duration, BPS); how = 'placed roughly for now. They will be matched to the voice when the transcript finishes'; }
  t.words = timed.map(w => ({ text: w.text, start: w.start, end: w.end, ...(w.p ? { p: 1 } : {}) })); t._text = null;
  t.chapters = scriptChapters(t.words, sc.headings) || transcriptChapters(t.words);
  save(t, true).catch(() => {}); renderLib();
  if (cur === t) { renderChapters(); renderTranscript(); drawOverview(); updateMain(); setMode('tx'); }
  toast(`Script added: ${t.words.length} words in ${t.chapters.length} chapters, ${how}.`, false, 6000);
  if (!sc.words.length || how.startsWith('placed')) enqueueTranscribe(t, true, true); // get real timings from the voice
}
function spread(text, a, b) { const ws = text.trim().split(/\s+/).filter(Boolean), wt = ws.map(w => w.length + 2), tot = wt.reduce((x, y) => x + y, 0) || 1; let t = a; return ws.map((w, i) => { const d = (b - a) * wt[i] / tot; const o = { text: w, start: t, end: t + d * 0.9 }; t += d; return o; }); }

// paste your own script (spread over speech, using the waveform to skip pauses)
$('pasteBtn').onclick = () => {
  if (!cur || !isOwn(cur)) return; $('pop').classList.remove('open');
  $('scriptTxt').value = cur.description || ''; $('scriptDlg').classList.add('open'); setTimeout(() => $('scriptTxt').focus(), 50);
};
$('scriptGo').onclick = () => { const v = $('scriptTxt').value; if (!v.trim()) { $('scriptTxt').focus(); return; } $('scriptDlg').classList.remove('open'); applyScript(cur, v); };
$('scriptClose').onclick = () => $('scriptDlg').classList.remove('open');
$('scriptDlg').onclick = e => { if (e.target.id === 'scriptDlg') $('scriptDlg').classList.remove('open'); };
const tsec = s => { const m = s.trim().replace(',', '.').split(':').map(Number); return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : m[0] * 60 + m[1]; };
function importSRT(txt) {
  if (!cur) return alert('Add the audio first, then the transcript.'); if (!isOwn(cur)) return alert('This memo is shared with you, so it is play only.');
  const list = []; const re = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g; let m;
  while ((m = re.exec(txt.replace(/\r/g, '')))) list.push(...spread(m[3].replace(/<[^>]+>/g, '').replace(/\n/g, ' '), tsec(m[1]), tsec(m[2])));
  if (list.length) { setWords(cur, list); setMode('tx'); } else alert('No captions found in that file.');
}
$('rechapBtn').onclick = () => {
  if (!cur || !isOwn(cur)) return; $('pop').classList.remove('open');
  if (!cur.words.length) { toast('Transcribe this memo first, then chapters can be rebuilt from the words.'); return; }
  if (!confirm(`Replace the ${cur.chapters.length} chapters on "${cur.title}" with new ones made from the transcript? Renamed chapters will be lost.`)) return;
  cur.chapters = transcriptChapters(cur.words); save(cur, true).catch(() => {}); renderChapters(); renderTranscript(); drawOverview(); renderLib();
  toast(`Rebuilt into ${cur.chapters.length} chapters ✓`);
};
$('srtBtn').onclick = () => $('srtFile').click(); $('srtFile').onchange = e => { e.target.files[0] && e.target.files[0].text().then(importSRT); e.target.value = ''; };
function dl(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const dlText = (text, name) => dl(new Blob([text], { type: 'text/plain' }), name);
$('expTxt').onclick = () => { if (!cur || !cur.words.length) return; const out = []; let ci = 0, line = []; cur.words.forEach(w => { while (ci < cur.chapters.length && cur.chapters[ci].t <= w.start + 0.25) { if (line.length) { out.push(line.join(' ')); line = []; } out.push(`\n[${short(cur.chapters[ci].t)}] ${cur.chapters[ci].title}\n`); ci++; } line.push(w.text); }); out.push(line.join(' ')); dlText(`${cur.title}\n${out.join('\n')}\n`, cur.title + '.txt'); };
$('expSrt').onclick = () => {
  if (!cur || !cur.words.length) return; const f = s => { const ms = Math.round(s * 1000); return `${pad(Math.floor(ms / 3.6e6))}:${pad(Math.floor(ms / 6e4) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`; };
  const g = []; let c = null; cur.words.forEach(w => { if (!c || c.w.length >= 7 || w.start - c.e > 0.8) { c = { s: w.start, e: w.end, w: [] }; g.push(c); } c.w.push(w.text); c.e = w.end; });
  dlText(g.map((c, i) => `${i + 1}\n${f(c.s)} --> ${f(c.e)}\n${c.w.join(' ')}\n`).join('\n'), cur.title + '.srt');
};

// ---------- main loop ----------
let favTick = 0, ovTick = 0, looping = false;
function loop() {
  if (cur) {
    const t = audio.currentTime; $('clock').textContent = clockFmt(t);
    const k = chapterAt(t); if (k !== lastChap) { lastChap = k; $('chapnow').textContent = k >= 0 && cur.chapters.length > 1 ? `Chapter ${k + 1} · ${cur.chapters[k].title}` : ''; $('clist').querySelectorAll('.chap').forEach(el => el.classList.toggle('on', +el.dataset.k === k)); updateMediaSession(); }
    if (repeatMode === 'ch' && !pl && !rep && !audio.paused && k >= 0) { const end = cur.chapters[k + 1]?.t ?? cur.duration; if (t >= end - 0.05) audio.currentTime = cur.chapters[k].t; }
    if (++favTick % 15 === 0) updateMain();
    tickStats(t); tickPlaylist(t); tickRep(t); if (!$('reader').hidden) tickReader(t);
    updateTranscript(); if (++ovTick % 6 === 0) drawOverview();
  }
  drawWave(); updateLibRow(); requestAnimationFrame(loop);
}
addEventListener('resize', drawOverview);
audio.addEventListener('seeked', () => { userScrollUntil = 0; lastW = -2; updateTranscript(); scrollToActive(true); drawOverview(); });

// ---------- converter + compressor ----------
const PRESETS = { voice: { ch: 1, sr: 22050, kbps: 64 }, standard: { ch: 1, sr: 44100, kbps: 96 }, music: { ch: 2, sr: 44100, kbps: 128 }, high: { ch: 2, sr: 44100, kbps: 192 } };
const KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const cvs = { file: null, dur: 0, preset: 'standard', fmt: 'mp3', ab: null };
// settings for a preset, lowered if needed to fit under fitMB
function settingsFor(preset, duration, fitMB) {
  const p = { ...PRESETS[preset] };
  if (fitMB && duration) {
    const k = fitMB * MB * 0.96 * 8 / duration / 1000;
    const pick = [...KBPS].reverse().find(x => x <= k) || 32; if (pick < p.kbps) p.kbps = pick; if (p.kbps <= 64) p.ch = 1; if (p.kbps <= 48) p.sr = 22050; if (p.kbps <= 32) p.sr = 16000;
  }
  return p;
}
function openConverter(f) {
  $('cv').classList.add('open'); $('cvMsg').textContent = ''; $('cvBar').style.display = 'none';
  $('cvLead').textContent = 'Shrink big recordings, or turn any audio or video file into MP3 or WAV. Everything happens on this device. New memos are compressed with Standard automatically.';
  if (f) cvLoad(f); else { cvs.file = null; cvs.ab = null; cvs.dur = 0; $('cvInfo').textContent = ''; $('cvGo').disabled = $('cvAdd').disabled = true; cvEstimate(); }
}
$('cv').onclick = e => { if (e.target.id === 'cv') $('cv').classList.remove('open'); };
$('cvCancel').onclick = () => $('cv').classList.remove('open');
async function cvLoad(f) {
  cvs.file = f; cvs.ab = null; $('cvInfo').textContent = `${f.name} · ${mb(f.size)} · reading...`; $('cvGo').disabled = $('cvAdd').disabled = true;
  try {
    cvs.ab = await decode(f); cvs.dur = cvs.ab.duration;
    $('cvInfo').textContent = `${f.name} · ${mb(f.size)} · ${short(cvs.dur)} long`; $('cvGo').disabled = $('cvAdd').disabled = false; cvEstimate();
  } catch (err) { $('cvInfo').textContent = `${f.name}: this file's audio could not be read (${err.message || 'unsupported format'}).`; }
}
const cvSettings = () => settingsFor(cvs.preset, cvs.dur, $('cvFitOn').checked && cvs.fmt === 'mp3' ? +$('cvFit').value : 0);
function cvEstimate() {
  if (!cvs.dur) { $('cvEst').textContent = '-'; return; } const p = cvSettings();
  const bytes = cvs.fmt === 'mp3' ? p.kbps * 1000 / 8 * cvs.dur : p.sr * p.ch * 2 * cvs.dur + 44;
  const saved = cvs.file ? Math.round((1 - bytes / cvs.file.size) * 100) : 0;
  $('cvEst').textContent = mb(bytes); $('cvEstL').textContent = cvs.fmt === 'mp3' ? `Estimated size (${p.ch === 1 ? 'mono' : 'stereo'}, ${p.kbps} kbps)${saved > 0 ? ` · ${saved}% smaller` : ''}` : `Estimated size (WAV, ${p.ch === 1 ? 'mono' : 'stereo'})`;
  if ($('cvFitOn').checked && cvs.fmt === 'mp3' && bytes > +$('cvFit').value * MB) $('cvEstL').textContent += ' · too long to fit, this is the smallest';
  if (bytes > MAX_FILE) $('cvEstL').textContent += ' · over the 50 MB upload limit';
}
$('convBtn').onclick = () => { $('pop').classList.remove('open'); openConverter(null); };
$('cvPick').onclick = () => $('cvFile').click();
$('cvFile').onchange = e => { if (e.target.files[0]) cvLoad(e.target.files[0]); e.target.value = ''; };
$('cvPick').addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dragN = 0; document.body.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) cvLoad(f); });
document.querySelectorAll('#cvPresets .pre').forEach(b => b.onclick = () => { cvs.preset = b.dataset.p; document.querySelectorAll('#cvPresets .pre').forEach(x => x.classList.toggle('on', x === b)); cvEstimate(); });
document.querySelectorAll('#cvFmt button').forEach(b => b.onclick = () => { cvs.fmt = b.dataset.v; document.querySelectorAll('#cvFmt button').forEach(x => x.classList.toggle('on', x === b)); cvEstimate(); });
['cvFitOn', 'cvFit'].forEach(id => $(id).addEventListener('input', cvEstimate));
$('cvGo').onclick = () => cvRun(false); $('cvAdd').onclick = () => cvRun(true);

function wavBlob(chs, sr) {
  const n = chs[0].length, c = chs.length, buf = new ArrayBuffer(44 + n * c * 2), v = new DataView(buf); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * c * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, c, true); v.setUint32(24, sr, true); v.setUint32(28, sr * c * 2, true); v.setUint16(32, c * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * c * 2, true);
  let o = 44; for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) { const s = Math.max(-1, Math.min(1, chs[k][i])); v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}
// resample, optionally trim silence and even out volume, then encode (MP3 in a Web Worker, or WAV)
async function compress(ab, p, { trim, norm: normalize, fmt }, onP = () => {}) {
  const ch = Math.min(p.ch, ab.numberOfChannels), off = new OfflineAudioContext(ch, Math.ceil(ab.duration * p.sr), p.sr);
  const s = off.createBufferSource(); s.buffer = ab; s.connect(off.destination); s.start(); const r = await off.startRendering();
  let chs = [...Array(ch)].map((_, k) => r.getChannelData(k));
  if (trim) {
    const th = 0.012, padS = Math.floor(0.3 * p.sr), L = chs[0]; let a = 0, b = L.length - 1; while (a < b && Math.abs(L[a]) < th && (!chs[1] || Math.abs(chs[1][a]) < th)) a++; while (b > a && Math.abs(L[b]) < th && (!chs[1] || Math.abs(chs[1][b]) < th)) b--;
    a = Math.max(0, a - padS); b = Math.min(L.length, b + padS); if (b - a > p.sr) chs = chs.map(c => c.subarray(a, b));
  }
  if (normalize) { let pk = 0; chs.forEach(c => { for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > pk) pk = v; } }); if (pk > 0.01) { const g = 0.89 / pk; chs = chs.map(c => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; }); } else chs = chs.map(c => new Float32Array(c)); }
  else chs = chs.map(c => new Float32Array(c));
  onP(0.1);
  if (fmt === 'wav') return wavBlob(chs, p.sr);
  return new Promise((res, rej) => {
    const wk = new Worker('/mp3-worker.js');
    wk.onmessage = e => { if (e.data.type === 'p') onP(0.1 + 0.9 * e.data.p); else { wk.terminate(); onP(1); res(new Blob(e.data.out, { type: 'audio/mpeg' })); } };
    wk.onerror = e => { wk.terminate(); rej(new Error(e.message || 'encoder failed')); };
    wk.postMessage({ chs, sr: p.sr, kbps: p.kbps }, chs.map(c => c.buffer));
  });
}
async function cvRun(addToLib) {
  if (!cvs.ab) return; const p = cvSettings(), bar = $('cvBar'), msg = $('cvMsg'); bar.style.display = 'block'; bar.firstChild.style.width = '5%'; $('cvGo').disabled = $('cvAdd').disabled = true; msg.textContent = 'Preparing...';
  try {
    const blob = await compress(cvs.ab, p, { trim: $('cvTrim').checked, norm: $('cvNorm').checked, fmt: cvs.fmt }, x => { bar.firstChild.style.width = (5 + 95 * x) + '%'; msg.textContent = `Compressing... ${Math.round(x * 100)}%`; });
    const ext = cvs.fmt === 'wav' ? 'wav' : 'mp3';
    const name = cvs.file.name.replace(/\.[^.]+$/, '') + (cvs.fmt === 'mp3' ? `_${p.kbps}k` : '') + '.' + ext;
    const out = new File([blob], name, { type: blob.type });
    msg.textContent = `Done: ${mb(cvs.file.size)} → ${mb(out.size)} (${Math.max(0, Math.round((1 - out.size / cvs.file.size) * 100))}% smaller).`;
    if (addToLib) {
      if (out.size > MAX_FILE) { msg.textContent += ' That is still over the 50 MB limit, so it cannot be added. Try a smaller preset.'; }
      else { $('cv').classList.remove('open'); const before = cvs.file.size; queue = queue.then(() => addFile(out, true)).then(() => {}); toast(`Compressed ${mb(before)} → ${mb(out.size)}. Adding…`); }
    } else dl(out, name);
  } catch (err) { msg.textContent = 'Could not convert: ' + (err.message || err); }
  $('cvGo').disabled = $('cvAdd').disabled = false; setTimeout(() => bar.style.display = 'none', 1500);
}

// ---------- boot ----------
(async () => {
  if (!configured) { showAuth('MemoPad is not set up yet: the Supabase settings are missing.'); $('authGo').disabled = $('authGoogle').disabled = true; return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (session) start(session.user);
  else {
    // a shared link opened by someone not signed in: if that memo is public, go straight to the no-sign-up player
    const d = (() => { try { return JSON.parse(sessionStorage.getItem('mp.deep')); } catch { return null; } })();
    if (d && d.m) { const { data } = await supabase.from(TABLE).select('id').eq('id', d.m).eq('is_public', true).maybeSingle(); if (data) { location.replace(`/listen.html?id=${d.m}${d.t ? '&t=' + d.t : ''}`); return; } }
    showAuth(d && d.m ? 'Sign in to listen to this memo. (Its owner has not made it public.)' : undefined);
  }
  supabase.auth.onAuthStateChange((ev, s) => {
    setTimeout(() => { // never await Supabase inside this callback
      if (ev === 'SIGNED_OUT') { user = null; tracks = []; cur = null; audio.pause(); showAuth(); }
      else if (s && s.user && (!user || user.id !== s.user.id)) start(s.user);
    }, 0);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();


// ---------- repeat: off, the whole track, or the current chapter ----------
const repeatMode = 'off'; // repeat options were removed at Kheron's request (2026-11-05)
localStorage.removeItem('mp.repeat'); audio.loop = false;

// ---------- offline: memos whose audio is saved on this device ----------
let offline = new Set();
function keepOffline(t, b) { audioPut(t.id, b).then(() => { if (!offline.has(t.id)) { offline.add(t.id); renderLib(); updateOffBtn(); } }); }
function updateOffBtn() { const b = $('offBtn'); if (!cur) return; b.textContent = offline.has(cur.id) ? 'Saved for offline ✓  (tap to remove)' : 'Save for offline listening'; }
$('offBtn').onclick = async () => {
  const t = cur; if (!t) return;
  if (offline.has(t.id)) { await audioDel(t.id); offline.delete(t.id); toast('Removed from this device. It still plays online.'); }
  else {
    if (!navigator.onLine && !t.blob) { toast('Connect to the internet to save this memo.', true); return; }
    toast('Saving for offline…', false, 20000);
    try { const b = await getBlob(t); await audioPut(t.id, b); offline.add(t.id); navigator.storage?.persist?.(); toast('Saved. This memo now plays without signal.'); }
    catch (e) { toast('Could not save: ' + e.message, true); }
  }
  updateOffBtn(); renderLib();
};
$('setBtn').addEventListener('click', updateOffBtn);

// ---------- playlists (kept on this device) ----------
let playlists = [], pl = null, addItem = null, editPl = null;
const plKey = () => 'mp.playlists.' + (user ? user.id : 'x');
function loadPlaylists() { try { playlists = JSON.parse(localStorage.getItem(plKey())) || []; } catch { playlists = []; } }
function savePlaylists() { localStorage.setItem(plKey(), JSON.stringify(playlists)); renderLib(); }
const itemLen = it => { const t = tracks.find(x => x.id === it.m); if (!t) return 0; return (it.t1 ?? t.duration) - (it.t0 || 0); };
function renderPlaylists(L, q) {
  const list = playlists.filter(p => !q || norm(p.name).includes(q)); if (!list.length) return;
  const h = document.createElement('h4'); h.textContent = 'Playlists'; L.appendChild(h);
  list.forEach(p => {
    const d = document.createElement('div'); d.className = 'item pl' + (pl && pl.p === p ? ' playing' : '');
    const len = p.items.reduce((a, it) => a + itemLen(it), 0);
    d.innerHTML = `<span class="dot"></span><div style="min-width:0;flex:1"><div class="nm">${esc(p.name)}</div><div class="mt"><span>${p.items.length} item${p.items.length === 1 ? '' : 's'}</span><span>· ${short(len)}</span></div></div><button class="idel iplay" title="Play" aria-label="Play ${esc(p.name)}">▶</button>`;
    d.onclick = () => openEditPl(p);
    d.querySelector('.iplay').onclick = e => { e.stopPropagation(); startPlaylist(p, 0); closeLib(); };
    L.appendChild(d);
  });
}
function openAddPl(item) {
  addItem = item; $('plHead').textContent = 'Add to a playlist'; const L = $('plList'); L.innerHTML = '';
  if (!playlists.length) L.innerHTML = '<div class="none">No playlists yet. Name one below.</div>';
  playlists.forEach(p => { const b = document.createElement('button'); b.type = 'button'; b.className = 'plpick'; b.textContent = `${p.name}  ·  ${p.items.length}`; b.onclick = () => addTo(p); L.appendChild(b); });
  $('plNew').value = ''; $('plDlg').classList.add('open');
}
function addTo(p) { p.items.push({ ...addItem }); savePlaylists(); $('plDlg').classList.remove('open'); toast(`Added to "${p.name}".`); }
$('plNewGo').onclick = () => { const n = $('plNew').value.trim(); if (!n) { $('plNew').focus(); return; } const p = { id: crypto.randomUUID(), name: n, items: [] }; playlists.push(p); addTo(p); };
$('plNew').addEventListener('keydown', e => { if (e.key === 'Enter') $('plNewGo').click(); });
$('plClose').onclick = () => $('plDlg').classList.remove('open');
function openEditPl(p) {
  editPl = p; $('peHead').textContent = p.name; const L = $('peList'); L.innerHTML = '';
  if (!p.items.length) L.innerHTML = '<div class="none">Empty. Use + on a memo or a chapter to add it.</div>';
  p.items.forEach((it, i) => {
    const r = document.createElement('div'); r.className = 'perow';
    r.innerHTML = `<span class="pn">${i + 1}</span><span class="pt"></span><span class="pm">${short(itemLen(it))}</span><button type="button" title="Move up" ${i ? '' : 'disabled'}>↑</button><button type="button" title="Remove">✕</button>`;
    r.querySelector('.pt').textContent = it.label;
    const [up, rm] = r.querySelectorAll('button');
    up.onclick = () => { [p.items[i - 1], p.items[i]] = [p.items[i], p.items[i - 1]]; savePlaylists(); openEditPl(p); };
    rm.onclick = () => { p.items.splice(i, 1); savePlaylists(); openEditPl(p); };
    L.appendChild(r);
  });
  $('plEdit').classList.add('open');
}
$('pePlay').onclick = () => { $('plEdit').classList.remove('open'); if (editPl.items.length) { startPlaylist(editPl, 0); closeLib(); } };
$('peDel').onclick = () => { if (!confirm(`Delete the playlist "${editPl.name}"? Your memos stay.`)) return; if (pl && pl.p === editPl) stopPlaylist(); playlists = playlists.filter(p => p !== editPl); savePlaylists(); $('plEdit').classList.remove('open'); };
$('peClose').onclick = () => $('plEdit').classList.remove('open');
['plDlg', 'plEdit'].forEach(id => $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.remove('open'); }));
async function startPlaylist(p, i) { pl = { p, i }; audio.loop = false; await playItem(); }
function stopPlaylist() { if (!pl) return; pl = null; audio.loop = false; updatePlNow(); renderLib(); }
async function playItem() {
  const { p, i } = pl, it = p.items[i]; const t = tracks.find(x => x.id === it.m);
  updatePlNow(); renderLib();
  if (!t) { nextInPlaylist(); return; }
  if (cur !== t) await select(t);
  if (!pl || pl.p !== p || pl.i !== i) return;
  const go = () => { audio.currentTime = it.t0 || 0; audio.play().catch(() => {}); };
  audio.readyState >= 1 ? go() : audio.addEventListener('loadedmetadata', go, { once: true });
}
function nextInPlaylist() {
  if (!pl) return; pl.i++;
  if (pl.i >= pl.p.items.length) { if (repeatMode !== 'off') pl.i = 0; else { const n = pl.p.name; stopPlaylist(); audio.pause(); toast(`"${n}" finished.`); logListen(`Listened to the "${n}" playlist on MemoPad`, 'pl:' + n); return; } }
  playItem();
}
function tickPlaylist(t) { if (!pl || audio.paused) return; const it = pl.p.items[pl.i]; if (it && it.t1 != null && cur && cur.id === it.m && t >= it.t1 - 0.05) nextInPlaylist(); }
function updatePlNow() {
  const el = $('plnow'); if (!pl) { el.hidden = true; return; }
  el.hidden = false; el.innerHTML = `Playlist · ${esc(pl.p.name)} · ${pl.i + 1} of ${pl.p.items.length} <button type="button" id="plSkip" title="Next in playlist">›</button><button type="button" id="plStop" title="Stop playlist">✕</button>`;
  $('plSkip').onclick = nextInPlaylist; $('plStop').onclick = stopPlaylist;
}

// ---------- sentences (one affirmation) in the transcript ----------
const isEnd = x => /[.!?…]["'”’)]*$/.test(x) && !/^\d+[.)]$/.test(x);
const isNum = x => /^\d+[.)]?$/.test(x);
function sentenceAt(i) {
  const W = cur.words; i = clamp(i, 0, W.length - 1); let j = i, k = i;
  while (j > 0 && !isEnd(W[j - 1].text)) j--;
  while (k < W.length - 1 && !isEnd(W[k].text)) k++;
  while (j < k && isNum(W[j].text)) j++; // skip the spoken number, e.g. "12."
  if (k - j < 24) return [j, k];
  // a long run without full stops: break it into short phrases at pauses and commas
  let a = j;
  for (let q = j; q <= k; q++) {
    const n = q - a + 1, gap = q < k ? W[q + 1].start - W[q].end : 9;
    if (q === k || n >= 16 || (n >= 5 && (gap > 0.45 || /[,;:—–]$/.test(W[q].text)))) { if (i <= q) return [a, q]; a = q + 1; }
  }
  return [j, k];
}
const sentStart = j => Math.max(0, (dispSt[j] ?? cur.words[j].start) - 0.05);

// ---------- repeat one affirmation 3, 5 or 10 times ----------
let rep = null, repHide = 0;
function showRepBar(i) {
  if (!cur || !cur.words.length) return; const [j, k] = sentenceAt(i); if (rep) stopRep();
  const b = $('repbar'); b.hidden = false; b.dataset.j = j; b.dataset.k = k;
  const fv = favIndex(j, k) >= 0;
  b.innerHTML = `<button type="button" class="star${fv ? ' on' : ''}">${fv ? '★ Saved to favourites' : '☆ Save to favourites'}</button>${fv ? `<button type="button" class="cp" title="Copy" aria-label="Copy this line">${COPY_ICON}</button>` : ''}<button type="button" class="x" aria-label="Close">✕</button>`;
  b.querySelector('.x').onclick = stopRep;
  b.querySelector('.cp')?.addEventListener('click', () => { copyText(cur.words.slice(j, k + 1).map(w => w.text).join(' ')); clearTimeout(repHide); repHide = setTimeout(() => { if (!rep) b.hidden = true; }, 4000); });
  b.querySelector('.star').onclick = () => { toggleFav(j, k); showRepBar(i); };
  clearTimeout(repHide); repHide = setTimeout(() => { if (!rep) b.hidden = true; }, 6000);
}
function startRep(j, k, n) { clearTimeout(repHide); rep = { j, k, n, done: 0 }; audio.currentTime = sentStart(j); audio.play().catch(() => {}); repLabel(); }
function repLabel() { const b = $('repbar'); b.hidden = false; b.innerHTML = `<span>Repeating ${rep.done + 1} of ${rep.n}</span><button type="button" class="x" aria-label="Stop repeating">STOP</button>`; b.querySelector('.x').onclick = stopRep; }
function stopRep() { rep = null; clearTimeout(repHide); $('repbar').hidden = true; }
function tickRep(t) {
  if (!rep || audio.paused || !cur) return; const s0 = sentStart(rep.j), end = cur.words[rep.k].end + 0.35;
  if (t < s0 - 2 || t > end + 2) { stopRep(); return; } // you moved somewhere else
  if (t >= end) { rep.done++; if (rep.done >= rep.n) { stopRep(); return; } audio.currentTime = s0; repLabel(); }
}

// ---------- read-along: full screen, one affirmation at a time ----------
let shownSent = -1, wake = null;
async function openReader() {
  if (!cur) return; $('pop').classList.remove('open'); $('reader').hidden = false; shownSent = -1; tickReader(audio.currentTime); rPoke();
  try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
}
function closeReader() { setImm(false); $('reader').hidden = true; try { wake && wake.release(); } catch {} wake = null; }
$('readBtn').onclick = openReader; $('readIc').onclick = openReader; $('rClose').onclick = closeReader;
document.addEventListener('visibilitychange', async () => { if (!$('reader').hidden && document.visibilityState === 'visible') { try { wake = await navigator.wakeLock?.request('screen'); } catch {} } });
function tickReader(t) {
  $('rPlay').classList.toggle('on', !audio.paused);
  const k = chapterAt(t); $('rCh').textContent = k >= 0 && cur.chapters.length > 1 ? cur.chapters[k].title : cur.title;
  if (!cur.words.length) { if (shownSent !== -2) { $('rText').innerHTML = '<span class="rw now">No transcript yet.</span>'; shownSent = -2; } return; }
  const a = Math.max(0, activeWord(t)); const [j, e] = sentenceAt(a);
  if (j !== shownSent) {
    shownSent = j; const R = $('rText'); R.innerHTML = ''; R.classList.remove('in'); void R.offsetWidth; R.classList.add('in');
    for (let i = j; i <= e; i++) { const s = document.createElement('span'); s.className = 'rw'; s.dataset.i = i; s.textContent = cur.words[i].text; R.append(s, ' '); }
  }
  $('rText').querySelectorAll('.rw').forEach(s => { const i = +s.dataset.i; s.classList.toggle('past', i < a); s.classList.toggle('now', i === a); });
}
$('rPlay').onclick = togglePlay;
holdable($('rPrev'), -1); holdable($('rNext'), 1);
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('reader').hidden) closeReader(); });


// ---------- favourite lines (kept on this device) ----------
// the "saved" pop-up shows the line you just saved
function favToast(f, msg) {
  toast(msg, false, 5000, { label: 'Copy', run: () => copyText(f.text) });
  const q = document.createElement('div'); q.className = 'tq'; q.textContent = `“${f.text}”`; $('toast').prepend(q);
}
const COPY_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch {} a.remove(); }
  toast('Copied ✓', false, 1500);
}
function playFav(f) { const t = tracks.find(x => x.id === f.m); if (!t) return; stopPlaylist(); closeLib(); $('favDlg').classList.remove('open'); const go = () => { audio.currentTime = f.t0; audio.play().catch(() => {}); }; if (cur === t) go(); else { select(t); audio.addEventListener('loadedmetadata', go, { once: true }); } }
const favList = () => favs.filter(f => tracks.some(t => t.id === f.m));
function renderFavDlg() {
  const list = favList(), L = $('favList'); L.innerHTML = '';
  $('favLead').textContent = list.length ? `${list.length} favourite line${list.length > 1 ? 's' : ''}, newest first.` : 'No favourites yet. While a memo plays, press ☆ FAVOURITE to save the line you hear.';
  document.querySelector('#favDlg .favtools').hidden = !list.length;
  list.forEach(f => {
    const t = tracks.find(x => x.id === f.m), d = document.createElement('div'); d.className = 'fvrow';
    d.innerHTML = `<div class="fvtx"></div><div class="fvft"><span class="fvmt">${esc(t.title)} · ${short(f.t0)}</span><button type="button" class="fvb" data-a="play" title="Play" aria-label="Play this line"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg></button><button type="button" class="fvb" data-a="copy" title="Copy" aria-label="Copy this line">${COPY_ICON}</button><button type="button" class="fvb" data-a="del" title="Remove" aria-label="Remove from favourites">✕</button></div>`;
    d.querySelector('.fvtx').textContent = f.text;
    d.querySelector('[data-a=play]').onclick = () => playFav(f);
    d.querySelector('[data-a=copy]').onclick = () => copyText(f.text);
    d.querySelector('[data-a=del]').onclick = () => { favs.splice(favs.indexOf(f), 1); localStorage.setItem(favKey(), JSON.stringify(favs)); markFavs(); renderLib(); renderFavDlg(); toast(f.pp ? 'Removed from favourites. It stays in your Progress Pad Quotes.' : 'Removed from favourites.', false, 2500); };
    L.appendChild(d);
  });
}
function openFavs() { renderFavDlg(); $('favDlg').classList.add('open'); }
$('favBtn').onclick = openFavs;
$('favClose').onclick = () => $('favDlg').classList.remove('open');
$('favDlg').addEventListener('click', e => { if (e.target.id === 'favDlg') $('favDlg').classList.remove('open'); });
$('favCopyAll').onclick = () => copyText(favList().map(f => `“${f.text}”`).join('\n\n'));
$('favPlayAll').onclick = () => { const list = favList(); if (!list.length) return; $('favDlg').classList.remove('open'); startPlaylist({ name: 'Favourite lines', items: list.map(f => ({ m: f.m, t0: f.t0, t1: f.t1, label: f.text })) }, 0); closeLib(); };
let favs = [];
const favKey = () => 'mp.favs.' + (user ? user.id : 'x');
function loadFavs() { try { favs = JSON.parse(localStorage.getItem(favKey())) || []; } catch { favs = []; } }
const favIndex = (j, k) => cur ? favs.findIndex(f => f.m === cur.id && f.j === j && f.k === k) : -1;
function toggleFav(j, k) {
  const x = favIndex(j, k);
  if (x >= 0) { const f = favs.splice(x, 1)[0]; toast(f.pp ? 'Removed from favourites. It stays in your Progress Pad Quotes.' : 'Removed from favourites.', false, 2500); }
  else {
    const W = cur.words, f = { m: cur.id, j, k, t0: sentStart(j), t1: W[k].end + 0.35, text: W.slice(j, k + 1).map(w => w.text).join(' ') };
    favs.unshift(f); favToast(f, 'Saved to favourites ★'); quoteToPad(f, cur.title);
  }
  localStorage.setItem(favKey(), JSON.stringify(favs)); markFavs(); renderLib(); if ($('favDlg').classList.contains('open')) renderFavDlg();
}
function markFavs() {
  wordEls.forEach(el => el.classList.remove('fav')); if (!cur) return;
  favs.filter(f => f.m === cur.id && typeof f.j === 'number').forEach(f => { for (let i = f.j; i <= f.k; i++) wordEls[i]?.classList.add('fav'); });
}
function renderFavs(L, q) {
  const list = favs.filter(f => tracks.some(t => t.id === f.m) && (!q || norm(f.text).includes(q))); if (!list.length) return;
  const h = document.createElement('h4'); h.className = 'favh'; h.innerHTML = 'Favourite lines <span><button type="button" class="favplay favall">See all</button> <button type="button" class="favplay">▶ Play all</button></span>'; L.appendChild(h);
  h.querySelector('.favall').onclick = e => { e.stopPropagation(); openFavs(); };
  h.querySelector('.favplay:not(.favall)').onclick = () => { startPlaylist({ name: 'Favourite lines', items: list.map(f => ({ m: f.m, t0: f.t0, t1: f.t1, label: f.text })) }, 0); closeLib(); };
  list.forEach(f => {
    const t = tracks.find(x => x.id === f.m), d = document.createElement('div'); d.className = 'item fav';
    d.innerHTML = `<span class="favstar">★</span><div style="min-width:0;flex:1"><div class="ftx"></div><div class="mt"><span>${esc(t.title)}</span><span>· ${short(f.t0)}</span></div></div><button class="idel icopy" title="Copy" aria-label="Copy this line">${COPY_ICON}</button><button class="idel" title="Remove" aria-label="Remove from favourites">✕</button>`;
    d.querySelector('.ftx').textContent = f.text;
    d.querySelector('.icopy').onclick = e => { e.stopPropagation(); copyText(f.text); };
    d.onclick = () => { stopPlaylist(); closeLib(); const go = () => { audio.currentTime = f.t0; audio.play().catch(() => {}); }; if (cur === t) go(); else { select(t); audio.addEventListener('loadedmetadata', go, { once: true }); } };
    d.querySelector('.idel:not(.icopy)').onclick = e => { e.stopPropagation(); favs.splice(favs.indexOf(f), 1); localStorage.setItem(favKey(), JSON.stringify(favs)); markFavs(); renderLib(); };
    L.appendChild(d);
  });
}


// ---------- listening stats and streaks (this device) ----------
const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
let stats = { days: {}, tracks: {} }, statSaved = 0, lastTick = 0, lastPos = -1, heard = {};
const statKey = () => 'mp.stats.' + (user ? user.id : 'x');
function loadStats() { try { stats = JSON.parse(localStorage.getItem(statKey())) || stats; } catch {} stats.days ||= {}; stats.tracks ||= {}; stats.plays ||= {}; stats.loved ||= {}; statLine(); }
let playCounted = null, playSecs = 0;
// ---------- play counts and ❤️ Loved (kept in step across your devices once the memopad_listens table exists) ----------
const LOVED = '\u0001loved', LISTENS = 'memopad_listens';
const isLoved = t => !!(t && stats.loved && stats.loved[t.id]);
const playsOf = t => (t && stats.plays && stats.plays[t.id]) || 0;
let listenSync = true;
const listenRow = id => ({ user_id: user.id, memo_id: id, plays: stats.plays[id] || 0, loved: !!stats.loved[id], updated_at: new Date().toISOString() });
function pushListen(id) {
  if (!listenSync || !user || !navigator.onLine) return;
  supabase.from(LISTENS).upsert(listenRow(id)).then(({ error }) => { if (error) listenSync = false; });
}
async function syncListens() {
  if (!user) return;
  const { data, error } = await supabase.from(LISTENS).select('memo_id,plays,loved');
  if (error || !Array.isArray(data)) { listenSync = false; return; }
  listenSync = true; const seen = new Set(), push = [];
  data.forEach(r => {
    seen.add(r.memo_id); const lp = stats.plays[r.memo_id] || 0;
    if (r.plays > lp) stats.plays[r.memo_id] = r.plays; else if (lp > r.plays) push.push(r.memo_id);
    if (r.loved) stats.loved[r.memo_id] = 1; else delete stats.loved[r.memo_id];
  });
  // first time on this device: send up what it already knows
  new Set([...Object.keys(stats.plays), ...Object.keys(stats.loved)]).forEach(id => { if (!seen.has(id) && tracks.some(t => t.id === id)) push.push(id); });
  localStorage.setItem(statKey(), JSON.stringify(stats));
  if (push.length) supabase.from(LISTENS).upsert(push.map(listenRow)).then(() => {});
  renderLib(); renderLove();
}
function toggleLove(t) {
  if (!t) return;
  if (stats.loved[t.id]) delete stats.loved[t.id]; else stats.loved[t.id] = 1;
  localStorage.setItem(statKey(), JSON.stringify(stats)); pushListen(t.id);
  renderLib(); renderLove(); toast(isLoved(t) ? 'Added to Loved ♥' : 'Removed from Loved', false, 1500);
}
function renderLove() {
  const b = $('loveBtn'), p = $('playsTag'); if (!b || !cur) return; const on = isLoved(cur), n = playsOf(cur);
  b.classList.toggle('on', on); b.innerHTML = `${on ? IC.heartOn : IC.heart}<span>${on ? 'Loved' : 'Love'}</span>`;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  p.hidden = !n; p.textContent = n === 1 ? 'Played once' : `Played ${n} times`;
}
function tickStats(t) {
  const now = performance.now(), dt = (now - lastTick) / 1000; lastTick = now;
  if (!cur || audio.paused || dt <= 0 || dt > 2) { lastPos = t; return; }
  const day = dayOf(); stats.days[day] = (stats.days[day] || 0) + dt; stats.tracks[cur.id] = (stats.tracks[cur.id] || 0) + dt;
  // a "play" counts once you've listened 30 seconds since opening the memo
  if (playCounted !== cur.id) { playSecs += dt; if (playSecs >= Math.min(30, (cur.duration || 60) * 0.5)) { playCounted = cur.id; stats.plays[cur.id] = (stats.plays[cur.id] || 0) + 1; localStorage.setItem(statKey(), JSON.stringify(stats)); pushListen(cur.id); renderLib(); renderLove(); } }
  // a "finished listen": you heard most of the track (skips and seeks don't count)
  const d = t - lastPos; lastPos = t;
  if (d > 0 && d < 2) { heard[cur.id] = (heard[cur.id] || 0) + d; if (cur.duration && heard[cur.id] >= cur.duration * 0.85) { heard[cur.id] = -1e9; finishedTrack(cur); } }
  if (now - statSaved > 10000) { statSaved = now; localStorage.setItem(statKey(), JSON.stringify(stats)); statLine(); }
}
function streaks() {
  const has = d => (stats.days[d] || 0) >= 60; let cur = 0, best = 0, run = 0;
  const d = new Date(); if (!has(dayOf(d))) d.setDate(d.getDate() - 1); // today still counts until midnight
  while (has(dayOf(d))) { cur++; d.setDate(d.getDate() - 1); }
  Object.keys(stats.days).sort().forEach((k, i, a) => { if (!has(k)) { run = 0; return; } const p = a[i - 1]; const prev = new Date(k + 'T12:00:00'); prev.setDate(prev.getDate() - 1); run = p && has(p) && dayOf(prev) === p ? run + 1 : 1; best = Math.max(best, run); });
  return { cur, best: Math.max(best, cur) };
}
const mins = s => s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const GOAL = 20 * 60; // daily listening goal shown in the ring
function statLine() {
  const s = streaks(), today = stats.days[dayOf()] || 0, f = Math.min(1, today / GOAL), C = 2 * Math.PI * 26;
  $('ringArc').setAttribute('stroke-dasharray', `${(f * C).toFixed(1)} ${C.toFixed(1)}`); $('ringTxt').textContent = Math.round(today / 60);
  $('statTxt').textContent = `${Math.round(today / 60)} of ${GOAL / 60} min today`;
  $('statSub').textContent = s.cur ? `${s.cur}-day streak · best ${s.best}` : 'Listen a minute to start a streak';
  const days = []; const d = new Date(); d.setDate(d.getDate() - 6); for (let i = 0; i < 7; i++) { days.push(stats.days[dayOf(d)] || 0); d.setDate(d.getDate() + 1); }
  const mx = Math.max(GOAL, ...days);
  $('miniBars').innerHTML = days.map((v, i) => `<i class="${i === 6 ? 'now' : ''}" style="height:${Math.max(v ? 8 : 4, v / mx * 100)}%"></i>`).join('');
}
function openDash() {
  localStorage.setItem(statKey(), JSON.stringify(stats));
  const s = streaks(), today = stats.days[dayOf()] || 0, all = Object.values(stats.days).reduce((a, b) => a + b, 0);
  let week = 0; const d = new Date(); for (let i = 0; i < 7; i++) { week += stats.days[dayOf(d)] || 0; d.setDate(d.getDate() - 1); }
  const tile = (v, l) => `<div class="dtile"><b>${v}</b><span>${l}</span></div>`;
  $('dGrid').innerHTML = tile(mins(today), 'today') + tile(mins(week), 'last 7 days') + tile(`${s.cur} day${s.cur === 1 ? '' : 's'}`, 'current streak') + tile(`${s.best} day${s.best === 1 ? '' : 's'}`, 'best streak') + tile(mins(all), 'all time');
  const days = []; const e = new Date(); e.setDate(e.getDate() - 13); for (let i = 0; i < 14; i++) { days.push(dayOf(e)); e.setDate(e.getDate() + 1); }
  const mx = Math.max(60, ...days.map(k => stats.days[k] || 0));
  $('dBars').innerHTML = days.map((k, i) => { const v = stats.days[k] || 0; return `<div class="db${i === 13 ? ' now' : ''}" title="${k}: ${mins(v)}"><i style="height:${Math.max(v ? 4 : 0, v / mx * 100)}%"></i><span>${new Date(k + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`; }).join('');
  const top = Object.entries(stats.tracks).map(([id, v]) => [tracks.find(t => t.id === id), v]).filter(x => x[0]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('dTop').innerHTML = top.length ? top.map(([t, v]) => `<div class="dt"><span>${esc(t.title)}</span><b>${mins(v)}</b></div>`).join('') : '<div class="dt"><span>Nothing yet. Press play to start your streak.</span></div>';
  $('dash').classList.add('open');
}
$('statRow').onclick = () => { closeLib(); openDash(); };
$('dClose').onclick = () => $('dash').classList.remove('open');
$('dash').addEventListener('click', e => { if (e.target.id === 'dash') $('dash').classList.remove('open'); });
$('signOut2').onclick = () => $('signOut').click();

// ---------- Progress Pad: finished listens go on the Done list, and can count toward a trigger ----------
const ppPref = () => { try { return JSON.parse(localStorage.getItem('mp.pp.' + user.id)) || { log: true, trig: '' }; } catch { return { log: true, trig: '' }; } };
const ppSave = p => localStorage.setItem('mp.pp.' + user.id, JSON.stringify(p));
async function loadPP() {
  const p = ppPref(); $('ppLog').checked = p.log;
  const { data } = await supabase.from('triggers').select('id,name,emoji').eq('user_id', user.id).is('deleted_at', null).order('name');
  const sel = $('ppTrig'); sel.innerHTML = '<option value="">None</option>' + (data || []).map(t => `<option value="${t.id}">${esc((t.emoji ? t.emoji + ' ' : '') + t.name)}</option>`).join('');
  sel.value = (data || []).some(t => t.id === p.trig) ? p.trig : '';
}
$('ppLog').onchange = () => { const p = ppPref(); p.log = $('ppLog').checked; ppSave(p); };
$('ppTrig').onchange = () => { const p = ppPref(); p.trig = $('ppTrig').value; ppSave(p); if (p.trig) toast('Each finished listen will count toward that trigger.'); };
function finishedTrack(t) { logListen(`Listened to "${t.title}" on MemoPad`, t.id); }
async function logListen(title, key) {
  const p = ppPref(); if (!p.log && !p.trig) return; if (!navigator.onLine) return;
  const day = dayOf(), once = `mp.logged.${user.id}.${day}.${key}`; if (localStorage.getItem(once)) return; localStorage.setItem(once, '1');
  try {
    if (p.log) { const r = await supabase.from('writing_entries').insert({ user_id: user.id, on_date: day, kind: 'done', title, notes: 'MemoPad' }); if (r.error) throw r.error; }
    if (p.trig) {
      const ex = await supabase.from('date_trigger_states').select('status,times_done').eq('user_id', user.id).eq('on_date', day).eq('trigger_id', p.trig).maybeSingle();
      if (ex.error) throw ex.error;
      const r = ex.data
        ? await supabase.from('date_trigger_states').update({ status: 'achieved', times_done: ex.data.status === 'achieved' ? Math.min(999, ex.data.times_done + 1) : 1, updated_at: new Date().toISOString() }).eq('user_id', user.id).eq('on_date', day).eq('trigger_id', p.trig)
        : await supabase.from('date_trigger_states').insert({ user_id: user.id, on_date: day, trigger_id: p.trig, status: 'achieved', times_done: 1 });
      if (r.error) throw r.error;
      // make sure the trigger shows on today's list in the pad
      const a = await supabase.from('date_assignments').select('position,trigger_id').eq('user_id', user.id).eq('on_date', day);
      if (!a.error && !(a.data || []).some(x => x.trigger_id === p.trig)) await supabase.from('date_assignments').insert({ user_id: user.id, on_date: day, kind: 'trigger', trigger_id: p.trig, position: (a.data || []).reduce((m, x) => Math.max(m, x.position), -1) + 1 });
    }
    toast('Nice work. Logged in your Progress Pad ✓', false, 3500);
  } catch (e) { localStorage.removeItem(once); toast('Could not log to Progress Pad: ' + e.message, true); }
}

// ---------- share a playlist by link ----------
const b64e = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
$('peShare').onclick = () => {
  const p = editPl; if (!p || !p.items.length) return; $('plEdit').classList.remove('open');
  const code = b64e({ n: p.name, i: p.items.map(it => [it.m, it.t0 ?? null, it.t1 ?? null, it.label]) });
  const priv = p.items.some(it => { const t = tracks.find(x => x.id === it.m); return t && isOwn(t) && !t.is_shared; });
  if (priv) toast('Some memos in this playlist are not shared yet, so others will not hear them.', true, 6000);
  shareLink(`${location.origin}/?pl=${code}`, p.name);
};
(() => { const q = new URLSearchParams(location.search); if (q.get('pl')) { sessionStorage.setItem('mp.plshare', q.get('pl')); history.replaceState(null, '', '/'); } })();
function importSharedPlaylist() {
  const code = sessionStorage.getItem('mp.plshare'); if (!code) return; sessionStorage.removeItem('mp.plshare');
  let o; try { o = b64d(code); } catch { toast('That playlist link is not complete.', true); return; }
  const items = (o.i || []).map(([m, t0, t1, label]) => ({ m, t0, t1, label })).filter(it => tracks.some(t => t.id === it.m));
  if (!items.length) { toast('None of the memos in that playlist are shared with you.', true); return; }
  let p = playlists.find(x => x.name === o.n && JSON.stringify(x.items) === JSON.stringify(items));
  if (!p) { p = { id: crypto.randomUUID(), name: o.n || 'Shared playlist', items }; playlists.push(p); savePlaylists(); }
  const miss = (o.i || []).length - items.length;
  toast(`Playlist "${p.name}" added${miss ? ` (${miss} item${miss === 1 ? '' : 's'} not shared with you)` : ''}. Tap ▶ in your library to play.`, false, 6000);
}

// each favourite line also goes into the Quotes section of today's Progress Pad
async function quoteToPad(f, title) {
  if (!navigator.onLine) { toast('Saved here. It will not reach Progress Pad Quotes while you are offline.', true); return; }
  const { data, error } = await supabase.from('writing_entries').insert({ user_id: user.id, on_date: dayOf(), kind: 'quotes', title: f.text.slice(0, 500), notes: `From "${title}" on MemoPad` }).select('id').single();
  if (error) { toast('Saved here, but it could not reach Progress Pad: ' + error.message, true); return; }
  f.pp = data.id; localStorage.setItem(favKey(), JSON.stringify(favs)); favToast(f, 'Saved to favourites and your Progress Pad Quotes ★');
}


// ---------- true full screen and blackout ----------
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
async function goFull(el) { try { await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.()); } catch {} }
function exitFull() { if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
// read-along full screen: buttons fade while playing, one tap brings them back, double tap toggles full screen.
// iPhone Safari can't make a page truly full screen, so there we hide everything but the words.
const canFull = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) && !/iPhone|iPod/.test(navigator.userAgent);
let rHideT = 0, rTapAt = 0, rTapT = 0;
function rPoke() { const R = $('reader'); R.classList.add('ctl'); clearTimeout(rHideT); rHideT = setTimeout(() => { if (!audio.paused) R.classList.remove('ctl'); }, 3500); }
function setImm(on) { $('reader').classList.toggle('imm', on); $('rFull').textContent = on ? 'Exit full screen' : 'Full screen'; if (on) { if (canFull) goFull($('reader')); $('reader').classList.remove('ctl'); } else exitFull(); }
$('rFull').onclick = e => { e.stopPropagation(); const on = !$('reader').classList.contains('imm'); setImm(on); if (on && !canFull) toast('Tap once for the buttons. Double tap to leave full screen.', false, 3000); };
document.addEventListener('fullscreenchange', () => { if (!fsEl() && $('reader').classList.contains('imm')) setImm(false); });
$('reader').addEventListener('click', e => {
  if (e.target.closest('button')) { rPoke(); return; }
  const n = Date.now();
  if (n - rTapAt < 350) { clearTimeout(rTapT); rTapAt = 0; setImm(!$('reader').classList.contains('imm')); return; }
  rTapAt = n; rTapT = setTimeout(() => { const R = $('reader'); if (R.classList.contains('ctl') && !audio.paused) { clearTimeout(rHideT); R.classList.remove('ctl'); } else rPoke(); }, 300);
});
audio.addEventListener('pause', () => { if (!$('reader').hidden) rPoke(); });
let blackWake = null, hintT = 0;
async function openBlackout() {
  $('pop').classList.remove('open'); const B = $('blackout'); B.hidden = false; showHint();
  goFull(B); try { blackWake = await navigator.wakeLock?.request('screen'); } catch { blackWake = null; }
}
function closeBlackout() { $('blackout').hidden = true; exitFull(); try { blackWake && blackWake.release(); } catch {} blackWake = null; }
function showHint() { const h = $('bHint'); h.classList.add('show'); clearTimeout(hintT); hintT = setTimeout(() => h.classList.remove('show'), 2500); }
let lastTap = 0;
$('blackout').addEventListener('click', () => { const n = Date.now(); if (n - lastTap < 400) closeBlackout(); else showHint(); lastTap = n; });
$('blackBtn').onclick = openBlackout; $('rBlack').onclick = openBlackout;
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('blackout').hidden) closeBlackout(); });
document.addEventListener('fullscreenchange', () => { if (!fsEl() && !$('blackout').hidden) { /* leaving full screen keeps the black screen; double tap to close */ } });

// ---------- phone version: install to the home screen ----------
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone()) $('installBtn').hidden = false;
$('installBtn').onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; if (r.outcome === 'accepted') $('installBtn').hidden = true; installEvt = null; return; }
  toast('In Safari, tap the Share button, then "Add to Home Screen". MemoPad then opens full screen like an app.', false, 9000);
};


// ---------- Esc backs out of whatever is open ----------
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!$('blackout').hidden || !$('reader').hidden) return; // those close themselves
  const dlg = [...document.querySelectorAll('.cv.open')].pop();
  if (dlg) { dlg.classList.remove('open'); return; }
  if ($('pop').classList.contains('open')) { $('pop').classList.remove('open'); return; }
  if (!$('repbar').hidden) { stopRep(); return; }
  if (document.body.classList.contains('libopen')) { closeLib(); return; }
  if (!$('libSearch').hidden) { $('libSearchBtn').click(); return; }
  if (mode === 'tx') setMode('wave');
});

// the style switch and full screen button fade away while playing; touch or move over the view to bring them back
let vzT = 0;
function vzPoke() { const w = $('waveWrap'); w.classList.remove('idle'); clearTimeout(vzT); vzT = setTimeout(() => { if (!audio.paused) w.classList.add('idle'); }, 2500); }
['pointermove', 'pointerdown'].forEach(ev => $('view').addEventListener(ev, vzPoke, { passive: true }));
audio.addEventListener('play', vzPoke); audio.addEventListener('pause', () => { clearTimeout(vzT); $('waveWrap').classList.remove('idle'); });

// ---------- full screen visualiser controls ----------
$('vizFs').onclick = e => { e.stopPropagation(); openVizFull(); };
$('vfClose').onclick = e => { e.stopPropagation(); closeVizFull(); };
$('vfPlay').onclick = e => { e.stopPropagation(); togglePlay(); vfPoke(); };
holdable($('vfPrev'), -1); holdable($('vfNext'), 1);
['vfPrev', 'vfNext'].forEach(id => $(id).addEventListener('click', vfPoke));
// tap the screen (anywhere that isn't a button) to pause or play
$('vFull').addEventListener('click', e => { if (e.target.closest('button')) { vfPoke(); return; } togglePlay(); vfPoke(); });
{ let tap = null;
  $('waveWrap').addEventListener('pointerdown', e => { tap = vizStyle !== 'wave' && !e.target.closest('button') ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
  $('waveWrap').addEventListener('pointerup', e => { if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8 && performance.now() - tap.t < 400) togglePlay(); tap = null; }); }
document.addEventListener('fullscreenchange', () => { if (!fsEl() && !$('vFull').hidden) closeVizFull(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('vFull').hidden) { e.preventDefault(); closeVizFull(); } });

// ---------- light mode for read-along / full screen ----------
function setReaderLight(on) { $('reader').classList.toggle('light', on); $('rLight').textContent = on ? 'Dark mode' : 'Light mode'; localStorage.setItem('mp.readerLight', on ? '1' : ''); }
$('rLight').onclick = () => setReaderLight(!$('reader').classList.contains('light'));
setReaderLight(!!localStorage.getItem('mp.readerLight'));

// ---------- drag the panel edges to resize (computer) ----------
(() => {
  const app = document.querySelector('.app'), clampW = v => Math.max(240, Math.min(560, v));
  const load = () => { const w = JSON.parse(localStorage.getItem('mp.widths') || '{}'); if (w.l) app.style.setProperty('--lw', w.l + 'px'); if (w.r) app.style.setProperty('--rw', w.r + 'px'); };
  const save = () => localStorage.setItem('mp.widths', JSON.stringify({ l: parseInt(app.style.getPropertyValue('--lw')) || 0, r: parseInt(app.style.getPropertyValue('--rw')) || 0 }));
  const drag = (el, side) => el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const panel = el.parentElement, x0 = e.clientX, w0 = panel.getBoundingClientRect().width;
    const move = ev => { const w = clampW(side === 'l' ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0)); app.style.setProperty(side === 'l' ? '--lw' : '--rw', w + 'px'); drawOverview(); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); save(); drawOverview(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  drag($('rzL'), 'l'); drag($('rzR'), 'r'); load();
  $('rzL').ondblclick = $('rzR').ondblclick = () => { app.style.removeProperty('--lw'); app.style.removeProperty('--rw'); localStorage.removeItem('mp.widths'); drawOverview(); };
})();
