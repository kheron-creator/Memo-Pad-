// MemoPad Reader (pilot): paste or upload up to 1,000 affirmations, pick a voice, hear them line by line
// (current line highlighted, like ElevenLabs Reader) with a YouTube beat on the same page.
// Lines are spoken just ahead of time and cached on this device, so replays cost no ElevenLabs credits.
import './create.css';
import { VOICES, orb } from './voices.js';
import { speakBlob } from './tts.js';
import { parseYt, loadYtApi, beatTiles } from './yt.js';
import { mpTiles } from './beats.js';
import { LOFI_DRAW } from './lofi.js';
import { docxText } from './docx.js';
import { audioGet, audioPut, supabase } from './cloud.js';
import { dayOf, pushDays, otherDays } from './listentime.js';
const $ = id => document.getElementById(id);
const MAX = 1000, AHEAD = 3, LS = 'memopad-reader';
const aud = $('aud'), bAud = $('bAud');
let voice = VOICES[0].id, items = [], spoken = [], cur = 0, playing = false, repLeft = 0, gapTimer = 0, docKey = '';
let yt = null, ytReady = false, beatOn = false, curV = null, beatSrc = '';

/* ---------- saved state ---------- */
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const save = () => { saved.pos = { ...(saved.pos || {}), [docKey]: cur }; localStorage.setItem(LS, JSON.stringify({ text: $('text').value, voice, pos: saved.pos, yt: $('yt').value, aVol: $('aVol').value, mVol: $('mVol').value, rate: $('rate').value, rep: $('rep').value, gap: $('gap').value, beat: beatSrc, view, lofi: typeof lofiScene === 'undefined' ? 'glass' : lofiScene })); };

/* ---------- voice row ---------- */
function renderVoices() {
  $('vRow').innerHTML = VOICES.map(v => `<button class="vchip${v.id === voice ? ' on' : ''}" data-id="${v.id}"><i class="orb" style="background:${orb(v)}"></i><span><b>${v.name}</b><small>${v.desc}</small></span></button>`).join('');
  const v = VOICES.find(x => x.id === voice);
  $('voiceHint').innerHTML = (v.id.startsWith('el:') ? 'Natural ElevenLabs voice. Each line uses credits the first time only.' : 'Free voice on this device. Downloads once, about 60 MB.') + (v.preview ? ' <a href="#" id="sample">Hear a sample</a>' : '');
  const s = $('sample'); if (s) s.onclick = e => { e.preventDefault(); new Audio(v.preview).play(); };
}
$('vRow').onclick = e => { const b = e.target.closest('.vchip'); if (!b) return; voice = b.dataset.id; renderVoices(); prefetch(); save(); if (playing && ac) speakCurrent(); };

/* ---------- text ---------- */
const clean = s => s.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim();
function parse(text) {
  const out = []; let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim(); if (!t) continue;
    if (/^#+\s*/.test(t)) { out.push({ head: true, text: t.replace(/^#+\s*/, '') }); continue; }
    const c = clean(t); if (!c) continue;
    if (n >= MAX) break; out.push({ text: c.slice(0, 480) }); n++;
  }
  return out;
}
function countText() {
  const n = parse($('text').value).filter(x => !x.head).length;
  $('cnt').textContent = n ? `${n}${n >= MAX ? ' (max)' : ''}` : '';
}
function openReader() {
  items = parse($('text').value); spoken = items.map((x, i) => x.head ? -1 : i).filter(i => i >= 0);
  if (!spoken.length) { $('now').textContent = 'Add some affirmations first.'; return; }
  docKey = String(items.length) + ':' + items.slice(0, 3).map(x => x.text).join('|').slice(0, 80);
  cur = Math.min(saved.pos?.[docKey] || 0, spoken.length - 1);
  $('lines').innerHTML = items.map((x, i) => x.head ? `<h3>${esc(x.text)}</h3>` : `<p data-i="${i}">${esc(x.text)}</p>`).join('');
  $('editBox').hidden = true; $('readBox').hidden = false; countText(); show(false); save();
}
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
$('text').oninput = countText;
$('load').onclick = openReader;
$('edit').onclick = () => { stop(); localStorage.removeItem(LS + '-files'); $('readBox').hidden = true; $('editBox').hidden = false; };
$('file').onchange = async e => {
  const files = [...e.target.files]; const f = files[0]; if (!f) return;
  const audio = files.filter(x => x.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg)$/i.test(x.name));
  if (audio.length) { audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); openFiles(audio); e.target.value = ''; return; }
  try { $('text').value = /\.docx$/i.test(f.name) ? await docxText(f) : await f.text(); countText(); openReader(); }
  catch (err) { $('now').textContent = 'Could not read that file: ' + (err.message || err) + '. Try a .txt file, or paste the text.'; }
  e.target.value = '';
};
function openFiles(files, keep = true) {
  if (keep) { files.forEach((f, i) => audioPut('reader-file-' + i, f)); localStorage.setItem(LS + '-files', JSON.stringify(files.map(f => f.name))); }
  stop(); items = files.map(f => ({ text: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), file: f })); spoken = items.map((_, i) => i);
  docKey = 'files:' + files.map(f => f.name).join('|').slice(0, 80); cur = 0;
  $('lines').innerHTML = items.map((x, i) => `<p data-i="${i}">♪ ${esc(x.text)}</p>`).join('');
  $('editBox').hidden = true; $('readBox').hidden = false; $('cnt').textContent = `${files.length} audio`; show(false);
  $('now').textContent = `${files.length} recording${files.length > 1 ? 's' : ''} ready. Pick a beat and press play.`;
}
$('lines').onclick = e => { const p = e.target.closest('p[data-i]'); if (!p) return; cur = spoken.indexOf(+p.dataset.i); play(true); };

/* ---------- playback ---------- */
// Phones ignore an audio player's own volume, so the voice and the MemoPad beat each go through a Web Audio
// volume knob (gain). 'playback' tells iPhones to ignore the silent switch and keep playing in the background.
if (navigator.audioSession) try { navigator.audioSession.type = 'playback'; } catch {}
let ac = null, vG = null, bG = null, an = null;
function mixer() {
  if (!ac) try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    vG = ac.createGain(); bG = ac.createGain();
    ac.createMediaElementSource(aud).connect(vG).connect(ac.destination);
    ac.createMediaElementSource(bAud).connect(bG).connect(ac.destination);
    an = ac.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.75; vG.connect(an); bG.connect(an);
  } catch { ac = vG = bG = an = null; }
  if (ac && ac.state !== 'running') ac.resume().catch(() => {});
  vol();
}
document.addEventListener('visibilitychange', () => { if (ac && ac.state !== 'running' && (playing || beatOn)) ac.resume().catch(() => {}); });
function vol() {
  const v = +$('aVol').value / 100, m = +$('mVol').value / 100;
  if (vG) { vG.gain.value = v; bG.gain.value = m; aud.volume = 1; bAud.volume = 1; } else { aud.volume = Math.min(1, v); bAud.volume = Math.min(1, m); }
  if (yt && ytReady) yt.setVolume(+$('mVol').value);
}
function show(scroll = true) {
  const i = spoken[cur]; document.querySelectorAll('#lines p.now').forEach(p => p.classList.remove('now'));
  const p = document.querySelector(`#lines p[data-i="${i}"]`); if (p) { p.classList.add('now'); if (scroll) { const box = $('lines'); box.scrollTo({ top: p.offsetTop - box.clientHeight / 2 + p.clientHeight / 2, behavior: 'smooth' }); } }
  $('pos').textContent = `${cur + 1} / ${spoken.length}`;
  $('now').textContent = items[i]?.text || '';
  const vc = $('vCap'); if (vc && vc.dataset.i !== String(i)) { vc.dataset.i = i; vc.innerHTML = items[i] ? `<span class="in">${esc(items[i].text)}</span>` : ''; }
  let h = ''; for (let k = i; k >= 0; k--) if (items[k]?.head) { h = items[k].text; break; } $('rCh').textContent = h;
  $('rPos').textContent = `${cur + 1} / ${spoken.length}`; $('rFill').style.width = (spoken.length ? (cur + 1) / spoken.length * 100 : 0) + '%';
}
// ElevenLabs voices: pace is made by ElevenLabs itself (sounds natural); free voices use the player's speed
const isEl = () => voice.startsWith('el:');
const elSpeed = () => isEl() ? Math.min(1.2, Math.max(0.7, +$('rate').value || 1)) : 1;
const ctxOf = i => { const k = spoken.indexOf(i); return { prev: items[spoken[k - 1]]?.text || '', next: items[spoken[k + 1]]?.text || '' }; };
function prefetch() { for (let k = 1; k <= AHEAD; k++) { const i = spoken[cur + k]; if (i != null && !items[i].file) speakBlob(items[i].text, voice, undefined, elSpeed(), ctxOf(i)).catch(() => {}); } }
let token = 0, lastSrc = '';
/* Smooth playback: each line is decoded once, its silent edges are trimmed, and the next line (or the repeat) is
   scheduled on the audio clock while the current one is still playing, with tiny fades. No gaps from loading,
   no clicks between lines, and it keeps going with the screen locked. (Old browsers fall back to the plain player.) */
const bufs = new Map(); let live = [], timers = [];
function trim(buf) {
  const ch = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c)), n = buf.length, th = 0.012, pad = Math.round(buf.sampleRate * 0.04);
  let a = 0, z = n - 1; const loud = i => ch.some(d => Math.abs(d[i]) > th);
  while (a < n && !loud(a)) a++; while (z > a && !loud(z)) z--;
  a = Math.max(0, a - pad); z = Math.min(n - 1, z + pad * 2); if (z - a < buf.sampleRate * 0.2) return buf;
  const out = ac.createBuffer(buf.numberOfChannels, z - a + 1, buf.sampleRate);
  ch.forEach((d, c) => out.copyToChannel(d.subarray(a, z + 1), c)); return out;
}
function bufFor(i, onDl) {
  const it = items[i], k = it.file ? 'f' + i + it.file.name : voice + '|' + elSpeed() + '|' + it.text + '|' + (items[spoken[spoken.indexOf(i) + 1]]?.text || '');
  if (bufs.has(k)) return bufs.get(k);
  const pr = (it.file ? Promise.resolve(it.file) : speakBlob(it.text, voice, onDl, elSpeed(), ctxOf(i)))
    .then(b => b.arrayBuffer()).then(x => new Promise((res, rej) => ac.decodeAudioData(x, res, rej))).then(b => (it.file ? b : trim(b)));
  pr.catch(() => bufs.delete(k)); bufs.set(k, pr);
  if (bufs.size > 30) bufs.delete(bufs.keys().next().value);
  return pr;
}
function halt() { live.forEach(n => { try { n.stop(); } catch {} }); live = []; timers.forEach(clearTimeout); timers = []; }
const later = (f, sec) => timers.push(setTimeout(f, Math.max(0, sec) * 1000));
function plan(k, rep, at, my) {
  const i = spoken[k];
  bufFor(i, p => ($('now').textContent = `Downloading the free voice… ${Math.round(p * 100)}%`)).then(buf => {
    if (my !== token || !playing) return;
    const now = ac.currentTime; at = Math.max(at, now + 0.03);
    const rate = isEl() || items[i].file ? 1 : +$('rate').value, dur = buf.duration / rate, f = Math.min(0.02, dur / 4);
    const src = ac.createBufferSource(), g = ac.createGain(); src.buffer = buf; src.playbackRate.value = rate;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + f); g.gain.setValueAtTime(1, at + dur - f); g.gain.linearRampToValueAtTime(0, at + dur);
    src.connect(g).connect(vG); src.start(at); src.stop(at + dur + 0.05); live.push(src); src.onended = () => (live = live.filter(x => x !== src));
    later(() => { if (my === token) { cur = k; repLeft = rep; show(); save(); } }, at - now);
    let nk = k, nrep = rep - 1;
    if (nrep < 1) { nk = k + 1; nrep = +$('rep').value; if (nk >= spoken.length) { if ($('loopAll').checked) nk = 0; else { later(() => { if (my === token) { stop(); $('now').textContent = 'Finished. Did you get the message?'; } }, at + dur - now); return; } } }
    // line up the next one as soon as this one starts, so it is ready (and already scheduled) before this ends
    later(() => { if (my === token) { plan(nk, nrep, at + dur + +$('gap').value, my); for (let x = 1; x <= AHEAD; x++) { const j = spoken[nk + x]; if (j != null) bufFor(j).catch(() => {}); } } }, at - now);
  }).catch(err => { if (my === token) { stop(); $('now').textContent = 'The voice could not play: ' + (err.message || err) + '.'; } });
}
async function speakCurrent() {
  const my = ++token; clearTimeout(gapTimer); halt(); show();
  if (ac && vG) { aud.pause(); plan(cur, repLeft || +$('rep').value, ac.currentTime, my); return; }
  const line = items[spoken[cur]];
  try {
    const blob = line.file || await speakBlob(line.text, voice, p => ($('now').textContent = `Downloading the free voice… ${Math.round(p * 100)}%`), elSpeed(), ctxOf(spoken[cur]));
    if (my !== token || !playing) return;
    if (lastSrc) URL.revokeObjectURL(lastSrc);
    aud.src = lastSrc = URL.createObjectURL(blob); aud.playbackRate = isEl() ? 1 : +$('rate').value; await aud.play(); show(false); prefetch(); save();
  } catch (err) { if (my === token) { stop(); $('now').textContent = 'The voice could not play: ' + (err.message || err) + '.'; } }
}
aud.onended = () => {
  if (!playing || aud.src === SILENT || (ac && vG)) return;
  gapTimer = setTimeout(() => {
    if (repLeft > 1) { repLeft--; aud.currentTime = 0; aud.play(); return; }
    if (cur < spoken.length - 1) { cur++; repLeft = +$('rep').value; speakCurrent(); }
    else if ($('loopAll').checked) { cur = 0; repLeft = +$('rep').value; speakCurrent(); }
    else { stop(); $('now').textContent = 'Finished. Did you get the message?'; }
  }, +$('gap').value * 1000);
};
function setBtn() { document.body.classList.toggle('playing', playing); $('rp').classList.toggle('playing', playing); }
// iPhones only let sound start straight from a tap, so we start everything synchronously here
// (a silent clip unlocks the voice player, then later lines can play on their own).
const SILENT = (() => { const n = 800, b = new ArrayBuffer(44 + n * 2), d = new DataView(b), w = (o, t) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' })); })();
let unlocked = false;
function unlock() {
  mixer();
  if (!unlocked) { unlocked = true; aud.src = SILENT; aud.play().catch(() => {}); }
}
function play(fromHere) {
  if (!spoken.length) openReader(); if (!spoken.length) return;
  unlock(); playing = true; repLeft = +$('rep').value; setBtn(); tick();
  if (ac && vG) return speakCurrent();
  if (fromHere || !lastSrc || aud.ended || aud.src === SILENT) speakCurrent(); else aud.play().catch(() => speakCurrent());
}
function stop() { playing = false; token++; clearTimeout(gapTimer); halt(); aud.pause(); setBtn(); }
$('play').onclick = () => (playing ? stop() : play(false));
$('prev').onclick = () => { if (!spoken.length) return; cur = Math.max(0, cur - 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('next').onclick = () => { if (!spoken.length) return; cur = Math.min(spoken.length - 1, cur + 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('more').onclick = () => ($('dset').hidden = !$('dset').hidden);

/* ---------- views: words (captions), waves, bars, circle, timer ---------- */
const COLS = ['#25DD5F', '#FFB000', '#EB7100', '#E10195'];
const LOFI = ['glass', 'neon', 'path', 'boat'];
let view = saved.view || 'words', raf = 0, envL = 0, lofiScene = LOFI.includes(saved.lofi) ? saved.lofi : 'glass';
function setView(v) {
  view = v; [...$('viewSw').children].forEach(b => b.classList.toggle('on', b.dataset.v === v));
  const rp = $('rp'); rp.classList.toggle('cap', v === 'words'); rp.classList.toggle('tm', v === 'time'); $('vTime').hidden = v !== 'time';
  LOFI.forEach(k => rp.classList.toggle('lofi-' + k, v === 'lofi' && lofiScene === k));
  save(); draw();
}
// Lofi: press it again for the next rainy scene, like in MemoPad
$('viewSw').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.v === 'lofi' && view === 'lofi') { lofiScene = LOFI[(LOFI.indexOf(lofiScene) + 1) % LOFI.length]; } setView(b.dataset.v); };
$('rPlay').onclick = () => $('play').click(); $('rPrev').onclick = () => $('prev').click(); $('rNext').onclick = () => $('next').click();
$('rBar').onclick = e => { if (!spoken.length) return; const r = $('rBar').getBoundingClientRect(); cur = Math.max(0, Math.min(spoken.length - 1, Math.floor((e.clientX - r.left) / r.width * spoken.length))); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
function setFull(on) { if (on && !items.length) { $('now').textContent = 'Add your affirmations first, then the captions open here.'; return; } if (on && document.body.classList.contains('mini')) setMini(false); document.body.classList.toggle('rfull', on); $('mini').classList.toggle('open', on); $('rFull').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); setTimeout(draw, 50); }
$('rFull').onclick = () => setFull(!document.body.classList.contains('rfull'));
addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('rfull')) setFull(false); });
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function colAt(t) { t = Math.max(0, Math.min(.999, t)) * (COLS.length - 1); const i = Math.floor(t), f = t - i, h = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)); const [a, b] = [h(COLS[i]), h(COLS[i + 1])]; return `rgb(${lerp(a[0], b[0], f)},${lerp(a[1], b[1], f)},${lerp(a[2], b[2], f)})`; }
const F = new Uint8Array(128), T = new Uint8Array(256);
function draw() {
  cancelAnimationFrame(raf);
  const cv = $('vizC'), mini = document.body.classList.contains('mini');
  if ((view === 'words' && !mini) || document.hidden) return;
  const c = mini ? $('miniC') : cv; if (!c) return;
  const r = c.getBoundingClientRect(), d = devicePixelRatio || 1, W = c.width = Math.round(r.width * d), H = c.height = Math.round(r.height * d), x = c.getContext('2d');
  if (an) { an.getByteFrequencyData(F); an.getByteTimeDomainData(T); } else { F.fill(0); T.fill(128); }
  const band = k => { let m = 0; const a = Math.floor(2 + k * 1.6), b = Math.floor(2 + (k + 1) * 1.6); for (let i = a; i <= b; i++) m = Math.max(m, F[i] || 0); return Math.pow(m / 255, 1.5); };
  let tot = 0; for (let k = 0; k < 32; k++) tot += band(k); const lvl = tot / 32; envL += (lvl - envL) * (lvl > envL ? .4 : .1);
  x.clearRect(0, 0, W, H);
  if (view === 'lofi' && !mini) { x.save(); LOFI_DRAW[lofiScene](x, W, H, Math.min(W, H), envL, performance.now() / 1000); x.restore(); raf = requestAnimationFrame(draw); return; }
  const style = mini ? 'bars' : view, cx = W / 2, cy = mini ? H / 2 : H * .44, M = Math.min(W, H), idle = playing ? 0 : 0.04 + 0.02 * Math.sin(performance.now() / 600);
  if (style === 'bars' || style === 'time') {
    const N = mini ? 12 : 28, gap = (mini ? 2 : 4) * d, bw = Math.max(1, Math.min((mini ? 4 : 16) * d, W / (N * 2) - gap));
    for (let k = 0; k < N; k++) { const h = Math.max(3 * d, (band(k) + idle) * H * (style === 'time' ? .3 : .5)); x.fillStyle = colAt(k / N); x.globalAlpha = style === 'time' ? .55 : 1;
      [cx + k * (bw + gap) + gap / 2, cx - (k + 1) * (bw + gap) + gap / 2].forEach(px => { x.beginPath(); x.roundRect ? x.roundRect(px, (style === 'time' ? H * .66 : cy) - h / 2, bw, h, bw / 2) : x.rect(px, cy - h / 2, bw, h); x.fill(); }); }
    x.globalAlpha = 1;
  } else if (style === 'circle') {
    const N = 72, r0 = M * .13 + envL * M * .04; x.lineCap = 'round'; x.lineWidth = Math.max(3 * d, 2 * Math.PI * r0 / N * .55);
    for (let k = 0; k < N; k++) { const a = k / N * Math.PI * 2 - Math.PI / 2, kk = k < N / 2 ? k : N - k, len = (band(kk % 32) + idle) * M * .15 + 3 * d; x.strokeStyle = colAt(kk / (N / 2)); x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); x.stroke(); }
  } else { // waves: three soft lines that move with the voice and beat
    for (let L = 0; L < 3; L++) { x.beginPath(); x.lineWidth = (3 - L) * 1.5 * d; x.strokeStyle = COLS[[0, 1, 3][L]]; x.globalAlpha = 1 - L * .25;
      for (let i = 0; i <= 64; i++) { const px = i / 64 * W, v = (T[Math.floor(i * 3.9)] - 128) / 128, s = Math.sin(i / 64 * Math.PI); const py = cy + (v * 1.6 + Math.sin(i / 5 + performance.now() / (500 + L * 180)) * (envL + idle) * .9) * H * .38 * s * (1 - L * .2); i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke(); } x.globalAlpha = 1;
  }
  raf = requestAnimationFrame(draw);
}
// listening time today for the Timer view: this device's count plus your other devices' (when signed in)
const dayKey = () => 'memopad-reader-time-' + dayOf();
let heard = +localStorage.getItem(dayKey()) || 0, tickT = 0, elsewhere = 0, uid = null, pushedAt = 0, heardDay = dayOf();
const shown = () => heard + elsewhere;
async function syncTime() {
  if (!uid) return; await pushDays(uid, 'reader', { [heardDay]: heard });
  const o = await otherDays(uid, 'reader'); if (o) { elsewhere = o[dayOf()] || 0; $('vClock').textContent = mmss(shown()); }
}
const pushNow = () => { if (uid) { pushedAt = Date.now(); localStorage.setItem(dayKey(), heard); pushDays(uid, 'reader', { [heardDay]: heard }); } };
supabase?.auth.getSession().then(({ data }) => { uid = data?.session?.user?.id || null; syncTime(); }).catch(() => {});
addEventListener('pagehide', pushNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) pushNow(); else syncTime(); });
const mmss = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
function tick() {
  clearInterval(tickT);
  tickT = setInterval(() => {
    if (!playing) return; if (dayOf() !== heardDay) { if (uid) pushDays(uid, 'reader', { [heardDay]: heard }); heardDay = dayOf(); heard = +localStorage.getItem(dayKey()) || 0; elsewhere = 0; } heard++; if (heard % 5 === 0) localStorage.setItem(dayKey(), heard); if (Date.now() - pushedAt > 30000) pushNow();
    $('vClock').textContent = mmss(shown()); const left = sleepEnd ? Math.max(0, (sleepEnd - Date.now()) / 1000) : 0;
    $('vSub').textContent = `listened today · line ${cur + 1} of ${spoken.length}` + (sleepEnd ? ` · sleep in ${mmss(left)}` : '');
    if (sleepEnd && Date.now() >= sleepEnd) sleepNow();
  }, 1000);
}
$('vClock').textContent = mmss(shown());
// sleep timer: fades the voice and beat out gently, then stops
let sleepEnd = 0;
$('sleep').onchange = () => { const m = +$('sleep').value; sleepEnd = m ? Date.now() + m * 60000 : 0; $('now').textContent = m ? `Sleep timer: stopping in ${m} minutes.` : 'Sleep timer off.'; };
function sleepNow() {
  sleepEnd = 0; $('sleep').value = '0';
  if (ac && vG) { const t = ac.currentTime; [vG, bG].forEach(g => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 8); }); }
  setTimeout(() => { stop(); if (beatOn) beatToggle(); vol(); $('now').textContent = 'Sleep well. Did you get the message?'; }, 8200);
}
// minimise: the whole page folds into a slim banner at the top that keeps playing
function setMini(on) { document.body.classList.toggle('mini', on);  $('dset').hidden = true; window.scrollTo(0, 0); draw(); }
// the dropdown button opens the captions player (MemoPad style); the player's own button minimises to a banner
$('mini').onclick = () => setFull(!document.body.classList.contains('rfull'));
$('rMini').onclick = () => { setFull(false); setMini(true); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) draw(); });
addEventListener('resize', draw);
$('aVol').oninput = () => { vol(); save(); }; $('mVol').oninput = () => { vol(); save(); };
$('rate').onchange = () => { aud.playbackRate = isEl() ? 1 : +$('rate').value; prefetch(); save(); if (playing && ac) speakCurrent(); };
['rep', 'gap'].forEach(id => ($(id).onchange = save));
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession; try { ms.metadata = new MediaMetadata({ title: 'My affirmations', artist: 'MemoPad', artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch {}
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  h('nexttrack', () => $('next').click()); h('previoustrack', () => $('prev').click());
  h('play', () => { if (!playing) play(false); if (beatSrc && !beatOn) beatToggle(); }); h('pause', () => { if (playing) stop(); if (beatOn) beatToggle(); });
}

/* ---------- beat: MemoPad's own beats (plain audio, loops, background) or YouTube ---------- */
$('mpBeats').innerHTML = mpTiles();
$('presets').innerHTML = beatTiles();
const tilesOff = () => document.querySelectorAll('#mpBeats button, #presets button, #ytRes button').forEach(x => x.classList.remove('on'));
$('mpBeats').onclick = e => { const b = e.target.closest('button'); if (!b) return; tilesOff(); b.classList.add('on'); playFileBeat(b.dataset.beat); };
$('presets').onclick = e => { const b = e.target.closest('button'); if (!b) return; tilesOff(); b.classList.add('on'); $('yt').value = b.dataset.yt; useYt(); loadBeat(true); };
$('ytLoad').onclick = () => (useYt(), loadBeat()); $('yt').onkeydown = e => { if (e.key === 'Enter') (useYt(), loadBeat()); };
function beatUi(on) { beatOn = on; document.body.classList.toggle('beat', on); document.querySelectorAll('.beatBtn span').forEach(x => (x.textContent = on ? 'Pause beat' : 'Play beat')); }
function useYt() { beatSrc = 'yt'; bAud.pause(); save(); }
function playFileBeat(url) {
  if (yt && ytReady) yt.pauseVideo();
  beatSrc = url; mixer();
  if (bAud.src !== url) bAud.src = url;
  bAud.play().then(() => beatUi(true)).catch(() => { beatUi(false); $('now').textContent = 'That beat would not play just now. Try another one.'; });
  save();
}
// The beat has its own play button, separate from the voice.
function beatToggle() {
  if (beatOn) { if (beatSrc && beatSrc !== 'yt') bAud.pause(); else if (yt && ytReady) yt.pauseVideo(); beatUi(false); return; }
  if (beatSrc && beatSrc !== 'yt') return playFileBeat(beatSrc);
  if (!beatSrc) { const first = $('mpBeats').querySelector('button'); tilesOff(); first.classList.add('on'); return playFileBeat(first.dataset.beat); }
  if (!$('yt').value) { const first = $('presets').querySelector('button'); $('yt').value = first.dataset.yt; }
  if (yt && ytReady && curV && JSON.stringify(curV) === JSON.stringify(parseYt($('yt').value))) { vol(); yt.playVideo(); beatUi(true); }
  else loadBeat(true);
}
document.querySelectorAll('.beatBtn').forEach(b => (b.onclick = beatToggle));
bAud.onerror = () => { if (beatSrc && beatSrc !== 'yt') { beatUi(false); $('now').textContent = 'That beat would not load. Check your connection, or try another.'; } };
async function loadBeat(autoplay) {
  const v = parseYt($('yt').value); if (!v) { $('now').textContent = 'That does not look like a YouTube link.'; return; }
  let YT; try { YT = await loadYtApi(); } catch { $('now').textContent = 'YouTube did not load. Check your connection.'; return; }
  $('ytBox').hidden = false; save();
  curV = v; const cue = () => { const fn = autoplay === true ? 'load' : 'cue'; if (v.list) yt[fn + 'Playlist']({ listType: 'playlist', list: v.list, index: 0 }); else yt[fn + 'VideoById'](v.id); };
  if (yt) { if (ytReady) { cue(); vol(); } return; }
  yt = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { ytReady = true; cue(); vol(); },
      onStateChange: e => { const S = YT.PlayerState; if (e.data === S.PLAYING) { beatUi(true); if (/YouTube would not play|skipping/.test($('now').textContent)) show(false); } else if (e.data === S.PAUSED) beatUi(false); else if (e.data === S.ENDED) { if (beatOn) { if (curV.list) yt.playVideoAt(0); else { yt.seekTo(0); yt.playVideo(); } } } },
      onError: () => { // a preset that has ended: quietly move to the next preset; anything else: say so
        const tiles = [...$('presets').querySelectorAll('button')], k = tiles.findIndex(t => t.dataset.yt === $('yt').value);
        if (k >= 0 && k < tiles.length - 1 && beatSrc === 'yt') { tilesOff(); tiles[k + 1].classList.add('on'); $('yt').value = tiles[k + 1].dataset.yt; $('now').textContent = 'That YouTube beat has ended, skipping to the next one…'; loadBeat(true); return; }
        beatUi(false); $('now').textContent = 'YouTube would not play that one here. Try another beat or paste a link.';
      },
    },
  });
}

/* ---------- YouTube search (needs YOUTUBE_API_KEY on Vercel; without it, YouTube's own search opens) ---------- */
async function findBeats() {
  const q = $('ytQ').value.trim() || 'lofi hip hop'; $('ytRes').innerHTML = '<p class="hint">Searching…</p>';
  try {
    const r = await fetch('/api/yt-search?q=' + encodeURIComponent(q));
    if (r.status === 503) { $('ytRes').innerHTML = `<p class="hint">Search inside MemoPad isn't switched on yet. <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}" target="_blank" rel="noopener">Search on YouTube</a>, copy the link of a video you like, and paste it below.</p>`; return; }
    if (!r.ok) throw new Error(r.status);
    const { items } = await r.json();
    $('ytRes').innerHTML = items.length ? items.map(x => `<button data-yt="https://www.youtube.com/watch?v=${x.id}"><img src="${esc(x.thumb)}" alt="" loading="lazy"><span><b>${esc(x.title)}</b><small>${esc(x.channel)}${x.live ? ' · live' : ''}</small></span></button>`).join('') : '<p class="hint">Nothing found. Try other words.</p>';
  } catch { $('ytRes').innerHTML = '<p class="hint">Search did not work just now. Paste a YouTube link instead.</p>'; }
}
$('ytFind').onclick = findBeats; $('ytQ').onkeydown = e => { if (e.key === 'Enter') findBeats(); };
$('ytRes').onclick = e => { const b = e.target.closest('button[data-yt]'); if (!b) return; tilesOff(); $('yt').value = b.dataset.yt; useYt(); loadBeat(true); };

/* ---------- start ---------- */
if (saved.voice && VOICES.some(v => v.id === saved.voice)) voice = saved.voice;
['aVol', 'mVol', 'rate', 'rep', 'gap'].forEach(id => { if (saved[id]) $(id).value = saved[id]; });
renderVoices();
const savedFiles = (() => { try { return JSON.parse(localStorage.getItem(LS + '-files')) || []; } catch { return []; } })();
if (savedFiles.length) Promise.all(savedFiles.map((n, i) => audioGet('reader-file-' + i).then(b => b && new File([b], n, { type: b.type })))).then(fs => { fs = fs.filter(Boolean); if (fs.length) openFiles(fs, false); else if (saved.text) { $('text').value = saved.text; openReader(); } });
else if (saved.text) { $('text').value = saved.text; openReader(); } else countText();
if (new URLSearchParams(location.search).has('go') && spoken.length) $('now').textContent = 'Ready. Press ▶ to hear your affirmations, and ♪ for a beat.';
if (saved.yt) $('yt').value = saved.yt;
if (saved.beat) { beatSrc = saved.beat; const t = beatSrc === 'yt' ? null : $('mpBeats').querySelector(`[data-beat="${beatSrc}"]`); if (t) t.classList.add('on'); }
setView(['words', 'wave', 'bars', 'circle', 'time', 'lofi'].includes(view) ? view : 'words');
