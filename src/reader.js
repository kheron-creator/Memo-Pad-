// MemoPad Reader (pilot): paste or upload up to 1,000 affirmations, pick a voice, hear them line by line
// (current line highlighted, like ElevenLabs Reader) with a YouTube beat on the same page.
// Lines are spoken just ahead of time and cached on this device, so replays cost no ElevenLabs credits.
import './create.css';
import { VOICES, orb } from './voices.js';
import { speakBlob } from './tts.js';
import { parseYt, loadYtApi, beatTiles } from './yt.js';
import { mpTiles } from './beats.js';
import { docxText } from './docx.js';
import { audioGet, audioPut } from './cloud.js';
const $ = id => document.getElementById(id);
const MAX = 1000, AHEAD = 3, LS = 'memopad-reader';
const aud = $('aud'), bAud = $('bAud');
let voice = VOICES[0].id, items = [], spoken = [], cur = 0, playing = false, repLeft = 0, gapTimer = 0, docKey = '';
let yt = null, ytReady = false, beatOn = false, curV = null, beatSrc = '';

/* ---------- saved state ---------- */
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const save = () => { saved.pos = { ...(saved.pos || {}), [docKey]: cur }; localStorage.setItem(LS, JSON.stringify({ text: $('text').value, voice, pos: saved.pos, yt: $('yt').value, aVol: $('aVol').value, mVol: $('mVol').value, rate: $('rate').value, rep: $('rep').value, gap: $('gap').value, beat: beatSrc })); };

/* ---------- voice row ---------- */
function renderVoices() {
  $('vRow').innerHTML = VOICES.map(v => `<button class="vchip${v.id === voice ? ' on' : ''}" data-id="${v.id}"><i class="orb" style="background:${orb(v)}"></i><span><b>${v.name}</b><small>${v.desc}</small></span></button>`).join('');
  const v = VOICES.find(x => x.id === voice);
  $('voiceHint').innerHTML = (v.id.startsWith('el:') ? 'Natural ElevenLabs voice. Each line uses credits the first time only.' : 'Free voice on this device. Downloads once, about 60 MB.') + (v.preview ? ' <a href="#" id="sample">Hear a sample</a>' : '');
  const s = $('sample'); if (s) s.onclick = e => { e.preventDefault(); new Audio(v.preview).play(); };
}
$('vRow').onclick = e => { const b = e.target.closest('.vchip'); if (!b) return; voice = b.dataset.id; renderVoices(); prefetch(); save(); };

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
let ac = null, vG = null, bG = null;
function mixer() {
  if (!ac) try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    vG = ac.createGain(); bG = ac.createGain();
    ac.createMediaElementSource(aud).connect(vG).connect(ac.destination);
    ac.createMediaElementSource(bAud).connect(bG).connect(ac.destination);
  } catch { ac = vG = bG = null; }
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
}
// ElevenLabs voices: pace is made by ElevenLabs itself (sounds natural); free voices use the player's speed
const isEl = () => voice.startsWith('el:');
const elSpeed = () => isEl() ? Math.min(1.2, Math.max(0.7, +$('rate').value || 1)) : 1;
const ctxOf = i => { const k = spoken.indexOf(i); return { prev: items[spoken[k - 1]]?.text || '', next: items[spoken[k + 1]]?.text || '' }; };
function prefetch() { for (let k = 1; k <= AHEAD; k++) { const i = spoken[cur + k]; if (i != null && !items[i].file) speakBlob(items[i].text, voice, undefined, elSpeed(), ctxOf(i)).catch(() => {}); } }
let token = 0, lastSrc = '';
async function speakCurrent() {
  const my = ++token; clearTimeout(gapTimer); show();
  const line = items[spoken[cur]];
  try {
    const blob = line.file || await speakBlob(line.text, voice, p => ($('now').textContent = `Downloading the free voice… ${Math.round(p * 100)}%`), elSpeed(), ctxOf(spoken[cur]));
    if (my !== token || !playing) return;
    if (lastSrc) URL.revokeObjectURL(lastSrc);
    aud.src = lastSrc = URL.createObjectURL(blob); aud.playbackRate = isEl() ? 1 : +$('rate').value; await aud.play(); show(false); prefetch(); save();
  } catch (err) { if (my === token) { stop(); $('now').textContent = 'The voice could not play: ' + (err.message || err) + '.'; } }
}
aud.onended = () => {
  if (!playing || aud.src === SILENT) return;
  gapTimer = setTimeout(() => {
    if (repLeft > 1) { repLeft--; aud.currentTime = 0; aud.play(); return; }
    if (cur < spoken.length - 1) { cur++; repLeft = +$('rep').value; speakCurrent(); }
    else if ($('loopAll').checked) { cur = 0; repLeft = +$('rep').value; speakCurrent(); }
    else { stop(); $('now').textContent = 'Finished. Did you get the message?'; }
  }, +$('gap').value * 1000);
};
function setBtn() { document.body.classList.toggle('playing', playing); }
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
  unlock(); playing = true; repLeft = +$('rep').value; setBtn();
  if (fromHere || !lastSrc || aud.ended || aud.src === SILENT) speakCurrent(); else aud.play().catch(() => speakCurrent());
}
function stop() { playing = false; token++; clearTimeout(gapTimer); aud.pause(); setBtn(); }
$('play').onclick = () => (playing ? stop() : play(false));
$('prev').onclick = () => { if (!spoken.length) return; cur = Math.max(0, cur - 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('next').onclick = () => { if (!spoken.length) return; cur = Math.min(spoken.length - 1, cur + 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('more').onclick = () => ($('dset').hidden = !$('dset').hidden);
$('aVol').oninput = () => { vol(); save(); }; $('mVol').oninput = () => { vol(); save(); };
$('rate').onchange = () => { aud.playbackRate = isEl() ? 1 : +$('rate').value; prefetch(); save(); };
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
      onStateChange: e => { const S = YT.PlayerState; if (e.data === S.PLAYING) beatUi(true); else if (e.data === S.PAUSED) beatUi(false); else if (e.data === S.ENDED) { if (beatOn) { if (curV.list) yt.playVideoAt(0); else { yt.seekTo(0); yt.playVideo(); } } } },
      onError: () => (beatUi(false), $('now').textContent = 'YouTube would not play that one here. Try another beat or paste a link.'),
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
