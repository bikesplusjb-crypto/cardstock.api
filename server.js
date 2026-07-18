// =============================================================
//  CARDSTOCK API — backend for stockmarketsportscards.com
//  New Render Web Service · Node/Express
//
//  ENDPOINTS
//    GET  /                        health check
//    GET  /api/stock-history       real daily closes from Finnhub, indexed to 100
//    GET  /api/card-history        card price history from Supabase, indexed to 100
//    POST /api/log-card            snapshot a card's price today (secret-protected)
//
//  SETUP (one time)
//    npm install express cors @supabase/supabase-js
//    Render → Environment, add:
//      FINNHUB_KEY        = <your rotated Finnhub key>
//      SUPABASE_URL       = https://nlaqvfplecacbbdbmhxd.supabase.co
//      SUPABASE_SERVICE   = <your Supabase service role key>
//      LOG_SECRET         = <any long random string you choose>
//    Run the SQL in cardstock_table.sql in Supabase first (creates the table).
// =============================================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE);

// ---- helpers ----------------------------------------------------

// index a series of {t, price} to 100 at the first point
function indexTo100(points) {
  if (!points.length) return [];
  const base = points[0].price;
  if (!base) return points.map(p => ({ t: p.t, v: 100 }));
  return points.map(p => ({ t: p.t, v: +( (p.price / base) * 100 ).toFixed(2) }));
}

// how many days back for a window string
function windowDays(win) {
  if (win === '3M') return 90;
  if (win === '6M') return 182;
  return 365; // default 12M
}

// ---- health -----------------------------------------------------
app.get('/', (req, res) => {
  res.json({ success: true, app: 'CardStock API', status: 'online' });
});

// ---- STOCK HISTORY (Finnhub) -----------------------------------
// GET /api/stock-history?ticker=AAPL&window=12M
app.get('/api/stock-history', async (req, res) => {
  try {
    if (!FINNHUB_KEY) return res.status(500).json({ success: false, error: 'Stock data not configured.' });
    const ticker = (req.query.ticker || '').toUpperCase().trim();
    if (!ticker) return res.status(400).json({ success: false, error: 'ticker required' });

    const now = Math.floor(Date.now() / 1000);
    const from = now - windowDays(req.query.window) * 86400;

    // Finnhub stock candles: daily resolution
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_KEY}`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.s !== 'ok' || !Array.isArray(data.c) || !data.c.length) {
      return res.status(404).json({ success: false, error: 'No stock data for ' + ticker });
    }

    // build {t, price} from close prices, then index
    const points = data.c.map((close, i) => ({ t: data.t[i] * 1000, price: close }));
    const indexed = indexTo100(points);

    return res.json({
      success: true,
      ticker,
      start: points[0].price,
      end: points[points.length - 1].price,
      changePct: +(((points[points.length - 1].price / points[0].price) - 1) * 100).toFixed(1),
      series: indexed
    });
  } catch (e) {
    console.error('stock-history error:', e);
    return res.status(500).json({ success: false, error: 'Stock fetch failed' });
  }
});

// ---- CARD HISTORY (Supabase) -----------------------------------
// GET /api/card-history?query=2018%20Ohtani%20RC%20PSA%2010&window=12M
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
      // honest empty state — no fabricated line
      return res.json({
        success: true,
        query,
        series: [],
        points: 0,
        note: 'No history logged yet for this card. The line fills in as prices are logged daily.'
      });
    }

    const points = data.map(d => ({ t: new Date(d.logged_at).getTime(), price: Number(d.price) }));
    const indexed = indexTo100(points);
    const totalSold = data.reduce((a, d) => a + (d.sold_count || 0), 0);

    return res.json({
      success: true,
      query,
      start: points[0].price,
      end: points[points.length - 1].price,
      changePct: +(((points[points.length - 1].price / points[0].price) - 1) * 100).toFixed(1),
      points: points.length,
      soldCount: totalSold,
      series: indexed
    });
  } catch (e) {
    console.error('card-history error:', e);
    return res.status(500).json({ success: false, error: 'Card history fetch failed' });
  }
});

// ---- LOG A CARD PRICE (daily snapshot) -------------------------
// POST /api/log-card   body: { secret, card_key, price, sold_count }
// Call this once a day per tracked card (cron/pinger) so the line grows.
app.post('/api/log-card', async (req, res) => {
  try {
    const { secret, card_key, price, sold_count } = req.body || {};
    if (secret !== process.env.LOG_SECRET) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    if (!card_key || !price) {
      return res.status(400).json({ success: false, error: 'card_key and price required' });
    }
    const { error } = await supabase.from('cardstock_history').insert({
      card_key: String(card_key),
      price: Number(price),
      sold_count: sold_count ? Number(sold_count) : null,
      logged_at: new Date().toISOString()
    });
    if (error) throw error;
    return res.json({ success: true, logged: card_key });
  } catch (e) {
    console.error('log-card error:', e);
    return res.status(500).json({ success: false, error: 'log failed' });
  }
});

// ---- 404 --------------------------------------------------------
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CardStock API on ' + PORT));
