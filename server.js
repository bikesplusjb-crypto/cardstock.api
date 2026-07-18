// =============================================================
//  CARDSTOCK API v3 — with stock caching
//  Stock history: Alpha Vantage (cached daily in Supabase)
//  Card history: Supabase
//
//  ENV VARS on Render:
//    ALPHAVANTAGE_KEY, SUPABASE_URL, SUPABASE_SERVICE, LOG_SECRET
//
//  Run BOTH SQL files in Supabase first:
//    cardstock_table.sql        (card history)
//    cardstock_cache_table.sql  (stock cache)
// =============================================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE);

const CACHE_HOURS = 12; // re-fetch a ticker at most twice a day

function indexTo100(points) {
  if (!points.length) return [];
  const base = points[0].price;
  if (!base) return points.map(p => ({ t: p.t, v: 100 }));
  return points.map(p => ({ t: p.t, v: +((p.price / base) * 100).toFixed(2) }));
}
function windowDays(win) {
  if (win === '3M') return 90;
  if (win === '6M') return 182;
  return 365;
}

app.get('/', (req, res) => {
  res.json({ success: true, app: 'CardStock API', status: 'online' });
});

// ---- STOCK HISTORY (cached) ----
app.get('/api/stock-history', async (req, res) => {
  try {
    if (!AV_KEY) return res.status(500).json({ success: false, error: 'Stock data not configured.' });
    const ticker = (req.query.ticker || '').toUpperCase().trim();
    const win = (req.query.window || '12M').toUpperCase();
    if (!ticker) return res.status(400).json({ success: false, error: 'ticker required' });

    // 1) try cache
    const { data: cached } = await supabase
      .from('cardstock_stock_cache')
      .select('payload, cached_at')
      .eq('ticker', ticker)
      .eq('window_key', win)
      .maybeSingle();

    if (cached && cached.payload) {
      const ageHrs = (Date.now() - new Date(cached.cached_at).getTime()) / 3600000;
      if (ageHrs < CACHE_HOURS) {
        return res.json({ ...cached.payload, cached: true });
      }
    }

    // 2) cache miss or stale — fetch from Alpha Vantage
    const need = windowDays(win);
    const size = need > 100 ? 'full' : 'compact';
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=${size}&apikey=${AV_KEY}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.Note || data.Information) {
      // rate-limited: serve stale cache if we have any, else error
      if (cached && cached.payload) return res.json({ ...cached.payload, cached: true, stale: true });
      return res.status(429).json({ success: false, error: 'Stock data busy, try again shortly.' });
    }
    const ts = data['Time Series (Daily)'];
    if (!ts) {
      if (cached && cached.payload) return res.json({ ...cached.payload, cached: true, stale: true });
      return res.status(404).json({ success: false, error: 'No stock data for ' + ticker });
    }

    const cutoff = Date.now() - need * 86400 * 1000;
    const points = Object.keys(ts)
      .map(d => ({ t: new Date(d).getTime(), price: parseFloat(ts[d]['4. close']) }))
      .filter(p => p.t >= cutoff)
      .sort((a, b) => a.t - b.t);
    if (!points.length) return res.status(404).json({ success: false, error: 'No stock data in window' });

    const payload = {
      success: true,
      ticker,
      start: points[0].price,
      end: points[points.length - 1].price,
      changePct: +(((points[points.length - 1].price / points[0].price) - 1) * 100).toFixed(1),
      series: indexTo100(points)
    };

    // 3) write to cache (upsert)
    await supabase.from('cardstock_stock_cache').upsert({
      ticker, window_key: win, payload, cached_at: new Date().toISOString()
    });

    return res.json({ ...payload, cached: false });
  } catch (e) {
    console.error('stock-history error:', e);
    return res.status(500).json({ success: false, error: 'Stock fetch failed' });
  }
});

// ---- CARD HISTORY ----
app.get('/api/card-history', async (req, res) => {
  try {
    const query = (req.query.query || '').trim();
    if (!query) return res.status(400).json({ success: false, error: 'query required' });
    const cutoff = new Date(Date.now() - windowDays(req.query.window) * 86400 * 1000).toISOString();
    const { data, error } = await supabase
      .from('cardstock_history')
      .select('logged_at, price, sold_count')
      .eq('card_key', query)
      .gte('logged_at', cutoff)
      .order('logged_at', { ascending: true });
    if (error) throw error;
    if (!data || !data.length) {
      return res.json({ success: true, query, series: [], points: 0,
        note: 'No history logged yet for this card. The line fills in as prices are logged daily.' });
    }
    const points = data.map(d => ({ t: new Date(d.logged_at).getTime(), price: Number(d.price) }));
    const totalSold = data.reduce((a, d) => a + (d.sold_count || 0), 0);
    return res.json({
      success: true, query,
      start: points[0].price, end: points[points.length - 1].price,
      changePct: +(((points[points.length - 1].price / points[0].price) - 1) * 100).toFixed(1),
      points: points.length, soldCount: totalSold, series: indexTo100(points)
    });
  } catch (e) {
    console.error('card-history error:', e);
    return res.status(500).json({ success: false, error: 'Card history fetch failed' });
  }
});

// ---- LOG A CARD PRICE ----
app.post('/api/log-card', async (req, res) => {
  try {
    const { secret, card_key, price, sold_count } = req.body || {};
    if (secret !== process.env.LOG_SECRET) return res.status(403).json({ success: false, error: 'forbidden' });
    if (!card_key || !price) return res.status(400).json({ success: false, error: 'card_key and price required' });
    const { error } = await supabase.from('cardstock_history').insert({
      card_key: String(card_key), price: Number(price),
      sold_count: sold_count ? Number(sold_count) : null, logged_at: new Date().toISOString()
    });
    if (error) throw error;
    return res.json({ success: true, logged: card_key });
  } catch (e) {
    console.error('log-card error:', e);
    return res.status(500).json({ success: false, error: 'log failed' });
  }
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CardStock API v3 on ' + PORT));
