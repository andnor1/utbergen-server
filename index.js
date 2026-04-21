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

app.get('/crawl-venue', async (req, res) => {
  try {
    const { url } = req.query;
    const baseUrl = new URL(url).origin;
    
    const eventKeywords = [
      'event', 'program', 'musikk', 'sport', 'kamp', 'quiz',
      'hva-skjer', 'kalender', 'konsert', 'live', 'aktivitet',
      'arrangement', 'forestilling', 'scene', 'turnering',
      'billetter', 'agenda', 'fotball', 'football', 'helg'
    ];

    const fetchText = async (fetchUrl) => {
      const response = await axios.get(fetchUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)' }
      });
      return response.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2500);
    };

    // Hent hovedside
    console.log(`Crawler starter: ${url}`);
    const mainHtml = (await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)' }
    })).data;

    const mainText = mainHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);

    // Finn relevante undersider
    const linkRegex = /href=["']([^"'#?]+)["']/g;
    const foundLinks = new Set();
    let match;

    while ((match = linkRegex.exec(mainHtml)) !== null) {
      const href = match[1];
      if (!href || href.length < 2) continue;

      let fullUrl;
      if (href.startsWith('http')) {
        if (!href.startsWith(baseUrl)) continue;
        fullUrl = href;
      } else if (href.startsWith('/')) {
        fullUrl = baseUrl + href;
      } else {
        continue;
      }

      fullUrl = fullUrl.split('#')[0].replace(/\/$/, '');
      if (fullUrl === url.replace(/\/$/, '')) continue;

      const urlLower = fullUrl.toLowerCase();
      if (eventKeywords.some(kw => urlLower.includes(kw))) {
        foundLinks.add(fullUrl);
      }
    }

    console.log(`  Fant ${foundLinks.size} relevante undersider`);

    // Bygg opp samlet tekst fra alle sider
    let allText = `--- HOVEDSIDE: ${url} ---\n${mainText}`;
    const subUrls = Array.from(foundLinks).slice(0, 4);

    for (const subUrl of subUrls) {
      try {
        console.log(`  Leser underside: ${subUrl}`);
        const subText = await fetchText(subUrl);
        if (subText.length > 100) {
          allText += `\n\n--- UNDERSIDE: ${subUrl} ---\n${subText}`;
          console.log(`  ✓ ${subText.length} tegn fra ${subUrl.split('/').pop()}`);
        }
      } catch (err) {
        console.log(`  ✗ ${subUrl}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`  Total tekst: ${allText.length} tegn`);
    res.json({ 
      text: allText.slice(0, 8000), 
      links: subUrls,
    });

  } catch (err) {
    console.error('Crawl feil:', err.message);
    res.status(500).json({ error: err.message, text: null });
  }
});

// Hent Open Graph bilder fra nettside
app.get('/og-images', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)' }
    });
    const html = response.data;
    const base = new URL(url).origin;

    const getOG = (property) => {
      const match = html.match(new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i'));
      return match ? match[1] : null;
    };

    const normalizeUrl = (src) => {
      if (!src) return null;
      src = src.trim();
      if (src.startsWith('//')) return 'https:' + src;
      if (src.startsWith('/')) return base + src;
      return src;
    };

    // Hent logo
    const logoMatch = html.match(/<img[^>]*(?:logo|brand)[^>]*src=["']([^"']+)["']/i)
      || html.match(/<a[^>]*href=["']\/?["'][^>]*>\s*<img[^>]*src=["']([^"']+)["']/i);

    const result = {
      cover: normalizeUrl(getOG('og:image')),
      title: getOG('og:title'),
      description: getOG('og:description'),
      logo: normalizeUrl(logoMatch ? logoMatch[1] : null),
    };

    console.log(`OG for ${url}:`, result);
    res.json(result);
  } catch (err) {
    console.error('OG feil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy for eksterne bilder
app.get('/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; NattBergenBot/1.0)',
        'Accept': 'image/webp,image/apng,image/*,*/*'
      }
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    console.error('proxy-image feil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => {
  console.log('✅ NattBergen proxy kjører på port 3001');
  console.log('   Google API:', GOOGLE_KEY ? '✓' : '✗ MANGLER');
  console.log('   Claude API:', CLAUDE_KEY ? '✓' : '✗ MANGLER');
});