const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ACCOUNTS, EMERGENCY_KEYWORDS, LISTING_KEYWORDS } = require('./accounts');

const BEARER = process.env.TWITTER_BEARER_TOKEN;
const ID_CACHE_FILE = path.join(__dirname, 'user_ids_cache.json');
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

let userIdMap = {};
let lastTweetIds = {};
let broadcastFn = null;

// ── STARTUP BUFFER: collect all initial tweets, sort, then release ─────────
let startupBuffer = [];
let startupComplete = false;
let startupTimer = null;
let accountsPolled = 0;
let totalAccounts = 0;

function releaseStartupBuffer() {
  if (startupComplete) return;
  startupComplete = true;
  console.log('Releasing ' + startupBuffer.length + ' buffered tweets sorted by time...');
  startupBuffer.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  startupBuffer.forEach(payload => {
    if (broadcastFn) broadcastFn(payload);
  });
  startupBuffer = [];
}

function loadCache() {
  try {
    if (fs.existsSync(ID_CACHE_FILE)) {
      userIdMap = JSON.parse(fs.readFileSync(ID_CACHE_FILE, 'utf8'));
      console.log('Loaded ' + Object.keys(userIdMap).length + ' cached user IDs');
      return true;
    }
  } catch (e) { console.error('Cache read error:', e.message); }
  return false;
}

function saveCache() {
  fs.writeFileSync(ID_CACHE_FILE, JSON.stringify(userIdMap, null, 2));
}

async function resolveUserIds() {
  const handles = ACCOUNTS.map(a => a.handle);
  const chunks = [];
  for (let i = 0; i < handles.length; i += 100) chunks.push(handles.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const res = await axios.get('https://api.twitter.com/2/users/by', {
        headers: { Authorization: 'Bearer ' + BEARER },
        params: { usernames: chunk.join(','), 'user.fields': 'name,username' }
      });
      if (res.data.data) {
        res.data.data.forEach(user => {
          const account = ACCOUNTS.find(a => a.handle.toLowerCase() === user.username.toLowerCase());
          if (account) {
            userIdMap[user.username.toLowerCase()] = {
              id: user.id, name: user.name, username: user.username,
              category: account.category, emoji: account.emoji, priority: account.priority || false
            };
          }
        });
      }
      await sleep(1000);
    } catch (err) {
      const title = err.response?.data?.title || err.message;
      console.error('Error resolving user IDs:', title);
      if (title === 'CreditsDepleted' || err.response?.status === 403) {
        console.warn('Twitter credits depleted — skipping Twitter, website will still run');
        return;
      }
    }
  }
  saveCache();
  console.log('Resolved ' + Object.keys(userIdMap).length + ' user IDs');
}

async function fetchTweets(userId, sinceId) {
  const params = {
    max_results: 5,
    'tweet.fields': 'created_at,public_metrics,text,referenced_tweets',
    exclude: 'retweets,replies'
  };
  if (sinceId) params.since_id = sinceId;
  const res = await axios.get(
    'https://api.twitter.com/2/users/' + userId + '/tweets',
    { headers: { Authorization: 'Bearer ' + BEARER }, params, timeout: 10000 }
  );
  return res.data;
}

function shouldShowTweet(text) {
  if (!text) return false;
  if (/^RT @/i.test(text.trim())) return false;
  const clean = text.replace(/https?:\/\/\S+/g, '').trim();
  if (clean.length < 15) return false;
  const spam = ['follow me','follow back','giveaway','airdrop','dm me','check my bio',
    'click link','sign up now','retweet to win','like and retweet','drop your wallet','100x','1000x'];
  const lower = text.toLowerCase();
  if (spam.some(p => lower.includes(p))) return false;
  return true;
}

function isEmergency(text, category) {
  const t = text.toUpperCase();
  if (EMERGENCY_KEYWORDS.some(k => t.includes(k.toUpperCase()))) return true;
  if (category === 'Exchanges' && LISTING_KEYWORDS.some(k => t.toLowerCase().includes(k))) return true;
  return false;
}

function cleanText(text) {
  text = text.replace(/https?:\/\/t\.co\/\S+/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/#[0-9a-fA-F]{3,8};[^">]*">/g, '');
  text = text.replace(/font-[^">]*">/g, '');
  return text.trim();
}

function extractTags(text) {
  const tags = [];
  const coins = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LINK','UNI','MATIC','DOT'];
  coins.forEach(coin => { if (text.toUpperCase().includes(coin)) tags.push(coin); });
  if (/bitcoin/i.test(text) && !tags.includes('BTC')) tags.push('BTC');
  if (/ethereum/i.test(text) && !tags.includes('ETH')) tags.push('ETH');
  if (/solana/i.test(text) && !tags.includes('SOL')) tags.push('SOL');
  if (/\bsec\b/i.test(text)) tags.push('SEC');
  if (/\betf\b/i.test(text)) tags.push('ETF');
  if (/defi/i.test(text)) tags.push('DeFi');
  if (/hack|exploit/i.test(text)) tags.push('Security');
  if (/list(ing|ed)/i.test(text)) tags.push('Listing');
  return [...new Set(tags)].slice(0, 4);
}

async function pollAccount(userInfo, isStartup = false) {
  const { id, name, username, category, emoji, priority } = userInfo;
  try {
    const data = await fetchTweets(id, lastTweetIds[id]);
    if (data.data && data.data.length > 0) {
      lastTweetIds[id] = data.data[0].id;
      const tweets = [...data.data].reverse();

      tweets.forEach(tweet => {
        if (/^RT @/i.test(tweet.text.trim())) return;
        if (tweet.referenced_tweets?.some(r => r.type === 'retweeted')) return;
        if (!shouldShowTweet(tweet.text)) return;

        const tweetAge = tweet.created_at ? Date.now() - new Date(tweet.created_at).getTime() : 0;
        if (isStartup && tweetAge > FRESH_WINDOW_MS) return;

        const payload = {
          type: 'tweet',
          id: tweet.id,
          text: cleanText(tweet.text),
          author: { name, username, category, emoji },
          metrics: tweet.public_metrics,
          createdAt: tweet.created_at,
          tags: extractTags(tweet.text),
          emergency: isEmergency(tweet.text, category),
          priority: priority || false
        };

        if (isStartup && !startupComplete) {
          startupBuffer.push(payload);
        } else {
          if (broadcastFn) broadcastFn(payload);
        }
      });
    }
  } catch (err) {
    const title = err.response?.data?.title || err.message;
    if (err.response?.status === 429) {
      console.warn('Rate limited @' + username + ', waiting 5min');
      await sleep(5 * 60 * 1000);
    } else if (title === 'CreditsDepleted' || err.response?.status === 403) {
      console.warn('Credits depleted @' + username + ' — skipping, website still running');
    } else if (err.response?.status !== 404) {
      console.error('Error @' + username + ':', title);
    }
  }

  if (isStartup) {
    accountsPolled++;
    if (accountsPolled >= totalAccounts) {
      clearTimeout(startupTimer);
      releaseStartupBuffer();
    }
  }
}

function startPollingEngine() {
  const users = Object.values(userIdMap);
  if (users.length === 0) {
    console.warn('No user IDs loaded — Twitter polling skipped, website still running');
    return;
  }

  totalAccounts = users.length;
  accountsPolled = 0;

  console.log('Startup: polling ' + users.length + ' accounts for last 24h tweets...');

  startupTimer = setTimeout(() => {
    if (!startupComplete) {
      console.log('Startup timeout — releasing buffer with ' + startupBuffer.length + ' tweets');
      releaseStartupBuffer();
    }
  }, 30000);

  users.forEach((user, i) => {
    setTimeout(() => pollAccount(user, true), i * 300);
  });

  const POLL_CYCLE_MS = 5 * 60 * 1000;
  const interval = Math.floor(POLL_CYCLE_MS / users.length);
  let index = 0;

  setTimeout(() => {
    startupComplete = true;
    setInterval(() => {
      const user = users[index % users.length];
      pollAccount(user, false);
      index++;
    }, interval);

    const priority = users.filter(u => u.priority);
    setInterval(() => {
      priority.forEach(user => pollAccount(user, false));
    }, 60 * 1000);

    setInterval(() => {
      const customUsers = Object.values(userIdMap).filter(u => u.custom);
      customUsers.forEach(user => pollAccount(user, false));
      if (customUsers.length > 0) {
        console.log('[Twitter] Polled ' + customUsers.length + ' custom account(s)');
      }
    }, 3 * 60 * 1000);

    console.log('Live polling started: interval ' + (interval/1000).toFixed(1) + 's per account');
  }, 35000);
}

async function startTwitterPolling(broadcast) {
  broadcastFn = broadcast;
  console.log('Initialising Twitter engine...');
  try {
    const cached = loadCache();
    if (!cached || Object.keys(userIdMap).length < 10) {
      console.log('Resolving Twitter user IDs...');
      await resolveUserIds();
    }
    startPollingEngine();
  } catch (err) {
    console.error('Twitter startup failed (website will still run):', err.message);
    // App crash nahi hogi — website chalti rahegi
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function validateAndResolveUser(handle) {
  if (!BEARER) return { valid: false, reason: 'Twitter API not configured' };
  const clean = handle.replace('@', '').trim().toLowerCase();
  if (!clean || !/^[a-zA-Z0-9_]{1,50}$/.test(clean)) {
    return { valid: false, reason: 'Invalid username format' };
  }
  if (userIdMap[clean]) {
    return { valid: true, user: userIdMap[clean], cached: true };
  }
  try {
    const res = await axios.get('https://api.twitter.com/2/users/by/username/' + clean, {
      headers: { Authorization: 'Bearer ' + BEARER },
      params: { 'user.fields': 'name,username,profile_image_url,description' },
      timeout: 8000
    });
    if (res.data && res.data.data) {
      const u = res.data.data;
      userIdMap[clean] = { id: u.id, name: u.name, username: u.username, category: 'Custom', emoji: '👤', priority: false, custom: true };
      saveCache();
      return { valid: true, user: userIdMap[clean] };
    }
    return { valid: false, reason: 'Account not found on Twitter' };
  } catch (err) {
    if (err.response?.status === 404) return { valid: false, reason: 'Account @' + clean + ' does not exist on Twitter' };
    if (err.response?.status === 429) return { valid: false, reason: 'Rate limited — please try again in a moment' };
    return { valid: false, reason: 'Could not verify — check TWITTER_BEARER_TOKEN' };
  }
}

async function fetchCustomUserTweets(handle) {
  if (!BEARER) return [];
  const clean = handle.replace('@', '').trim().toLowerCase();
  const userInfo = userIdMap[clean];
  if (!userInfo) return [];
  try {
    const data = await fetchTweets(userInfo.id, null);
    if (!data.data) return [];
    return data.data
      .filter(t => !(/^RT @/i.test(t.text.trim())) && shouldShowTweet(t.text))
      .slice(0, 10)
      .map(tweet => ({
        type:      'tweet',
        id:        tweet.id,
        text:      cleanText(tweet.text),
        author:    { name: userInfo.name, username: userInfo.username, category: 'Custom', emoji: '👤' },
        metrics:   tweet.public_metrics,
        createdAt: tweet.created_at,
        tags:      extractTags(tweet.text),
        emergency: false,
        priority:  false,
        custom:    true
      }));
  } catch (err) {
    console.warn('[Twitter] Custom fetch @' + clean + ':', err.response?.data?.title || err.message);
    return [];
  }
}

function getUserIdMap() { return userIdMap; }

module.exports = { startTwitterPolling, validateAndResolveUser, fetchCustomUserTweets, getUserIdMap };
