# MemoPad · Did you get the message?

Voice memo affirmations by Progress Today: a colourful waveform, chapters, a live transcript, search, and a built-in converter and compressor.

- **Front end:** Vite + vanilla JS (`index.html`, `src/`), hosted on Vercel.
- **Back end:** the existing Progress Pad Supabase project. MemoPad only adds `memopad_` objects and the private `memopad-audio` bucket (see `supabase/`).
- **Login:** Supabase Auth from the same project (email and password, or Google), so a Progress Pad account works here.
- **Audio:** compressed on the device (lamejs MP3 encoder in a Web Worker, Standard preset by default), uploaded to `memopad-audio/{user_id}/{memo_id}.mp3`, and played through signed URLs. IndexedDB keeps an offline copy.

## Environment variables

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://hiwgaywnfxzeptflxrsi.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the project's anon (public) key |

Never put the service-role key in this app.

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in the anon key
npm run dev
```

## Free plan limits

1 GB storage in total, 50 MB per file, 500 MB database. MemoPad refuses files over 50 MB after compression and warns in settings once storage passes 70%.

## Credits

MP3 encoding: [lamejs](https://github.com/zhuker/lamejs) 1.2.1 (LGPL-3.0), served unmodified as `public/lame.js`. Transcription: Whisper via [transformers.js](https://github.com/huggingface/transformers.js), downloaded on first use.
