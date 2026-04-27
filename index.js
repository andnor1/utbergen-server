const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(cors());
app.use(express.json());

const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_KEY;
const CLAUDE_KEY = process.env.REACT_APP_CLAUDE_KEY;
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY = process.env.REACT_APP_SUPABASE_KEY;
const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'utbergen-secret-2026';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GEO_QUERIES = [
  "bar Bergen Norway", "pub Bergen Norway", "nattklubb Bergen",
  "sportsbar Bergen", "cocktailbar Bergen", "live musikk bar Bergen",
  "irish pub Bergen", "studentbar Bergen", "ølbar Bergen",
  "utested Bergen sentrum", "nightclub Bergen", "sports bar Bergen",
  "minigolf Bergen", "shuffleboard bar Bergen", "biljard bar Bergen",
  "dart bar Bergen", "biljardklubb Bergen", "spillbar Bergen",
];

function mapGoogleTypes(types = []) {
  const map = { bar:"cocktail", night_club:"nightclub", pub:"pub", sports_bar:"sport", bowling_alley:"bowling", live_music_venue:"live_music" };
  const cats = new Set();
  types.forEach(t => { if (map[t]) cats.add(map[t]); });
  if (types.includes("sports_bar") || types.includes("stadium")) cats.add("football");
  if (cats.size === 0) cats.add("bar");
  return Array.from(cats);
}

function parseHours(openingHours) {
  if (!openingHours?.weekday_text) return {};
  const days = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
  const result = {};
  openingHours.weekday_text.forEach((text, i) => {
    const parts = text.split(": ");
    result[days[i]] = parts[1] || "Stengt";
  });
  return result;
}

function normalizeUrl(src, base) {
  if (!src) return null;
  src = src.trim();
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return base + src;
  return src;
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── PIPELINE FUNKSJON ────────────────────────────────────────────────────────

async function runPipeline(log = console.log) {
  log('🚀 Pipeline starter...');
  const seen = new Set();
  const foundVenues = [];
  const today = new Date().toLocaleDateString('nb-NO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Fase 1: Google Places
  log('🔍 Søker utesteder i Bergen...');
  for (const q of GEO_QUERIES) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=no&key=${GOOGLE_KEY}`;
      const { data } = await axios.get(url);
      let newCount = 0;
      for (const place of (data.results || [])) {
        if (seen.has(place.place_id)) continue;
        seen.add(place.place_id);
        newCount++;
        foundVenues.push({
          place_id: place.place_id, name: place.name,
          address: (place.formatted_address || '').replace(', Norway', '').replace(', Norge', ''),
          lat: place.geometry?.location?.lat || 0, lng: place.geometry?.location?.lng || 0,
          rating: place.rating || 0, rating_count: place.user_ratings_total || 0,
          website: null, phone: null, email: null, instagram: null, facebook: null,
          categories: mapGoogleTypes(place.types || []),
          description: `${place.name} – ${place.vicinity || 'Bergen'}`, hours: {},
        });
      }
      log(`  ✓ "${q}": ${newCount} nye`);
    } catch (err) { log(`  ✗ "${q}": ${err.message}`); }
    await delay(300);
  }
  log(`✅ Fant ${foundVenues.length} utesteder`);

  // Fase 2: Detaljer + OG
  log('📋 Henter detaljer...');
  for (const v of foundVenues) {
    try {
      const fields = 'name,formatted_address,formatted_phone_number,website,opening_hours,geometry,types,rating,user_ratings_total,photos';
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${v.place_id}&fields=${fields}&language=no&key=${GOOGLE_KEY}`;
      const { data } = await axios.get(url);
      const d = data.result;
      if (d) {
        v.phone = d.formatted_phone_number || null;
        v.website = d.website || null;
        v.hours = parseHours(d.opening_hours);
        if (d.rating) v.rating = d.rating;
        if (d.user_ratings_total) v.rating_count = d.user_ratings_total;
        if (d.photos) v.photo_references = d.photos.slice(0, 6).map(p => p.photo_reference);
      }
    } catch {}

    if (v.website) {
      try {
        const base = new URL(v.website).origin;
        const { data: html } = await axios.get(v.website, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const getOG = (prop) => {
          const m = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
            || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'));
          return m ? m[1] : null;
        };
        const cover = normalizeUrl(getOG('og:image'), base);
        const desc = getOG('og:description');
        if (cover) v.cover_image = cover;
        if (desc && !v.description) v.description = desc;
      } catch {}
    }
    await delay(200);
  }

  // Fase 3: Lagre venues
  log('💾 Lagrer utesteder...');
  const { error: venueErr } = await supabase.from('venues').upsert(foundVenues, { onConflict: 'place_id' });
  if (venueErr) log(`  ✗ ${venueErr.message}`);
  else log(`✅ ${foundVenues.length} utesteder lagret`);

  // Fase 4: Claude event-scraping
  log('🤖 Skanner nettsider for eventer...');
  const allEvents = [];

  const scrapeAndExtract = async (url, venueName, placeId) => {
    try {
      const baseUrl = new URL(url).origin;
      const { data: mainHtml } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const mainText = stripHtml(mainHtml).slice(0, 2500);
      const eventKeywords = ['event', 'program', 'musikk', 'sport', 'kamp', 'quiz', 'hva-skjer', 'kalender', 'konsert', 'live', 'arrangement', 'fotball'];
      const linkRegex = /href=["']([^"'#?]+)["']/g;
      const foundLinks = new Set();
      let m;
      while ((m = linkRegex.exec(mainHtml)) !== null) {
        const href = m[1];
        if (!href || href.length < 2) continue;
        let fullUrl = href.startsWith('http') ? (href.startsWith(baseUrl) ? href : null) : href.startsWith('/') ? baseUrl + href : null;
        if (!fullUrl) continue;
        fullUrl = fullUrl.split('#')[0].replace(/\/$/, '');
        if (eventKeywords.some(kw => fullUrl.toLowerCase().includes(kw))) foundLinks.add(fullUrl);
      }
      let allText = `--- HOVEDSIDE ---\n${mainText}`;
      for (const subUrl of Array.from(foundLinks).slice(0, 4)) {
        try {
          const { data: subHtml } = await axios.get(subUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
          const subText = stripHtml(subHtml).slice(0, 2000);
          if (subText.length > 100) allText += `\n\n--- UNDERSIDE: ${subUrl} ---\n${subText}`;
        } catch {}
        await delay(200);
      }

      const { data: claudeData } = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: 1000,
        messages: [{ role: 'user', content: `Du er AI-agent for utBergen i Bergen. Dagens dato er ${today}.
Analyser innholdet fra "${venueName}" og ekstraher ALLE kommende eventer og faste ukentlige arrangementer.
Se etter: konserter, live musikk, fotballkamper, quiz, happy hour, nattklubb, turneringer.
For faste ukentlige eventer, lag én rad per kommende forekomst de neste 2 ukene.
INNHOLD:\n${allText.slice(0, 6000)}
Returner KUN JSON-array:
[{"id":"${placeId}_1","venue_id":"${placeId}","title":"tittel","date":"27. apr","time":"21:00","type":"live_music","league":null}]
Hvis ingen eventer: []` }]
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' } });

      const raw = claudeData.content?.map(c => c.text || '').join('') || '[]';
      const clean = raw.replace(/```json|```/g, '').trim();
      let events = [];
      try { events = JSON.parse(clean); if (!Array.isArray(events)) events = []; }
      catch { const mx = clean.match(/\[[\s\S]*\]/); if (mx) try { events = JSON.parse(mx[0]); } catch {} }
      return events.map(e => ({
        ...e,
        id: `${placeId}_${(e.title||'').toLowerCase().replace(/\s+/g,'_').slice(0,25)}_${(e.date||'').replace(/\s+/g,'')}`,
        venue_id: placeId, league: e.league || null,
      }));
    } catch (err) { log(`  ✗ ${venueName}: ${err.message}`); return []; }
  };

  for (const v of foundVenues.filter(v => v.website)) {
    log(`🤖 Skanner ${v.name}...`);
    const events = await scrapeAndExtract(v.website, v.name, v.place_id);
    if (events.length > 0) { allEvents.push(...events); log(`  ✓ ${events.length} eventer`); }
    await delay(1500);
  }

  // venue_urls
  const { data: venueUrls } = await supabase.from('venue_urls').select('*, venues(name,place_id)').eq('active', true);
  if (venueUrls?.length > 0) {
    log(`🔗 Skanner ${venueUrls.length} event-URL-er...`);
    for (const vu of venueUrls) {
      const venueName = vu.venues?.name || vu.venue_id;
      const events = await scrapeAndExtract(vu.url, venueName, vu.venue_id);
      if (events.length > 0) { allEvents.push(...events); log(`  ✓ ${events.length} eventer fra ${venueName}`); }
      await delay(1500);
    }
  }

  if (allEvents.length > 0) {
    await supabase.from('events').delete().neq('id', 'placeholder');
    const unique = Object.values(allEvents.reduce((acc, e) => { acc[e.id] = e; return acc; }, {}));
    const { error: evErr } = await supabase.from('events').upsert(unique, { onConflict: 'id' });
    if (evErr) log(`  ✗ Event feil: ${evErr.message}`);
    else log(`💾 ${unique.length} eventer lagret`);
  }

  log(`\n✅ PIPELINE FERDIG! ${foundVenues.length} utesteder · ${allEvents.length} eventer`);
  return { venues: foundVenues.length, events: allEvents.length };
}

// ─── ENDEPUNKTER ──────────────────────────────────────────────────────────────

app.get('/test', (req, res) => {
  res.json({ ok: true, google: !!GOOGLE_KEY, claude: !!CLAUDE_KEY, supabase: !!SUPABASE_URL,
    google_start: GOOGLE_KEY?.slice(0, 10), claude_start: CLAUDE_KEY?.slice(0, 15) });
});

app.post('/run-pipeline', async (req, res) => {
  const auth = req.headers['x-pipeline-secret'];
  if (auth !== PIPELINE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ message: 'Pipeline startet', timestamp: new Date().toISOString() });
  try { await runPipeline(msg => console.log(msg)); }
  catch (err) { console.error('Pipeline feil:', err.message); }
});

app.get('/places/search', async (req, res) => {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(req.query.query)}&language=no&key=${GOOGLE_KEY}`;
    const { data } = await axios.get(url);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/places/details', async (req, res) => {
  try {
    const fields = 'name,formatted_address,formatted_phone_number,website,opening_hours,geometry,types,rating,user_ratings_total,photos';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${req.query.place_id}&fields=${fields}&language=no&key=${GOOGLE_KEY}`;
    const { data } = await axios.get(url);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/places/photo', async (req, res) => {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${req.query.maxwidth||800}&photo_reference=${req.query.photo_reference}&key=${GOOGLE_KEY}`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type']);
    res.send(response.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/fetch-website', async (req, res) => {
  try {
    const { data } = await axios.get(req.query.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.json({ text: stripHtml(data).slice(0, 5000) });
  } catch (err) { res.status(500).json({ error: err.message, text: null }); }
});

app.get('/crawl-venue', async (req, res) => {
  try {
    const { url } = req.query;
    const baseUrl = new URL(url).origin;
    const { data: mainHtml } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const mainText = stripHtml(mainHtml).slice(0, 2500);
    const eventKeywords = ['event', 'program', 'musikk', 'sport', 'kamp', 'quiz', 'hva-skjer', 'kalender', 'konsert', 'live', 'arrangement', 'fotball', 'football'];
    const linkRegex = /href=["']([^"'#?]+)["']/g;
    const foundLinks = new Set();
    let m;
    while ((m = linkRegex.exec(mainHtml)) !== null) {
      const href = m[1];
      if (!href || href.length < 2) continue;
      let fullUrl = href.startsWith('http') ? (href.startsWith(baseUrl) ? href : null) : href.startsWith('/') ? baseUrl + href : null;
      if (!fullUrl) continue;
      fullUrl = fullUrl.split('#')[0].replace(/\/$/, '');
      if (eventKeywords.some(kw => fullUrl.toLowerCase().includes(kw))) foundLinks.add(fullUrl);
    }
    console.log(`  Fant ${foundLinks.size} undersider`);
    let allText = `--- HOVEDSIDE: ${url} ---\n${mainText}`;
    for (const subUrl of Array.from(foundLinks).slice(0, 4)) {
      try {
        const { data: subHtml } = await axios.get(subUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const subText = stripHtml(subHtml).slice(0, 2000);
        if (subText.length > 100) allText += `\n\n--- UNDERSIDE: ${subUrl} ---\n${subText}`;
      } catch {}
      await delay(300);
    }
    res.json({ text: allText.slice(0, 8000), links: Array.from(foundLinks).slice(0, 4) });
  } catch (err) { res.status(500).json({ error: err.message, text: null }); }
});

app.post('/claude/scrape-events', async (req, res) => {
  try {
    const { venue, content } = req.body;
    const today = new Date().toLocaleDateString('nb-NO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    console.log('Claude analyserer:', venue.name);
    const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{ role: 'user', content: `Du er AI-agent for utBergen i Bergen. Dagens dato er ${today}.
Analyser innholdet fra "${venue.name}" og ekstraher ALLE kommende eventer og faste ukentlige arrangementer.
Se etter: konserter, live musikk, fotballkamper, quiz-kvelder, happy hour, nattklubb, turneringer.
For faste ukentlige eventer (f.eks. "Quiz hver torsdag"), lag én rad per forekomst de neste 2 ukene.
INNHOLD:\n${content}
Returner KUN JSON-array, ingen markdown:
[{"id":"${venue.place_id}_1","venue_id":"${venue.place_id}","title":"tittel","date":"27. apr","time":"21:00","type":"football/live_music/quiz/games/happy_hour/nightclub","league":"PREMIER LEAGUE eller null"}]
Hvis ingen eventer: []` }]
    }, { headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' } });

    const raw = data.content?.map(c => c.text || '').join('') || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();
    let events = [];
    try { events = JSON.parse(clean); if (!Array.isArray(events)) events = []; }
    catch { const mx = clean.match(/\[[\s\S]*\]/); if (mx) try { events = JSON.parse(mx[0]); } catch {} }
    events = events.map(e => ({
      ...e,
      id: `${venue.place_id}_${(e.title||'').toLowerCase().replace(/\s+/g,'_').slice(0,25)}_${(e.date||'').replace(/\s+/g,'')}`,
      venue_id: venue.place_id, league: e.league || null,
    }));
    console.log(`✓ ${venue.name}: ${events.length} eventer`);
    res.json({ events });
  } catch (err) {
    console.error('Claude feil:', err.response?.status, err.response?.data?.error?.message || err.message);
    res.status(500).json({ error: err.response?.data || err.message, events: [] });
  }
});

app.get('/og-images', async (req, res) => {
  try {
    const { url } = req.query;
    const { data: html } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const base = new URL(url).origin;
    const getOG = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'));
      return m ? m[1] : null;
    };
    const logoMatch = html.match(/<img[^>]*(?:logo|brand)[^>]*src=["']([^"']+)["']/i)
      || html.match(/<a[^>]*href=["']\/?["'][^>]*>\s*<img[^>]*src=["']([^"']+)["']/i);
    res.json({
      cover: normalizeUrl(getOG('og:image'), base),
      title: getOG('og:title'),
      description: getOG('og:description'),
      logo: normalizeUrl(logoMatch ? logoMatch[1] : null, base),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/proxy-image', async (req, res) => {
  try {
    const response = await axios.get(req.query.url, {
      responseType: 'arraybuffer', timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/webp,image/apng,image/*,*/*' }
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ utBergen proxy kjører på port ${PORT}`);
  console.log('   Google API:', GOOGLE_KEY ? '✓' : '✗ MANGLER');
  console.log('   Claude API:', CLAUDE_KEY ? '✓' : '✗ MANGLER');
  console.log('   Supabase:', SUPABASE_URL ? '✓' : '✗ MANGLER');
});
