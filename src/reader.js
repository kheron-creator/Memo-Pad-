// MemoPad Reader (pilot): paste or upload up to 1,000 affirmations, pick a voice, hear them line by line
// (current line highlighted, like ElevenLabs Reader) with a YouTube beat on the same page.
// Lines are spoken just ahead of time and cached on this device, so replays cost no ElevenLabs credits.
import './create.css';
import { VOICES, orb } from './voices.js';
import { speakBlob } from './tts.js';
import { parseYt, loadYtApi, beatTiles } from './yt.js';
import { docxText } from './docx.js';
const $ = id => document.getElementById(id);
const MAX = 1000, AHEAD = 3, LS = 'memopad-reader';
const aud = $('aud');
let voice = VOICES[0].id, items = [], spoken = [], cur = 0, playing = false, repLeft = 0, gapTimer = 0, docKey = '';
let actx = null, gain = null, yt = null, ytReady = false;

/* ---------- saved state ---------- */
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const save = () => { saved.pos = { ...(saved.pos || {}), [docKey]: cur }; localStorage.setItem(LS, JSON.stringify({ text: $('text').value, voice, pos: saved.pos, yt: $('yt').value, aVol: $('aVol').value, mVol: $('mVol').value, rate: $('rate').value, rep: $('rep').value, gap: $('gap').value })); };

/* ---------- voice row ---------- */
function renderVoices() {
  $('vRow').innerHTML = VOICES.map(v => `<button class="vchip${v.id === voice ? ' on' : ''}" data-id="${v.id}"><i class="orb" style="background:${orb(v)}"></i><span><b>${v.name}</b><small>${v.desc}</small></span></button>`).join('');
  const v = VOICES.find(x => x.id === voice);
  $('voiceHint').innerHTML = (v.id.startsWith('el:') ? 'Natural ElevenLabs voice (sign in to MemoPad). Each line uses credits the first time only.' : 'Free voice on this device. Downloads once, about 60 MB.') + (v.preview ? ' <a href="#" id="sample">Hear a sample</a>' : '');
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
$('edit').onclick = () => { stop(); $('readBox').hidden = true; $('editBox').hidden = false; };
$('file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { $('text').value = /\.docx$/i.test(f.name) ? await docxText(f) : await f.text(); countText(); openReader(); }
  catch (err) { $('now').textContent = 'Could not read that file: ' + (err.message || err) + '. Try a .txt file, or paste the text.'; }
  e.target.value = '';
};
$('lines').onclick = e => { const p = e.target.closest('p[data-i]'); if (!p) return; cur = spoken.indexOf(+p.dataset.i); play(true); };

/* ---------- playback ---------- */
function graph() {
  if (actx) return; actx = new (window.AudioContext || window.webkitAudioContext)();
  gain = actx.createGain(); actx.createMediaElementSource(aud).connect(gain).connect(actx.destination); vol();
}
function vol() { if (gain) gain.gain.value = +$('aVol').value / 100; if (yt && ytReady) yt.setVolume(+$('mVol').value); }
function show(scroll = true) {
  const i = spoken[cur]; document.querySelectorAll('#lines p.now').forEach(p => p.classList.remove('now'));
  const p = document.querySelector(`#lines p[data-i="${i}"]`); if (p) { p.classList.add('now'); if (scroll) { const box = $('lines'); box.scrollTo({ top: p.offsetTop - box.clientHeight / 2 + p.clientHeight / 2, behavior: 'smooth' }); } }
  $('pos').textContent = `${cur + 1} / ${spoken.length}`;
  $('now').textContent = items[i]?.text || '';
}
function prefetch() { for (let k = 1; k <= AHEAD; k++) { const i = spoken[cur + k]; if (i != null) speakBlob(items[i].text, voice).catch(() => {}); } }
let token = 0;
async function speakCurrent() {
  const my = ++token; clearTimeout(gapTimer); show();
  const line = items[spoken[cur]];
  try {
    const blob = await speakBlob(line.text, voice, p => ($('now').textContent = `Downloading the free voice… ${Math.round(p * 100)}%`));
    if (my !== token || !playing) return;
    if (aud.src) URL.revokeObjectURL(aud.src);
    aud.src = URL.createObjectURL(blob); aud.playbackRate = +$('rate').value; await aud.play(); show(false); prefetch(); save();
  } catch (err) { if (my === token) { stop(); $('now').textContent = 'The voice could not play: ' + (err.message || err) + '.'; } }
}
aud.onended = () => {
  if (!playing) return;
  gapTimer = setTimeout(() => {
    if (repLeft > 1) { repLeft--; aud.currentTime = 0; aud.play(); return; }
    if (cur < spoken.length - 1) { cur++; repLeft = +$('rep').value; speakCurrent(); }
    else if ($('loopAll').checked) { cur = 0; repLeft = +$('rep').value; speakCurrent(); }
    else { stop(); $('now').textContent = 'Finished. Did you get the message?'; }
  }, +$('gap').value * 1000);
};
function setBtn() { document.body.classList.toggle('playing', playing); }
async function play(fromHere) {
  if (!spoken.length) openReader(); if (!spoken.length) return;
  graph(); await actx.resume(); playing = true; repLeft = +$('rep').value; setBtn();
  if (yt && ytReady) { vol(); yt.playVideo(); }
  if (fromHere || !aud.src || aud.ended) speakCurrent(); else aud.play();
}
function stop() { playing = false; token++; clearTimeout(gapTimer); aud.pause(); if (yt && ytReady) yt.pauseVideo(); setBtn(); }
$('play').onclick = () => (playing ? stop() : play(false));
$('prev').onclick = () => { if (!spoken.length) return; cur = Math.max(0, cur - 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('next').onclick = () => { if (!spoken.length) return; cur = Math.min(spoken.length - 1, cur + 1); playing ? (repLeft = +$('rep').value, speakCurrent()) : show(); };
$('more').onclick = () => ($('dset').hidden = !$('dset').hidden);
$('aVol').oninput = () => { vol(); save(); }; $('mVol').oninput = () => { vol(); save(); };
$('rate').onchange = () => { aud.playbackRate = +$('rate').value; save(); };
['rep', 'gap'].forEach(id => ($(id).onchange = save));
if ('mediaSession' in navigator) { navigator.mediaSession.setActionHandler('nexttrack', () => $('next').click()); navigator.mediaSession.setActionHandler('previoustrack', () => $('prev').click()); }

/* ---------- beat (YouTube) ---------- */
$('presets').innerHTML = beatTiles();
$('presets').onclick = e => { const b = e.target.closest('button'); if (!b) return; [...$('presets').children].forEach(x => x.classList.toggle('on', x === b)); $('yt').value = b.dataset.yt; loadBeat(); };
$('ytLoad').onclick = loadBeat; $('yt').onkeydown = e => { if (e.key === 'Enter') loadBeat(); };
async function loadBeat() {
  const v = parseYt($('yt').value); if (!v) { $('now').textContent = 'That does not look like a YouTube link.'; return; }
  let YT; try { YT = await loadYtApi(); } catch { $('now').textContent = 'YouTube did not load. Check your connection.'; return; }
  $('ytBox').hidden = false; save();
  const cue = () => { const fn = playing ? 'load' : 'cue'; if (v.list) yt[fn + 'Playlist']({ listType: 'playlist', list: v.list, index: 0 }); else yt[fn + 'VideoById'](v.id); };
  if (yt) { if (ytReady) { cue(); vol(); } return; }
  yt = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { ytReady = true; cue(); vol(); },
      onStateChange: e => { if (e.data === YT.PlayerState.ENDED && playing) { if (v.list) yt.playVideoAt(0); else { yt.seekTo(0); yt.playVideo(); } } },
      onError: () => ($('now').textContent = 'YouTube would not play that one here. Try another beat or paste a link.'),
    },
  });
}

/* ---------- start ---------- */
if (saved.voice && VOICES.some(v => v.id === saved.voice)) voice = saved.voice;
['aVol', 'mVol', 'rate', 'rep', 'gap'].forEach(id => { if (saved[id]) $(id).value = saved[id]; });
renderVoices();
if (saved.text) { $('text').value = saved.text; openReader(); } else countText();
if (saved.yt) $('yt').value = saved.yt;
