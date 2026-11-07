// MemoPad Create (pilot): write affirmations, turn them into speech, lay them over music, download the mix.
// Everything runs on this device. The AI voice is Piper (open source, MIT voices) running in the browser,
// downloaded once from Hugging Face and kept in the browser's private storage. Music is generated here too.
import './create.css';
import { supabase, audioPut } from './cloud.js';
import { VOICES, orb } from './voices.js';
const $ = id => document.getElementById(id);
const SR = 44100;
let vMode = 'ai', mMode = 'calm', recBlob = null, voiceFileBlob = null, musicFileBuf = null, busy = false, outUrl = null;
let actx = null; const ac = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());

/* ---------- 1. Words ---------- */
const BANK = {
  Mentally: ['My mind is clear and focused.', 'I learn quickly and think in solutions.', 'I choose thoughts that move me forward.', 'I give my full attention to one thing at a time.', 'My mind is calm, sharp and ready.', 'I trust my ability to work things out.', 'I let go of what I cannot control.'],
  Emotionally: ['I am safe to feel what I feel.', 'I meet myself with kindness.', 'I am calm, steady and at peace.', 'I release what no longer serves me.', 'I am proud of how far I have come.', 'My feelings guide me, they do not rule me.', 'I am enough, exactly as I am.'],
  Professionally: ['I do excellent work and I am rewarded for it.', 'I take one focused step at a time.', 'I add real value to everyone I work with.', 'Opportunities find me and I am ready for them.', 'I finish what I start.', 'I am organised, prepared and in control of my day.', 'I deserve to be paid well for my skills.'],
  Physically: ['My body is strong and full of energy.', 'I move my body every day with joy.', 'I fuel myself with good food and water.', 'I rest well and wake up refreshed.', 'Every day I get a little fitter.', 'I listen to what my body needs.', 'I am healthy, vibrant and alive.'],
  Socially: ['I attract good people into my life.', 'I speak with warmth and confidence.', 'I am a great friend and I am well loved.', 'People feel at ease around me.', 'I show up fully in every conversation.', 'I give and receive support easily.', 'I belong wherever I choose to be.'],
  Romantically: ['I give and receive love freely.', 'I am worthy of deep, lasting love.', 'I communicate openly and listen with my heart.', 'My relationship grows stronger every day.', 'I am patient, loving and kind.', 'I celebrate the people I love.', 'Love flows easily in my life.'],
};
const GOAL = ['I am ready to {g}.', 'Every day I {g}.', 'It is safe and natural for me to {g}.', 'I have everything I need to {g}.', 'I am becoming someone who can {g}.'];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function writeForMe() {
  const g = $('goal').value.trim().replace(/[.!?]+$/, '').replace(/^(to|i want to|i want|i'd like to)\s+/i, '');
  const goalLines = g ? shuffle(GOAL).slice(0, 3).map(t => t.replace('{g}', g.charAt(0).toLowerCase() + g.slice(1))) : [];
  const lines = [...goalLines.slice(0, 1), ...shuffle(BANK[$('pillar').value]).slice(0, g ? 4 : 7), ...goalLines.slice(1)];
  $('text').value = lines.join('\n'); updateCount();
}
const lines = () => $('text').value.split('\n').map(s => s.trim()).filter(Boolean);
const fmt = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function updateCount() {
  const L = lines(); if (!L.length) { $('count').textContent = ''; return; }
  const words = L.join(' ').split(/\s+/).length, rep = +$('rep').value, gap = +$('gap').value;
  $('count').textContent = `${L.length} line${L.length > 1 ? 's' : ''} · about ${fmt(10 + rep * (words / 2.6 + L.length * gap))} with the AI voice`;
}

/* ---------- 2. Voice ---------- */
let tts = null; const ttsCache = new Map();
const loadTts = () => (tts ||= import('@diffusionstudio/vits-web'));
async function decode(blob) { return ac().decodeAudioData(await blob.arrayBuffer()); }
// ElevenLabs voices go through our own server function (api/tts.js) so the API key stays secret.
async function speakEleven(text, voice) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('sign in to MemoPad first to use ElevenLabs voices');
  const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ text, voice }) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error({ not_configured: 'ElevenLabs is not switched on yet (the API key is missing)', sign_in: 'sign in to MemoPad first to use ElevenLabs voices', text: 'that line is too long, keep each line under 500 characters' }[e.error] || `ElevenLabs said no (${e.status || r.status})`);
  }
  return decode(await r.blob());
}
async function speak(text, voiceId, onDl) {
  const k = voiceId + '|' + text; if (ttsCache.has(k)) return ttsCache.get(k);
  if (voiceId.startsWith('el:')) { const b = await speakEleven(text, voiceId.slice(3)); ttsCache.set(k, b); return b; }
  const T = await loadTts();
  const wav = await T.predict({ text, voiceId }, p => { if (p && p.total) onDl(p.loaded / p.total); });
  const buf = await decode(wav); ttsCache.set(k, buf); return buf;
}
function seg(id, attr, on) {
  $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); on(b.dataset[attr]); });
}
seg('vMode', 'v', v => { vMode = v; $('vPill').hidden = v !== 'ai'; document.querySelectorAll('.vp').forEach(p => (p.hidden = p.dataset.p !== v)); $('aiOpts').hidden = v !== 'ai'; });
seg('mMode', 'm', m => { mMode = m; $('mFileRow').hidden = m !== 'file'; });

let rec = null, recT0 = 0, recTimer = 0;
$('recBtn').onclick = async () => {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const chunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); clearInterval(recTimer); recBlob = new Blob(chunks, { type: rec.mimeType }); rec = null; $('recBtn').classList.remove('live'); $('recBtn').textContent = '● Record again'; $('recInfo').textContent = `Recorded ${fmt((Date.now() - recT0) / 1000)}. Ready to mix.`; };
    rec.start(); recT0 = Date.now(); $('recBtn').classList.add('live'); $('recBtn').textContent = '■ Stop';
    recTimer = setInterval(() => ($('recInfo').textContent = `Recording ${fmt((Date.now() - recT0) / 1000)}`), 500);
  } catch { $('recInfo').textContent = 'Microphone not available. Check the browser permission.'; }
};
$('voiceFile').onchange = e => { voiceFileBlob = e.target.files[0] || null; $('voiceFileInfo').textContent = voiceFileBlob ? 'Ready to mix.' : ''; };
$('musicFile').onchange = async e => { const f = e.target.files[0]; musicFileBuf = null; if (f) try { musicFileBuf = await decode(f); } catch { msg('That music file could not be read. Try an MP3 or WAV.'); } };

/* ---------- voice picker ---------- */
let sampleSrc = null, previewEl = null, playingCard = null;
function stopSample() { sampleSrc?.stop(); sampleSrc = null; previewEl?.pause(); if (playingCard) playingCard.classList.remove('playing'); playingCard = null; }
async function hearSample(v, card) {
  const again = playingCard === card; stopSample(); if (again) return;
  playingCard = card; card.classList.add('playing');
  try {
    if (v.preview) { previewEl = new Audio(v.preview); previewEl.onended = stopSample; await previewEl.play(); return; }
    if (busy) return; busy = true;
    const buf = await speak('I am calm, clear and confident. I did get the message.', v.id, p => msg(`Downloading the free voice… ${Math.round(p * 100)}%`));
    msg(''); sampleSrc = ac().createBufferSource(); sampleSrc.buffer = buf; sampleSrc.connect(ac().destination); sampleSrc.onended = stopSample; await ac().resume(); sampleSrc.start();
  } catch (err) { stopSample(); msg('The voice could not play: ' + (err.message || err) + '.'); }
  finally { busy = false; }
}
let vFilter = 'all';
function renderVoices() {
  const g = $('vGrid'), cur = $('voice').value; g.innerHTML = '';
  VOICES.filter(v => vFilter === 'all' || v.tags.includes(vFilter)).forEach(v => {
    const c = document.createElement('div'); c.className = 'vcard' + (v.id === cur ? ' on' : ''); c.tabIndex = 0;
    c.innerHTML = `<i class="orb"></i><span class="vn"><b>${v.name}</b><small>${v.desc}</small></span><button class="vplay" aria-label="Hear ${v.name}"><svg viewBox="0 0 24 24"><path class="ip" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/><path class="ipa" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg></button>`;
    c.querySelector('.orb').style.background = orb(v);
    c.onclick = e => { if (e.target.closest('.vplay')) return hearSample(v, c); pickVoice(v.id); };
    c.onkeydown = e => { if (e.key === 'Enter') pickVoice(v.id); };
    g.appendChild(c);
  });
}
function pickVoice(id) {
  $('voice').value = id; const v = VOICES.find(x => x.id === id);
  $('vPillName').textContent = `${v.name} · ${v.desc}`; $('vPillOrb').style.background = orb(v);
  $('voiceHint').textContent = id.startsWith('el:') ? 'Natural ElevenLabs voice. Sign in to MemoPad to use it. Each line is made once, then reused.' : 'Free voice. It downloads once (about 60 MB), then works offline.';
  [...$('vGrid').children].forEach((c, i) => c.classList.toggle('on', c.querySelector('b').textContent === v.name));
}
$('voice').innerHTML = VOICES.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
$('vFilter').onclick = e => { const b = e.target.closest('button'); if (!b) return; [...$('vFilter').children].forEach(x => x.classList.toggle('on', x === b)); vFilter = b.dataset.f; renderVoices(); };
$('vPill').onclick = () => { document.querySelector('[data-v=ai]').click(); $('vGrid').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
renderVoices(); pickVoice(VOICES[0].id);

/* ---------- 3. Music (generated here, no samples, no rights issues) ---------- */
const MOODS = {
  calm: { len: 8, cut: 900, chords: [[57, 60, 64, 67], [53, 57, 60, 64], [50, 53, 57, 60], [55, 59, 62, 67]], keys: 0 },
  warm: { len: 6, cut: 1300, chords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], keys: 0.75 },
  bright: { len: 4, cut: 2200, chords: [[62, 66, 69, 73], [59, 62, 66, 69], [55, 59, 62, 66], [57, 61, 64, 69]], keys: 0.375 },
};
const hz = n => 440 * 2 ** ((n - 69) / 12);
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
function reverb(ctx) {
  const n = Math.floor(3 * ctx.sampleRate), ir = ctx.createBuffer(2, n, ctx.sampleRate), r = rng(7);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (r() * 2 - 1) * (1 - i / n) ** 3; }
  const cv = ctx.createConvolver(); cv.buffer = ir; return cv;
}
// Schedules dur seconds of music into dest on ctx (an OfflineAudioContext).
function music(ctx, dest, mood, dur) {
  if (mood === 'none') return;
  if (mood === 'file') {
    if (!musicFileBuf) return; const s = ctx.createBufferSource(); s.buffer = musicFileBuf; s.loop = true;
    const g = ctx.createGain(); g.gain.value = 0.7; s.connect(g).connect(dest); s.start(0); s.stop(dur); return;
  }
  const M = MOODS[mood], r = rng(42), bus = ctx.createGain(), lp = ctx.createBiquadFilter(), wet = ctx.createGain(), rv = reverb(ctx);
  lp.type = 'lowpass'; lp.frequency.value = M.cut; wet.gain.value = 0.45;
  bus.connect(lp); lp.connect(dest); lp.connect(rv).connect(wet).connect(dest);
  const note = (f, t0, t1, type, peak, det) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = f; o.detune.value = det;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + Math.min(2, (t1 - t0) / 3)); g.gain.setValueAtTime(peak, t1); g.gain.linearRampToValueAtTime(0, t1 + 2.5);
    o.connect(g).connect(bus); o.start(t0); o.stop(t1 + 2.6);
  };
  for (let i = 0, t = 0; t < dur; i++, t += M.len) {
    const ch = M.chords[i % M.chords.length], end = Math.min(dur, t + M.len + 0.5);
    ch.forEach(n => { note(hz(n), t, end, 'triangle', 0.035, -7); note(hz(n), t, end, 'sine', 0.035, 7); });
    note(hz(ch[0] - 12), t, end, 'sine', 0.09, 0);
    if (M.keys) for (let k = t + M.keys; k < t + M.len && k < dur - 3; k += M.keys) {
      if (r() < 0.35) continue;
      const f = hz(ch[Math.floor(r() * ch.length)] + 12), o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
      o.frequency.value = f; o2.frequency.value = f * 2; g2.gain.value = 0.25; const pk = 0.05 + r() * 0.03;
      g.gain.setValueAtTime(0.0001, k); g.gain.exponentialRampToValueAtTime(pk, k + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, k + 2.4);
      o.connect(g); o2.connect(g2).connect(g); g.connect(bus); o.start(k); o2.start(k); o.stop(k + 2.5); o2.stop(k + 2.5);
    }
  }
}
function musicBus(ctx, dur) {
  const g = ctx.createGain(), v = (+$('mVol').value / 100) * 1.4;
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(v, Math.min(3, dur / 4)); g.gain.setValueAtTime(v, Math.max(0, dur - 5)); g.gain.linearRampToValueAtTime(0, dur);
  g.connect(ctx.destination); return g;
}
let prevSrc = null;
$('mPrev').onclick = async () => {
  if (prevSrc) { prevSrc.stop(); prevSrc = null; $('mPrev').textContent = '▶ Preview'; return; }
  if (mMode === 'none') return; if (mMode === 'file' && !musicFileBuf) return msg('Choose your instrumental first.');
  const ctx = new OfflineAudioContext(2, 20 * SR, SR); music(ctx, musicBus(ctx, 20), mMode, 20);
  const buf = await ctx.startRendering(); await ac().resume();
  prevSrc = ac().createBufferSource(); prevSrc.buffer = buf; prevSrc.connect(ac().destination); prevSrc.start();
  $('mPrev').textContent = '■ Stop'; prevSrc.onended = () => { prevSrc = null; $('mPrev').textContent = '▶ Preview'; };
};

/* ---------- 4. Mix and export ---------- */
const msg = t => ($('msg').textContent = t);
const prog = p => { $('bar').hidden = false; $('bar').firstChild.style.width = Math.round(p * 100) + '%'; };
function encodeMp3(buf) {
  return new Promise((res, rej) => {
    const chs = [new Float32Array(buf.getChannelData(0)), new Float32Array(buf.getChannelData(1))], wk = new Worker('/mp3-worker.js');
    wk.onmessage = e => { if (e.data.type === 'p') prog(0.8 + 0.2 * e.data.p); else { wk.terminate(); res(new Blob(e.data.out, { type: 'audio/mpeg' })); } };
    wk.onerror = e => { wk.terminate(); rej(new Error(e.message || 'encoder failed')); };
    wk.postMessage({ chs, sr: SR, kbps: 128 }, chs.map(c => c.buffer));
  });
}
$('make').onclick = async () => {
  if (busy) return; const L = lines();
  if (vMode === 'ai' && !L.length) return msg('Add some words in step 1 first.');
  if (vMode === 'rec' && !recBlob) return msg('Record your voice in step 2 first.');
  if (vMode === 'file' && !voiceFileBlob) return msg('Choose a recording in step 2 first.');
  if (mMode === 'file' && !musicFileBuf) return msg('Choose your instrumental in step 3 first.');
  busy = true; $('make').disabled = true; $('out').hidden = true; prog(0.02);
  try {
    const lead = 4, tail = 6, place = []; let t = lead;
    if (vMode === 'ai') {
      const rep = +$('rep').value, gap = +$('gap').value, v = $('voice').value;
      for (let i = 0; i < L.length; i++) {
        msg(`Speaking line ${i + 1} of ${L.length}…`);
        const b = await speak(L[i], v, p => msg(`Downloading the voice (first time only)… ${Math.round(p * 100)}%`));
        for (let r = 0; r < rep; r++) { place.push([b, t]); t += b.duration + gap; }
        prog(0.02 + 0.6 * (i + 1) / L.length);
      }
      t -= gap;
    } else { msg('Reading your recording…'); const b = await decode(vMode === 'rec' ? recBlob : voiceFileBlob); place.push([b, t]); t += b.duration; prog(0.6); }
    const dur = t + tail; msg('Mixing voice over music…');
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
    music(ctx, musicBus(ctx, dur), mMode, dur);
    const vg = ctx.createGain(); vg.gain.value = 1; vg.connect(ctx.destination);
    place.forEach(([b, at]) => { const s = ctx.createBufferSource(); s.buffer = b; s.connect(vg); s.start(at); });
    const mix = await ctx.startRendering(); prog(0.8);
    let pk = 0; for (let c = 0; c < 2; c++) { const d = mix.getChannelData(c); for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i])); }
    if (pk > 0.95) for (let c = 0; c < 2; c++) { const d = mix.getChannelData(c), g = 0.95 / pk; for (let i = 0; i < d.length; i++) d[i] *= g; }
    msg('Saving as MP3…'); const mp3 = await encodeMp3(mix);
    if (outUrl) URL.revokeObjectURL(outUrl); outUrl = URL.createObjectURL(mp3);
    const name = ($('title').value.trim() || 'My affirmations').replace(/[\\/:*?"<>|]+/g, '');
    $('player').src = outUrl; $('dl').href = outUrl; $('dl').download = name + '.mp3';
    audioPut('_create_last', mp3);
    $('out').hidden = false; prog(1); msg(`Done: ${fmt(dur)}, ${(mp3.size / 1048576).toFixed(1)} MB. Download it, then add it in MemoPad to share it.`);
  } catch (err) { msg('Something went wrong: ' + (err.message || err)); }
  busy = false; $('make').disabled = false; setTimeout(() => ($('bar').hidden = true), 1200);
};

$('write').onclick = writeForMe;
$('text').oninput = updateCount; $('rep').onchange = updateCount; $('gap').onchange = updateCount;
$('goal').onkeydown = e => { if (e.key === 'Enter') writeForMe(); };

