#!/usr/bin/env node
const http = require('http'), path = require('path'), fs = require('fs');

function loadConfig() {
  const ep = path.join(__dirname, 'config.env');
  const cfg = { baseUrl:'https://linux.do', defaultCategory:'ai', pageSize:30, maxContentLength:3000, maxPosts:10, vcpPort:6005, apiKey:'' };
  try {
    for (const l of fs.readFileSync(ep,'utf-8').split('\n')) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq === -1) continue;
      const k = t.substring(0, eq).trim(), v = t.substring(eq + 1).trim();
      if (k === 'DISCOURSE_BASE_URL') cfg.baseUrl = v.replace(/\/+$/, '');
      else if (k === 'DEFAULT_CATEGORY') cfg.defaultCategory = v;
      else if (k === 'MAX_CONTENT_LENGTH') cfg.maxContentLength = parseInt(v) || 3000;
      else if (k === 'MAX_POSTS') cfg.maxPosts = parseInt(v) || 10;
      else if (k === 'VCP_PORT') cfg.vcpPort = parseInt(v) || 6005;
      else if (k === 'VCP_API_KEY') cfg.apiKey = v;
    }
  } catch (e) {}
  try {
    const me = fs.readFileSync(path.join(__dirname, '..', '..', 'config.env'), 'utf-8');
    if (!cfg.apiKey) { const m = me.match(/^Key=(.+)$/m); if (m) cfg.apiKey = m[1].trim().replace(/^["']|["']$/g, ''); }
    const pm = me.match(/^PORT=(.+)$/m); if (pm) cfg.vcpPort = parseInt(pm[1].trim()) || 6005;
  } catch (e) {}
  return cfg;
}function fetchViaUrlFetch(url, config) {
  return new Promise((resolve, reject) => {
    const LB = '<'.repeat(3), RB = '>'.repeat(3);
    const TR = LB + '[TOOL_REQUEST]' + RB;
    const ETR = LB + '[END_TOOL_REQUEST]' + RB;
    const S = '\u300c\u59cb\u300d', E = '\u300c\u672b\u300d';
    const body = TR + '\ntool_name:' + S + 'UrlFetch' + E + ',\nurl:' + S + url + E + ',\nmode:' + S + 'text' + E + '\n' + ETR;
    const opts = { hostname:'127.0.0.1', port:config.vcpPort, path:'/v1/human/tool', method:'POST',
      headers:{ 'Content-Type':'text/plain; charset=utf-8', 'Content-Length':Buffer.byteLength(body) }, timeout:60000 };
    if (config.apiKey) opts.headers['Authorization'] = 'Bearer ' + config.apiKey;
    const req = http.request(opts, res => {
      let d = ''; res.setEncoding('utf-8');
      res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) { reject(new Error('VCP HTTP ' + res.statusCode)); return; } resolve(d); });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout 60s')); });
    req.write(body); req.end();
  });
}

function extractJSON(raw) {
  let p;
  try { p = JSON.parse(raw); } catch (e) {
    const i = raw.search(/[\[{]/); if (i >= 0) try { return JSON.parse(raw.substring(i)); } catch (e2) {}
    throw new Error('Parse fail: ' + raw.substring(0, 500));
  }
  const r0 = p.result || p.original_plugin_output; if (r0) {
    const r = r0;
    if (typeof r === 'string') { try { return JSON.parse(r); } catch(e) {} const i = r.search(/[\[{]/); if (i >= 0) try { return JSON.parse(r.substring(i)); } catch(e) {} }
    if (typeof r === 'object') {
      if (r.topic_list || r.post_stream || r.topics) return r;
      if (r.content && Array.isArray(r.content)) {
        for (const it of r.content) {
          if (it.type === 'text' && it.text) {
            try { return JSON.parse(it.text); } catch(e) {}
            const i = it.text.search(/[\[{]/); if (i >= 0) try { return JSON.parse(it.text.substring(i)); } catch(e) {}
          }
        }
      }
    }
    if (p.messageForAI) { try { return JSON.parse(p.messageForAI); } catch(e) {} }
  }
  if (p.topic_list || p.post_stream || p.topics) return p;
  throw new Error('Unknown: ' + Object.keys(p).join(','));
}

async function fetchJSON(url) { const cfg = loadConfig(); const raw = await fetchViaUrlFetch(url, cfg); return extractJSON(raw); }function stripHtml(h) {
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
}async function readTopic(args, cfg) {
  let tid = args.topic_id;
  if (!tid && args.url) { const m = args.url.match(/\/t\/[^\/]*?(\d+)/); if (m) tid = parseInt(m[1]); }
  if (!tid) throw new Error('Need topic_id or url');
  const maxP = parseInt(args.max_posts) || cfg.maxPosts, startN = parseInt(args.post_number) || 1;
  const data = await fetchJSON(cfg.baseUrl + '/t/' + tid + '.json');
  const ps = data.post_stream || {}; let posts = ps.posts || [];
  if (startN > 1 || posts.length < maxP) {
    const all = ps.stream || [], needed = all.slice(startN - 1, startN - 1 + maxP);
    const loaded = new Set(posts.map(p => p.id)), missing = needed.filter(id => !loaded.has(id));
    if (missing.length > 0) {
      try {
        const extra = await fetchJSON(cfg.baseUrl + '/t/' + tid + '/posts.json?' + missing.map(id => 'post_ids[]=' + id).join('&'));
        if (extra.post_stream && extra.post_stream.posts) posts = posts.concat(extra.post_stream.posts);
      } catch (e) {}
    }
  }
  posts.sort((a, b) => a.post_number - b.post_number);
  if (startN > 1) posts = posts.filter(p => p.post_number >= startN);
  posts = posts.slice(0, maxP);
  const L = ['# ' + data.title, 'ID:' + tid + ' | Re:' + (data.posts_count - 1) + ' | Views:' + data.views + ' | Likes:' + data.like_count + ' | Tags:' + ((data.tags || []).map(function(x){return typeof x==='object'?(x.name||x.id||String(x)):x}).join(',') || 'none'), '---'];
  for (const p of posts) {
    let c = stripHtml(p.cooked || '');
    if (c.length > cfg.maxContentLength) c = c.substring(0, cfg.maxContentLength) + '\n...(truncated)';
    L.push('\n### ' + (p.post_number === 1 ? 'OP' : '#' + p.post_number) + ' @' + p.username + ' | ' + fmtTime(p.created_at) + (p.like_count > 0 ? ' | L' + p.like_count : ''));
    L.push(c);
  }
  const rem = data.posts_count - (posts.length + startN - 1);
  if (rem > 0) L.push('\n---\n' + rem + ' more. post_number=' + (startN + posts.length));
  return L.join('\n');
}async function listTopics(args, cfg) {
  const cat = args.tag ? (args.category || '') : (args.category || cfg.defaultCategory), page = parseInt(args.page) || 0, tag = args.tag || '', order = args.order || 'latest';
  let url;
  if (tag) {
    url = cat ? cfg.baseUrl + '/tags/c/' + cat + '/' + tag + '.json'
              : cfg.baseUrl + '/tag/' + tag + '.json' + (page > 0 ? '?page=' + page : '');
  } else if (cat) {
    url = cfg.baseUrl + '/c/' + encodeURIComponent(cat) + '.json?page=' + page;
    if (order === 'views') url += '&order=views'; else if (order === 'posts') url += '&order=posts';
  } else { url = cfg.baseUrl + '/latest.json?page=' + page; }
  const data = await fetchJSON(url); 
  const topics = (data.topic_list || {}).topics || [], users = data.users || [];
  const um = {}; for (const u of users) um[u.id] = u.username;
  const L = ['## ' + cfg.baseUrl + ' - ' + (cat || 'all') + (tag ? ' [' + tag + ']' : '') + ' (p' + (page + 1) + ')',
    '| # | Title | Author | Re | Views | Active | Tags |', '|---|-------|--------|-----|-------|--------|------|'];
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i], au = um[t.posters && t.posters[0] ? t.posters[0].user_id : 0] || t.last_poster_username || '?';
    L.push('| ' + (i + 1) + ' | ' + (t.pinned ? 'pin ' : '') + '**' + t.title + '** (' + t.id + ') | ' + au + ' | ' + (t.posts_count - 1) + ' | ' + t.views + ' | ' + fmtTime(t.last_posted_at) + ' | ' + ((t.tags || []).map(function(x){return typeof x==='object'?(x.name||x.id||String(x)):x}).join(',') || '-') + ' |');
  }
  L.push('\n' + topics.length + ' topics. ReadTopic + topic_id for details.');
  if (topics.length >= cfg.pageSize) L.push('Next: page=' + (page + 1));
  return L.join('\n');
}async function searchForum(args, cfg) {
  if (!args.keyword) throw new Error('Need keyword');
  let q = args.keyword; if (args.category) q += ' category:' + args.category;
  const order = args.order || 'relevance';
  if (order === 'latest') q += ' order:latest'; else if (order === 'likes') q += ' order:likes';
  const data = await fetchJSON(cfg.baseUrl + '/search.json?q=' + encodeURIComponent(q) + '&page=' + (parseInt(args.page) || 1));
  const topics = data.topics || [], sp = data.posts || [];
  const L = ['## Search: "' + args.keyword + '"'];
  if (!topics.length && !sp.length) { L.push('No results.'); return L.join('\n'); }
  if (topics.length) {
    L.push('| # | Title | Re | Views | Tags |', '|---|-------|-----|-------|------|');
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      L.push('| ' + (i + 1) + ' | **' + t.title + '** (' + t.id + ') | ' + ((t.posts_count || 1) - 1) + ' | ' + (t.views || 0) + ' | ' + ((t.tags || []).join(',') || '-') + ' |');
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
  const data = await fetchJSON(cfg.baseUrl + '/categories.json');
  const cats = (data.category_list || {}).categories || [];
  const L = ['## ' + cfg.baseUrl + ' Categories (' + cats.length + ')', '| # | Category | Slug | Topics | Posts |', '|---|----------|------|--------|-------|'];
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    L.push('| ' + (i + 1) + ' | ' + (c.name || '?') + ' | `' + (c.slug || '?') + '` | ' + (c.topic_count || 0) + ' | ' + (c.post_count || 0) + ' |');
  }
  return L.join('\n');
}

async function listTags(args, cfg) {
  const data = await fetchJSON(cfg.baseUrl + '/tags.json');
  const extras = data.extras || {};
  const tagGroups = extras.tag_groups || [];
  const allTags = [];
  if (tagGroups.length > 0) {
    for (const group of tagGroups) {
      const tags = group.tags || [];
      for (const t of tags) {
        allTags.push({ name: t.text || t.name || t.id, count: t.count || 0, id: t.id || '' });
      }
    }
  }
  if (allTags.length === 0 && data.tags) {
    for (const t of data.tags) {
      allTags.push({ name: t.text || t.name || t.id, count: t.count || 0, id: t.id || '' });
    }
  }
  allTags.sort((a, b) => b.count - a.count);
  const L = ['## ' + cfg.baseUrl + ' Tags (' + allTags.length + ')', '| # | Tag | Path | Posts |', '|---|-----|------|-------|'];
  for (let i = 0; i < allTags.length; i++) {
    const t = allTags[i];
    const tagPath = t.id ? (t.id + '-tag/' + t.id) : t.name;
    L.push('| ' + (i + 1) + ' | ' + t.name + ' | `' + tagPath + '` | ' + t.count + ' |');
  }
  return L.join('\n');
}

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
      default: throw new Error('Unknown: ' + cmd);
    }
    console.log(JSON.stringify({ status: 'success', result: result, messageForAI: result }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: e.message || String(e) }));
  }
  process.exit(0);
}
main();