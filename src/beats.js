// MemoPad's own beats, made with Suno (Progress Today Pro plan, so they can be used in the app).
// They are plain audio files, so they loop, keep playing when you leave the app, and the Beat slider works on phones.
const BASE = 'https://hiwgaywnfxzeptflxrsi.supabase.co/storage/v1/object/public/memopad-beats/';
export const MP_BEATS = [
  { name: 'Lofi hip-hop', sub: 'chill boom bap', cls: 'm-lofi', file: 'lofi-hiphop.mp3' },
  { name: 'Calm piano', sub: 'soft and gentle', cls: 'm-calm', file: 'calm-piano.mp3' },
  { name: 'Atmospheric', sub: 'airy, ambient', cls: 'm-synth', file: 'atmospheric.mp3' },
  { name: 'Emotional', sub: 'strings and piano', cls: 'm-chill', file: 'emotional.mp3' },
  { name: 'Soulful', sub: 'warm neo soul', cls: 'm-bright', file: 'soulful.mp3' },
  { name: 'Rainy lofi', sub: 'rain and guitar', cls: 'm-ai', file: 'rainy-lofi.mp3' },
].map(b => ({ ...b, url: BASE + b.file }));
export const mpTiles = () => MP_BEATS.map(b => `<button class="${b.cls}" data-beat="${b.url}"><b>${b.name}</b><small>${b.sub}</small></button>`).join('');
