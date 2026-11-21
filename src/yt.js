// YouTube helpers shared by Reader and Play over music. YouTube plays in its official embedded player.
// Preset ids checked by playing each one on 2026-11-21 (live radios get new ids when a stream restarts; if one ends, Reader skips to the next) (all exist and allow embedding). If one ever ends, the player shows an error and you can paste another link.
export const BEATS = [
  { art: 'lofi-hiphop', name: 'Lofi hip hop', sub: 'beats to relax/study', cls: 'm-lofi', url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A' },
  { art: 'sleepy', name: 'Sleepy lofi', sub: 'music to sleep/dream', cls: 'm-calm', url: 'https://www.youtube.com/watch?v=VAlMDl00mYY' },
  { art: 'chillhop', name: 'Chillhop', sub: 'warm and jazzy', cls: 'm-chill', url: 'https://www.youtube.com/watch?v=5yx6BWlEVcY' },
  { art: 'jazz', name: 'Jazz lofi', sub: 'beats to chill to', cls: 'm-bright', url: 'https://www.youtube.com/watch?v=E2vONfzoyRI' },
  { art: 'rainy-lofi', name: 'Sad lofi', sub: 'beats for rainy days', cls: 'm-synth', url: 'https://www.youtube.com/watch?v=CwPCy1GLS38' },
  { art: 'synthwave', name: 'Synthwave', sub: 'dreamy, retro', cls: 'm-synth', url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY' },
  { art: 'night', name: '1 A.M study', sub: 'late-night lofi, 1 hour', cls: 'm-bright', url: 'https://www.youtube.com/watch?v=lTRiuFIWV54' },
];
export function parseYt(s) {
  try {
    const u = new URL(s.trim()); const list = u.searchParams.get('list');
    let id = u.searchParams.get('v');
    if (!id && /youtu\.be$/.test(u.hostname)) id = u.pathname.slice(1);
    if (!id) { const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/); if (m) id = m[1]; }
    return id || list ? { id, list } : null;
  } catch { return /^[\w-]{11}$/.test(s.trim()) ? { id: s.trim() } : null; }
}
let api = null;
export const loadYtApi = () => (api ||= new Promise((res, rej) => {
  if (window.YT?.Player) return res(window.YT);
  window.onYouTubeIframeAPIReady = () => res(window.YT);
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { api = null; rej(); }; document.head.appendChild(s);
  setTimeout(() => { if (!window.YT?.Player) { api = null; rej(); } }, 15000);
}));
export const beatTiles = () => BEATS.map(b => `<button class="${b.cls}" data-yt="${b.url}" data-art="${b.art || 'lofi-hiphop'}"><i class="cv"></i><b>${b.name}</b><small>${b.sub}</small></button>`).join('');
