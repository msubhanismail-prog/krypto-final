require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const path      = require('path');

const { startTwitterPolling, validateAndResolveUser, fetchCustomUserTweets, getUserIdMap } = require('./twitter');
const { startPriceAlerts }     = require('./prices');
const { broadcastToChannel }   = require('./channel');
const { startNewsPolling }     = require('./news');
const { pollUpdates, notifyTweet, notifyBreakingNews,
        registerUser: registerTgUser, getUser: getTgUser,
        getBotInfo, getConnectedUsers } = require('./telegrambot');
const { createCheckoutSession, verifySession, verifyWebhookSignature } = require('./payments');
const { requestOTP, verifyOTP, getUserBySession, deleteSession, upgradeUserPlan,
        getUserData, saveTracking, saveTelegram } = require('./auth');
const { sendOTPEmail, notifyAdmin, saveUserToCSV } = require('./mailer');
const { addUserToSheet, updateUserPlan } = require('./sheets');

const app = express();

const ALLOWED_ORIGINS = [
  'https://kryptoinsides.com',
  'https://www.kryptoinsides.com',
  'http://localhost:3000',
  'http://localhost:3001',
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: '50kb' }));

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
const _rateLimitStore = new Map();
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
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _rateLimitStore) {
    if (now > rec.resetAt) _rateLimitStore.delete(ip);
  }
}, 10 * 60 * 1000);

// ── SEO ───────────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});

// ── HTTPS REDIRECT ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|woff|woff2|svg)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── FEED CACHE ────────────────────────────────────────────────────────────────
const feed     = [];
const MAX_FEED = 200;
const FRESH_WINDOW = {
  tweet:       30 * 60 * 1000,
  news:        35 * 60 * 1000,
  price_alert: 35 * 60 * 1000,
};
const LOGIN_CAP = {
  tweet:       20,
  news:        25,
  price_alert: 10,
};

// ── CLIENTS ───────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcastRaw(msgStr, itemId) {
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > 64 * 1024) continue;
    if (itemId && ws._seen.has(itemId)) continue;
    if (itemId) {
      ws._seen.add(itemId);
      if (ws._seen.size > 2000) {
        const iter = ws._seen.values();
        for (let i = 0; i < 500; i++) ws._seen.delete(iter.next().value);
      }
    }
    try { ws.send(msgStr); } catch (e) { clients.delete(ws); }
  }
}

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
function pong() { this.isAlive = true; }
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { clients.delete(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ── NEW CONNECTION ────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o) || origin === '';
  if (!allowed) { ws.close(1008, 'Origin not allowed'); return; }
  ws.isAlive = true;
  ws._seen   = new Set();
  ws.on('pong',    pong);
  ws.on('close',   () => clients.delete(ws));
  ws.on('error',   () => clients.delete(ws));
  ws.on('message', () => {});
  clients.add(ws);

  const now = Date.now();
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
    .reverse();

  snapshot.forEach(item => {
    const id = item.id || item.tweetId;
    if (id) ws._seen.add(id);
  });

  ws.send(JSON.stringify({
    type:       'batch_start',
    tweetCount: counts.tweet,
    newsCount:  counts.news + counts.price_alert,
    total:      snapshot.length,
  }));

  let i = 0;
  function sendNext() {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (i >= snapshot.length) { ws.send(JSON.stringify({ type: 'batch_end' })); return; }
    const chunk = snapshot.slice(i, i + 5);
    for (const item of chunk) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(item)); } catch { return; }
    }
    i += 5;
    setImmediate(sendNext);
  }
  setImmediate(sendNext);
});

// ── BROADCAST ─────────────────────────────────────────────────────────────────
function broadcast(payload) {
  const now = Date.now();
  const ts  = payload.createdAt || payload.publishedAt || payload.timestamp;
  const win = FRESH_WINDOW[payload.type] || FRESH_WINDOW.news;
  if (payload.type === 'tweet' && ts && (now - new Date(ts).getTime()) > win) return;
  feed.unshift(payload);
  if (feed.length > MAX_FEED) feed.pop();
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
  const itemId = payload.id || payload.tweetId;
  broadcastRaw(JSON.stringify(payload), itemId);
}

// ── FEED CACHE CLEANUP ────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    const ts   = item.createdAt || item.publishedAt || item.timestamp;
    const win  = FRESH_WINDOW[item.type] || FRESH_WINDOW.news;
    if (ts && (now - new Date(ts).getTime()) > win) feed.splice(i, 1);
  }
}, 10 * 60 * 1000);

// ── SANITIZATION ──────────────────────────────────────────────────────────────
function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.toLowerCase().trim().slice(0, 254);
}
function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, maxLen || 200);
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// helper used in user routes
function apiHeaders(req) {
  return req.headers['x-session-token'] || '';
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/request-otp', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
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
  res.json({ success: true });
});

app.post('/api/auth/verify-otp', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
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
  const token = req.headers['x-session-token'];
  const user  = getUserBySession(token);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: { email: user.email, name: user.name, plan: user.plan } });
});

// ── USER DATA ROUTES (per-user tracking + telegram) ───────────────────────────
app.get('/api/user/data', rateLimit(60, 60 * 1000), (req, res) => {
  const token = req.headers['x-session-token'];
  const user  = getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const data = getUserData(user.email);
  res.json(data);
});

app.post('/api/user/tracking', rateLimit(60, 60 * 1000), (req, res) => {
  const token = req.headers['x-session-token'];
  const user  = getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const accounts = Array.isArray(req.body.accounts)
    ? req.body.accounts.slice(0, 50).map(a => sanitizeString(a, 50)).filter(Boolean) : [];
  const keywords = Array.isArray(req.body.keywords)
    ? req.body.keywords.slice(0, 50).map(k => sanitizeString(k, 100)).filter(Boolean) : [];
  saveTracking(user.email, accounts, keywords);
  res.json({ success: true });
});

app.post('/api/user/telegram', rateLimit(20, 60 * 1000), (req, res) => {
  const token = req.headers['x-session-token'];
  const user  = getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const chatId = String(req.body.chatId || '').trim();
  const prefs  = (typeof req.body.prefs === 'object' && req.body.prefs) ? req.body.prefs : {};
  saveTelegram(user.email, chatId, prefs);
  res.json({ success: true });
});

// ── TWITTER VALIDATION + CUSTOM ACCOUNT TWEETS ───────────────────────────────
app.get('/api/twitter/validate', rateLimit(30, 60 * 1000), async (req, res) => {
  const handle = sanitizeString(req.query.handle || '', 50).replace('@', '').trim();
  if (!handle) return res.status(400).json({ valid: false, reason: 'Missing handle' });
  const result = await validateAndResolveUser(handle);
  res.json(result);
});

app.get('/api/twitter/custom-tweets', rateLimit(20, 60 * 1000), async (req, res) => {
  const token  = req.headers['x-session-token'];
  const user   = getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const handle = sanitizeString(req.query.handle || '', 50).replace('@', '').trim();
  if (!handle) return res.status(400).json({ tweets: [] });
  const tweets = await fetchCustomUserTweets(handle);
  res.json({ tweets });
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
    const { valid, event, error } = await verifyWebhookSignature(req.body, sig);
    if (!valid) {
      console.error('[Stripe] Webhook verification failed:', error);
      return res.status(400).json({ error: 'Webhook verification failed: ' + error });
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const email = session.customer_details && session.customer_details.email;
        const plan  = (session.metadata && session.metadata.plan) || 'pro';
        if (email) {
          try {
            upgradeUserPlan(email);
            updateUserPlan(email, plan).catch(() => {});
            console.log('[Stripe] Upgraded', email, 'to', plan);
          } catch(e) {
            console.error('[Stripe] Failed to upgrade user:', e.message);
          }
        }
      }
    }
    res.json({ received: true });
  }
);

// ── STRIPE ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/checkout', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
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
  const session_id = req.query.session_id;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  const result = await verifySession(session_id);
  res.json(result.success
    ? { success: true, plan: result.data.plan }
    : { success: false, reason: result.reason });
});

// ── TELEGRAM ROUTES ───────────────────────────────────────────────────────────
app.post('/api/telegram/connect', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const rawChatId = String(req.body.chatId || '').trim();
  const chatId    = parseInt(rawChatId, 10);
  if (!rawChatId || isNaN(chatId) || Math.abs(chatId) > 9999999999999)
    return res.status(400).json({ error: 'Missing or invalid chatId' });
  const keywords = Array.isArray(req.body.keywords)
    ? req.body.keywords.slice(0,20).map(k => sanitizeString(k,100)).filter(Boolean) : [];
  const accounts = Array.isArray(req.body.accounts)
    ? req.body.accounts.slice(0,20).map(a => sanitizeString(a,50)).filter(Boolean) : [];
  const isPro = !!req.body.isPro;
  const prefs = (typeof req.body.prefs === 'object' && req.body.prefs !== null) ? req.body.prefs : {};

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (BOT_TOKEN) {
    try {
      const axios = require('axios');
      const test  = await axios.get(
        'https://api.telegram.org/bot' + BOT_TOKEN + '/getChat',
        { params: { chat_id: chatId }, timeout: 8000 }
      );
      if (!test.data || !test.data.ok)
        return res.status(400).json({ error: 'Chat ID not found. Make sure you sent /start to @kryptoinsidesbot first.' });
    } catch (e) {
      const desc = (e.response && e.response.data && e.response.data.description) || '';
      if (desc.includes('chat not found') || desc.includes('Bad Request'))
        return res.status(400).json({ error: 'Chat ID not found. Open @kryptoinsidesbot and send /start first.' });
      console.warn('[TG] Could not verify chatId:', desc || e.message);
    }
  }

  const user = registerTgUser(chatId, isPro, keywords, accounts, prefs);
  res.json({ success: true, user });
});

app.get('/api/telegram/status', (req, res) => {
  const chatId = req.query.chatId;
  const user   = getTgUser(chatId);
  res.json({ connected: !!user, user });
});

app.get('/api/telegram/debug', (req, res) => {
  const ip      = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).send('Access denied');
  const bot      = getBotInfo();
  const tokenSet = !!process.env.TELEGRAM_BOT_TOKEN;
  const users    = getConnectedUsers();
  let botRows = '';
  if (bot) {
    botRows = '<tr><td>Username</td><td>@' + bot.username + '</td></tr>' +
              '<tr><td>Bot name</td><td>' + bot.first_name + '</td></tr>' +
              '<tr><td>Bot ID</td><td>' + bot.id + '</td></tr>';
  }
  let statusBox = bot
    ? '<div class="box"><p class="ok">Bot is running.</p></div>'
    : '<div class="box"><p class="fail">Bot NOT running — check TELEGRAM_BOT_TOKEN in .env</p></div>';
  const html = '<!DOCTYPE html><html><head><title>TG Debug</title>' +
    '<style>body{font-family:monospace;padding:30px;background:#0f0f0f;color:#e0e0e0}' +
    'h2{color:#00b894}.ok{color:#00b894}.fail{color:#e74c3c}' +
    'table{border-collapse:collapse;width:100%;margin:16px 0}' +
    'td{padding:8px 14px;border:1px solid #333}td:first-child{color:#888;width:200px}' +
    '.box{background:#1e1e1e;border-radius:10px;padding:16px;margin:12px 0}</style></head><body>' +
    '<h2>Telegram Bot Status</h2><div class="box"><table>' +
    '<tr><td>Bot connected</td><td class="' + (bot ? 'ok' : 'fail') + '">' + (bot ? 'YES' : 'NO') + '</td></tr>' +
    botRows +
    '<tr><td>Connected users</td><td>' + users + '</td></tr>' +
    '<tr><td>BOT_TOKEN set</td><td class="' + (tokenSet ? 'ok' : 'fail') + '">' + (tokenSet ? 'YES' : 'NO') + '</td></tr>' +
    '</table></div>' + statusBox + '</body></html>';
  res.send(html);
});

// ── ADMIN PANEL ───────────────────────────────────────────────────────────────
app.get('/admin/users', (req, res) => {
  const key      = req.query.key || '';
  const adminKey = process.env.ADMIN_KEY || '';
  if (!adminKey || key !== adminKey)
    return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">Access Denied — set ADMIN_KEY in .env and add ?key=YOUR_PASSWORD</h2>');

  const fs        = require('fs');
  const usersPath = path.join(__dirname, 'users_db.json');
  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e) {}

  const rows    = Object.values(users);
  const total   = rows.length;
  const freeCnt = rows.filter(u => u.plan !== 'pro').length;
  const proCnt  = rows.filter(u => u.plan === 'pro').length;
  const withTg  = rows.filter(u => u.telegram && u.telegram.chatId).length;

  const tableRows = rows
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(function(u) {
      const tg       = (u.telegram && u.telegram.chatId) ? '✅' : '—';
      const accounts = u.tracking ? (u.tracking.accounts || []).length : 0;
      const keywords = u.tracking ? (u.tracking.keywords || []).length : 0;
      const date     = u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '—';
      const badge    = u.plan === 'pro'
        ? '<span style="background:#a855f7;color:white;padding:2px 8px;border-radius:10px;font-size:11px">PRO</span>'
        : '<span style="background:#00b894;color:white;padding:2px 8px;border-radius:10px;font-size:11px">FREE</span>';
      return '<tr><td>' + (u.name || '—') + '</td>' +
        '<td><a href="mailto:' + u.email + '" style="color:#00b894">' + u.email + '</a></td>' +
        '<td>' + badge + '</td>' +
        '<td>' + date + '</td>' +
        '<td>' + accounts + '</td>' +
        '<td>' + keywords + '</td>' +
        '<td>' + tg + '</td></tr>';
    }).join('');

  const csvLines = ['Name,Email,Plan,Signup Date'].concat(
    rows.sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))
      .map(function(u) {
        return '"' + (u.name||'').replace(/"/g,'""') + '",' +
               '"' + u.email + '",' +
               '"' + (u.plan||'free') + '",' +
               '"' + (u.createdAt||'') + '"';
      })
  );
  const csvData  = csvLines.join('\n');
  const allEmails = rows.map(function(u){ return u.email; }).join(', ');

  const html = '<!DOCTYPE html><html><head><title>KryptoInsides Admin</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:30px}' +
    'h1{color:#00b894;font-size:22px;margin-bottom:6px}.sub{color:#666;font-size:13px;margin-bottom:24px}' +
    '.stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}' +
    '.stat{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:16px 24px;min-width:120px}' +
    '.stat .n{font-size:28px;font-weight:700;color:#00b894}.stat .l{font-size:12px;color:#666;margin-top:2px}' +
    '.actions{display:flex;gap:10px;margin-bottom:16px;align-items:center}' +
    'input[type=text]{background:#1a1a1a;border:1px solid #333;color:#e0e0e0;padding:8px 14px;border-radius:8px;font-size:13px;width:280px;outline:none}' +
    'button{background:#00b894;color:white;border:none;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}' +
    'button.sec{background:#1a1a1a;border:1px solid #333;color:#aaa}' +
    'table{width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:12px;overflow:hidden}' +
    'th{background:#111;padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#666;letter-spacing:.5px;text-transform:uppercase;border-bottom:1px solid #2a2a2a}' +
    'td{padding:10px 14px;border-bottom:1px solid #1e1e1e;font-size:13px}' +
    'tr:last-child td{border-bottom:none}tr:hover td{background:#222}' +
    '.count{color:#666;font-size:13px}</style></head><body>' +
    '<h1>KryptoInsides Users</h1>' +
    '<div class="sub">All registered accounts — sorted newest first</div>' +
    '<div class="stats">' +
    '<div class="stat"><div class="n">' + total + '</div><div class="l">Total Users</div></div>' +
    '<div class="stat"><div class="n">' + freeCnt + '</div><div class="l">Free Plan</div></div>' +
    '<div class="stat"><div class="n" style="color:#a855f7">' + proCnt + '</div><div class="l">Pro Plan</div></div>' +
    '<div class="stat"><div class="n">' + withTg + '</div><div class="l">Telegram Connected</div></div>' +
    '</div>' +
    '<div class="actions">' +
    '<input type="text" id="search" placeholder="Search by name or email..." oninput="filterTable(this.value)">' +
    '<button onclick="exportCSV()">Export CSV</button>' +
    '<button class="sec" onclick="copyEmails()">Copy All Emails</button>' +
    '<span class="count" id="countLabel">' + total + ' users</span>' +
    '</div>' +
    '<table id="usersTable"><thead><tr>' +
    '<th>Name</th><th>Email</th><th>Plan</th><th>Signed Up</th><th>Accounts</th><th>Keywords</th><th>Telegram</th>' +
    '</tr></thead><tbody id="tableBody">' + tableRows + '</tbody></table>' +
    '<script>' +
    'var csvData=' + JSON.stringify(csvData) + ';' +
    'var allEmails=' + JSON.stringify(allEmails) + ';' +
    'var total=' + total + ';' +
    'function exportCSV(){' +
    'var blob=new Blob([csvData],{type:"text/csv"});' +
    'var a=document.createElement("a");' +
    'a.href=URL.createObjectURL(blob);' +
    'a.download="kryptoinsides-users-"+new Date().toISOString().slice(0,10)+".csv";' +
    'a.click();}' +
    'function copyEmails(){navigator.clipboard.writeText(allEmails).then(function(){alert("All "+total+" emails copied!");});}' +
    'function filterTable(q){' +
    'q=q.toLowerCase();' +
    'var rows=document.querySelectorAll("#tableBody tr");' +
    'var shown=0;' +
    'rows.forEach(function(row){var match=row.textContent.toLowerCase().includes(q);row.style.display=match?"":"none";if(match)shown++;});' +
    'document.getElementById("countLabel").textContent=shown+" users";}' +
    '<\/script></body></html>';

  res.send(html);
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const ip      = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Forbidden' });
  const counts = feed.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
  res.json({ status: 'ok', clients: clients.size, feed: feed.length, ...counts });
});

// ── START ─────────────────────────────────────────────────────────────────────
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
