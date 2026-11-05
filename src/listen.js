// Public listen page: anyone with the link can hear a memo the owner made public. No sign-up.
import './listen.css';
import { supabase, BUCKET, TABLE } from './cloud.js';
import { displayStarts } from './sync.js';
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const short = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const audio = $('lAudio'), q = new URLSearchParams(location.search);
let memo = null, words = [], st = [], chapters = [], shown = -1, lastA = -2, lastCh = -2;

const isEnd = x => /[.!?…]["'”’)]*$/.test(x) && !/^\d+[.)]$/.test(x);
const isNum = x => /^\d+[.)]?$/.test(x);
function sentenceAt(i) {
  const W = words; i = Math.max(0, Math.min(W.length - 1, i)); let j = i, k = i;
  while (j > 0 && !isEnd(W[j - 1].text)) j--;
  while (k < W.length - 1 && !isEnd(W[k].text)) k++;
  while (j < k && isNum(W[j].text)) j++;
  if (k - j < 24) return [j, k];
  let a = j;
  for (let p = j; p <= k; p++) { const n = p - a + 1, gap = p < k ? W[p + 1].start - W[p].end : 9; if (p === k || n >= 16 || (n >= 5 && (gap > 0.45 || /[,;:—–]$/.test(W[p].text)))) { if (i <= p) return [a, p]; a = p + 1; } }
  return [j, k];
}
function activeWord(t) { t += 0.06; let lo = 0, hi = st.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (st[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; }
const chapterAt = t => { let k = -1; chapters.forEach((c, i) => { if (c.t <= t + 0.01) k = i; }); return k; };

async function load() {
  const id = q.get('id'); if (!id) return fail('This link is not complete.');
  const { data, error } = await supabase.from(TABLE).select('id,title,duration_s,peaks,words,chapters,audio_path').eq('id', id).eq('is_public', true).maybeSingle();
  if (error || !data) return fail('This memo is not public any more, or the link is wrong.');
  memo = data; words = Array.isArray(data.words) ? data.words : []; chapters = Array.isArray(data.chapters) && data.chapters.length ? data.chapters : [{ t: 0, title: 'Start' }];
  st = displayStarts(words, Array.isArray(data.peaks) ? data.peaks : null, 20);
  document.title = `${data.title} · MemoPad`; $('lTitle').textContent = data.title; $('lDur').textContent = short(data.duration_s);
  const s = await supabase.storage.from(BUCKET).createSignedUrl(data.audio_path, 6 * 3600);
  if (s.error) return fail('The audio could not be loaded. Please try again later.');
  audio.src = s.data.signedUrl;
  const t0 = +q.get('t') || 0;
  if (t0) { const go = () => { if (audio.currentTime < t0 - 1) audio.currentTime = t0; }; audio.addEventListener('loadedmetadata', go, { once: true }); audio.addEventListener('canplay', go, { once: true }); audio.addEventListener('play', go, { once: true }); }
  renderChapters(); if (!words.length) $('lSent').innerHTML = '<span class="lmsg">Press play to listen.</span>';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: data.title, artist: 'MemoPad · Progress Today', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    navigator.mediaSession.setActionHandler('play', () => audio.play()); navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prevCh); navigator.mediaSession.setActionHandler('nexttrack', nextCh);
  }
  requestAnimationFrame(loop);
}
function fail(msg) { $('lTitle').textContent = 'MemoPad'; $('lSent').innerHTML = `<span class="lmsg">${msg}</span>`; document.querySelector('.lctl').hidden = true; $('lBar').hidden = true; document.querySelector('.ltime').hidden = true; }
function renderChapters() {
  const L = $('lChaps'); L.innerHTML = ''; if (chapters.length < 2) return;
  chapters.forEach((c, k) => { const b = document.createElement('button'); b.innerHTML = `<span class="n">${k + 1}</span><span class="t"></span><span class="tm">${short(c.t)}</span>`; b.querySelector('.t').textContent = c.title; b.onclick = () => { audio.currentTime = c.t; audio.play().catch(() => {}); scrollTo({ top: 0, behavior: 'smooth' }); }; L.appendChild(b); });
}
function loop() {
  const t = audio.currentTime || 0, d = audio.duration || memo.duration_s || 1;
  $('lFill').style.width = (t / d * 100).toFixed(2) + '%'; $('lNow').textContent = short(t); $('lPlay').classList.toggle('on', !audio.paused);
  const k = chapterAt(t); if (k !== lastCh) { lastCh = k; $('lCh').textContent = chapters.length > 1 && k >= 0 ? chapters[k].title : ''; $('lChaps').querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === k)); }
  if (words.length) {
    const a = Math.max(0, activeWord(t));
    if (a !== lastA) {
      lastA = a; const [j, e] = sentenceAt(a);
      if (j !== shown) { shown = j; const R = $('lSent'); R.innerHTML = ''; const w = document.createElement('div'); w.className = 'in'; for (let i = j; i <= e; i++) { const s = document.createElement('span'); s.className = 'rw'; s.dataset.i = i; s.textContent = words[i].text; w.append(s, ' '); } R.appendChild(w); }
      $('lSent').querySelectorAll('.rw').forEach(s => { const i = +s.dataset.i; s.classList.toggle('past', i < a); s.classList.toggle('now', i === a); });
    }
  }
  requestAnimationFrame(loop);
}
function prevCh() { const t = audio.currentTime, k = chapterAt(t); if (k < 0) return; audio.currentTime = (t - chapters[k].t > 3 || k === 0) ? chapters[k].t : chapters[k - 1].t; }
function nextCh() { const n = chapters[chapterAt(audio.currentTime) + 1]; if (n) audio.currentTime = n.t; }
$('lPlay').onclick = () => audio.paused ? audio.play().catch(() => {}) : audio.pause();
$('lBack').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 15);
$('lFwd').onclick = () => audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15);
$('lPrevCh').onclick = prevCh; $('lNextCh').onclick = nextCh;
const seekAt = e => { const r = $('lBar').getBoundingClientRect(); audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (audio.duration || memo.duration_s); };
let drag = false;
$('lBar').addEventListener('pointerdown', e => { drag = true; $('lBar').setPointerCapture(e.pointerId); seekAt(e); });
$('lBar').addEventListener('pointermove', e => drag && seekAt(e));
$('lBar').addEventListener('pointerup', () => drag = false);
addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); $('lPlay').click(); } });
load();
