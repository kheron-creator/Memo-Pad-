// Lofi scenes: four calm rain scenes in the Progress Today colours, all drawn in code (nothing to download).
// Shared by the app and the public listen page.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lofiLogo = new Image(); lofiLogo.src = '/logo.png';
const lofiRnd = (i, n) => { const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
const LOFI_COLS = ['#25DD5F', '#E10195', '#FFB000', '#5197A8', '#ff7a3d'];
const lofiCache = {}; // the still parts of each scene, drawn once per screen size
function lofiLayer(key, W, H, paint) {
  const id = key + ':' + W + 'x' + H; let c = lofiCache[key];
  if (!c || c.id !== id) { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); paint(g); c = lofiCache[key] = { id, cv, ok: lofiLogo.complete && lofiLogo.naturalWidth > 0 }; }
  else if (!c.ok && lofiLogo.complete && lofiLogo.naturalWidth) { delete lofiCache[key]; return lofiLayer(key, W, H, paint); } // redraw once the logo has loaded
  return c.cv;
}
function lofiSoft(x, px, py, r, col, a) { if (r <= 0) return; const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, col + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0')); g.addColorStop(1, col + '00'); x.fillStyle = g; x.fillRect(px - r, py - r, r * 2, r * 2); }
function lofiLogoAt(x, cx, cy, w, alpha = 1) { if (!lofiLogo.complete || !lofiLogo.naturalWidth) return; const h = w * lofiLogo.naturalHeight / lofiLogo.naturalWidth; x.globalAlpha = alpha; x.drawImage(lofiLogo, cx - w / 2, cy - h / 2, w, h); x.globalAlpha = 1; }
function lofiRain(x, W, H, now, n, len, col, sp = 1, x0 = 0, y0 = 0, w = W, h = H) {
  x.strokeStyle = col; x.lineWidth = Math.max(1, len / 14); x.lineCap = 'round'; x.beginPath();
  for (let k = 0; k < n; k++) { const px = x0 + lofiRnd(k, 1) * w, v = (0.8 + lofiRnd(k, 2) * 0.5) * h * 1.4 * sp, py = y0 + ((now * v + lofiRnd(k, 3) * h) % (h + len)) - len; x.moveTo(px, py); x.lineTo(px - len * 0.18, py + len); }
  x.stroke();
}
function lofiUmbrella(x, cx, top, s, col, bob) { // a small figure under an umbrella
  const y = top + bob;
  x.fillStyle = '#05050a'; x.beginPath(); x.arc(cx, y + s * 0.62, s * 0.13, 0, 7); x.fill();
  x.beginPath(); x.roundRect ? x.roundRect(cx - s * 0.16, y + s * 0.75, s * 0.32, s * 0.62, s * 0.1) : x.rect(cx - s * 0.16, y + s * 0.75, s * 0.32, s * 0.62); x.fill();
  const st = Math.sin(bob * 3) * s * 0.05; x.fillRect(cx - s * 0.13 + st, y + s * 1.3, s * 0.1, s * 0.36); x.fillRect(cx + s * 0.03 - st, y + s * 1.3, s * 0.1, s * 0.34);
  x.strokeStyle = '#05050a'; x.lineWidth = Math.max(1, s * 0.03); x.beginPath(); x.moveTo(cx + s * 0.1, y + s * 0.95); x.lineTo(cx, y + s * 0.15); x.stroke();
  x.fillStyle = col; x.beginPath(); x.moveTo(cx - s * 0.62, y + s * 0.38); x.quadraticCurveTo(cx, y - s * 0.28, cx + s * 0.62, y + s * 0.38); x.closePath(); x.fill();
  x.fillStyle = '#00000030'; x.beginPath(); x.moveTo(cx - s * 0.62, y + s * 0.38); x.quadraticCurveTo(cx - s * 0.2, y - s * 0.05, cx, y + s * 0.38); x.closePath(); x.fill();
}
let lofiInkCv = null;
function lofiInk() { // the logo in dark ink, so it shows on the white paper boat
  if (lofiInkCv || !lofiLogo.complete || !lofiLogo.naturalWidth) return lofiInkCv;
  const c = document.createElement('canvas'); c.width = lofiLogo.naturalWidth; c.height = lofiLogo.naturalHeight; const g = c.getContext('2d');
  g.drawImage(lofiLogo, 0, 0); g.globalCompositeOperation = 'source-atop'; g.fillStyle = '#1f3a4d'; g.fillRect(0, 0, c.width, c.height); return lofiInkCv = c;
}
export const LOFI_DRAW = {
  glass(x, W, H, M, e, now) { // 1. a rainy window at night, city lights blurred behind it, drops running down the glass
    x.drawImage(lofiLayer('glass', W, H, g => {
      g.fillStyle = '#0b0c12'; g.fillRect(0, 0, W, H);
      const n = Math.round(40 + 30 * W * H / (M * M * 1.8));
      for (let k = 0; k < n; k++) lofiSoft(g, lofiRnd(k, 1) * W, H * 0.22 + lofiRnd(k, 2) * H * 0.62, M * (0.04 + lofiRnd(k, 3) * 0.12), LOFI_COLS[k % 5], 0.22 + lofiRnd(k, 4) * 0.3);
      g.fillStyle = '#ffffff0c'; g.fillRect(0, 0, W, H);
      const dn = Math.round(W * H / (M * M) * 150);
      for (let k = 0; k < dn; k++) { const a = lofiRnd(k, 5) * W, b = lofiRnd(k, 6) * H, s = M * (0.003 + lofiRnd(k, 7) * 0.009); g.fillStyle = '#ffffff26'; g.beginPath(); g.ellipse(a, b, s * 0.8, s, 0, 0, 7); g.fill(); g.fillStyle = '#ffffff60'; g.beginPath(); g.arc(a - s * 0.25, b - s * 0.3, s * 0.28, 0, 7); g.fill(); }
    }), 0, 0);
    // the lights breathe with the voice
    lofiSoft(x, W * 0.3, H * 0.5, M * 0.7, '#25DD5F', 0.05 + e * 0.12); lofiSoft(x, W * 0.72, H * 0.45, M * 0.6, '#E10195', 0.04 + e * 0.1);
    // drops running down the glass, leaving a trail
    const n = Math.round(10 + 6 * W / M);
    for (let k = 0; k < n; k++) {
      const per = 9 + lofiRnd(k, 9) * 10, c = Math.floor((now + lofiRnd(k, 10) * per) / per), p = ((now + lofiRnd(k, 10) * per) % per) / per;
      const px = lofiRnd(k + c * 31, 11) * W, y0 = lofiRnd(k + c * 31, 12) * H * 0.5, y = y0 + p * p * H * 0.9, s = M * (0.006 + lofiRnd(k, 13) * 0.006);
      const wob = t => Math.sin(t * 0.012 / (M / 900) + k) * s * 0.35;
      x.strokeStyle = '#ffffff1e'; x.lineWidth = s * 1.1; x.lineCap = 'round'; x.beginPath(); x.moveTo(px + wob(y0), y0);
      for (let q = y0; q < y; q += M * 0.02) x.lineTo(px + wob(q), q); x.lineTo(px + wob(y), y); x.stroke();
      x.fillStyle = '#ffffff55'; x.beginPath(); x.ellipse(px + wob(y), y, s * 1.1, s * 1.45, 0, 0, 7); x.fill();
      x.fillStyle = '#ffffffaa'; x.beginPath(); x.arc(px + wob(y) - s * 0.35, y - s * 0.45, s * 0.35, 0, 7); x.fill();
    }
    lofiRain(x, W, H, now, Math.round(30 * W / M), M * 0.03, '#c9d6ff14', 0.8);
  },
  neon(x, W, H, M, e, now) { // 2. a quiet rainy street; a pink neon sign says the MemoPad message above the Progress Today logo
    const gy = H * 0.7, fs = Math.min(W * 0.085, H * 0.09), sy = H * 0.2;
    x.drawImage(lofiLayer('neonBg', W, H, g => {
      let gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#07070d'); gr.addColorStop(1, '#12101c'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const ww = W * 0.2; g.fillStyle = '#16141f'; g.fillRect(0, 0, ww, gy); g.fillRect(W - ww, 0, ww, gy);
      const cw = ww / 3.4, ch = cw * 0.7;
      for (let k = 0; k < 24; k++) { const cx = (k % 3) * cw * 1.1 + cw * 0.25, cy = H * 0.06 + Math.floor(k / 3) * ch * 1.6; if (cy + ch > gy - 10) continue; g.fillStyle = lofiRnd(k, 1) > 0.6 ? '#ffb00038' : '#ffffff0a'; g.fillRect(cx, cy, cw, ch); g.fillStyle = lofiRnd(k, 2) > 0.65 ? '#E1019530' : '#ffffff0a'; g.fillRect(W - ww + cx, cy, cw, ch); }
      gr = g.createLinearGradient(0, gy, 0, H); gr.addColorStop(0, '#0e0d16'); gr.addColorStop(1, '#09080f'); g.fillStyle = gr; g.fillRect(0, gy, W, H - gy);
    }), 0, 0);
    const sign = lofiLayer('neonSign', W, H, g => {
      lofiSoft(g, W / 2, sy + fs * 0.8, Math.max(W, H) * 0.45, '#E10195', 0.32);
      g.font = `800 ${Math.round(fs)}px Poppins, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = '#E10195'; g.shadowBlur = fs * 0.45; g.fillStyle = '#ffd1ec'; g.fillText('Did you get', W / 2, sy + fs * 0.5); g.fillText('the message?', W / 2, sy + fs * 1.65);
      g.shadowColor = '#25DD5F'; g.shadowBlur = fs * 0.35; lofiLogoAt(g, W / 2, sy + fs * 2.75, Math.min(W * 0.42, fs * 4.4)); g.shadowBlur = 0;
    });
    const fl = (now % 11) < 0.12 || ((now + 0.3) % 17) < 0.08 ? 0.55 : 1; // a little neon flicker now and then
    x.globalAlpha = (0.72 + e * 0.28) * fl; x.drawImage(sign, 0, 0); x.globalAlpha = 1;
    // its reflection in the wet ground
    x.save(); x.beginPath(); x.rect(0, gy, W, H - gy); x.clip(); x.translate(0, gy * 2 - sy * 0.4); x.scale(1, -1); x.globalAlpha = 0.14 * fl; x.drawImage(sign, 0, 0); x.restore(); x.globalAlpha = 1;
    // ripples in the puddles
    x.lineWidth = Math.max(1, M * 0.002);
    for (let k = 0; k < 22; k++) { const per = 1.6 + lofiRnd(k, 4) * 1.4, c = Math.floor((now + k * 0.37) / per), p = ((now + k * 0.37) % per) / per, rx = M * (0.01 + p * 0.06); x.strokeStyle = `rgba(255,255,255,${0.28 * (1 - p)})`; x.beginPath(); x.ellipse(lofiRnd(k + c * 13, 5) * W, gy + H * 0.03 + lofiRnd(k + c * 13, 6) * (H - gy - H * 0.05), rx, rx * 0.22, 0, 0, 7); x.stroke(); }
    // someone strolls past under a green umbrella
    const span = W * 1.3, ux = ((now * M * 0.018) % span) - W * 0.15, us = M * 0.16;
    lofiUmbrella(x, ux, gy - us * 1.6, us, '#25DD5F', Math.abs(Math.sin(now * 2.4)) * us * 0.03);
    lofiRain(x, W, H, now, Math.round(70 * W / M), M * 0.035, '#c9d6ff40');
  },
  path(x, W, H, M, e, now) { // 3. a wet road into the city at night; the centre line is the green Progress Today arrow
    const hz = H * 0.52, cx = W / 2;
    x.drawImage(lofiLayer('path', W, H, g => {
      let gr = g.createLinearGradient(0, 0, 0, hz); gr.addColorStop(0, '#100f24'); gr.addColorStop(1, '#2d2048'); g.fillStyle = gr; g.fillRect(0, 0, W, hz);
      lofiSoft(g, cx, hz, Math.max(W, H) * 0.5, '#ff7a3d', 0.22);
      const bw = M * 0.07; let bx = -bw * 0.3, k = 0;
      while (bx < W) { const w = bw * (0.7 + lofiRnd(k, 2) * 0.8), h = M * (0.08 + lofiRnd(k, 1) * 0.24) * (1 - 0.5 * Math.min(1, Math.abs(bx + w / 2 - cx) / W) * 0); g.fillStyle = '#100f22'; g.fillRect(bx, hz - h, w, h + 2); for (let y = hz - h + M * 0.012; y < hz - M * 0.012; y += M * 0.022) for (let xx = bx + M * 0.008; xx < bx + w - M * 0.012; xx += M * 0.015) if (lofiRnd(Math.round(xx), Math.round(y)) > 0.62) { g.fillStyle = lofiRnd(k, 7) > 0.5 ? '#ffcd5e60' : '#b3d5dd50'; g.fillRect(xx, y, M * 0.005, M * 0.008); } bx += w + M * 0.006; k++; }
      gr = g.createLinearGradient(0, hz, 0, H); gr.addColorStop(0, '#15131f'); gr.addColorStop(1, '#0b0b12'); g.fillStyle = gr; g.fillRect(0, hz, W, H - hz);
      g.fillStyle = '#0d0d14'; g.beginPath(); g.moveTo(cx - M * 0.03, hz); g.lineTo(cx + M * 0.03, hz); g.lineTo(cx + Math.max(W, M * 1.4) * 0.75, H); g.lineTo(cx - Math.max(W, M * 1.4) * 0.75, H); g.fill();
      for (let q = 0; q < 14; q++) { const t = lofiRnd(q, 1); lofiSoft(g, cx + (lofiRnd(q, 2) - 0.5) * W * t * 1.2, hz + M * 0.02 + t * (H - hz) * 0.9, M * (0.04 + t * 0.1), ['#E10195', '#FFB000', '#25DD5F', '#5197A8'][q % 4], 0.1); }
    }), 0, 0);
    // the centre line flows towards you, glowing with the voice
    x.fillStyle = '#25DD5F'; x.shadowColor = '#25DD5F'; x.shadowBlur = M * 0.02 * (0.6 + e);
    for (let k = 0; k < 9; k++) { const t = (k / 9 + now * 0.05) % 1, y = hz + Math.pow(t, 2) * (H - hz) * 1.05, w = M * (0.003 + t * 0.03), h = M * (0.006 + t * 0.07); x.globalAlpha = Math.min(1, t * 6); x.fillRect(cx - w / 2, y, w, h); }
    x.globalAlpha = 1; const aw = M * (0.028 + e * 0.008); x.beginPath(); x.moveTo(cx, hz - aw * 1.3); x.lineTo(cx + aw, hz - aw * 0.1); x.lineTo(cx - aw, hz - aw * 0.1); x.closePath(); x.fill(); x.shadowBlur = 0;
    lofiSoft(x, cx, hz - aw * 0.5, M * 0.12, '#25DD5F', 0.15 + e * 0.25);
    // you, walking forward under a pink umbrella
    const us = M * 0.17, wy = H * 0.7, bob = Math.abs(Math.sin(now * 2.2)) * us * 0.04;
    lofiUmbrella(x, cx + M * 0.2, wy - us, us, '#E10195', bob);
    x.fillStyle = '#ffffff10'; x.fillRect(cx + M * 0.2 - us * 0.2, wy + us * 0.68, us * 0.4, us * 0.04);
    lofiRain(x, W, H, now, Math.round(80 * W / M), M * 0.03, '#c9d6ff38');
  },
  boat(x, W, H, M, e, now) { // 4. looking down at a calm puddle; a paper boat with the logo drifts as the rain lands
    x.drawImage(lofiLayer('boat', W, H, g => { const gr = g.createRadialGradient(W / 2, H / 2, M * 0.1, W / 2, H / 2, Math.max(W, H) * 0.8); gr.addColorStop(0, '#16324a'); gr.addColorStop(1, '#07111a'); g.fillStyle = gr; g.fillRect(0, 0, W, H); lofiSoft(g, W * 0.25, H * 0.2, M * 0.5, '#FFB000', 0.06); lofiSoft(g, W * 0.8, H * 0.8, M * 0.5, '#E10195', 0.05); }), 0, 0);
    // raindrops landing
    x.lineWidth = Math.max(1, M * 0.0022);
    for (let k = 0; k < 26; k++) { const per = 2.2 + lofiRnd(k, 4) * 2, c = Math.floor((now + k * 0.53) / per), p = ((now + k * 0.53) % per) / per, px = lofiRnd(k + c * 17, 5) * W, py = lofiRnd(k + c * 17, 6) * H; for (let j = 0; j < 3; j++) { const q = p - j * 0.12; if (q <= 0) continue; const r = M * q * 0.09; x.strokeStyle = `rgba(200,225,255,${0.3 * (1 - q) * (1 - j * 0.3)})`; x.beginPath(); x.ellipse(px, py, r, r * 0.92, 0, 0, 7); x.stroke(); } }
    // the boat drifts slowly in a loop
    const bx = W / 2 + Math.sin(now * 0.07) * W * 0.12, by = H * 0.46 + Math.sin(now * 0.11) * H * 0.06, rot = Math.sin(now * 0.07 + 1.2) * 0.25, s = M * 0.0014;
    // green rings pulse out from the boat with the voice
    for (let j = 0; j < 4; j++) { const p = (now * 0.25 + j / 4) % 1, r = M * (0.14 + p * 0.3); x.strokeStyle = `rgba(37,221,95,${(1 - p) * (0.12 + e * 0.45)})`; x.lineWidth = M * 0.004; x.beginPath(); x.ellipse(bx, by + 30 * s, r, r * 0.55, rot, 0, 7); x.stroke(); }
    x.save(); x.translate(bx, by); x.rotate(rot + Math.sin(now * 1.3) * 0.02); x.scale(s, s);
    x.fillStyle = '#00000045'; x.beginPath(); x.ellipse(10, 75, 165, 30, 0, 0, 7); x.fill();
    x.fillStyle = '#f3efe4'; x.beginPath(); x.moveTo(-150, 0); x.lineTo(150, 0); x.lineTo(100, 60); x.lineTo(-100, 60); x.closePath(); x.fill();
    x.fillStyle = '#e2dac7'; x.beginPath(); x.moveTo(-90, 0); x.lineTo(0, -150); x.lineTo(90, 0); x.closePath(); x.fill();
    x.fillStyle = '#fffaf0'; x.beginPath(); x.moveTo(0, -150); x.lineTo(40, 0); x.lineTo(-10, 0); x.closePath(); x.fill();
    x.strokeStyle = '#00000018'; x.lineWidth = 2; x.beginPath(); x.moveTo(-150, 0); x.lineTo(150, 0); x.stroke();
    const ink = lofiInk(); if (ink) { const lw = 180, lh = lw * ink.height / ink.width; x.globalAlpha = 0.85; x.drawImage(ink, -lw / 2, 30 - lh / 2, lw, lh); x.globalAlpha = 1; } // the logo, printed on the paper
    x.restore();
  },
};
