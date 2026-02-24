#!/usr/bin/env node
const path = require('path'), fs = require('fs');

// ============================================================
// DiscourseReader v1.5.1 - Puppeteer + Multi-Forum API Key Auth
// Author: Rosa | License: MIT
// Architecture: Puppeteer(stealth) handles CF, API Key handles Discourse auth
// ============================================================

let puppeteerExtra, StealthPlugin;
const nmPath = path.join(__dirname, '..', '..', 'node_modules');
try {
  puppeteerExtra = require(path.join(nmPath, 'puppeteer-extra'));
  StealthPlugin = require(path.join(nmPath, 'puppeteer-extra-plugin-stealth'));
  puppeteerExtra.use(StealthPlugin());
} catch (e) {
  console.log(JSON.stringify({ status:'error', error:'Puppeteer not found in VCP node_modules. Please run npm install in VCP root.' }));
  process.exit(1);
}

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteerExtra.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--no-first-run','--no-zygote','--single-process',
           '--disable-extensions','--disable-background-networking']
  });
  return _browser;
}
async function closeBrowser() {
  if (_browser) { try { await _browser.close(); } catch(e){} _browser = null; }
}

// ============================================================
// Configuration
// ============================================================
function loadConfig() {
  const ep = path.join(__dirname, 'config.env');
  const cfg = {
    baseUrl: 'https://linux.do',
    defaultCategory: 'develop',
    pageSize: 30,
    maxContentLength: 3000,
    maxPosts: 10,
    apiKeys: {},   // forum_{name}_api_key -> User API Key (priority)
    cookies: {},   // forum_{name}_cookie  -> raw cookie string (fallback)
  };
  try {
    for (const l of fs.readFileSync(ep, 'utf-8').split('\n')) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq === -1) continue;
      const k = t.substring(0, eq).trim(), v = t.substring(eq + 1).trim();
      if (k === 'DISCOURSE_BASE_URL') cfg.baseUrl = v.replace(/\/+$/, '');
      else if (k === 'DEFAULT_CATEGORY') cfg.defaultCategory = v;
      else if (k === 'MAX_CONTENT_LENGTH') cfg.maxContentLength = parseInt(v) || 3000;
      else if (k === 'MAX_POSTS') cfg.maxPosts = parseInt(v) || 10;
      else if (k.startsWith('forum_') && k.endsWith('_api_key')) {
        const name = k.substring(6, k.length - 8); // forum_{name}_api_key
        if (name) cfg.apiKeys[name] = v;
      }
      else if (k.startsWith('forum_') && k.endsWith('_cookie')) {
        const name = k.substring(6, k.length - 7); // forum_{name}_cookie
        if (name) cfg.cookies[name] = v;
      }
    }
  } catch (e) {}
  return cfg;
}

// Domain fuzzy matching (shared logic for both apiKeys and cookies)
function matchByDomain(url, map) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [name, value] of Object.entries(map)) {
      if (host.replace(/\./g, '').includes(name.replace(/_/g, '')) ||
          name.replace(/_/g, '').includes(host.replace(/\./g, '')) ||
          host.includes(name.replace(/_/g, '.'))) return value;
    }
  } catch (e) {}
  return null;
}

// Parse raw cookie string into Puppeteer setCookie format
function parseCookies(str, domain) {
  const out = [], skipNames = new Set(['cf_clearance']); // TLS-fingerprint-bound
  if (!str) return out;
  for (const part of str.split(';')) {
    const t = part.trim(); if (!t) continue;
    const eq = t.indexOf('='); if (eq <= 0) continue;
    const name = t.substring(0, eq).trim(), value = t.substring(eq + 1).trim();
    if (value.includes('{') || value.includes('}')) continue; // skip JSON fields
    if (skipNames.has(name)) continue;
    out.push({ name, value, domain: '.' + domain, path: '/', httpOnly: false, secure: true });
  }
  return out;
}

// ============================================================
// Core: Puppeteer fetch with API Key (priority) or cookie (fallback)
// ============================================================
async function fetchJSON(url, cfg) {
  const apiKey = matchByDomain(url, cfg.apiKeys);
  const cookie = matchByDomain(url, cfg.cookies);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Inject cookies if available (fallback auth)
    if (cookie) {
      const domain = new URL(url).hostname;
      const parsed = parseCookies(cookie, domain);
      if (parsed.length > 0) await page.setCookie(...parsed);
    }
    // Set headers: API Key takes priority
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['User-Api-Key'] = apiKey;
    await page.setExtraHTTPHeaders(headers);

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    if (!resp) throw new Error('No response');
    if (!resp.ok()) {
      let body = '';
      try { body = await page.evaluate(() => document.body.innerText || ''); } catch (e) {}
      if (body) {
        try {
          const j = JSON.parse(body);
          if (j.errors || j.error_type || j.failed)
            throw new Error('Discourse: ' + (j.errors || []).join(', ') + ' ' + (j.error_type || '') + ' ' + (j.message || j.failed || ''));
        } catch (e) { if (e.message.startsWith('Discourse:')) throw e; }
      }
      throw new Error('HTTP ' + resp.status() + (body ? ': ' + body.substring(0, 200) : ''));
    }
    const text = await page.evaluate(() => document.body.innerText || document.body.textContent);
    const data = JSON.parse(text);
    if (data.failed) throw new Error('Discourse: ' + (data.message || data.failed));
    if (data.error_type) throw new Error('Discourse: ' + data.error_type + ' - ' + (data.errors || []).join(', '));
    return data;
  } finally {
    await page.close();
  }
}

// ============================================================
// Helpers
// ============================================================
function stripHtml(h) {
  if (!h) return '';
  return h
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]')
    .replace(/<img[^>]*>/gi, '[img]')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2($1)')
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, l, t) => '#'.repeat(parseInt(l)) + ' ' + t + '\n')
    .replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n')
    .replace(/<blockquote[^>]*>/gi, '> ').replace(/<\/blockquote>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '')
    .replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function fmtTime(s) {
  if (!s) return '?';
  try {
    const d = new Date(s), ms = Date.now() - d.getTime();
    const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
    if (m < 1) return 'now'; if (m < 60) return m + 'm'; if (h < 24) return h + 'h'; if (dy < 7) return dy + 'd';
    return (d.getMonth() + 1) + '/' + d.getDate();
  } catch (e) { return s; }
}

function fmtTags(tags) {
  return (tags || []).map(x => typeof x === 'object' ? (x.name || x.id || String(x)) : x).join(',') || '-';
}

// ============================================================
// Commands
// ============================================================
async function readTopic(args, cfg) {
  let tid = args.topic_id;
  if (!tid && args.url) { const m = args.url.match(/\/t\/[^\/]*?(\d+)/); if (m) tid = parseInt(m[1]); }
  if (!tid) throw new Error('Need topic_id or url');
  const maxP = parseInt(args.max_posts) || cfg.maxPosts, startN = parseInt(args.post_number) || 1;
  const base = args.base_url || cfg.baseUrl;

  const data = await fetchJSON(base + '/t/' + tid + '.json', cfg);
  const ps = data.post_stream || {}; let posts = ps.posts || [];

  if (startN > 1 || posts.length < maxP) {
    const all = ps.stream || [], needed = all.slice(startN - 1, startN - 1 + maxP);
    const loaded = new Set(posts.map(p => p.id)), missing = needed.filter(id => !loaded.has(id));
    if (missing.length > 0) {
      try {
        const extra = await fetchJSON(base + '/t/' + tid + '/posts.json?' + missing.map(id => 'post_ids[]=' + id).join('&'), cfg);
        if (extra.post_stream && extra.post_stream.posts) posts = posts.concat(extra.post_stream.posts);
      } catch (e) {}
    }
  }
  posts.sort((a, b) => a.post_number - b.post_number);
  if (startN > 1) posts = posts.filter(p => p.post_number >= startN);
  posts = posts.slice(0, maxP);

  const L = ['# ' + data.title, 'ID:' + tid + ' | Re:' + (data.posts_count - 1) + ' | Views:' + data.views + ' | Likes:' + data.like_count + ' | Tags:' + fmtTags(data.tags), '---'];
  for (const p of posts) {
    let c = stripHtml(p.cooked || '');
    if (c.length > cfg.maxContentLength) c = c.substring(0, cfg.maxContentLength) + '\n...(truncated)';
    L.push('\n### ' + (p.post_number === 1 ? 'OP' : '#' + p.post_number) + ' @' + p.username + ' | ' + fmtTime(p.created_at) + (p.like_count > 0 ? ' | L' + p.like_count : ''));
    L.push(c);
  }
  const rem = data.posts_count - (posts.length + startN - 1);
  if (rem > 0) L.push('\n---\n' + rem + ' more. post_number=' + (startN + posts.length));
  return L.join('\n');
}

async function listTopics(args, cfg) {
  const base = args.base_url || cfg.baseUrl;
  const cat = args.tag ? (args.category || '') : (args.category || cfg.defaultCategory);
  const page = parseInt(args.page) || 0, tag = args.tag || '', order = args.order || 'latest';
  let url;
  if (tag) {
    url = cat ? base + '/tags/c/' + cat + '/' + tag + '.json' : base + '/tag/' + tag + '.json' + (page > 0 ? '?page=' + page : '');
  } else if (cat) {
    url = base + '/c/' + encodeURIComponent(cat) + '.json?page=' + page;
    if (order === 'views') url += '&order=views'; else if (order === 'posts') url += '&order=posts';
  } else { url = base + '/latest.json?page=' + page; }

  const data = await fetchJSON(url, cfg);
  const topics = (data.topic_list || {}).topics || [], users = data.users || [];
  const um = {}; for (const u of users) um[u.id] = u.username;
  const L = ['## ' + base + ' - ' + (cat || 'all') + (tag ? ' [' + tag + ']' : '') + ' (p' + (page + 1) + ')',
    '| # | Title | Author | Re | Views | Active | Tags |', '|---|-------|--------|-----|-------|--------|------|'];
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i], au = um[t.posters && t.posters[0] ? t.posters[0].user_id : 0] || t.last_poster_username || '?';
    L.push('| ' + (i + 1) + ' | ' + (t.pinned ? 'pin ' : '') + '**' + t.title + '** (' + t.id + ') | ' + au + ' | ' + (t.posts_count - 1) + ' | ' + t.views + ' | ' + fmtTime(t.last_posted_at) + ' | ' + fmtTags(t.tags) + ' |');
  }
  L.push('\n' + topics.length + ' topics. ReadTopic + topic_id for details.');
  if (topics.length >= cfg.pageSize) L.push('Next: page=' + (page + 1));
  return L.join('\n');
}

async function searchForum(args, cfg) {
  if (!args.keyword) throw new Error('Need keyword');
  const base = args.base_url || cfg.baseUrl;
  let q = args.keyword; if (args.category) q += ' category:' + args.category;
  const order = args.order || 'relevance';
  if (order === 'latest') q += ' order:latest'; else if (order === 'likes') q += ' order:likes';

  const data = await fetchJSON(base + '/search.json?q=' + encodeURIComponent(q) + '&page=' + (parseInt(args.page) || 1), cfg);
  const topics = data.topics || [], sp = data.posts || [];
  const L = ['## Search: "' + args.keyword + '"'];
  if (!topics.length && !sp.length) { L.push('No results.'); return L.join('\n'); }
  if (topics.length) {
    L.push('| # | Title | Re | Views | Tags |', '|---|-------|-----|-------|------|');
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      L.push('| ' + (i + 1) + ' | **' + t.title + '** (' + t.id + ') | ' + ((t.posts_count || 1) - 1) + ' | ' + (t.views || '-') + ' | ' + fmtTags(t.tags) + ' |');
    }
  }
  if (sp.length) {
    const tm = {}; for (const t of topics) tm[t.id] = t;
    L.push('\n### Snippets');
    for (let i = 0; i < Math.min(sp.length, 10); i++) {
      const p = sp[i], topic = tm[p.topic_id] || {};
      L.push('**' + (i + 1) + '. [' + (topic.title || '?') + '](' + p.topic_id + ') #' + p.post_number + '** @' + p.username + '\n> ' + stripHtml(p.blurb || '').substring(0, 200));
    }
  }
  L.push('\nReadTopic + topic_id for details.');
  return L.join('\n');
}

async function listCategories(args, cfg) {
  const base = args.base_url || cfg.baseUrl;
  const data = await fetchJSON(base + '/categories.json', cfg);
  const cats = (data.category_list || {}).categories || [];
  const L = ['## ' + base + ' Categories (' + cats.length + ')', '| # | Category | Slug | Topics | Posts |', '|---|----------|------|--------|-------|'];
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    L.push('| ' + (i + 1) + ' | ' + (c.name || '?') + ' | `' + (c.slug || '?') + '` | ' + (c.topic_count || 0) + ' | ' + (c.post_count || 0) + ' |');
  }
  return L.join('\n');
}

async function listTags(args, cfg) {
  const base = args.base_url || cfg.baseUrl;
  const data = await fetchJSON(base + '/tags.json', cfg);
  const seen = new Set(), allTags = [];
  const extras = data.extras || {};
  for (const group of (extras.tag_groups || [])) {
    for (const t of (group.tags || [])) {
      const name = t.text || t.name || t.id;
      if (!seen.has(name)) { seen.add(name); allTags.push({ name, count: t.count || 0, id: t.id || '' }); }
    }
  }
  for (const t of (data.tags || [])) {
    const name = t.text || t.name || t.id;
    if (!seen.has(name)) { seen.add(name); allTags.push({ name, count: t.count || 0, id: t.id || '' }); }
  }
  allTags.sort((a, b) => b.count - a.count);
  const L = ['## ' + base + ' Tags (' + allTags.length + ')', '| # | Tag | Path | Posts |', '|---|-----|------|-------|'];
  for (let i = 0; i < allTags.length; i++) {
    const t = allTags[i], tp = t.id ? (t.id + '-tag/' + t.id) : t.name;
    L.push('| ' + (i + 1) + ' | ' + t.name + ' | `' + tp + '` | ' + t.count + ' |');
  }
  return L.join('\n');
}

// ============================================================
// Entry
// ============================================================
async function main() {
  let input = ''; process.stdin.setEncoding('utf-8');
  await new Promise(r => { process.stdin.on('data', c => input += c); process.stdin.on('end', r); setTimeout(r, 5000); });
  try {
    const args = JSON.parse(input.trim()), cfg = loadConfig(), cmd = args.command || '';
    let result;
    switch (cmd) {
      case 'ListTopics': result = await listTopics(args, cfg); break;
      case 'ReadTopic': result = await readTopic(args, cfg); break;
      case 'SearchForum': result = await searchForum(args, cfg); break;
      case 'ListTags': result = await listTags(args, cfg); break;
      case 'ListCategories': result = await listCategories(args, cfg); break;
      default: throw new Error('Unknown command: ' + cmd + '. Available: ListTopics, ReadTopic, SearchForum, ListTags, ListCategories');
    }
    console.log(JSON.stringify({ status: 'success', result, messageForAI: result }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: e.message || String(e) }));
  }
  await closeBrowser();
  process.exit(0);
}
main();