// MemoPad Create (pilot): write affirmations, turn them into speech, lay them over music, download the mix.
// Everything runs on this device. The AI voice is Piper (open source, MIT voices) running in the browser,
// downloaded once from Hugging Face and kept in the browser's private storage. Music is generated here too.
import './create.css';
import { audioPut, supabase, BUCKET, TABLE, trackToRow } from './cloud.js';
import { VOICES, orb } from './voices.js';
import { speakBlob, elevenReason } from './tts.js';
import { addMic } from './dictate.js';
import { readDoc, DOC_ACCEPT, splitLines } from './doctext.js';
const $ = id => document.getElementById(id);
const SR = 44100;
let vMode = 'ai', mMode = 'calm', recBlob = null, voiceFileBlob = null, musicFileBuf = null, aiBuf = null, busy = false, outUrl = null, last = null;
let actx = null; const ac = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());

/* ---------- 1. Words ---------- */
const BANK = {
  Mentally: ['My mind is clear and focused.', 'I learn quickly and think in solutions.', 'I choose thoughts that move me forward.', 'I give my full attention to one thing at a time.', 'My mind is calm, sharp and ready.', 'I trust my ability to work things out.', 'I let go of what I cannot control.'],
  Emotionally: ['I am safe to feel what I feel.', 'I meet myself with kindness.', 'I am calm, steady and at peace.', 'I release what no longer serves me.', 'I am proud of how far I have come.', 'My feelings guide me, they do not rule me.', 'I am enough, exactly as I am.'],
  Professionally: ['I do excellent work and I am rewarded for it.', 'I take one focused step at a time.', 'I add real value to everyone I work with.', 'Opportunities find me and I am ready for them.', 'I finish what I start.', 'I am organised, prepared and in control of my day.', 'I deserve to be paid well for my skills.'],
  Physically: ['My body is strong and full of energy.', 'I move my body every day with joy.', 'I fuel myself with good food and water.', 'I rest well and wake up refreshed.', 'Every day I get a little fitter.', 'I listen to what my body needs.', 'I am healthy, vibrant and alive.'],
  Socially: ['I attract good people into my life.', 'I speak with warmth and confidence.', 'I am a great friend and I am well loved.', 'People feel at ease around me.', 'I show up fully in every conversation.', 'I give and receive support easily.', 'I belong wherever I choose to be.'],
  Spiritually: ['I am guided, protected and provided for.', 'I walk in faith, not fear.', 'I am grateful for every blessing today.', 'My purpose is bigger than my doubts.', 'I trust the timing of my life.', 'I am at peace with who I am becoming.', 'I carry light into every room.'],
  Financially: ['I manage my money with care and confidence.', 'I am open to new streams of income.', 'I spend with purpose and save with ease.', 'My value grows every day.', 'I make wise choices with what I have.', 'Money flows to me through good work.', 'I am building wealth step by step.'],
  Romantically: ['I give and receive love freely.', 'I am worthy of deep, lasting love.', 'I communicate openly and listen with my heart.', 'My relationship grows stronger every day.', 'I am patient, loving and kind.', 'I celebrate the people I love.', 'Love flows easily in my life.'],
};
const GOAL = ['I am ready to {g}.', 'Every day I {g}.', 'It is safe and natural for me to {g}.', 'I have everything I need to {g}.', 'I am becoming someone who can {g}.'];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// chip rows: one choice, or many for life areas
const pick = id => $(id).querySelector('button.on')?.dataset || {};
['person', 'tone', 'howMany'].forEach(id => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); }));
$('areas').addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.classList.toggle('on'); });
const areas = () => [...$('areas').querySelectorAll('button.on')].map(b => b.dataset.a);
const AREA_TITLE = { Mentally: 'A clear, focused mind', Emotionally: 'Calm and steady emotions', Professionally: 'Excellent work and growth', Physically: 'A strong, healthy body', Socially: 'Great friends and connection', Romantically: 'Deep, lasting love', Spiritually: 'Faith and purpose', Financially: 'Money and abundance' };
// 500 lines = 10 chapters of 50: who I am becoming, the chosen areas, then general themes, ending on the message
function chapters(goal) {
  const t = ['Who I am becoming', ...(goal ? [`Ready to ${goal}`] : []), ...areas().map(a => AREA_TITLE[a]), 'Confidence and courage', 'Discipline and focus', 'Gratitude', 'Rest and peace', 'Energy and joy', 'Love and kindness'];
  const out = [...new Set(t)].slice(0, 9); while (out.length < 9) out.push('Progress every day');
  return [...out, 'Did you get the message?'];
}
const cleanName = () => $('who').value.trim().replace(/[^\p{L}\p{M}' -]/gu, '').slice(0, 40);
const cleanGoal = () => $('goal').value.trim().replace(/[.!?]+$/, '').replace(/^(to|i want to|i want|i'd like to)\s+/i, '');
function addName(L, who, where) { // the name opens the track; "often" brings it back about one line in ten
  if (!who || where === 'none') return L;
  L = L.slice(); L.unshift(`${who}, you are ready for today.`);
  if (where === 'often') for (let i = 10; i < L.length; i += 11) L.splice(i, 0, `${who}, you are doing so well.`);
  L.push(`${who}, did you get the message?`); return L;
}
// ready-made words for each area, mixed with simple openings so any number of lines (up to 500+) can be made without the AI writer
const QUAL = {
  Mentally: ['focused', 'clear-minded', 'calm under pressure', 'curious', 'sharp', 'present', 'open to learning', 'resourceful', 'patient with myself', 'wise'],
  Emotionally: ['at peace', 'steady', 'gentle with myself', 'resilient', 'hopeful', 'grounded', 'safe in my own skin', 'joyful', 'balanced', 'kind to myself'],
  Professionally: ['valuable', 'skilled', 'reliable', 'confident at work', 'creative', 'organised', 'prepared', 'a strong leader', 'paid well for my skills', 'proud of my work'],
  Physically: ['strong', 'healthy', 'full of energy', 'well rested', 'active', 'flexible', 'well nourished', 'comfortable in my body', 'fit', 'fully alive'],
  Socially: ['friendly', 'a good listener', 'warm', 'generous', 'supported', 'connected', 'welcome', 'easy to be around', 'appreciated', 'loving towards others'],
  Romantically: ['loved', 'loving', 'worthy of love', 'open-hearted', 'cherished', 'attractive', 'patient in love', 'honest in love', 'adored', 'deeply connected'],
  Spiritually: ['guided', 'blessed', 'grateful', 'faithful', 'living my purpose', 'protected', 'humble', 'full of grace', 'trusting', 'aligned'],
  Financially: ['abundant', 'wise with money', 'prosperous', 'generous with money', 'calm about money', 'rich in opportunity', 'a good saver', 'open to wealth', 'financially free', 'secure'],
};
const STEMS = ['I am {q}.', 'Today I am {q}.', 'I choose to be {q}.', 'I allow myself to be {q}.', 'It is natural for me to be {q}.', 'I am proud to be {q}.', 'Every day I am {q}.', 'Right now, I am {q}.', 'I give myself permission to be {q}.', 'I was made to be {q}.'];
function bankPool(list, g) {
  const goalLines = g ? GOAL.map(t => t.replace('{g}', g.charAt(0).toLowerCase() + g.slice(1))) : [];
  return [...new Set([...goalLines, ...list.flatMap(a => BANK[a] || []), ...list.flatMap(a => (QUAL[a] || []).flatMap(q => STEMS.map(t => t.replace('{q}', q))))])];
}
function bankLines(n, g) { // built-in lines, used when the AI writer is not available
  const mine = areas().length ? areas() : ['Professionally'];
  let pool = shuffle(bankPool(mine, g));
  if (pool.length < n) pool = [...pool, ...shuffle(bankPool(Object.keys(QUAL), '').filter(x => !pool.includes(x)))];
  if (n !== 500) return pool.slice(0, n);
  const ch = chapters(g), out = [];
  ch.forEach((c, i) => out.push(`# ${c}`, ...pool.slice(i * 50, i * 50 + 50)));
  return out;
}
let writing = false;
async function writeForMe() {
  if (writing) return; writing = true; $('write').disabled = true;
  const info = t => ($('writeInfo').textContent = t);
  const n = +pick('howMany').n || 25, g = cleanGoal(), keep = $('writeMode').value === 'add' ? $('text').value.split('\n').map(x => x.trim()).filter(Boolean) : [];
  const base = { goal: g, why: $('why').value.trim(), areas: areas(), person: pick('person').p || 'i', tone: pick('tone').t || 'calm and steady', include: $('include').value.trim() };
  const tok = await token();
  const ask = async (count, chapter, avoid) => {
    const r = await fetch('/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ ...base, count, chapter, avoid }) });
    if (!r.ok) { const e = new Error(r.status); e.status = r.status; throw e; }
    return (await r.json()).lines || [];
  };
  let out = [];
  try {
    if (n <= 50) { info('Writing your affirmations…'); out = await ask(n, '', keep.slice(-40)); }
    else {
      const ch = n === 500 ? chapters(g) : ['Who I am becoming', 'Did you get the message?'];
      const per = Math.round(n / ch.length), parts = new Array(ch.length);
      let done = 0; info(`Writing chapter 1 of ${ch.length}…`);
      for (let i = 0; i < ch.length; i += 3) { // three chapters at a time
        await Promise.all(ch.slice(i, i + 3).map((c, k) => ask(per, c, keep.slice(-20)).then(L => { parts[i + k] = L; info(`Written ${++done} of ${ch.length} chapters…`); })));
      }
      out = parts.flatMap((L, i) => n === 500 ? [`# ${ch[i]}`, ...L] : L);
    }
    info('Done. Edit any line you like, then press Play now or Make my track.');
  } catch (e) {
    out = bankLines(n, g);
    info(e.status === 401 ? 'Sign in on the MemoPad home page so MemoPad can write lines just for you. For now, here are some ready-made ones.'
      : e.status === 503 || e.status === 404 ? 'The personal writer is not switched on yet, so here are ready-made lines for your areas.'
      : 'The writer was busy, so here are ready-made lines for now. Try again in a minute.');
  }
  const body = out.filter(x => !x.startsWith('# '));
  const named = n === 500 ? out : addName(body, cleanName(), $('nameWhere').value);
  if (n === 500 && cleanName() && $('nameWhere').value !== 'none') { // name opens each chapter
    const who = cleanName(); for (let i = 0; i < named.length; i++) if (named[i].startsWith('# ') && named[i + 1]) named.splice(i + 1, 0, `${who}, this one is for you.`);
    named.push(`${who}, did you get the message?`);
  }
  $('text').value = [...keep, ...named].join('\n'); updateCount();
  writing = false; $('write').disabled = false;
}
// chapter headings (# Title) are spoken as plain lines here; the Reader shows them as headings
const lines = () => splitLines($('text').value).map(s => s.replace(/^#+\s*/, '').trim()).filter(Boolean);
const fmt = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function updateCount() {
  const L = lines(); if (!L.length) { $('count').textContent = ''; return; }
  const words = L.join(' ').split(/\s+/).length, rep = +$('rep').value, gap = +$('gap').value;
  $('count').textContent = `${L.length} line${L.length > 1 ? 's' : ''} · about ${fmt(10 + rep * (words / 2.6 + L.length * gap))} with the AI voice`;
}

/* ---------- 2. Voice ---------- */
const ttsCache = new Map();
async function decode(blob) { return ac().decodeAudioData(await blob.arrayBuffer()); }
async function speak(text, voiceId, onDl, ctx = null) {
  const k = voiceId + '|' + $('pace').value + '|' + (ctx ? 'f|' : '') + text; if (ttsCache.has(k)) return ttsCache.get(k);
  const b = await decode(await speakBlob(text, voiceId, onDl, +$('pace').value || 1, ctx)); ttsCache.set(k, b); return b;
}

function seg(id, attr, on) {
  $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); on(b.dataset[attr]); });
}
seg('vMode', 'v', v => { vMode = v; $('vPill').hidden = v !== 'ai'; document.querySelectorAll('.vp').forEach(p => (p.hidden = p.dataset.p !== v)); $('aiOpts').hidden = v !== 'ai'; });
seg('mMode', 'm', m => { mMode = m; $('mFileRow').hidden = m !== 'file'; $('aiRow').hidden = m !== 'ai'; });

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
  if (mood === 'file' || mood === 'ai') {
    const src = mood === 'ai' ? aiBuf : musicFileBuf;
    if (!src) return; const s = ctx.createBufferSource(); s.buffer = src; s.loop = true;
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
  if (mMode === 'none') return; if (mMode === 'file' && !musicFileBuf) return msg('Choose your instrumental first.'); if (mMode === 'ai' && !aiBuf) return msg('Make your AI beat first.');
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
  if (mMode === 'ai' && !aiBuf) return msg('Make your AI beat in step 3 first, or pick another beat.');
  busy = true; $('make').disabled = true; $('out').hidden = true; prog(0.02);
  try {
    const lead = 4, tail = 6, place = [], said = []; let t = lead;
    if (vMode === 'ai') {
      const rep = +$('rep').value, gap = +$('gap').value, v = $('voice').value;
      for (let i = 0; i < L.length; i++) {
        msg(`Speaking line ${i + 1} of ${L.length}…`);
        const b = await speak(L[i], v, p => msg(`Downloading the voice (first time only)… ${Math.round(p * 100)}%`), { prev: L[i - 1] || '', next: L[i + 1] || '' });
        for (let r = 0; r < rep; r++) { place.push([b, t]); said.push([L[i], t, t + b.duration]); t += b.duration + gap; }
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
    last = { mp3, dur, name, said, peaks: peaksOf(mix, dur), saved: false };
    $('save').disabled = false; $('save').textContent = 'Save to my MemoPad';
    $('out').hidden = false; prog(1); msg(`Done: ${fmt(dur)}, ${(mp3.size / 1048576).toFixed(1)} MB. Save it to your MemoPad below, or download it.`);
  } catch (err) { msg('Something went wrong: ' + (err.message || err)); }
  busy = false; $('make').disabled = false; setTimeout(() => ($('bar').hidden = true), 1200);
};

$('write').onclick = writeForMe;
['goal', 'why', 'include', 'who', 'text'].forEach(id => addMic($(id)));
// upload a document of affirmations (Word, PDF, RTF or text): one line each, ready to make into a track
$('docFile').accept = DOC_ACCEPT;
$('docFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; $('docInfo').textContent = 'Reading ' + f.name + '…';
  try { const t = await readDoc(f); $('text').value = t; updateCount(); $('docInfo').textContent = `Added ${t.split('\n').length} lines from ${f.name}.`; $('text').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  catch (err) { $('docInfo').textContent = 'Could not read that file: ' + (err.message || err) + '.'; }
  e.target.value = '';
};
try { const d = JSON.parse(sessionStorage.getItem('mp.doc') || 'null'); if (d && d.text) { sessionStorage.removeItem('mp.doc'); $('text').value = d.text; updateCount(); $('docInfo').textContent = `Added ${d.text.split('\n').length} lines from ${d.name}. Pick a voice and make your track.`; } } catch {}
$('text').oninput = updateCount;
$('text').addEventListener('paste', e => { // keep one affirmation or prayer per line
  const t = e.clipboardData?.getData('text/plain'); if (!t) return; e.preventDefault();
  const el = $('text'), a = el.selectionStart, b = el.selectionEnd, ins = splitLines(t).join('\n');
  el.value = el.value.slice(0, a) + ins + el.value.slice(b); el.selectionStart = el.selectionEnd = a + ins.length; updateCount();
}); $('rep').onchange = updateCount; $('gap').onchange = updateCount;
$('goal').onkeydown = e => { if (e.key === 'Enter') writeForMe(); };


/* ---------- AI beat (ElevenLabs Music through /api/music) ---------- */
$('aiPresets').onclick = e => { const b = e.target.closest('button'); if (!b) return; [...$('aiPresets').children].forEach(x => x.classList.toggle('on', x === b)); $('aiPrompt').value = b.dataset.p; };
async function token() { const { data } = supabase ? await supabase.auth.getSession() : { data: null }; return data?.session?.access_token || null; }
$('aiMake').onclick = async () => {
  if (busy) return; const prompt = $('aiPrompt').value.trim();
  if (!prompt) return ($('aiInfo').textContent = 'Pick a style above or describe your beat first.');
  const tk = await token(); if (!tk) return ($('aiInfo').innerHTML = 'Sign in first: <a href="/">open MemoPad</a>, sign in, then come back here.');
  busy = true; $('aiMake').disabled = true; $('aiInfo').textContent = 'Making your beat… this takes about a minute.';
  try {
    const r = await fetch('/api/music', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` }, body: JSON.stringify({ prompt }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error({ sign_in: 'please sign in to MemoPad again', not_configured: 'ElevenLabs is not switched on yet' }[e.error] || `ElevenLabs said no (${e.status || r.status}${elevenReason(e) ? ', ' + elevenReason(e) : ''})`); }
    aiBuf = await decode(await r.blob());
    $('aiInfo').textContent = `Your beat is ready (${fmt(aiBuf.duration)}, it loops to fit). Tap Preview to hear it.`;
  } catch (err) { $('aiInfo').textContent = 'Could not make the beat: ' + (err.message || err); }
  busy = false; $('aiMake').disabled = false;
};

/* ---------- Save to my MemoPad (private unless Public is ticked) ---------- */
const BPS = 20; // same as the main player
function peaksOf(ab, dur) {
  const ch = ab.getChannelData(0), n = Math.max(1, Math.ceil(dur * BPS)), step = Math.max(1, Math.floor(ch.length / n)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = i * step; j < (i + 1) * step && j < ch.length; j += 4) { s += ch[j] * ch[j]; c++; } out[i] = Math.sqrt(s / (c || 1)); }
  let mx = 0; for (const v of out) mx = Math.max(mx, v); for (let i = 0; i < n; i++) out[i] = Math.pow(out[i] / (mx || 1), 0.7);
  return out;
}
// read-along words: each line's words spread evenly over the time that line is spoken
function wordsOf(said) {
  const w = [];
  said.forEach(([line, a, b]) => { const parts = line.split(/\s+/).filter(Boolean), d = (b - a) / (parts.length || 1); parts.forEach((p, i) => w.push({ text: p, start: a + i * d, end: a + (i + 1) * d, ...(i === parts.length - 1 ? { p: 1 } : {}) })); });
  return w;
}
function chaptersOf(said) { // one chapter about every 10 lines, named by its first line
  const c = [{ t: 0, title: 'Start' }];
  for (let i = 10; i < said.length; i += 10) c.push({ t: Math.max(0, said[i][1] - 0.5), title: said[i][0].slice(0, 60) });
  return c;
}
$('save').onclick = async () => {
  if (!last || last.saved || busy) return;
  if (!supabase) return msg('Saving is not set up on this copy of MemoPad.');
  const { data: { user } = {} } = await supabase.auth.getUser().catch(() => ({ data: {} }));
  if (!user) return msg('Sign in to MemoPad first: open MemoPad in another tab, sign in, then tap Save again.');
  busy = true; $('save').disabled = true; $('save').textContent = 'Saving…';
  try {
    const id = crypto.randomUUID(), audio_path = `${user.id}/${id}.mp3`;
    const t = { title: last.name, category: 'Affirmations', description: last.said.map(x => x[0]).filter((x, i, a) => a.indexOf(x) === i).join('\n'), duration: last.dur, peaks: last.peaks,
      words: wordsOf(last.said), chapters: last.said.length ? chaptersOf(last.said) : [{ t: 0, title: 'Start' }], is_shared: false, is_public: $('pub').checked };
    const up = await supabase.storage.from(BUCKET).upload(audio_path, last.mp3, { contentType: 'audio/mpeg', upsert: false });
    if (up.error) throw new Error('upload failed: ' + up.error.message);
    const ins = await supabase.from(TABLE).insert({ id, user_id: user.id, audio_path, ...trackToRow(t, true) }).select('id').single();
    if (ins.error) { await supabase.storage.from(BUCKET).remove([audio_path]); throw new Error('could not save: ' + ins.error.message); }
    last.saved = true; $('save').textContent = 'Saved ✓';
    msg(t.is_public ? 'Saved to your MemoPad as a public track. Open MemoPad to copy its link.' : 'Saved to your MemoPad. Only you can see it. You can make it public later from Share.');
  } catch (err) { $('save').disabled = false; $('save').textContent = 'Save to my MemoPad'; msg('Could not save: ' + (err.message || err)); }
  busy = false;
};

/* ---------- Play now: hear the words straight away in Reader (line by line, with a YouTube lofi beat) ---------- */
$('playNow').onclick = () => {
  const L = lines(); if (!L.length) return msg('Add some words first, or tap Write for me.');
  const v = $('voice').value, LS = 'memopad-reader';
  let old = {}; try { old = JSON.parse(localStorage.getItem(LS)) || {}; } catch {}
  localStorage.removeItem(LS + '-files');
  localStorage.setItem(LS, JSON.stringify({ ...old, text: L.join('\n'), voice: v, rate: String({ '0.85': 0.9, '1': 1, '1.1': 1.1 }[$('pace').value] || 1), rep: $('rep').value }));
  location.href = '/reader.html?go=1';
};
