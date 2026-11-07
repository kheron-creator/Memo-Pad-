// Play over music (pilot): an affirmation track on top of a YouTube song or a music file, each with its own volume.
// YouTube plays in its own official player (we only control play, pause and volume); nothing is downloaded or re-recorded.
import './create.css';
import { supabase, BUCKET, TABLE, audioGet } from './cloud.js';
const $ = id => document.getElementById(id);
const aud = $('aud'), mus = $('mus'), q = new URLSearchParams(location.search);
const msg = t => ($('msg').textContent = t);
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
let mMode = 'yt', yt = null, ytReady = false, playing = false, actx = null, aGain = null, mGain = null;

// Affirmations go through Web Audio so the volume works on iPhone too (iOS ignores audio.volume), and can be boosted to 200%.
function graph() {
  if (actx) return; actx = new (window.AudioContext || window.webkitAudioContext)();
  aGain = actx.createGain(); actx.createMediaElementSource(aud).connect(aGain).connect(actx.destination);
  mGain = actx.createGain(); actx.createMediaElementSource(mus).connect(mGain).connect(actx.destination);
  applyVol();
}
function applyVol() {
  const a = +$('aVol').value / 100, m = +$('mVol').value / 100;
  if (aGain) aGain.gain.value = a; if (mGain) mGain.gain.value = m;
  if (yt && ytReady) yt.setVolume(Math.round(m * 100));
}
$('aVol').oninput = applyVol; $('mVol').oninput = applyVol;

function seg(id, attr, sel, on) {
  $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); document.querySelectorAll(`[${sel}]`).forEach(p => (p.hidden = p.getAttribute(sel) !== b.dataset[attr])); on(b.dataset[attr]); });
}
seg('aMode', 'a', 'data-ap', () => {});
seg('mMode', 'm', 'data-mp', m => { mMode = m; $('ytBox').hidden = m !== 'yt' || !yt; if (m !== 'yt' && yt && ytReady) yt.pauseVideo(); if (m !== 'file') mus.pause(); });

/* ---------- affirmations ---------- */
async function loadMemos() {
  const sel = $('memo');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { sel.innerHTML = '<option value="">Sign in on MemoPad first, or use a file</option>'; return; }
  const { data, error } = await supabase.from(TABLE).select('id,title,audio_path,user_id').order('created_at', { ascending: false });
  if (error || !data?.length) { sel.innerHTML = '<option value="">No memos yet</option>'; return; }
  sel.innerHTML = '<option value="">Choose a memo</option>' + data.map(r => `<option value="${r.id}" data-path="${r.audio_path.replace(/"/g, '&quot;')}">${r.title.replace(/</g, '&lt;')}${r.user_id === session.user.id ? '' : ' · shared'}</option>`).join('');
  const want = q.get('id'); if (want && data.some(r => r.id === want)) { sel.value = want; pickMemo(); }
}
async function pickMemo() {
  const o = $('memo').selectedOptions[0]; if (!o?.dataset.path) return;
  stopAll(); msg('Loading the memo…');
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(o.dataset.path, 6 * 3600);
  if (error) return msg('That memo could not be loaded.');
  aud.src = data.signedUrl; msg('Ready. Add your music, then press Play both.');
}
$('memo').onchange = pickMemo;
$('aFile').onchange = e => { const f = e.target.files[0]; if (!f) return; stopAll(); aud.src = URL.createObjectURL(f); msg('Ready. Add your music, then press Play both.'); };

/* ---------- music ---------- */
function parseYt(s) {
  try {
    const u = new URL(s.trim()); const list = u.searchParams.get('list');
    let id = u.searchParams.get('v');
    if (!id && /youtu\.be$/.test(u.hostname)) id = u.pathname.slice(1);
    if (!id) { const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/); if (m) id = m[1]; }
    return id || list ? { id, list } : null;
  } catch { return /^[\w-]{11}$/.test(s.trim()) ? { id: s.trim() } : null; }
}
let ytApi = null;
const loadYtApi = () => (ytApi ||= new Promise((res, rej) => { window.onYouTubeIframeAPIReady = () => res(window.YT); const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { ytApi = null; rej(); }; document.head.appendChild(s); setTimeout(() => { if (!window.YT?.Player) { ytApi = null; rej(); } }, 15000); }));
$('ytLoad').onclick = async () => {
  const v = parseYt($('yt').value); if (!v) return msg('That does not look like a YouTube link.');
  msg('Loading YouTube…'); let YT; try { YT = await loadYtApi(); } catch { return msg('YouTube did not load. Check your connection, or use a music file instead.'); } $('ytBox').hidden = false; ytReady = false;
  const cue = () => { if (v.list) yt.cuePlaylist({ listType: 'playlist', list: v.list, index: 0 }); else yt.cueVideoById(v.id); };
  if (yt) { cue(); ytReady = true; applyVol(); msg('Song loaded. Press Play both.'); return; }
  yt = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { ytReady = true; cue(); applyVol(); msg('Song loaded. Press Play both.'); },
      onStateChange: e => { if (e.data === YT.PlayerState.ENDED && playing && $('loopM').checked) { if (v.list) yt.playVideoAt(0); else { yt.seekTo(0); yt.playVideo(); } } },
      onError: () => msg('YouTube would not play that one here (some songs are blocked from playing on other sites). Try another link.'),
    },
  });
};
$('presets').onclick = e => { const b = e.target.closest('button'); if (!b) return; [...$('presets').children].forEach(x => x.classList.toggle('on', x === b)); $('yt').value = b.dataset.yt; $('ytLoad').click(); };
$('yt').onkeydown = e => { if (e.key === 'Enter') $('ytLoad').click(); };
$('mFile').onchange = e => { const f = e.target.files[0]; if (f) { mus.src = URL.createObjectURL(f); msg('Music ready. Press Play both.'); } };
$('loopM').onchange = () => (mus.loop = $('loopM').checked); mus.loop = true;
$('loopA').onchange = () => (aud.loop = $('loopA').checked);

/* ---------- play both ---------- */
function setBtn() { $('play').textContent = playing ? 'PAUSE BOTH' : 'PLAY BOTH'; }
function stopAll() { playing = false; aud.pause(); mus.pause(); if (yt && ytReady) yt.pauseVideo(); setBtn(); }
$('play').onclick = async () => {
  if (playing) return stopAll();
  if (!aud.src) return msg('Choose your affirmations in step 1 first.');
  graph(); await actx.resume(); playing = true; setBtn(); msg('');
  try { await aud.play(); } catch { stopAll(); return msg('The affirmations could not play. Try another memo or file.'); }
  if (mMode === 'yt' && yt && ytReady) { applyVol(); yt.playVideo(); }
  else if (mMode === 'file' && mus.src) mus.play().catch(() => {});
};
aud.onended = () => { if (!aud.loop) { stopAll(); msg('Finished. Did you get the message?'); } };
aud.ontimeupdate = () => { $('tNow').textContent = fmt(aud.currentTime); if (aud.duration) $('seek').value = Math.round(1000 * aud.currentTime / aud.duration); };
aud.onloadedmetadata = () => ($('tDur').textContent = fmt(aud.duration));
$('seek').oninput = () => { if (aud.duration) aud.currentTime = aud.duration * $('seek').value / 1000; };

// Coming from Create: use the track just made on this device.
async function loadLocal() {
  const b = await audioGet('_create_last'); if (!b) return false;
  document.querySelector('[data-a=file]').click(); aud.src = URL.createObjectURL(b);
  $('aFile').insertAdjacentHTML('afterend', '<span class="hint">Using the track you just made.</span>');
  msg('Your new track is ready. Pick a beat, then press Play both.'); return true;
}
(q.get('local') ? loadLocal() : Promise.resolve()).then(loadMemos);
