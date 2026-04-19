const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_KEY;
const CLAUDE_KEY = process.env.REACT_APP_CLAUDE_KEY;

// Test
app.get('/test', (req, res) => {
  res.json({
    ok: true,
    google: !!GOOGLE_KEY,
    claude: !!CLAUDE_KEY,
    google_start: GOOGLE_KEY?.slice(0, 10),
    claude_start: CLAUDE_KEY?.slice(0, 15),
  });
});

// Google Places søk
app.get('/places/search', async (req, res) => {
  try {
    const { query } = req.query;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=no&key=${GOOGLE_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    console.error('Google search feil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Google Places detaljer
app.get('/places/details', async (req, res) => {
  try {
    const { place_id } = req.query;
    const fields = 'name,formatted_address,formatted_phone_number,website,opening_hours,geometry,types,rating,user_ratings_total,photos';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&language=no&key=${GOOGLE_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    console.error('Google details feil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hent nettside-innhold
app.get('/fetch-website', async (req, res) => {
  try {
    const { url } = req.query;
    console.log('Henter:', url);
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'no,nb;q=0.9,en;q=0.8',
      }
    });
    const text = response.data
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
    console.log('Hentet', text.length, 'tegn fra', url);
    res.json({ text });
  } catch (err) {
    console.error('Website fetch feil:', url, err.message);
    res.status(500).json({ error: err.message, text: null });
  }
});

// Claude AI event-scraping
app.post('/claude/scrape-events', async (req, res) => {
  try {
    const { venue, content } = req.body;
    console.log('Claude analyserer:', venue.name, '– innhold lengde:', content?.length);

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Du er en AI-agent for NattBergen-appen i Bergen, Norge. Dagens dato er 11. april 2026.

Analyser dette innholdet fra "${venue.name}" og ekstraher KOMMENDE eventer (kun fremtidige datoer etter 11. april 2026).

INNHOLD:
${content}

Returner KUN en gyldig JSON-array. Ingen forklaring, ingen markdown, bare JSON:
[
  {
    "id": "${venue.place_id}_1",
    "venue_id": "${venue.place_id}",
    "title": "Navn på artist eller kamp",
    "date": "12. apr",
    "time": "23:00",
    "type": "live_music",
    "league": null
  }
]

Gyldige typer: football, live_music, quiz, games, happy_hour, nightclub
League fylles kun ut for fotball (f.eks. "PREMIER LEAGUE", "ELITESERIEN").
Hvis ingen kommende eventer finnes, returner: []`
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01',
        }
      }
    );

    const raw = response.data.content?.map(c => c.text || '').join('') || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();

    // Sikker JSON-parsing
    let events = [];
    try {
      const parsed = JSON.parse(clean);
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      console.log('Direkte parse feilet, prøver å finne array...');
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        try { events = JSON.parse(match[0]); } catch { events = []; }
      }
    }

    // Sikre gyldige IDer og venue_id
    events = events.map((e, i) => ({
      ...e,
      id: `${venue.place_id}_${Date.now()}_${i}`,
      venue_id: venue.place_id,
      league: e.league || null,
    }));

    console.log(`✓ ${venue.name}: ${events.length} eventer funnet`);
    res.json({ events });

  } catch (err) {
    console.error('Claude feil status:', err.response?.status);
    console.error('Claude feil:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({
      error: err.response?.data || err.message,
      events: []
    });
  }
});

// Google Places bilder
app.get('/places/photo', async (req, res) => {
  try {
    const { photo_reference, maxwidth = 800 } = req.query;
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${photo_reference}&key=${GOOGLE_KEY}`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type']);
    res.send(response.data);
  } catch (err) {
    console.error('Photo feil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Intelligent crawler – følger lenker automatisk
app.get('/crawl-venue', async (req, res) => {
  try {
    const { url } = req.query;
    const baseUrl = new URL(url).origin;
    
    const eventKeywords = [
      'event', 'program', 'musikk', 'sport', 'kamp', 'quiz',
      'hva-skjer', 'kalender', 'konsert', 'live', 'aktivitet',
      'arrangement', 'forestilling', 'scene', 'turnering',
      'billetter', 'agenda', 'schedule', 'what', 'happening',
      'fotball', 'football', 'kvelds', 'weekend', 'helg'
    ];

    // Hent hovedside
    console.log(`Crawler starter: ${url}`);
    const mainRes = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)' }
    });

    const html = mainRes.data;

    // Strip og lagre hovedside-tekst
    const mainText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    // Finn alle interne lenker
    const linkRegex = /href=["']([^"'#?]+)["']/g;
    const foundLinks = new Set();
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      if (!href || href.length < 2) continue;

      let fullUrl;
      if (href.startsWith('http')) {
        // Kun interne lenker
        if (!href.startsWith(baseUrl)) continue;
        fullUrl = href;
      } else if (href.startsWith('/')) {
        fullUrl = baseUrl + href;
      } else {
        continue;
      }

      // Fjern trailing slash og anchors
      fullUrl = fullUrl.split('#')[0].replace(/\/$/, '');
      if (fullUrl === url.replace(/\/$/, '')) continue;

      // Sjekk om URL inneholder event-keywords
      const urlLower = fullUrl.toLowerCase();
      if (eventKeywords.some(kw => urlLower.includes(kw))) {
        foundLinks.add(fullUrl);
      }
    }

    console.log(`  Fant ${foundLinks.size} relevante undersider`);

    // Besøk topp 5 undersider
    let allText = `--- HOVEDSIDE: ${url} ---\n${mainText}`;
    const subUrls = Array.from(foundLinks).slice(0, 5);

    for (const subUrl of subUrls) {
      try {
        console.log(`  Besøker: ${subUrl}`);
        const subRes = await axios.get(subUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)' }
        });
        const subText = subRes.data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000);
        
        if (subText.length > 100) {
          allText += `\n\n--- UNDERSIDE: ${subUrl} ---\n${subText}`;
          console.log(`  ✓ ${subUrl.split('/').pop()}: ${subText.length} tegn`);
        }
      } catch (err) {
        console.log(`  ✗ ${subUrl}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ 
      text: allText.slice(0, 8000), 
      links: subUrls,
      mainLength: mainText.length 
    });

  } catch (err) {
    console.error('Crawl feil:', err.message);
    res.status(500).json({ error: err.message, text: null });
  }
});

app.listen(3001, () => {
  console.log('✅ NattBergen proxy kjører på port 3001');
  console.log('   Google API:', GOOGLE_KEY ? '✓' : '✗ MANGLER');
  console.log('   Claude API:', CLAUDE_KEY ? '✓' : '✗ MANGLER');
});