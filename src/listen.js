// Public listen page: anyone with the link can hear a memo the owner made public. No sign-up.
import './listen.css';
import { supabase, BUCKET, TABLE } from './cloud.js';
import { displayStarts } from './sync.js';
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const short = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const audio = $('lAudio'), q = new URLSearchParams(location.search);
let wasPlaying = null, memo = null, words = [], st = [], chapters = [], shown = -1, lastA = -2, lastCh = -2;

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
  renderChapters(); renderTicks(); if (!words.length) $('lSent').innerHTML = '<span class="lmsg">Press play to listen.</span>';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: data.title, artist: 'MemoPad · Progress Today', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    navigator.mediaSession.setActionHandler('play', () => audio.play()); navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prevCh); navigator.mediaSession.setActionHandler('nexttrack', nextCh);
  }
  requestAnimationFrame(loop);
}
function fail(msg) { $('lTitle').textContent = 'MemoPad'; $('lSent').innerHTML = `<span class="lmsg">${msg}</span>`; document.querySelector('.ybar').hidden = true; $('ybig').hidden = true; }
function renderChapters() {
  const L = $('lChaps'); L.innerHTML = ''; if (chapters.length < 2) return; $('lChh').hidden = false;
  chapters.forEach((c, k) => { const b = document.createElement('button'); b.innerHTML = `<span class="n">${k + 1}</span><span class="t"></span><span class="tm">${short(c.t)}</span>`; b.querySelector('.t').textContent = c.title; b.onclick = () => { audio.currentTime = c.t; audio.play().catch(() => {}); scrollTo({ top: 0, behavior: 'smooth' }); poke(); }; L.appendChild(b); });
}
function loop() {
  const t = audio.currentTime || 0, d = audio.duration || memo.duration_s || 1;
  const pc = (t / d * 100).toFixed(2) + '%'; $('lFill').style.width = pc; $('lDot').style.left = pc; $('lNow').textContent = short(t);
  const playing = !audio.paused; if (playing !== wasPlaying) { wasPlaying = playing; $('yt').classList.toggle('playing', playing); $('lPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play'); $('ybig').setAttribute('aria-label', playing ? 'Pause' : 'Play'); if (playing) { yt.classList.add('started'); poke(); } else showCtl(); }
  const k = chapterAt(t); if (k !== lastCh) { lastCh = k; const nm = chapters.length > 1 && k >= 0 ? chapters[k].title : ''; $('lCh').textContent = nm; $('lChn').textContent = nm ? '· ' + nm : ''; $('lChaps').querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === k)); }
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
$('lBar').addEventListener('pointerdown', e => { e.stopPropagation(); drag = true; $('yt').classList.add('drag'); $('lBar').setPointerCapture(e.pointerId); seekAt(e); });
$('lBar').addEventListener('pointermove', e => { if (drag) { seekAt(e); poke(); } });
$('lBar').addEventListener('pointerup', () => { drag = false; $('yt').classList.remove('drag'); });
function renderTicks() { const T = $('lTicks'), d = memo.duration_s || 1; T.innerHTML = ''; if (chapters.length < 2) return; chapters.slice(1).forEach(c => { const i = document.createElement('i'); i.style.left = (c.t / d * 100) + '%'; T.appendChild(i); }); }
addEventListener('keydown', e => {
  if (e.target.closest?.('input,textarea')) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space' || k === 'k') { e.preventDefault(); $('lPlay').click(); }
  else if (k === 'j' || e.key === 'ArrowLeft') $('lBack').click();
  else if (k === 'l' || e.key === 'ArrowRight') $('lFwd').click();
  else if (k === 'f') $('lFull').click();
  else return; poke();
});
load();

// YouTube-style player: controls fade while playing, tap to show, double tap the sides to skip
const yt = $('yt'); let hideT = 0;
function showCtl() { yt.classList.add('ctl'); clearTimeout(hideT); }
function poke() { showCtl(); if (!audio.paused && !drag) hideT = setTimeout(() => yt.classList.remove('ctl'), 3000); }
showCtl();
yt.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') poke(); });
yt.addEventListener('mouseleave', () => { if (!audio.paused) { clearTimeout(hideT); yt.classList.remove('ctl'); } });
$('ybig').onclick = e => { e.stopPropagation(); $('lPlay').click(); poke(); };
document.querySelector('.ybar').addEventListener('click', e => { e.stopPropagation(); poke(); });
let tapT = 0, tapAt = 0, tapX = 0;
function flash(id) { const el = $(id); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }
yt.addEventListener('click', e => {
  const r = yt.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, n = Date.now();
  if (n - tapAt < 320 && Math.abs(x - tapX) < 0.2) { clearTimeout(tapT); tapAt = 0;
    if (x < 0.35) { $('lBack').click(); flash('yl'); } else if (x > 0.65) { $('lFwd').click(); flash('yr'); } else $('lFull').click();
    return; }
  tapAt = n; tapX = x;
  tapT = setTimeout(() => { if (matchMedia('(hover:hover)').matches) { $('lPlay').click(); poke(); } else if (yt.classList.contains('ctl') && !audio.paused) { clearTimeout(hideT); yt.classList.remove('ctl'); } else poke(); }, 260);
});

// full screen, light mode, blackout
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const goFull = el => { try { const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.(); r?.catch?.(() => {}); } catch {} };
const exitFull = () => { if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); };
function setFull(on) { document.body.classList.toggle('full', on); $('lFull').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); $('lFull').title = on ? 'Exit full screen (f)' : 'Full screen (f)'; if (on) goFull(document.documentElement); else exitFull(); poke(); }
$('lFull').onclick = () => setFull(!document.body.classList.contains('full'));
document.addEventListener('fullscreenchange', () => { if (!fsEl() && document.body.classList.contains('full') && $('blackout').hidden) setFull(false); });
document.addEventListener('webkitfullscreenchange', () => { if (!fsEl() && document.body.classList.contains('full') && $('blackout').hidden) setFull(false); });
function setLight(on) { document.body.classList.toggle('light', on); $('lLight').setAttribute('aria-label', on ? 'Dark mode' : 'Light mode'); $('lLight').title = on ? 'Dark mode' : 'Light mode'; try { localStorage.setItem('mpl.light', on ? '1' : ''); } catch {} }
$('lLight').onclick = () => setLight(!document.body.classList.contains('light'));
try { setLight(!!localStorage.getItem('mpl.light')); } catch {}
let wake = null, hintT = 0, lastTap = 0;
async function blackout(on) {
  $('blackout').hidden = !on;
  if (on) { hint(); goFull($('blackout')); try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
  else { exitFull(); document.body.classList.remove('full'); try { wake && wake.release(); } catch {} wake = null; }
}
function hint() { $('bHint').classList.add('show'); clearTimeout(hintT); hintT = setTimeout(() => $('bHint').classList.remove('show'), 2500); }
$('lBlack').onclick = () => blackout(true);
$('blackout').addEventListener('click', () => { const n = Date.now(); if (n - lastTap < 400) blackout(false); else hint(); lastTap = n; });
addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!$('blackout').hidden) blackout(false); else if (document.body.classList.contains('full')) setFull(false); });
