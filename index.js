require('dotenv').config();
console.log('=== NEW CODE v1.0.3 LOADED ===');
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const path      = require('path');

const { startTwitterPolling, validateAndResolveUser, fetchCustomUserTweets }  = require('./twitter');
const { startPriceAlerts }     = require('./prices');
const { broadcastToChannel }   = require('./channel');
const { startNewsPolling }     = require('./news');
const { pollUpdates, notifyTweet, notifyBreakingNews,
        registerUser: registerTgUser, getUser: getTgUser,
        getBotInfo, getConnectedUsers } = require('./telegrambot');
const { createCheckoutSession, verifySession, verifyWebhookSignature } = require('./payments');
const { requestOTP, verifyOTP, getUserBySession, deleteSession, upgradeUserPlan } = require('./auth');
const { sendOTPEmail, notifyAdmin, saveUserToCSV } = require('./mailer');
const { addUserToSheet } = require('./sheets');

const app = express();

// ── CORS — only allow your own domain (not every website on the internet) ─
const ALLOWED_ORIGINS = [
  'https://kryptoinsides.com',
  'https://www.kryptoinsides.com',
  'http://localhost:3000',   // dev only
  'http://localhost:3001',
];
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman in dev)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: '50kb' }));   // reject oversized payloads

// ── SIMPLE IN-MEMORY RATE LIMITER ─────────────────────────────────────────
// No external package needed — keyed by IP
const _rateLimitStore = new Map();  // ip → { count, resetAt }

function rateLimit(maxReqs, windowMs) {
  return function(req, res, next) {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = _rateLimitStore.get(ip);

    if (!rec || now > rec.resetAt) {
      _rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    rec.count++;
    if (rec.count > maxReqs) {
      res.setHeader('Retry-After', Math.ceil((rec.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

// Clean up rate limit store every 10 minutes to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _rateLimitStore) {
    if (now > rec.resetAt) _rateLimitStore.delete(ip);
  }
}, 10 * 60 * 1000);
// ── SEO FILES ─────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});

// ── HTTPS REDIRECT (production only) ─────────────────────────────────────
app.use((req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const isHttp = req.headers['x-forwarded-proto'] === 'http';
  if (isProduction && isHttp) {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// ── SECURITY + PERFORMANCE HEADERS ───────────────────────────────────────
app.use((req, res, next) => {
  // Cache static assets aggressively
const FEED_CACHE_FILE = '/app/data/feed_cache.json';
  if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|woff|woff2|svg)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  // ── Content Security Policy ───────────────────────────────────────────
  // Controls which scripts, styles and connections the browser allows.
  // This stops injected scripts from running even if XSS gets through.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' wss: ws: https://api.stripe.com https://api.coingecko.com",
    "frame-src https://js.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));

  // ── Other security headers ────────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // ── HSTS (only on HTTPS) ──────────────────────────────────────────────
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

app.use(express.static(path.join(__dirname)));  // serve from root — landing.html, dashboard.html etc are in root

// Explicit routes so / and /dashboard always resolve
// Cache-bust: redirect old cached URLs to versioned URL
// Change BUILD_VERSION whenever you deploy — forces ALL browsers to fetch fresh
const BUILD_VERSION = 'v' + Date.now(); // changes on every server restart

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get('/dashboard.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED FEED CACHE
// Single array holds tweets + news + price_alerts — newest first
// All users see the EXACT same feed regardless of when they connected
// ─────────────────────────────────────────────────────────────────────────────
const feed     = [];   // unified: tweet | news | price_alert, newest first

// ── FEED PERSISTENCE — survives server restarts ───────────────────────────
const FEED_CACHE_FILE = path.join(__dirname, 'feed_cache.json');

function loadFeedCache() {
  try {
    if (require('fs').existsSync(FEED_CACHE_FILE)) {
      const data = JSON.parse(require('fs').readFileSync(FEED_CACHE_FILE, 'utf8'));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const fresh = data.filter(item => {
        const ts = item.createdAt || item.publishedAt || item.timestamp;
        return ts && new Date(ts).getTime() > cutoff;
      });
      feed.push(...fresh);
      console.log('[Feed] Loaded ' + feed.length + ' cached items from disk');
    }
  } catch(e) { console.warn('[Feed] Cache load failed:', e.message); }
}

setInterval(() => {
  try {
    require('fs').writeFileSync(FEED_CACHE_FILE, JSON.stringify(feed));
  } catch(e) { console.warn('[Feed] Cache save failed:', e.message); }
}, 2 * 60 * 1000);  // save every 2 minutes

loadFeedCache();
const MAX_FEED = 2000;  // 24h worth of content

// How long each type stays "fresh" (used for initial-load filtering)
const FRESH_WINDOW = {
  tweet:       24 * 60 * 60 * 1000,  // 24 hours
  news:        24 * 60 * 60 * 1000,  // 24 hours
  price_alert: 24 * 60 * 60 * 1000,  // 24 hours
};

// How many of each type to send to a new connection (prevents flooding)
const LOGIN_CAP = {
  tweet:       200,  // up to 200 tweets on login (24h)
  news:        100,
  price_alert: 50,
};

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTED CLIENTS
// ─────────────────────────────────────────────────────────────────────────────
const clients = new Set();

// Pre-serialize once, send to N clients — O(1) JSON work, O(clients) I/O
function broadcastRaw(msgStr, itemId) {
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > 64 * 1024) continue;   // skip lagging/slow clients
    if (itemId && ws._seen.has(itemId))   continue; // dedup: reconnected client
    if (itemId) {
      ws._seen.add(itemId);
      if (ws._seen.size > 2000) {
        // Prevent memory leak on long-lived connections — trim oldest 500
        const iter = ws._seen.values();
        for (let i = 0; i < 500; i++) ws._seen.delete(iter.next().value);
      }
    }
    try { ws.send(msgStr); } catch (e) { clients.delete(ws); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEARTBEAT — drop dead connections every 30s
// ─────────────────────────────────────────────────────────────────────────────
function pong() { this.isAlive = true; }

setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { clients.delete(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// NEW CLIENT CONNECTION — send them the shared feed snapshot
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // Origin check — only accept WebSocket connections from our own domain
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o) || origin === '';
  if (!allowed) {
    console.warn('[WS] Rejected connection from unknown origin:', origin);
    ws.close(1008, 'Origin not allowed');
    return;
  }
  ws.isAlive = true;
  ws._seen   = new Set();
  ws.on('pong',    pong);
  ws.on('close',   () => clients.delete(ws));
  ws.on('error',   () => clients.delete(ws));
  ws.on('message', () => {});
  clients.add(ws);

  const now = Date.now();

  // Build the snapshot: filter by freshness, cap per type, oldest→newest for drip
  const counts = { tweet: 0, news: 0, price_alert: 0 };
  const snapshot = feed
    .filter(item => {
      const ts  = item.createdAt || item.publishedAt || item.timestamp;
      const win = FRESH_WINDOW[item.type] || FRESH_WINDOW.news;
      if (!ts || (now - new Date(ts).getTime()) > win) return false;
      const cap = LOGIN_CAP[item.type] || 20;
      if (counts[item.type] >= cap) return false;
      counts[item.type]++;
      return true;
    })
    .reverse();  // oldest first — client drips newest to top in order

  // Mark snapshot IDs as seen so reconnects don't re-show same items
  snapshot.forEach(item => {
    const id = item.id || item.tweetId;
    if (id) ws._seen.add(id);
  });

  // Tell client how many items to expect
  ws.send(JSON.stringify({
    type:       'batch_start',
    tweetCount: counts.tweet,
    newsCount:  counts.news + counts.price_alert,
    total:      snapshot.length,
  }));

  // Stream snapshot in chunks of 5 using setImmediate — non-blocking
  // 1000 users connecting simultaneously won't freeze the server
  let i = 0;
  function sendNext() {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (i >= snapshot.length) {
      ws.send(JSON.stringify({ type: 'batch_end' }));
      return;
    }
    const chunk = snapshot.slice(i, i + 5);
    for (const item of chunk) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(item)); } catch { return; }
    }
    i += 5;
    setImmediate(sendNext);  // yield the event loop between chunks
  }
  setImmediate(sendNext);
});

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST — called by twitter/news/prices modules
// Adds to unified feed, serializes once, sends to all connected clients
// ─────────────────────────────────────────────────────────────────────────────
function broadcast(payload) {
  const now = Date.now();
  const ts  = payload.createdAt || payload.publishedAt || payload.timestamp;
  const win = FRESH_WINDOW[payload.type] || FRESH_WINDOW.news;

  // Drop stale items before caching (tweets especially age fast)
  if (payload.type === 'tweet' && ts && (now - new Date(ts).getTime()) > win) return;

  // Add to unified feed cache (newest first)
  feed.unshift(payload);
  if (feed.length > MAX_FEED) feed.pop();

  // Side effects
  if (payload.type === 'tweet') {
    notifyTweet(payload).catch(() => {});
  } else if (payload.type === 'news') {
    if (payload.breaking) {
      notifyBreakingNews(payload).catch(() => {});
      broadcastToChannel(payload).catch(() => {});
    }
  } else if (payload.type === 'price_alert') {
    broadcastToChannel(payload).catch(() => {});
  }

  // Serialize ONCE — send to all N clients (O(1) stringify, O(N) send)
  const itemId = payload.id || payload.tweetId;
  broadcastRaw(JSON.stringify(payload), itemId);
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE CLEANUP — every 10 min, evict items outside their fresh window
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    const ts   = item.createdAt || item.publishedAt || item.timestamp;
    const win  = FRESH_WINDOW[item.type] || FRESH_WINDOW.news;
    if (ts && (now - new Date(ts).getTime()) > win) feed.splice(i, 1);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// INPUT SANITIZATION
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.toLowerCase().trim().slice(0, 254);  // max valid email length
}

function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  // Strip HTML tags and control chars — prevent XSS if value ever rendered
  return str.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen || 200);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/request-otp', rateLimit(10, 15 * 60 * 1000), async (req, res) => {  // 10 per 15min per IP
  const email = sanitizeEmail(req.body.email || '');
  const name  = sanitizeString(req.body.name  || '', 100);
  if (!isValidEmail(email))
    return res.status(400).json({ success: false, reason: 'Please enter a valid email' });
  const result = requestOTP(email, name);
  if (!result.success) return res.status(429).json({ success: false, reason: result.reason });
  try {
    await sendOTPEmail(email, name || email.split('@')[0], result.code);
    console.log('OTP sent to', email);
  } catch (err) {
    console.error('Email error:', err.message);
    return res.status(500).json({ success: false, reason: 'Failed to send email. Please try again.' });
  }
  // SECURITY: never return the OTP code in the HTTP response
  res.json({ success: true });
});

app.post('/api/auth/verify-otp', rateLimit(20, 15 * 60 * 1000), async (req, res) => {  // 20 per 15min per IP
  const email = sanitizeEmail(req.body.email || '');
  const code  = sanitizeString(req.body.code || '', 10);
  if (!isValidEmail(email) || !code)
    return res.status(400).json({ success: false, reason: 'Missing email or code' });
  const result = verifyOTP(email, code);
  if (result.success && result.isNew) {
    const name = result.user.name;
    saveUserToCSV(email, name);
    addUserToSheet(name, email, 'free').catch(() => {});
    notifyAdmin(email, name).catch(() => {});
  }
  res.json(result);
});

app.post('/api/auth/signout', (req, res) => {
  const token = req.body.token || req.headers['x-session-token'];
  if (token) deleteSession(token);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  // SECURITY: token must come from header only — never from URL query string
  // URL params appear in server logs, browser history, and Referrer headers
  const token = req.headers['x-session-token'];
  const user  = getUserBySession(token);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: { email: user.email, name: user.name, plan: user.plan } });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK — must use raw body (before express.json() parses it)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),   // raw body needed for signature
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

    const { valid, event, error } = await verifyWebhookSignature(req.body, sig);
    if (!valid) {
      console.error('[Stripe] Webhook verification failed:', error);
      return res.status(400).json({ error: 'Webhook verification failed: ' + error });
    }

    // Handle verified events
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const email = session.customer_details?.email;
        const plan  = session.metadata?.plan || 'pro';
        if (email) {
          try {
            const { upgradeUserPlan } = require('./auth');
            upgradeUserPlan(email);
            console.log('[Stripe] ✅ Upgraded', email, 'to', plan);
          } catch(e) {
            console.error('[Stripe] Failed to upgrade user:', e.message);
          }
        }
      }
    }

    res.json({ received: true });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/checkout', rateLimit(10, 60 * 60 * 1000), async (req, res) => {  // 10 per hour
  try {
    const { plan, chatId } = req.body;
    if (!['monthly', 'annual'].includes(plan))
      return res.status(400).json({ error: 'Invalid plan' });
    const host    = req.headers.origin || 'http://localhost:' + PORT;
    const session = await createCheckoutSession(
      plan, chatId || '',
      host + '/dashboard.html',
      host + '/dashboard.html'
    );
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verify-payment', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  const result = await verifySession(session_id);
  res.json(result.success
    ? { success: true, plan: result.data.plan }
    : { success: false, reason: result.reason });
});

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/telegram/connect', rateLimit(10, 60 * 60 * 1000), async (req, res) => {  // 10 per hour
  const rawChatId  = String(req.body.chatId || '').trim();
  const chatId     = parseInt(rawChatId, 10);
  if (!rawChatId || isNaN(chatId) || Math.abs(chatId) > 9999999999999)
    return res.status(400).json({ error: 'Missing or invalid chatId' });

  // Sanitize arrays — only accept strings, max 20 items, max 100 chars each
  const keywords = Array.isArray(req.body.keywords)
    ? req.body.keywords.slice(0,20).map(k => sanitizeString(k,100)).filter(Boolean)
    : [];
  const accounts = Array.isArray(req.body.accounts)
    ? req.body.accounts.slice(0,20).map(a => sanitizeString(a,50)).filter(Boolean)
    : [];
  const isPro = !!req.body.isPro;
  const prefs = (typeof req.body.prefs === 'object' && req.body.prefs !== null)
    ? req.body.prefs : {};

  // Verify the chatId is a real Telegram user before registering
  // (prevents typos from silently registering wrong IDs)
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (BOT_TOKEN) {
    try {
      const axios = require('axios');
      const test = await axios.get(
        `https://api.telegram.org/bot${BOT_TOKEN}/getChat`,
        { params: { chat_id: chatId }, timeout: 8000 }
      );
      if (!test.data || !test.data.ok) {
        return res.status(400).json({ error: 'Chat ID not found. Make sure you sent /start to @kryptoinsidesbot first.' });
      }
    } catch (e) {
      const desc = e.response?.data?.description || '';
      if (desc.includes('chat not found') || desc.includes('Bad Request')) {
        return res.status(400).json({ error: 'Chat ID not found. Open @kryptoinsidesbot and send /start first.' });
      }
      // On network error, allow registration anyway (don't block user)
      console.warn('[TG] Could not verify chatId:', desc || e.message);
    }
  }

  const user = registerTgUser(chatId, isPro, keywords, accounts, prefs);
  res.json({ success: true, user });
});

app.get('/api/telegram/status', (req, res) => {
  const { chatId } = req.query;
  const user = getTgUser(chatId);
  res.json({ connected: !!user, user });
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM ACCOUNT VALIDATION — validates Twitter username before tracking
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/validate-account', async (req, res) => {
  const handle = (req.body && req.body.handle) ? req.body.handle : null;
  if (!handle) return res.status(400).json({ valid: false, reason: 'No username provided' });

  try {
    const result = await validateAndResolveUser(handle);
    if (result.valid) {
      const tweets = await fetchCustomUserTweets(handle);
      return res.json({ valid: true, user: result.user, tweets: tweets });
    } else {
      return res.json({ valid: false, reason: result.reason });
    }
  } catch (err) {
    console.error('Validate account error:', err.message);
    return res.json({ valid: false, reason: 'Server error — try again' });
  }
});

// ── TELEGRAM DEBUG — restricted to localhost only ────────────────────────
app.get('/api/telegram/debug', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).send('Access denied');
  }
  const bot      = getBotInfo();
  const tokenSet = !!process.env.TELEGRAM_BOT_TOKEN;
  const users    = getConnectedUsers();

  let botRows = '';
  if (bot) {
    botRows = '<tr><td>Username</td><td>@' + bot.username + '</td></tr>' +
              '<tr><td>Bot name</td><td>' + bot.first_name + '</td></tr>' +
              '<tr><td>Bot ID</td><td>' + bot.id + '</td></tr>';
  }

  let statusBox = '';
  if (bot) {
    statusBox = '<div class="box"><p class="ok">✅ Bot is running correctly.</p>' +
                '<p>Tell users to open Telegram, search <b>@' + bot.username + '</b>, and send <b>/start</b></p>' +
                '<p>They will receive their Chat ID to paste into the dashboard.</p></div>';
  } else {
    statusBox = '<div class="box"><p class="fail">❌ Bot is NOT running. Common causes:</p><ul>' +
                '<li>TELEGRAM_BOT_TOKEN not set in <code>.env</code> file</li>' +
                '<li>Wrong token — get correct one from @BotFather on Telegram</li>' +
                '<li>Another bot instance already running (409 conflict)</li>' +
                '<li>Network error during startup</li></ul>' +
                '<p>Check your terminal for <code>[TG]</code> log lines.</p></div>';
  }

  const html = '<!DOCTYPE html><html><head><title>Telegram Bot Debug</title>' +
    '<style>body{font-family:monospace;padding:30px;background:#0f0f0f;color:#e0e0e0}' +
    'h2{color:#00b894}.ok{color:#00b894}.fail{color:#e74c3c}' +
    'table{border-collapse:collapse;width:100%;margin:16px 0}' +
    'td{padding:8px 14px;border:1px solid #333}td:first-child{color:#888;width:200px}' +
    '.box{background:#1e1e1e;border-radius:10px;padding:16px;margin:12px 0}' +
    'a{color:#00b894}</style></head><body>' +
    '<h2>🤖 Telegram Bot Status</h2>' +
    '<div class="box"><table>' +
    '<tr><td>Bot connected</td><td class="' + (bot ? 'ok' : 'fail') + '">' + (bot ? '✅ YES' : '❌ NO') + '</td></tr>' +
    botRows +
    '<tr><td>Connected users</td><td>' + users + '</td></tr>' +
    '<tr><td>BOT_TOKEN set</td><td class="' + (tokenSet ? 'ok' : 'fail') + '">' + (tokenSet ? '✅ YES' : '❌ NO — missing from .env') + '</td></tr>' +
    '</table></div>' +
    statusBox +
    '<p><a href="/api/telegram/debug">↻ Refresh</a></p>' +
    '</body></html>';

  res.send(html);
});
// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Forbidden' });
  const counts = feed.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  res.json({
    status:   'ok',
    clients:  clients.size,
    feed:     feed.length,
    ...counts,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('\n==================================');
  console.log('  KryptoInsides  ·  port ' + PORT);
  console.log('  Unified feed — all users in sync');
  console.log('==================================\n');
  try { await startTwitterPolling(broadcast); }  catch (e) { console.error('Twitter:', e.message); }
  try { await startNewsPolling(broadcast); }      catch (e) { console.error('News:',    e.message); }
  try { startPriceAlerts(broadcast); }            catch (e) { console.error('Prices:',  e.message); }
  try { await pollUpdates(); }                    catch (e) { console.error('Telegram:', e.message); }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
