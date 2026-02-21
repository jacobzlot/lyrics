require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. AUTOCOMPLETE — search Genius for songs (includes album thumbnail)
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const response = await axios.get('https://api.genius.com/search', {
      params: { q },
      headers: { Authorization: `Bearer ${process.env.GENIUS_TOKEN}` }
    });

    const hits = response.data.response.hits.slice(0, 8).map(hit => ({
      id: hit.result.id,
      title: hit.result.title,
      artist: hit.result.primary_artist.name,
      artistSlug: hit.result.primary_artist.name,
      titleSlug: hit.result.title,
      thumbnail: hit.result.song_art_image_thumbnail_url || hit.result.header_image_thumbnail_url || null
    }));

    res.json(hits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// 2. FETCH LYRICS — Genius scrape with full browser headers, fallback to lrclib
app.get('/api/lyrics', async (req, res) => {
  const { artist, title } = req.query;

  // First try Genius scrape
  try {
    const searchRes = await axios.get('https://api.genius.com/search', {
      params: { q: `${title} ${artist}` },
      headers: { Authorization: `Bearer ${process.env.GENIUS_TOKEN}` }
    });

    const hit = searchRes.data.response.hits[0];
    if (!hit) throw new Error('No hit found');

    const songUrl = hit.result.url;

    const pageRes = await axios.get(songUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000
    });

    const $ = cheerio.load(pageRes.data);
    let lyrics = '';

    $('[data-lyrics-container="true"]').each((i, el) => {
      $(el).find('br').replaceWith('\n');
      lyrics += $(el).text() + '\n';
    });

    if (lyrics.trim()) {
      return res.json({ lyrics: lyrics.trim() });
    }

    // Genius returned page but no lyrics container — fall through to fallback
    throw new Error('No lyrics container found');

  } catch (geniusErr) {
    console.error('Genius scrape failed:', geniusErr.message);

    // Fallback: lrclib.net
    try {
      const lrclibRes = await axios.get('https://lrclib.net/api/get', {
        params: { artist_name: artist, track_name: title },
        timeout: 8000
      });

      const lyrics = lrclibRes.data.plainLyrics || lrclibRes.data.syncedLyrics;
      if (lyrics) return res.json({ lyrics });

      throw new Error('No lyrics in lrclib response');

    } catch (lrclibErr) {
      console.error('lrclib fallback failed:', lrclibErr.message);

      // Final fallback: lyrics.ovh
      try {
        const ovhRes = await axios.get(
          `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
          { timeout: 8000 }
        );
        if (ovhRes.data.lyrics) return res.json({ lyrics: ovhRes.data.lyrics });
      } catch (ovhErr) {
        console.error('lyrics.ovh fallback failed:', ovhErr.message);
      }

      res.status(404).json({ error: 'Lyrics not found. Try searching for the song with a slightly different title.' });
    }
  }
});

// 3. DETECT + TRANSLATE — single GPT call
app.post('/api/translate', async (req, res) => {
  const { lyrics, targetLanguage } = req.body;

  if (!lyrics || !targetLanguage) {
    return res.status(400).json({ error: 'Missing lyrics or target language' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a professional song translator.
Your task:
1. Detect the source language of the lyrics.
2. Translate each line into ${targetLanguage}, preserving the poetic feel and meaning.
3. Return ONLY valid JSON in this exact format, nothing else:
{
  "sourceLanguage": "detected language name",
  "lines": [
    { "original": "original line", "translated": "translated line" },
    ...
  ]
}
For blank lines between verses, use: { "original": "", "translated": "" }`
        },
        {
          role: 'user',
          content: `Translate these lyrics:\n\n${lyrics}`
        }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(completion.choices[0].message.content);

    // Safety: GPT sometimes wraps the array under a different key
    if (!result.lines || !Array.isArray(result.lines)) {
      const key = Object.keys(result).find(k => Array.isArray(result[k]));
      result.lines = key ? result[key] : [];
    }

    if (!result.sourceLanguage) result.sourceLanguage = 'Unknown';

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Translation failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));