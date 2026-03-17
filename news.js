/**
 * news.js — Crypto news polling from RSS feeds
 *
 * KEY DESIGN: articles are NEVER broadcast mid-cycle.
 * Every poll cycle (priority or full) runs like this:
 *
 *   1. Poll all feeds in the cycle — collect new items into _cycleBatch[]
 *   2. After ALL feeds are done → sort entire batch by publishedAt ASC (oldest first)
 *   3. Broadcast oldest→newest
 *
 * Why oldest→newest? Client does insertBefore(card, firstChild) on each arrival.
 * Broadcasting oldest first means the newest article ends up on top after all
 * insertions — which is the correct display order.
 *
 * Startup backfill: accepts articles ≤ 45 min old (some context on load)
 * Live polls:       accepts articles ≤ 30 min old (fresh only)
 */

'use strict';

const RSSParser = require('rss-parser');
const parser = new RSSParser({ timeout: 20000 });

// ── FEEDS ─────────────────────────────────────────────────────────────────
const NEWS_FEEDS = [
  // TIER 1 — polled every 2 min + every 5 min
  { name: 'CoinDesk',        url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',       priority: true },
  { name: 'Crypto Briefing', url: 'https://cryptobriefing.com/feed/',                      priority: true },
  { name: 'Cointelegraph',   url: 'https://cointelegraph.com/rss',                         priority: true },
  { name: 'The Block',       url: 'https://www.theblock.co/rss.xml',                       priority: true },
  { name: 'Decrypt',         url: 'https://decrypt.co/feed',                               priority: true },
  { name: 'Bitcoin.com',     url: 'https://news.bitcoin.com/feed/',                        priority: true },
  { name: 'Bitcoinist',      url: 'https://bitcoinist.com/feed/',                          priority: true },

  // TIER 2 — polled every 5 min only
  { name: 'AMBCrypto',       url: 'https://ambcrypto.com/feed/',                           priority: false },
  { name: 'U.Today',         url: 'https://u.today/rss',                                   priority: false },
  { name: 'NewsBTC',         url: 'https://www.newsbtc.com/feed/',                         priority: false },
  { name: 'BeInCrypto',      url: 'https://beincrypto.com/feed/',                          priority: false },
  { name: 'CryptoSlate',     url: 'https://cryptoslate.com/feed/',                         priority: false },
  { name: 'The Defiant',     url: 'https://thedefiant.io/feed',                            priority: false },
  { name: 'Bankless',        url: 'https://www.bankless.com/feed',                         priority: false },
  { name: 'DL News',         url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',         priority: false },
  { name: 'Protos',          url: 'https://protos.com/feed/',                              priority: false },
  { name: 'CoinGecko News',  url: 'https://www.coingecko.com/en/news/feed',                priority: false },
  { name: 'CoinPedia',       url: 'https://coinpedia.org/feed/',                           priority: false },
  { name: 'CryptoSlate News',url: 'https://cryptoslate.com/category/news/feed/',           priority: false },
  { name: 'Coinpaprika',     url: 'https://coinpaprika.com/news/feed/',                    priority: false },
  { name: 'ForbesCrypto',    url: 'https://www.forbes.com/digital-assets/feed/',           priority: false },
  { name: 'Benzinga Crypto', url: 'https://www.benzinga.com/topic/cryptocurrency/feed',    priority: false },
  { name: 'ZyCrypto',        url: 'https://zycrypto.com/feed/',                            priority: false },
  { name: 'CryptoDaily',     url: 'https://cryptodaily.co.uk/feed',                       priority: false },
  { name: 'Blockonomi',      url: 'https://blockonomi.com/feed/',                          priority: false },
  { name: 'CryptoPotato',    url: 'https://cryptopotato.com/feed/',                       priority: false },
];

// ── STATE ─────────────────────────────────────────────────────────────────
let broadcastFn     = null;
let isFirstPoll     = true;   // startup backfill vs. live mode
let _cycleBatch     = [];     // accumulates articles during a poll cycle
let _cycleRunning   = false;  // prevents overlapping cycles
const seenArticleUrls = new Set();

// ── TITLE-BASED DEDUP ──────────────────────────────────────────────────────
// The same story is often published by multiple sources, or RSS feeds serve
// the same article with different URLs (UTM params, CDN paths, etc.).
// Normalise titles and reject anything with ≥70% word overlap against a title
// already broadcast in the last 4 hours.
const TITLE_DEDUP_WINDOW = 24 * 60 * 60 * 1000;  // 24 hours
const seenTitles = new Map();  // normHash → { ts, source }

function _normNewsTitle(title) {
  const stops = new Set(['a','an','the','is','in','on','at','to','of','for',
    'and','or','but','with','by','as','from','its','it','this','that',
    'be','are','was','were','has','have','had','will','not','no','s']);
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stops.has(w))
    .sort()
    .join(' ');
}

function isDuplicateTitle(title, source) {
  const normA  = _normNewsTitle(title);
  const wordsA = new Set(normA.split(' ').filter(Boolean));
  if (wordsA.size === 0) return false;
  const now = Date.now();
  for (const [hash, entry] of seenTitles) {
    if (now - entry.ts > TITLE_DEDUP_WINDOW) { seenTitles.delete(hash); continue; }
    const wordsB = new Set(hash.split(' ').filter(Boolean));
    let shared = 0;
    for (const w of wordsA) if (wordsB.has(w)) shared++;
    const union = wordsA.size + wordsB.size - shared;
    const overlap = shared / union;
    if (overlap >= 0.70) {
      console.log('[News] Dedup blocked (' + (overlap*100).toFixed(0) + '% overlap, first seen from ' + entry.source + '): "' + title.slice(0,60) + '"');
      return true;
    }
  }
  seenTitles.set(normA, { ts: now, source });
  return false;
}

// Age limits
const BACKFILL_MAX_AGE_MS = 12 * 60 * 60 * 1000;  // 12 hours on startup
const LIVE_MAX_AGE_MS     = 12 * 60 * 60 * 1000;  // 12 hours on live polls

// ── CONTENT FILTERS ───────────────────────────────────────────────────────
const BREAKING_KEYWORDS = [
  'breaking', 'just in', 'urgent', 'alert', 'hack', 'exploit', 'crash',
  'ban', 'sec', 'lawsuit', 'arrest', 'seized', 'collapse', 'emergency',
  'flash crash', 'liquidat', 'etf approved', 'etf rejected', 'halving',
  'fork', 'listing', 'delisting', 'investigation', 'regulatory',
];

const ANALYTICAL_PATTERNS = [
  /\?$/,
  /\bwhat's the target\b/i,
  /\bhere's why\b/i,
  /\bhere are the\b/i,
  /\bhere is why\b/i,
  /\bcould\b.*\b(reach|hit|drop|surge|fall)\b/i,
  /\bpredicts?\b/i,
  /\banalyst says?\b/i,
  /\banalysts? (say|think|warn|expect|believe)\b/i,
  /\bwave analyst\b/i,
  /\bprice prediction\b/i,
  /\b(bull|bear)ish signal\b/i,
  /\bwhy (bitcoin|ethereum|btc|eth|crypto|market)\b/i,
  /\bwhat happens (if|when|next)\b/i,
  /\bis it (too late|time to)\b/i,
  /\b(will|can|should) (bitcoin|ethereum|btc|eth|crypto)\b/i,
  /\bhow (high|low|much|long)\b/i,
  /\bhere's what\b/i,
  /\bthis is why\b/i,
  /\bnext target\b/i,
  /\bprice outlook\b/i,
  /\bmarket analysis\b/i,
  /\btechnical analysis\b/i,
];

function isAnalytical(title) {
  return ANALYTICAL_PATTERNS.some(rx => rx.test(title));
}

function isBreaking(title) {
  if (isAnalytical(title)) return false;
  const t = title.toLowerCase();
  return BREAKING_KEYWORDS.some(k => t.includes(k));
}

function extractTags(title) {
  const tags = [];
  const coins = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LINK','UNI','MATIC','DOT'];
  coins.forEach(coin => { if (title.toUpperCase().includes(coin)) tags.push(coin); });
  if (title.toLowerCase().includes('bitcoin')  && !tags.includes('BTC')) tags.push('BTC');
  if (title.toLowerCase().includes('ethereum') && !tags.includes('ETH')) tags.push('ETH');
  if (title.toLowerCase().includes('solana')   && !tags.includes('SOL')) tags.push('SOL');
  if (title.toLowerCase().includes('sec'))        tags.push('SEC');
  if (title.toLowerCase().includes('etf'))        tags.push('ETF');
  if (title.toLowerCase().includes('defi'))       tags.push('DeFi');
  if (title.toLowerCase().includes('regulation')) tags.push('Regulation');
  if (title.toLowerCase().includes('hack') || title.toLowerCase().includes('exploit')) tags.push('Security');
  return [...new Set(tags)].slice(0, 4);
}

// ── POLL SINGLE FEED — pushes items into _cycleBatch (never broadcasts directly)
async function pollFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    let added = 0;

    for (const item of parsed.items.slice(0, 100)) {
      const url = item.link || item.guid;
      if (!url || seenArticleUrls.has(url)) continue;

      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      const maxAge  = isFirstPoll ? BACKFILL_MAX_AGE_MS : LIVE_MAX_AGE_MS;

      // Age filter
      if (pubDate && (Date.now() - pubDate.getTime()) > maxAge) continue;
      if (!pubDate && !isFirstPoll) continue;  // no date = skip on live polls

      // Title-based dedup — blocks same story from multiple sources or re-polled URLs
      if (isDuplicateTitle(item.title || '', feed.name)) continue;

      seenArticleUrls.add(url);
      _cycleBatch.push({
        type:        'news',
        title:       item.title || '',
        summary:     item.contentSnippet || item.content?.replace(/<[^>]+>/g, '').slice(0, 200) || '',
        url,
        source:      feed.name,
        publishedAt: item.pubDate || new Date().toISOString(),
        tags:        extractTags(item.title || ''),
        breaking:    isBreaking(item.title || ''),
        priority:    feed.priority || false,
      });
      added++;
    }

    if (added > 0) console.log(`[News] +${added} queued from ${feed.name}`);
  } catch (_err) {
    // timeouts are normal — silently skip
  }
}

// ── FLUSH CYCLE — sort everything together and broadcast oldest→newest ──────
// Broadcasting oldest→newest is deliberate: the client does
// insertBefore(card, firstChild) on each item, so the last item broadcast
// (newest) ends up at the very top — correct chronological order on screen.
function flushCycle(label) {
  if (_cycleBatch.length === 0) return;

  // Sort oldest → newest (ascending publishedAt)
  _cycleBatch.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  console.log(`[News] ${label}: broadcasting ${_cycleBatch.length} articles oldest→newest`);

  for (const item of _cycleBatch) {
    if (broadcastFn) broadcastFn(item);
  }

  _cycleBatch = [];
}

// ── POLL A SET OF FEEDS (returns Promise) ────────────────────────────────
async function runCycle(feeds, label) {
  if (_cycleRunning) {
    console.log(`[News] ${label} skipped — previous cycle still running`);
    return;
  }
  _cycleRunning = true;
  _cycleBatch   = [];

  try {
    for (const feed of feeds) await pollFeed(feed);
    flushCycle(label);
  } finally {
    _cycleRunning = false;
  }
}

// ── START ─────────────────────────────────────────────────────────────────
function startNewsPolling(broadcast) {
  broadcastFn = broadcast;
  console.log(`[News] Starting — ${NEWS_FEEDS.length} sources configured`);

  // Startup backfill — all feeds, allow ≤45min articles
  runCycle(NEWS_FEEDS, 'startup backfill').then(() => {
    isFirstPoll = false;
    console.log('[News] Live mode — articles ≤30min only, ordered by publish time');
  });

  // Priority feeds every 2 min
  const priorityFeeds = NEWS_FEEDS.filter(f => f.priority);
  setInterval(() => runCycle(priorityFeeds, 'priority poll'), 2 * 60 * 1000);

  // All feeds every 5 min
  setInterval(() => runCycle(NEWS_FEEDS, 'full poll'), 5 * 60 * 1000);

  // Hourly URL cache clear (so very old re-posted stories don't get blocked forever)
  setInterval(() => {
    seenArticleUrls.clear();
    // Don't clear seenTitles here — it self-expires per entry (4h window).
    // Clearing it would allow the same story to re-fire after an hour.
    console.log('[News] URL cache cleared (title dedup still active)');
  }, 60 * 60 * 1000);
}

module.exports = { startNewsPolling };
