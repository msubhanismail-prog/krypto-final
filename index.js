require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const path      = require('path');

const { startTwitterPolling }  = require('./twitter');
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

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED FEED CACHE
// Single array holds tweets + news + price_alerts — newest first
// All users see the EXACT same feed regardless of when they connected
// ─────────────────────────────────────────────────────────────────────────────
const feed     = [];   // unified: tweet | news | price_alert, newest first
const MAX_FEED = 200;  // max items in memory

// How long each type stays "fresh" (used for initial-load filtering)
const FRESH_WINDOW = {
  tweet:       30 * 60 * 1000,  // 30 min — show last 30 min of tweets on login
  news:        35 * 60 * 1000,  // 35 min
  price_alert: 35 * 60 * 1000,  // 35 min — new users still see recent alerts
};

// How many of each type to send to a new connection (prevents flooding)
const LOGIN_CAP = {
  tweet:       20,  // up to 20 recent tweets on login
  news:        25,
  price_alert: 10,
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
  return str.replace(/<[^>]*>/g, '').replace(/[
