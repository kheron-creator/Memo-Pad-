// Voices offered in MemoPad Create. ElevenLabs ids and preview links come from the ElevenLabs voice library;
// previews are ElevenLabs' own sample clips, so playing them costs no credits.
export const VOICES = [
  { id: 'el:JBFqnCBsd6RMkjVDRZzb', name: 'George', desc: 'Warm storyteller', tags: ['el', 'british', 'male'], c: ['#25DD5F', '#0E7C3A'], preview: 'https://api.us.elevenlabs.io/v1/voices/JBFqnCBsd6RMkjVDRZzb/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiJlNjIwNmQxYS0wNzIxLTQ3ODctYWFmYi0wNmE2ZTcwNWNhYzUubXAzIiwidGltZXN0YW1wIjoxNzk0MDIwNDAwMDAwMDAwfQ%3D%3D' },
  { id: 'el:Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', desc: 'Clear and friendly', tags: ['el', 'british', 'female'], c: ['#E10195', '#EB7100'], preview: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3' },
  { id: 'el:EXAVITQu4vr4xnSDxMaL', name: 'Sarah', desc: 'Reassuring, confident', tags: ['el', 'american', 'female'], c: ['#FFB000', '#EB7100'], preview: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3' },
  { id: 'el:nPczCjzI2devNBz1zQrb', name: 'Brian', desc: 'Deep and comforting', tags: ['el', 'american', 'male'], c: ['#5AA9FF', '#3B3BD9'], preview: 'https://api.us.elevenlabs.io/v1/voices/nPczCjzI2devNBz1zQrb/previews/audio?payload=eyJ2b2ljZV9zb3VyY2UiOiJwcmVtYWRlIiwiZmlsZW5hbWUiOiIyZGQzZTcyYy00ZmQzLTQyZjEtOTNlYS1hYmM1ZDRlNWFhMWQubXAzIiwidGltZXN0YW1wIjoxNzk0MDIwNDAwMDAwMDAwfQ%3D%3D' },
  { id: 'el:SAz9YHcvj6GT2YYXdXww', name: 'River', desc: 'Calm and relaxed', tags: ['el', 'american'], c: ['#2DD4BF', '#5AA9FF'], preview: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3' },
  { id: 'el:bIHbv24MWmeRgasZH58o', name: 'Will', desc: 'Relaxed optimist', tags: ['el', 'american', 'male'], c: ['#A855F7', '#E10195'], preview: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/8caf8f3d-ad29-4980-af41-53f20c72d7a4.mp3' },
  { id: 'en_GB-cori-high', name: 'Cori', desc: 'Free · on this device', tags: ['free', 'british', 'female'], c: ['#8e8e93', '#E10195'] },
  { id: 'en_GB-alba-medium', name: 'Alba', desc: 'Free · Scottish', tags: ['free', 'british', 'female'], c: ['#8e8e93', '#25DD5F'] },
  { id: 'en_GB-northern_english_male-medium', name: 'North', desc: 'Free · Northern English', tags: ['free', 'british', 'male'], c: ['#8e8e93', '#FFB000'] },
  { id: 'en_US-ryan-high', name: 'Ryan', desc: 'Free · American', tags: ['free', 'american', 'male'], c: ['#8e8e93', '#5AA9FF'] },
];
export const orb = v => `radial-gradient(circle at 30% 28%, #fff9 0, transparent 34%), conic-gradient(from 200deg, ${v.c[0]}, ${v.c[1]}, ${v.c[0]})`;
