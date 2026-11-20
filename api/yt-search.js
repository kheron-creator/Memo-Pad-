// YouTube search for MemoPad's beat picker. Uses the YouTube Data API (free quota) with the Vercel
// environment variable YOUTUBE_API_KEY, so the key never reaches the browser. Only embeddable videos and playlists.
export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  const from = req.headers.origin || req.headers.referer || '';
  let fromHost = ''; try { fromHost = new URL(from).host; } catch {}
  if (!fromHost || fromHost !== req.headers.host) return res.status(403).json({ error: 'origin' });
  const q = String(req.query?.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'q' });
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  Object.entries({ part: 'snippet', q, type: 'video', videoEmbeddable: 'true', maxResults: '12', safeSearch: 'moderate', key }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  if (!r.ok) return res.status(502).json({ error: 'youtube', status: r.status });
  const d = await r.json();
  const items = (d.items || []).filter(x => x.id?.videoId).map(x => ({
    id: x.id.videoId, title: x.snippet.title, channel: x.snippet.channelTitle,
    thumb: x.snippet.thumbnails?.medium?.url || x.snippet.thumbnails?.default?.url || '', live: x.snippet.liveBroadcastContent === 'live',
  }));
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.status(200).json({ items });
}
