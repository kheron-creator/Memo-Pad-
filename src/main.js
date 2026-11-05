import './style.css';
import {
  supabase, configured, BUCKET, TABLE, FREE_STORAGE, MAX_FILE,
  rowToTrack, trackToRow, cacheAll, cachePut, cacheDel, audioGet, audioPut, cacheClear,
} from './cloud.js';

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
const clockFmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = Math.floor(s % 60), c = Math.floor((s % 1) * 100); return `${pad(m)}:${pad(x)}.${pad(c)}`; };
const short = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`; };
function lerpCol(cols, f) { f = clamp(f, 0, 1) * (cols.length - 1); const i = Math.min(cols.length - 2, Math.floor(f)), k = f - i; const a = hex(cols[i]), b = hex(cols[i + 1]); return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(',')})`; }
function hex(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function status(t, err) { const s = $('status'); s.textContent = t || ''; s.className = 'status' + (err ? ' err' : ''); }
let toastT;
function toast(t, warn, ms = 4200) { const el = $('toast'); el.textContent = t; el.className = 'toast show' + (warn ? ' warn' : ''); clearTimeout(toastT); toastT = setTimeout(() => el.className = 'toast', ms); }
const mb = b => (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB';
const isOwn = t => !!(t && user && t.user_id === user.id);
const norm = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newAC = () => new (window.AudioContext || window.webkitAudioContext)();
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
  $('whoTxt').textContent = u.email || 'Signed in';
  // instant: show the offline cache, then refresh from Supabase
  const cached = (await cacheAll()).filter(t => t.user_id === u.id || t.is_shared);
  tracks = cached.map(t => ({ ...t, peaks: t.peaks ? Float32Array.from(t.peaks) : null })).sort((a, b) => b.added - a.added);
  renderCats(); renderLib(); if (tracks[0]) select(tracks[0]); else showEmpty();
  requestAnimationFrame(loop);
  await refresh();
  refreshStorage();
}
async function refresh() {
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: false });
  if (error) { if (!tracks.length) status('Offline. Showing what is saved on this device.'); return; }
  const prev = new Map(tracks.map(t => [t.id, t]));
  const fresh = data.map(r => { const t = rowToTrack(r); const p = prev.get(t.id); if (p) { t.blob = p.blob; if (!t.peaks && p.peaks) t.peaks = p.peaks; } return t; });
  // keep the selected object if it still exists, so playback isn't interrupted
  const curId = cur && cur.id;
  if (cur) { const f = fresh.find(t => t.id === curId); if (f && f.updated_at === cur.updated_at) fresh[fresh.indexOf(f)] = cur; else if (f) { Object.assign(cur, f); fresh[fresh.indexOf(f)] = cur; } }
  const gone = tracks.filter(t => !fresh.some(f => f.id === t.id));
  gone.forEach(t => cacheDel(t.id));
  tracks = fresh; tracks.forEach(t => cachePut(t));
  renderCats(); renderLib();
  if (!curId || !tracks.some(t => t.id === curId)) { cur = null; tracks[0] ? select(tracks[0]) : showEmpty(); }
  else { renderChapters(); renderTranscript(); drawOverview(); updateMain(); }
}

// ---------- storage meter ----------
let storageUsed = 0;
async function refreshStorage() {
  let used = null; // add up my own audio files
  const l = await supabase.storage.from(BUCKET).list(user.id, { limit: 1000 });
  if (!l.error && Array.isArray(l.data)) used = l.data.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  if (used == null) { $('storeTxt').textContent = 'Storage use is not available offline.'; return; }
  storageUsed = used;
  const pct = used / FREE_STORAGE * 100, warn = pct >= 70;
  $('storeBar').style.width = Math.min(100, pct).toFixed(1) + '%'; $('storeBar').classList.toggle('warn', warn);
  $('storeTxt').textContent = `${mb(used)} of 1 GB used (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)${warn ? ' · nearly full' : ''}`;
  $('storeTxt').classList.toggle('warn', warn);
  if (warn && !sessionStorage.getItem('mp.warned')) { sessionStorage.setItem('mp.warned', '1'); toast(`MemoPad storage is ${Math.round(pct)}% full (${mb(used)} of 1 GB). Delete old memos or compress more to make room.`, true, 7000); }
}

// ---------- adding audio ----------
$('drop').onclick = e => { if (e.target.id !== 'chooseBtn') $('file').click(); };
$('chooseBtn').onclick = $('browse').onclick = () => $('file').click();
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
    let ab;
    try { ab = await decode(f); } catch (err) { throw new Error(`could not read the audio in ${f.name}`); }
    let out = f;
    if (!preCompressed) {
      status(`Compressing ${mb(before)}…`);
      const p = settingsFor('standard', ab.duration, 48);
      const blob = await compress(ab, p, { trim: $('cvTrim').checked, norm: $('cvNorm').checked, fmt: 'mp3' }, x => { prog(5 + 70 * x); status(`Compressing ${mb(before)}… ${Math.round(x * 100)}%`); });
      out = new File([blob], base + '.mp3', { type: 'audio/mpeg' });
      if (out.size >= before && /mpeg|mp3/.test(f.type + f.name)) { out = f; }
      else ab = await decode(out);
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
  ['', ...allCats()].forEach(c => {
    const b = document.createElement('button'); b.textContent = c || 'All'; b.className = c === catFilter ? 'on' : '';
    b.onclick = () => { catFilter = c; renderCats(); renderLib(); }; C.appendChild(b);
  });
}
$('libq').addEventListener('input', () => renderLib());
function textOf(t) { if (t._text == null) t._text = norm(t.words.map(w => w.text).join(' ')); return t._text; }
function renderLib() {
  const L = $('lib'); L.innerHTML = '';
  const q = norm($('libq').value.trim());
  const ok = t => (!catFilter || t.category === catFilter) && (!q || norm(t.title).includes(q) || textOf(t).includes(q));
  const mine = tracks.filter(t => isOwn(t) && ok(t)), shared = tracks.filter(t => !isOwn(t) && ok(t));
  const section = (title, list) => {
    if (!list.length) return; const h = document.createElement('h4'); h.textContent = title; L.appendChild(h);
    list.forEach(t => {
      const d = document.createElement('div'); d.className = 'item' + (t === cur ? ' on' : '') + (t === cur && !audio.paused ? ' playing' : '');
      const n = t.chapters.length;
      d.innerHTML = `<span class="dot"></span><div style="min-width:0;flex:1"><div class="nm">${esc(t.title)}</div><div class="mt"><span>${short(t.duration)}</span><span>· ${n} chapter${n === 1 ? '' : 's'}</span>${t.category ? `<span class="cat">${esc(t.category)}</span>` : ''}${isOwn(t) && t.is_shared ? '<span class="sh">· shared</span>' : ''}${txing === t ? '<span class="sh">· transcribing…</span>' : txQueue.includes(t) ? '<span class="sh">· waiting to transcribe</span>' : ''}</div></div>`;
      d.onclick = () => { select(t); closeLib(); };
      L.appendChild(d);
    });
  };
  section('Your affirmations', mine);
  section('Shared in MemoPad', shared);
  if (!mine.length && !shared.length) L.innerHTML = `<div class="none">${tracks.length ? 'Nothing matches.' : 'No memos yet. Add your first one above.'}</div>`;
}
function showEmpty() { cur = null; $('emptycard').style.display = 'flex'; setSrc(null); $('clist').innerHTML = ''; drawOverview(); }
function setSrc(u) { if (srcUrl && srcUrl.startsWith('blob:')) URL.revokeObjectURL(srcUrl); srcUrl = u; if (u) audio.src = u; else audio.removeAttribute('src'); }

async function select(t) {
  if (cur === t) return; cur = t; audio.pause(); setSrc(null);
  const own = isOwn(t);
  document.body.classList.toggle('readonly', !own);
  $('ttl').contentEditable = own ? 'true' : 'false';
  $('emptycard').style.display = 'none'; $('ttl').textContent = t.title;
  const d = new Date(t.added); $('sub').textContent = `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}   ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  renderMeta();
  search.q = ''; $('q').value = ''; $('sbar').classList.remove('has'); $('qc').textContent = '';
  status(t._txMsg || ''); prog(null); renderLib(); renderChapters(); renderTranscript(); drawOverview(); updateMain();
  await loadAudio(t);
}
// cached copy first (works offline), otherwise a signed URL from the private bucket
async function loadAudio(t) {
  const blob = t.blob || await audioGet(t.id);
  if (cur !== t) return;
  if (blob) { t.blob = blob; setSrc(URL.createObjectURL(blob)); audio.playbackRate = speed(); return; }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(t.audio_path, 3600);
  if (cur !== t) return;
  if (error) { status('Could not load this audio. Check your connection.', true); return; }
  setSrc(data.signedUrl); audio.playbackRate = speed();
  fetch(data.signedUrl).then(r => r.ok ? r.blob() : null).then(b => { if (b) { t.blob = b; audioPut(t.id, b); } }).catch(() => {});
}
async function getBlob(t) {
  if (t.blob) return t.blob;
  const c = await audioGet(t.id); if (c) return t.blob = c;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(t.audio_path, 600);
  if (error) throw error;
  const b = await (await fetch(data.signedUrl)).blob(); t.blob = b; audioPut(t.id, b); return b;
}
const speed = () => +document.querySelector('#speed .on').dataset.v;
function renderMeta() {
  const t = cur; if (!t) return; const own = isOwn(t);
  $('catBtn').textContent = t.category || (own ? 'Add category' : 'No category');
  $('catBtn').disabled = !own; $('catBtn').hidden = !own && !t.category;
  $('shareWrap').hidden = !own; $('shareTog').checked = !!t.is_shared;
  $('roTag').hidden = own;
}
$('ttl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('ttl').addEventListener('blur', () => { if (!cur || !isOwn(cur)) return; const v = $('ttl').textContent.trim(); if (!v) { $('ttl').textContent = cur.title; return; } if (v !== cur.title) { cur.title = v; save(); renderLib(); } });
$('doneBtn').onclick = async () => {
  if (!cur) return; if (!isOwn(cur)) { toast('This memo is shared with you, so it is play only.'); return; }
  try { await save(cur, true); toast('Saved to MemoPad ✓', false, 1800); } catch { /* status shows the error */ }
};
$('shareTog').onchange = () => {
  if (!cur || !isOwn(cur)) return; cur.is_shared = $('shareTog').checked; save(cur, true).then(() => toast(cur.is_shared ? 'Shared to MemoPad. Signed-in Progress Today users can play it, but not edit it.' : 'Now private. Only you can play it.'), () => { cur.is_shared = !cur.is_shared; $('shareTog').checked = cur.is_shared; });
  renderLib();
};
// category picker
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
$('delBtn').onclick = async () => {
  const t = cur; if (!t || !isOwn(t)) return; $('pop').classList.remove('open');
  if (!confirm(`Delete "${t.title}" from MemoPad? This removes the audio and transcript for good.`)) return;
  const st = await supabase.storage.from(BUCKET).remove([t.audio_path]);
  const del = await supabase.from(TABLE).delete().eq('id', t.id);
  if (del.error || st.error) { toast('Could not delete: ' + (del.error || st.error).message, true); return; }
  cacheDel(t.id); tracks = tracks.filter(x => x !== t); cur = null; audio.pause();
  renderCats(); renderLib(); tracks[0] ? select(tracks[0]) : showEmpty(); toast('Deleted.'); refreshStorage();
};

// library drawer on phones and tablets
function openLib() { document.body.classList.add('libopen'); }
function closeLib() { document.body.classList.remove('libopen'); }
$('moreBtn').onclick = () => { if (innerWidth <= 1180) openLib(); else $('file').click(); };
$('closeSide').onclick = $('scrim').onclick = closeLib;

// ---------- transport ----------
function togglePlay() { if (!cur || !audio.src) return; if (audio.paused) audio.play().catch(err => status('Tap play again to start (' + err.message + ').', true)); else audio.pause(); }
$('play').onclick = togglePlay;
audio.onplay = () => { $('playIcon').setAttribute('d', 'M16 10 h10 v44 h-10 Z M38 10 h10 v44 h-10 Z'); $('play').classList.add('on'); renderLib(); };
audio.onpause = () => { $('playIcon').setAttribute('d', 'M18 10 L54 32 L18 54 Z'); $('play').classList.remove('on'); renderLib(); };
audio.onerror = () => { if (cur && audio.src) status('This audio could not play. Check your connection and try again.', true); };
const jump = d => { if (cur) audio.currentTime = clamp(audio.currentTime + d, 0, audio.duration || cur.duration); };
$('back').onclick = () => jump(-15); $('fwd').onclick = () => jump(15);
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
function drawWave() {
  if (mode !== 'wave') return;
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
function chapterAt(t) { if (!cur) return -1; let k = -1; cur.chapters.forEach((c, i) => { if (c.t <= t + 0.01) k = i; }); return k; }
function renderChapters() {
  const L = $('clist'); L.innerHTML = ''; if (!cur) return; const own = isOwn(cur);
  cur.chapters.sort((a, b) => a.t - b.t);
  cur.chapters.forEach((c, k) => {
    const d = document.createElement('div'); d.className = 'chap'; d.style.setProperty('--c', CHAP_COLS[k % CHAP_COLS.length]); d.dataset.k = k;
    d.innerHTML = `<div class="n">${k + 1}</div><div style="flex:1;min-width:0"><div class="t"></div><div class="tm">${short(c.t)}</div></div>${own ? '<button class="del" title="Delete">✕</button>' : ''}`;
    const tt = d.querySelector('.t'); tt.textContent = c.title;
    d.onclick = () => { if (tt.isContentEditable) return; audio.currentTime = c.t; };
    if (own) {
      tt.ondblclick = e => { e && e.stopPropagation && e.stopPropagation(); tt.contentEditable = 'true'; tt.focus(); document.getSelection().selectAllChildren(tt); };
      tt.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); tt.blur(); } };
      tt.onblur = () => { tt.contentEditable = 'false'; c.title = tt.textContent.trim() || c.title; save(); renderTranscript(); renderLib(); };
      d.querySelector('.del').onclick = e => { e.stopPropagation(); cur.chapters.splice(k, 1); if (!cur.chapters.length) cur.chapters.push({ t: 0, title: 'Start' }); save(); renderChapters(); renderTranscript(); drawOverview(); renderLib(); };
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
// chapters from transcript: new chapter after long pauses or every ~45s at a sentence end
function transcriptChapters(words) {
  if (!words.length) return [{ t: 0, title: 'Start' }];
  const total = words[words.length - 1].end || 0, minLen = Math.max(25, total / 24); // long tracks get longer chapters
  const out = []; const mk = i => ({ t: Math.max(0, words[i].start - 0.2), title: words.slice(i, i + 6).map(w => w.text).join(' ').replace(/[,.;:!?]+$/, '') });
  out.push({ ...mk(0), t: 0 });
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end, since = words[i].start - out[out.length - 1].t, endS = /[.!?]$/.test(words[i - 1].text);
    if ((gap > 1.6 && since > Math.max(12, minLen * 0.6)) || (endS && since > minLen * 1.8) || (gap > 0.7 && endS && since > minLen)) out.push(mk(i));
  }
  return out;
}

// ---------- transcript ----------
let wordEls = [];
function renderTranscript() {
  const T = $('tx'); T.innerHTML = ''; wordEls = [];
  if (!cur) return;
  if (!cur.words.length) {
    T.innerHTML = (txing === cur || txQueue.includes(cur))
      ? `<div class="empty">Transcribing in the background…<br>The words will appear here and light up as it plays.</div>`
      : isOwn(cur)
      ? `<div class="empty">No transcript yet.<br>Press <b>TRANSCRIBE</b> to turn the audio into text that lights up as it plays.<br><br><span style="font-size:15px">Runs privately on your device. The first time it downloads a speech model.</span></div>`
      : `<div class="empty">No transcript for this memo yet.</div>`;
    return;
  }
  const chStarts = cur.chapters.map(c => c.t); let ci = 0, p = null;
  const frag = document.createDocumentFragment();
  cur.words.forEach((w, i) => {
    const prev = cur.words[i - 1];
    while (ci < chStarts.length && chStarts[ci] <= w.start + 0.25) { const h = document.createElement('div'); h.className = 'ch'; const c = cur.chapters[ci]; h.textContent = `${ci + 1}. ${c.title}`; h.style.color = CHAP_COLS[ci % CHAP_COLS.length]; h.onclick = () => audio.currentTime = c.t; frag.appendChild(h); p = null; ci++; }
    if (!p || (prev && w.start - prev.end > 1.1 && /[.!?]$/.test(prev.text))) { p = document.createElement('p'); frag.appendChild(p); }
    const s = document.createElement('span'); s.className = 'w'; s.textContent = w.text; s.onclick = () => { audio.currentTime = Math.max(0, w.start - 0.05); };
    p.appendChild(s); p.appendChild(document.createTextNode(' ')); wordEls.push(s);
  });
  T.appendChild(frag);
  lastW = -2; applySearch(false);
}
let lastW = -2, lastChap = -2;
function activeWord(t) { const W = cur.words; let lo = 0, hi = W.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].start <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
function updateTranscript() {
  if (!cur || !cur.words.length || mode !== 'tx') return; const t = audio.currentTime; const a = activeWord(t);
  if (a === lastW) return;
  const lo = Math.min(a, lastW), hi = Math.max(a, lastW);
  if (lastW < -1 || Math.abs(a - lastW) > 60) { wordEls.forEach((el, i) => { el.classList.toggle('past', i < a); el.classList.toggle('now', i === a); }); }
  else for (let i = Math.max(0, lo); i <= hi; i++) { const el = wordEls[i]; if (!el) continue; el.classList.toggle('past', i < a); el.classList.toggle('now', i === a); }
  const w = cur.words[a]; if (w && wordEls[a]) { const k = Math.max(0, chapterAt(w.start)); wordEls[a].style.setProperty('--glow', CHAP_COLS[k % CHAP_COLS.length]); }
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
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { $('q').value = ''; search.q = ''; $('sbar').classList.remove('has'); applySearch(false); $('q').blur(); } });
$('qn').onclick = () => step(1); $('qp').onclick = () => step(-1);
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
  const b = $('mainBtn');
  if (busyFor(cur)) { b.textContent = 'TRANSCRIBING…'; b.disabled = true; return; }
  if (cur && txQueue.includes(cur)) { b.textContent = 'WAITING…'; b.disabled = true; return; }
  if (upBusy) { b.textContent = 'ADDING…'; b.disabled = true; return; }
  b.disabled = false; b.textContent = cur && cur.words.length ? 'ADD CHAPTER' : 'TRANSCRIBE';
}
$('mainBtn').onclick = () => { if (!cur || !isOwn(cur)) return; if (cur.words.length) addChapter(); else enqueueTranscribe(cur); };
function prog(p) { $('prog').style.display = p == null ? 'none' : 'block'; $('prog').firstChild.style.width = (p || 0) + '%'; }
// automatic transcription, like Voice Memos: every new memo joins a queue and is transcribed in the background
function enqueueTranscribe(t, auto) {
  if (!t || !isOwn(t) || t.words.length || txing === t || txQueue.includes(t)) return;
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
    const fail = msg => { finish(); if (here()) status('Transcription failed (' + msg + '). Press TRANSCRIBE to try again. The first run needs internet to download the speech model.', true); else toast(`Could not transcribe "${t.title}": ${msg}`, true); };
    try {
      st('Preparing audio for the transcript…'); pg(3);
      const ab = await decode(await getBlob(t));
      const off = new OfflineAudioContext(1, Math.ceil(ab.duration * 16000), 16000); const s = off.createBufferSource(); s.buffer = ab; s.connect(off.destination); s.start();
      const pcm = (await off.startRendering()).getChannelData(0);
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
          setWords(t, list.filter(w => w.text && !/^[\[(].*[\])]$/.test(w.text)));
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
function setWords(t, list) {
  if (!isOwn(t)) return;
  t.words = list.map(w => ({ text: w.text, start: +w.start, end: +w.end })).sort((a, b) => a.start - b.start); t._text = null; t.chapters = transcriptChapters(t.words); save(t, true).catch(() => {}); renderLib();
  if (cur === t) { renderChapters(); renderTranscript(); drawOverview(); updateMain(); }
}
function spread(text, a, b) { const ws = text.trim().split(/\s+/).filter(Boolean), wt = ws.map(w => w.length + 2), tot = wt.reduce((x, y) => x + y, 0) || 1; let t = a; return ws.map((w, i) => { const d = (b - a) * wt[i] / tot; const o = { text: w, start: t, end: t + d * 0.9 }; t += d; return o; }); }

// paste your own script (spread over speech, using the waveform to skip pauses)
$('pasteBtn').onclick = () => {
  if (!cur || !isOwn(cur)) return; const txt = prompt('Paste the script of this affirmation. MemoPad will spread the words over the speaking parts of the audio.'); if (!txt || !txt.trim()) return;
  const ws = txt.trim().split(/\s+/); const p = cur.peaks; if (!p) { setWords(cur, spread(txt, 0, cur.duration)); return; }
  const voiced = []; for (let i = 0; i < p.length; i++) if (p[i] > 0.1) voiced.push(i / BPS); if (!voiced.length) { setWords(cur, spread(txt, 0, cur.duration)); return; }
  const wt = ws.map(w => w.length + 2), tot = wt.reduce((a, b) => a + b, 0); let acc = 0; const list = ws.map((w, i) => { const f0 = acc / tot; acc += wt[i]; const f1 = acc / tot; return { text: w, start: voiced[Math.floor(f0 * (voiced.length - 1))], end: voiced[Math.floor(f1 * (voiced.length - 1))] }; });
  setWords(cur, list); setMode('tx');
};
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
let ovTick = 0, looping = false;
function loop() {
  if (cur) {
    const t = audio.currentTime; $('clock').textContent = clockFmt(t);
    const k = chapterAt(t); if (k !== lastChap) { lastChap = k; $('chapnow').textContent = k >= 0 && cur.chapters.length > 1 ? `Chapter ${k + 1} · ${cur.chapters[k].title}` : ''; $('clist').querySelectorAll('.chap').forEach(el => el.classList.toggle('on', +el.dataset.k === k)); }
    if ($('loop').checked && !audio.paused && k >= 0) { const end = cur.chapters[k + 1]?.t ?? cur.duration; if (t >= end - 0.05) audio.currentTime = cur.chapters[k].t; }
    updateTranscript(); if (++ovTick % 6 === 0) drawOverview();
  }
  drawWave(); requestAnimationFrame(loop);
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
  if (session) start(session.user); else showAuth();
  supabase.auth.onAuthStateChange((ev, s) => {
    setTimeout(() => { // never await Supabase inside this callback
      if (ev === 'SIGNED_OUT') { user = null; tracks = []; cur = null; audio.pause(); showAuth(); }
      else if (s && s.user && (!user || user.id !== s.user.id)) start(s.user);
    }, 0);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
