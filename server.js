require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const cors = require('cors');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── PostgreSQL ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id         SERIAL PRIMARY KEY,
      artist     TEXT NOT NULL,
      title      TEXT NOT NULL,
      lyrics     TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(artist, title)
    );
    CREATE TABLE IF NOT EXISTS translations (
      id          SERIAL PRIMARY KEY,
      song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      language    TEXT NOT NULL,
      source_lang TEXT,
      lines       JSONB,
      created_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE(song_id, language)
    );
    CREATE TABLE IF NOT EXISTS translation_log (
      id         SERIAL PRIMARY KEY,
      song_id    INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      language   TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tlog_date ON translation_log (created_at, song_id);
  `);
  console.log('DB ready');
})().catch(console.error);

// ── Apple Music helpers ────────────────────────────────────────────────────────

// Recursively walk any JSON object and collect anything that looks like a track
function deepFindTracks(obj, found, depth) {
  found = found || [];
  depth = depth || 0;
  if (depth > 12 || !obj || typeof obj !== 'object') return found;

  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      var item = obj[i];
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        var title = item.title || item.name || (item.attributes && item.attributes.name);
        var artist = item.artistName || (item.attributes && item.attributes.artistName)
          || (item.artist && item.artist.name) || item.subtitle;
        if (title && artist && typeof title === 'string' && typeof artist === 'string'
          && title.length > 0 && artist.length > 0) {
          var artworkUrl = (item.artwork && item.artwork.url)
            || (item.attributes && item.attributes.artwork && item.attributes.artwork.url)
            || item.imageUrl
            || null;
          if (artworkUrl) {
            artworkUrl = artworkUrl
              .replace('{w}', '60').replace('{h}', '60')
              .replace('{f}', 'jpg').replace('{c}', 'sr');
          }
          found.push({ title: title, artist: artist, thumbnail: artworkUrl });
          continue;
        }
      }
      deepFindTracks(item, found, depth + 1);
    }
  } else {
    var vals = Object.values(obj);
    for (var j = 0; j < vals.length; j++) {
      deepFindTracks(vals[j], found, depth + 1);
    }
  }
  return found;
}

function dedupe(tracks) {
  var seen = {};
  return tracks.filter(function (t) {
    var key = (t.title + '||' + t.artist).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// ── 1. Search autocomplete ─────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const r = await axios.get('https://api.genius.com/search', {
      params: { q },
      headers: { Authorization: `Bearer ${process.env.GENIUS_TOKEN}` }
    });
    res.json(r.data.response.hits.slice(0, 8).map(h => ({
      id: h.result.id,
      title: h.result.title,
      artist: h.result.primary_artist.name,
      artistSlug: h.result.primary_artist.name,
      titleSlug: h.result.title,
      thumbnail: h.result.song_art_image_thumbnail_url || h.result.header_image_thumbnail_url || null
    })));
  } catch (e) {
    console.error('Search failed:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── 2. Fetch lyrics (DB cache → Genius → lrclib → lyrics.ovh) ─────────────────
app.get('/api/lyrics', async (req, res) => {
  const { artist, title } = req.query;
  if (!artist || !title) return res.status(400).json({ error: 'Missing artist or title' });

  try {
    const cached = await pool.query(
      'SELECT lyrics FROM songs WHERE artist=$1 AND title=$2', [artist, title]
    );
    if (cached.rows[0] && cached.rows[0].lyrics) {
      return res.json({ lyrics: cached.rows[0].lyrics, fromCache: true });
    }
  } catch (e) { console.error('DB read error:', e.message); }

  let lyrics = null;
  let geniusUrl = null;

  try {
    const s = await axios.get('https://api.genius.com/search', {
      params: { q: `${title} ${artist}` },
      headers: { Authorization: `Bearer ${process.env.GENIUS_TOKEN}` }
    });
    const hit = s.data.response.hits[0];
    if (hit) {
      geniusUrl = hit.result.url;
      const p = await axios.get(hit.result.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/'
        },
        timeout: 10000
      });
      const $ = cheerio.load(p.data);
      let raw = '';
      $('[data-lyrics-container="true"]').each((_, el) => {
        $(el).find('br').replaceWith('\n');
        raw += $(el).text() + '\n';
      });
      if (raw.trim()) lyrics = raw.trim();
    }
  } catch (e) { console.error('Genius failed:', e.message); }

  if (!lyrics) {
    try {
      const r = await axios.get('https://lrclib.net/api/get', {
        params: { artist_name: artist, track_name: title }, timeout: 8000
      });
      lyrics = r.data.plainLyrics || r.data.syncedLyrics || null;
    } catch (e) { console.error('lrclib failed:', e.message); }
  }

  if (!lyrics) {
    try {
      const r = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { timeout: 8000 }
      );
      lyrics = r.data.lyrics || null;
    } catch (e) { console.error('lyrics.ovh failed:', e.message); }
  }

  if (!lyrics) {
    return res.status(404).json({ error: 'Lyrics not found. Try searching with a slightly different title.' });
  }

  try {
    await pool.query(
      `INSERT INTO songs (artist, title, lyrics) VALUES ($1,$2,$3)
       ON CONFLICT (artist,title) DO UPDATE SET lyrics=$3`,
      [artist, title, lyrics]
    );
  } catch (e) { console.error('DB write error:', e.message); }

  res.json({ lyrics, geniusUrl });
});

// ── 3. Translate (DB cache → GPT-4o) ──────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { lyrics, targetLanguage, artist, title } = req.body;
  if (!lyrics || !targetLanguage) {
    return res.status(400).json({ error: 'Missing lyrics or target language' });
  }

  let songId = null;
  try {
    const row = await pool.query(
      'SELECT id FROM songs WHERE artist=$1 AND title=$2', [artist || '', title || '']
    );
    songId = row.rows[0] ? row.rows[0].id : null;
  } catch (e) { console.error('DB song lookup error:', e.message); }

  if (songId) {
    try {
      const cached = await pool.query(
        'SELECT source_lang, lines FROM translations WHERE song_id=$1 AND language=$2',
        [songId, targetLanguage]
      );
      if (cached.rows[0] && cached.rows[0].lines) {
        pool.query(
          'INSERT INTO translation_log (song_id, language) VALUES ($1, $2)',
          [songId, targetLanguage]
        ).catch(() => { });

        return res.json({
          sourceLanguage: cached.rows[0].source_lang,
          lines: cached.rows[0].lines,
          fromCache: true
        });
      }
    } catch (e) { console.error('DB translation lookup error:', e.message); }
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a professional song translator.
1. Detect the source language of the lyrics.
2. Translate each line into ${targetLanguage}, preserving the poetic feel and meaning.
3. Return ONLY valid JSON in this exact format, nothing else:
{
  "sourceLanguage": "detected language name",
  "lines": [
    { "original": "original line", "translated": "translated line" }
  ]
}
For blank lines between verses, use: { "original": "", "translated": "" }`
        },
        { role: 'user', content: `Translate these lyrics:\n\n${lyrics}` }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(completion.choices[0].message.content);
    if (!Array.isArray(result.lines)) {
      const key = Object.keys(result).find(k => Array.isArray(result[k]));
      result.lines = key ? result[key] : [];
    }
    if (!result.sourceLanguage) result.sourceLanguage = 'Unknown';

    if (songId) {
      try {
        await pool.query(
          `INSERT INTO translations (song_id, language, source_lang, lines) VALUES ($1,$2,$3,$4)
           ON CONFLICT (song_id, language) DO UPDATE SET lines=$4, source_lang=$3`,
          [songId, targetLanguage, result.sourceLanguage, JSON.stringify(result.lines)]
        );
      } catch (e) { console.error('DB translation save error:', e.message); }
    }

    // Log every translation request for featured/trending
    if (songId) {
      pool.query(
        'INSERT INTO translation_log (song_id, language) VALUES ($1, $2)',
        [songId, targetLanguage]
      ).catch(() => { });
    }

    res.json(result);
  } catch (e) {
    console.error('GPT error:', e.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

// ── 4. Spotify playlist — scrapes public embed (no API key needed) ─────────────
app.get('/api/playlist/spotify', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });
  const id = match[1];

  try {
    const r = await axios.get(`https://open.spotify.com/embed/playlist/${id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    });

    const $ = cheerio.load(r.data);
    const raw = $('#__NEXT_DATA__').text();
    if (!raw) return res.status(422).json({ error: 'Could not read Spotify embed data. Make sure the playlist is public.' });

    const json = JSON.parse(raw);
    const items = json &&
      json.props &&
      json.props.pageProps &&
      json.props.pageProps.state &&
      json.props.pageProps.state.data &&
      json.props.pageProps.state.data.entity &&
      json.props.pageProps.state.data.entity.trackList || [];

    if (!items.length) {
      return res.status(422).json({ error: 'No tracks found. Make sure the playlist is set to public.' });
    }

    res.json({
      tracks: items.map(t => ({
        title: t.title,
        artist: t.subtitle,
        thumbnail: t.imageUrl || null
      }))
    });
  } catch (e) {
    console.error('Spotify embed scrape failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch Spotify playlist.' });
  }
});

// ── 5. Apple Music playlist — deep search parser ───────────────────────────────
app.get('/api/playlist/apple', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    });

    const $ = cheerio.load(r.data);
    const rawData = $('script#serialized-server-data').text();

    if (!rawData) {
      return res.status(422).json({ error: 'Could not find Apple Music data. Make sure the playlist is public.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch (e) {
      return res.status(422).json({ error: 'Failed to parse Apple Music page data.' });
    }

    const tracks = dedupe(deepFindTracks(parsed));

    if (!tracks.length) {
      return res.status(422).json({
        error: 'No tracks found. Make sure the playlist is public and the link contains "pl." in the URL.'
      });
    }

    res.json({ tracks });
  } catch (e) {
    console.error('Apple Music scrape failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch Apple Music playlist.' });
  }
});

// ── DEBUG: inspect Apple Music page structure ──────────────────────────────────
app.get('/api/playlist/apple/debug', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    });
    const $ = cheerio.load(r.data);
    const rawData = $('script#serialized-server-data').text();
    if (!rawData) return res.json({ error: 'No serialized-server-data found' });
    const parsed = JSON.parse(rawData);
    const tracks = dedupe(deepFindTracks(parsed));
    res.json({ tracksFound: tracks.length, sampleTracks: tracks.slice(0, 5), fullData: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 6. YouTube video search ───────────────────────────────────────────────────
app.get('/api/youtube', async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Missing title or artist' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('YouTube: YOUTUBE_API_KEY not set');
    return res.status(503).json({ error: 'YouTube not configured' });
  }

  const query = `${title} ${artist} official`;

  try {
    const r = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        maxResults: 1,
        key: apiKey
      },
      timeout: 8000
    });

    const videoId = r.data?.items?.[0]?.id?.videoId;
    if (!videoId) {
      console.warn(`YouTube: no results for "${query}"`);
      return res.status(404).json({ error: 'No video found' });
    }

    res.json({ videoId });
  } catch (e) {
    const status = e.response?.status;
    const ytError = e.response?.data?.error?.message || e.message;
    console.error(`YouTube API error (HTTP ${status}):`, ytError);

    if (status === 403) {
      return res.status(403).json({ error: 'YouTube quota exceeded or API key invalid' });
    }
    res.status(500).json({ error: 'YouTube search failed' });
  }
});

// ── 7. Featured today — top 3 most translated songs today ────────────────────
app.get('/api/featured', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.title, s.artist,
             COUNT(l.id) AS requests
      FROM translation_log l
      JOIN songs s ON s.id = l.song_id
      WHERE l.created_at >= CURRENT_DATE
      GROUP BY s.id, s.title, s.artist
      ORDER BY requests DESC
      LIMIT 3
    `);
    res.json({ songs: result.rows });
  } catch (e) {
    console.error('Featured query error:', e.message);
    res.json({ songs: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Lyra running on port ' + PORT));