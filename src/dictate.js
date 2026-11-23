// Dictation: a 🎤 button next to a text box. Uses the browser's own speech recognition (Chrome, Edge, Safari).
// Where that isn't available, the button explains how to use the keyboard's own mic instead.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let live = null;
export function addMic(input, onDone) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'mic'; b.setAttribute('aria-label', 'Speak your answer'); b.textContent = '🎤';
  input.insertAdjacentElement('afterend', b);
  const wrap = document.createElement('span'); wrap.className = 'micwrap';
  input.parentNode.insertBefore(wrap, input); wrap.append(input, b);
  b.onclick = () => {
    if (!SR) { b.title = 'Tap the 🎤 on your keyboard to speak'; input.focus(); input.placeholder = 'Tap the mic on your keyboard and speak…'; return; }
    if (live) { live.stop(); return; }
    const r = new SR(); live = r;
    r.lang = navigator.language || 'en-GB'; r.interimResults = true; r.continuous = input.tagName === 'TEXTAREA';
    const before = input.value.trim(); let final = '';
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += (input.tagName === 'TEXTAREA' ? '\n' : ' ') + t.trim(); else interim += t; }
      const said = (final + ' ' + interim).trim();
      input.value = (before ? before + (input.tagName === 'TEXTAREA' ? '\n' : ' ') : '') + said.replace(/^\n/, '');
      input.dispatchEvent(new Event('input'));
    };
    r.onstart = () => b.classList.add('on');
    r.onend = () => { b.classList.remove('on'); live = null; input.value = input.value.replace(/\n{2,}/g, '\n').trim(); if (input.maxLength > 0) input.value = input.value.slice(0, input.maxLength); input.dispatchEvent(new Event('input')); onDone?.(); };
    r.onerror = e => { if (e.error === 'not-allowed') alertOnce(input, 'Allow the microphone for this site to speak your answers.'); };
    try { r.start(); } catch { live = null; }
  };
  return b;
}
function alertOnce(input, t) { input.placeholder = t; }
