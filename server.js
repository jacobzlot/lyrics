require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. AUTOCOMPLETE — search Genius for songs
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
            // Store artist+title for lyrics.ovh lookup
            artistSlug: hit.result.primary_artist.name,
            titleSlug: hit.result.title
        }));

        res.json(hits);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// 2. FETCH LYRICS — using lyrics.ovh
app.get('/api/lyrics', async (req, res) => {
    const { artist, title } = req.query;

    try {
        const response = await axios.get(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
        );

        const lyrics = response.data.lyrics;
        if (!lyrics) return res.status(404).json({ error: 'Lyrics not found' });

        res.json({ lyrics });
    } catch (err) {
        res.status(404).json({ error: 'Lyrics not found for this song' });
    }
});

// 3. DETECT + TRANSLATE — single GPT call
app.post('/api/translate', async (req, res) => {
    const { lyrics, targetLanguage } = req.body;

    if (!lyrics || !targetLanguage) {
        return res.status(400).json({ error: 'Missing lyrics or target language' });
    }

    // Split into lines and filter blanks for cleaner processing
    const lines = lyrics.split('\n');

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional song translator. 
Your task:
1. First, detect the source language of the lyrics.
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
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Translation failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));