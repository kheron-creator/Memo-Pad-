// MemoPad's own beats, made with Suno (Progress Today Pro plan, so they can be used in the app).
// They are plain audio files, so they loop, keep playing when you leave the app, and the Beat slider works on phones.
const BASE = '/beats/';
const MOODS = [
  ['Lofi hip-hop', 'chill boom bap', 'm-lofi', 'lofi-hiphop'],
  ['Calm piano', 'soft and gentle', 'm-calm', 'calm-piano'],
  ['Atmospheric', 'airy, ambient', 'm-synth', 'atmospheric'],
  ['Emotional', 'strings and piano', 'm-chill', 'emotional'],
  ['Soulful', 'warm neo soul', 'm-bright', 'soulful'],
  ['Rainy lofi', 'rain and guitar', 'm-ai', 'rainy-lofi'],
];
// Suno made two takes of each mood, so there are 12 beats.
export const MP_BEATS = MOODS.flatMap(([name, sub, cls, f]) => [1, 2].map(n => ({ name: `${name} ${n}`, sub, cls, url: `${BASE}${f}${n === 2 ? '-2' : ''}.mp3` })));
export const mpTiles = () => MP_BEATS.map(b => `<button class="${b.cls}" data-beat="${b.url}"><b>${b.name}</b><small>${b.sub}</small></button>`).join('');
