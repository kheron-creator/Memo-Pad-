// Public listen page: anyone with the link can hear a memo the owner made public. No sign-up.
import './listen.css';
import { supabase, BUCKET, TABLE } from './cloud.js';
import { displayStarts } from './sync.js';
import { LOFI_DRAW } from './lofi.js';
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const short = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const audio = $('lAudio'), q = new URLSearchParams(location.search);
let wasPlaying = null, memo = null, words = [], st = [], chapters = [], peaks = null, shown = -1, lastA = -2, lastCh = -2;

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
  peaks = Array.isArray(data.peaks) && data.peaks.length ? data.peaks : null;
  st = displayStarts(words, peaks, 20);
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
    navigator.mediaSession.setActionHandler('previoustrack', () => skip(-1)); navigator.mediaSession.setActionHandler('nexttrack', () => skip(1));
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
  drawViz();
  requestAnimationFrame(loop);
}
function prevCh() { const t = audio.currentTime, k = chapterAt(t); if (k < 0) return; audio.currentTime = (t - chapters[k].t > 3 || k === 0) ? chapters[k].t : chapters[k - 1].t; }
function nextCh() { const n = chapters[chapterAt(audio.currentTime) + 1]; if (n) audio.currentTime = n.t; }
$('lPlay').onclick = () => audio.paused ? audio.play().catch(() => {}) : audio.pause();
$('lBack').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 15);
$('lFwd').onclick = () => audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15);
// one press = next/previous affirmation; two quick presses = next/previous chapter
const sStart = j => Math.max(0, (st[j] ?? words[j].start) - 0.05);
function prevAff() { const t = audio.currentTime, [j] = sentenceAt(Math.max(0, activeWord(t))); const [pj] = t - sStart(j) > 1.5 ? [j] : sentenceAt(Math.max(0, j - 1)); audio.currentTime = sStart(pj); }
function nextAff() { const [, e] = sentenceAt(Math.max(0, activeWord(audio.currentTime))); if (e + 1 < words.length) audio.currentTime = sStart(sentenceAt(e + 1)[0]); }
let skipMem = { at: 0, dir: 0, t: 0 };
function skip(dir) {
  if (!words.length) { dir > 0 ? nextCh() : prevCh(); return; }
  const n = Date.now();
  if (n - skipMem.at < 500 && skipMem.dir === dir) { audio.currentTime = skipMem.t; skipMem.at = 0; dir > 0 ? nextCh() : prevCh(); return; }
  skipMem = { at: n, dir, t: audio.currentTime }; dir > 0 ? nextAff() : prevAff();
}
$('lPrevCh').onclick = () => skip(-1); $('lNextCh').onclick = () => skip(1);
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

// ---------- view styles: Captions, Waves, Circle, Lofi (the same looks as the app's full screen view) ----------
const BPS = 20, COLS = ['#25DD5F', '#FFB000', '#EB7100', '#E10195'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
function lerpCol(cols, f) { f = clamp(f, 0, 1) * (cols.length - 1); const i = Math.min(cols.length - 2, Math.floor(f)), k = f - i, a = hex(cols[i]), b = hex(cols[i + 1]); return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(',')})`; }
function rrect(x, px, py, w, h, r) { x.beginPath(); if (x.roundRect) x.roundRect(px, py, w, h, r); else x.rect(px, py, w, h); x.fill(); }
const LOFI = ['glass', 'neon', 'path', 'boat'];
const VIEWS = ['captions', 'wave', 'circle', 'lofi'];
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };
let view = VIEWS.includes(store('mpl.view')) ? store('mpl.view') : 'captions', lofiScene = LOFI.includes(store('mpl.lofi')) ? store('mpl.lofi') : 'glass', vizEnv = 0;
const cv = $('lViz'), cx2 = cv.getContext('2d');
function setView(v) {
  view = v; store('mpl.view', v); yt.classList.toggle('cap', v === 'captions');
  LOFI.forEach(k => yt.classList.toggle('lofi-' + k, v === 'lofi' && lofiScene === k));
  $('lSw').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v !== 'captions') anSync(true);
}
$('lSw').querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation(); poke();
  if (b.dataset.v === 'lofi' && view === 'lofi') { lofiScene = LOFI[(LOFI.indexOf(lofiScene) + 1) % LOFI.length]; store('mpl.lofi', lofiScene); }
  setView(b.dataset.v);
}));
setView(view);
// live sound: a silent twin of the player feeds an analyser, so the audio you hear never goes through Web Audio
let an = null;
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
  const on = view !== 'captions' && view !== 'lofi' && audio.src;
  if (gesture && on) { const A = anEnsure(); if (A.dead) return; if (A.ac.state !== 'running') A.ac.resume().catch(() => {}); if (A.url !== audio.src) { A.url = audio.src; A.el.src = audio.src; } if (!A.started && !A.pending) { A.pending = true; A.el.play().then(() => { A.started = true; A.pending = false; if (audio.paused) A.el.pause(); }).catch(() => { A.pending = false; }); } }
  if (!on || audio.paused || document.hidden) { if (an && an.el && !an.el.paused && !an.pending) an.el.pause(); return; }
  const A = anEnsure(); if (A.dead) return;
  if (A.url !== audio.src) { A.url = audio.src; A.el.src = audio.src; }
  if (A.el.readyState >= 1 && Math.abs(A.el.currentTime - audio.currentTime) > 0.3) A.el.currentTime = audio.currentTime;
  if (A.el.paused && A.started && !A.pending) { A.pending = true; A.el.play().then(() => { A.pending = false; }).catch(() => { A.pending = false; }); }
}
addEventListener('pointerdown', () => anSync(true), true);
addEventListener('keydown', () => anSync(true), true);
const BANDS = Array.from({ length: 33 }, (_, k) => Math.round(2 + Math.pow(k / 32, 1.7) * 92));
function liveBands() {
  if (!an || an.dead || !an.el || an.el.paused || an.ac.state !== 'running') return null;
  an.a.getByteFrequencyData(an.data); let s = 0; for (let i = 2; i < 120; i++) s += an.data[i]; if (!s) return null;
  const L = []; let tot = 0; for (let k = 0; k < 32; k++) { let m = 0; for (let i = BANDS[k]; i < Math.max(BANDS[k] + 1, BANDS[k + 1]); i++) m = Math.max(m, an.data[i]); const v = Math.pow(m / 255, 1.6) * (1 + k / 40); L.push(v); tot += v; } L.avg = tot / 32; return L;
}
function level(t) { if (!peaks) return 0; const i = Math.floor(t * BPS); let m = 0, n = 0; for (let j = i - 1; j <= i + 1; j++) if (peaks[j] != null) { m += peaks[j]; n++; } return n ? m / n : 0; }
function drawViz() {
  if (view === 'captions' || !memo) return;
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, W = Math.round(r.width * d), H = Math.round(r.height * d);
  if (!W || !H) return; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  anSync(false);
  const x = cx2, t = audio.currentTime || 0, now = performance.now() / 1000, playing = !audio.paused, live = view === 'lofi' ? null : liveBands();
  const target = live ? Math.min(1, live.avg * 1.6) : playing ? Math.min(1, level(t) * 1.25) : 0.06 + 0.03 * Math.sin(now * 1.6);
  vizEnv += (target - vizEnv) * (target > vizEnv ? 0.45 : 0.12); const e = vizEnv, M = Math.min(W, H);
  const band = live ? (k => Math.max(0.03, Math.min(1, live[k % 32] * 1.15))) : k => Math.max(0.03, e * (0.5 + 0.5 * Math.sin(k * 0.9 + now * 4.2)) * (1 - k / 32 * 0.55));
  x.clearRect(0, 0, W, H);
  if (view === 'lofi') { x.save(); LOFI_DRAW[lofiScene](x, W, H, M, e, now); x.restore(); return; }
  x.fillStyle = '#0b0b0d'; x.fillRect(0, 0, W, H);
  const small = H < 520 * d, cx = W / 2, cy = H * (small ? 0.36 : 0.42);
  if (view === 'circle') {
    const N = 72, r0 = M * (small ? 0.11 : 0.15) + e * M * 0.03;
    x.lineCap = 'round'; x.lineWidth = Math.max(3 * d, (2 * Math.PI * r0 / N) * 0.55);
    for (let k = 0; k < N; k++) { const a = k / N * Math.PI * 2 - Math.PI / 2, kk = k < N / 2 ? k : N - k, len = band(kk % 32) * M * (small ? 0.12 : 0.17) + 3 * d; x.strokeStyle = lerpCol(COLS, kk / (N / 2)); x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); x.stroke(); }
    x.fillStyle = '#ffffff10'; x.beginPath(); x.arc(cx, cy, r0 - 6 * d, 0, 7); x.fill(); return;
  }
  // Waves: the memo's own waveform scrolling past a playhead, like the app
  const pps = W / 9, bw = pps / BPS, hh = H * 0.42;
  if (peaks) {
    const i0 = Math.max(0, Math.floor((t - W / 2 / pps) * BPS)), i1 = Math.min(peaks.length, Math.ceil((t + W / 2 / pps) * BPS) + 1);
    for (let i = i0; i < i1; i++) { const px = W / 2 + (i / BPS - t) * pps, v = peaks[i], h = Math.max(2 * d, v * hh), w = Math.max(1.5 * d, bw * 0.42); x.fillStyle = lerpCol(COLS, v * 0.75 + (i / peaks.length) * 0.25); x.globalAlpha = i / BPS <= t ? 1 : 0.4; rrect(x, px - w / 2, cy - h / 2, w, h, w / 2); }
  } else {
    const n = Math.floor(W / (6 * d)); for (let i = 0; i < n; i++) { const v = band(Math.abs(i - n / 2) % 32), h = Math.max(2 * d, v * hh); x.fillStyle = lerpCol(COLS, i / n); rrect(x, i * 6 * d + d, cy - h / 2, 3 * d, h, 1.5 * d); }
  }
  x.globalAlpha = 1; x.fillStyle = '#5AA9FF'; x.fillRect(W / 2 - d, cy - hh * 0.62, 2 * d, hh * 1.24);
}
