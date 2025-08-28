#!/usr/bin/env node
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

// --- 配置 ---
const WORK_DIR = __dirname;
const STORK_IDS_TMP = path.join(WORK_DIR, 'stork_paper_ids.tmp.txt');        // 输入：storkid 临时列表（回退）
const NEW_STORK_TMP = path.join(WORK_DIR, 'stork_paper_ids.new.tmp.txt');    // 输入：仅本次新增的 storkid（优先）
const PUBMED_IDS_TMP = path.join(WORK_DIR, 'pubmed_ids.tmp.txt');            // 输出：相似文献 pubmedid 临时列表（去重）
const SHOW_PAPER_BASE = 'https://www.storkapp.cn/paper/showPaper.php';
const RELATED_API_URL = 'https://www.storkapp.cn/pubmed/pubmed_related_api.php';

/** 可配参数：相似数量与节流间隔（毫秒） */
const SIMILAR_NUM = parseInt(process.env.STORK_SIMILAR_NUM || '5', 10);
const FETCH_INTERVAL_MS = parseInt(process.env.STORK_FETCH_INTERVAL_MS || '1000', 10);

/** NCBI ELink 备用相似获取配置（可选） */
const NCBI_ELINK_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi';
const NCBI_TOOL = process.env.NCBI_TOOL || '';
const NCBI_EMAIL = process.env.NCBI_EMAIL || '';
const NCBI_API_KEY = process.env.NCBI_API_KEY || '';

/** NCBI EFetch（批量取 DOI）与控制参数 */
const NCBI_EFETCH_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const FETCH_PUBMED_DOI = (process.env.FETCH_PUBMED_DOI || '1') === '1'; // A2：默认开启，无 API key 也执行，保守节流
const NCBI_EFETCH_BATCH = parseInt(process.env.NCBI_EFETCH_BATCH || '5', 10);
const NCBI_EUTILS_INTERVAL_MS = parseInt(process.env.NCBI_EUTILS_INTERVAL_MS || '500', 10);
const NCBI_EUTILS_MAX_RETRIES = parseInt(process.env.NCBI_EUTILS_MAX_RETRIES || '3', 10);
const NCBI_EUTILS_RETRY_BASE_MS = parseInt(process.env.NCBI_EUTILS_RETRY_BASE_MS || '800', 10);

// HTTP 头（参考 test_fetch_post.js）
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
  'X-Requested-With': 'XMLHttpRequest'
};
const FORM_HEADERS = {
  ...COMMON_HEADERS,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
};
const FETCH_PAGES_SCRIPT_PATH = path.join(WORK_DIR, 'fetch_stork_pages.js');
// --- 配置结束 ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function readIds(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[ERROR] 读取失败: ${filePath} -> ${err.message}`);
    }
    return [];
  }
}

function parseIdFromLine(line) {
  const idx = line.indexOf('\t');
  return idx >= 0 ? line.slice(0, idx).trim() : line.trim();
}

function normalizeIdList(lines) {
  return lines.map(parseIdFromLine).filter(Boolean);
}

async function readStorkIds() {
  // 优先仅处理本次新增（若存在且非空），否则回退全量
  if (fssync.existsSync(NEW_STORK_TMP)) {
    const lines = await readIds(NEW_STORK_TMP);
    const ids = normalizeIdList(lines);
    if (ids.length > 0) return ids;
  }
  const fallback = await readIds(STORK_IDS_TMP);
  return normalizeIdList(fallback);
}

// 解析 showPaper 页面中的 pubmedID：优先解析 ncbi 链接，失败再回退到 js 变量
function parsePubmedIdFromHtml(html) {
  try {
    const linkMatch = html.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d{5,})/i);
    if (linkMatch && linkMatch[1]) return linkMatch[1];
  } catch (_) { /* ignore */ }

  try {
    // 兼容页面内脚本变量：var pubmedID = 0; ... pubmedID = 40841804;
    const varMatch = html.match(/pubmedID\s*=\s*(\d{5,})/i);
    if (varMatch && varMatch[1]) return varMatch[1];
  } catch (_) { /* ignore */ }

  return null;
}

// 从 showPaper HTML 中提取首个 http://dx.doi.org/ 的后缀作为 DOI 原文
function extractDoiSuffixFromHtml(html) {
  const m = html.match(/http:\/\/dx\.doi\.org\/([^\s"'<>]+)/i);
  return m && m[1] ? m[1] : '';
}

async function fetchShowPaperHtml(storkid) {
  const url = `${SHOW_PAPER_BASE}?id=${encodeURIComponent(storkid)}`;
  try {
    const resp = await axios.get(url, {
      headers: {
        ...COMMON_HEADERS,
        // 加上 referer 指向站内，尽量模拟正常访问
        'Referer': SHOW_PAPER_BASE
      },
      timeout: 20000,
      maxRedirects: 5
    });
    if (resp.status === 200 && typeof resp.data === 'string') {
      return resp.data;
    }
    console.warn(`[WARN] showPaper 非 200 或返回非文本: storkid=${storkid}, status=${resp.status}`);
    return null;
  } catch (err) {
    console.error(`[ERROR] 获取 showPaper 失败: storkid=${storkid}, reason=${err.message}`);
    return null;
  }
}

async function fetchSimilarPubmedIds(pubmedId, storkid) {
  const referer = `${SHOW_PAPER_BASE}?id=${encodeURIComponent(storkid)}`;
  const data = `num=${encodeURIComponent(String(SIMILAR_NUM))}&id=${encodeURIComponent(String(pubmedId))}`;
  try {
    const resp = await axios.post(RELATED_API_URL, data, {
      headers: {
        ...FORM_HEADERS,
        'Referer': referer
      },
      timeout: 20000,
      maxRedirects: 5
    });

    // 接口返回 JSON 数组
    const payload = resp.data;
    let arr = [];
    if (Array.isArray(payload)) {
      arr = payload;
    } else if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) arr = parsed;
      } catch (_) {
        console.warn('[WARN] 相似接口返回非数组且 JSON 解析失败。');
      }
    } else if (typeof payload === 'object' && payload !== null) {
      // 某些情况下可能返回对象，尝试寻找数组字段
      const maybe = Object.values(payload).find(v => Array.isArray(v));
      if (maybe) arr = maybe;
    }

    const ids = new Set();
    for (const item of arr) {
      const pid = item && (item.pubmedID || item.pubmedId || item.id);
      if (pid) ids.add(String(pid));
    }
    return Array.from(ids);
  } catch (err) {
    if (err.response) {
      console.error(`[ERROR] 相似接口失败: pubmedId=${pubmedId}, status=${err.response.status}`);
    } else {
      console.error(`[ERROR] 相似接口请求错误: pubmedId=${pubmedId}, reason=${err.message}`);
    }
    return [];
  }
}

/**
 * 构造 NCBI ELink 请求 URL
 */
function buildNCBIUrl(pubmedId) {
  const params = new URLSearchParams({
    dbfrom: 'pubmed',
    id: String(pubmedId),
    linkname: 'pubmed_pubmed',
    cmd: 'neighbor',
    retmode: 'json'
  });
  if (NCBI_TOOL) params.set('tool', NCBI_TOOL);
  if (NCBI_EMAIL) params.set('email', NCBI_EMAIL);
  if (NCBI_API_KEY) params.set('api_key', NCBI_API_KEY);
  return `${NCBI_ELINK_BASE}?${params.toString()}`;
}

/**
 * 备用方案：通过 NCBI ELink 获取相似 pubmedid 列表（仅当主接口失败或为空时调用）
 * 限制返回数量为 SIMILAR_NUM，并排除自身 pubmedId
 */
async function fetchSimilarPubmedIdsViaNCBI(pubmedId) {
  const url = buildNCBIUrl(pubmedId);
  try {
    const resp = await axios.get(url, {
      headers: { ...COMMON_HEADERS, Accept: 'application/json' },
      timeout: 20000,
      maxRedirects: 5
    });
    const data = resp.data;
    const ids = new Set();

    // 尽量兼容不同 JSON 结构字段大小写
    const linksets = (data && (data.linksets || data.LinkSet || data.linkset)) || [];
    const lsArr = Array.isArray(linksets) ? linksets : [linksets];

    for (const set of lsArr) {
      const dbs = (set && (set.linksetdbs || set.LinkSetDb || set.linksetdb)) || [];
      const dbArr = Array.isArray(dbs) ? dbs : [dbs];

      for (const db of dbArr) {
        const lname = String(db && (db.linkname || db.LinkName) || '').toLowerCase();
        if (!lname.includes('pubmed_pubmed')) continue;

        const links = (db && (db.links || db.Link)) || [];
        const linkArr = Array.isArray(links) ? links : [links];

        for (const l of linkArr) {
          const id = String((l && (l.id || l.Id)) || l || '').trim();
          if (id && id !== String(pubmedId)) {
            ids.add(id);
          }
        }
      }
    }

    // 裁剪数量
    return Array.from(ids).slice(0, SIMILAR_NUM);
  } catch (err) {
    if (err.response) {
      console.error(`[ERROR] NCBI ELink 失败: pubmedId=${pubmedId}, status=${err.response.status}`);
    } else {
      console.error(`[ERROR] NCBI ELink 请求错误: pubmedId=${pubmedId}, reason=${err.message}`);
    }
    return [];
  }
}

/**
 * 构造 NCBI EFetch URL（批量取 XML）
 */
function buildEFetchUrl(ids) {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'xml'
  });
  if (NCBI_TOOL) params.set('tool', NCBI_TOOL);
  if (NCBI_EMAIL) params.set('email', NCBI_EMAIL);
  if (NCBI_API_KEY) params.set('api_key', NCBI_API_KEY);
  return `${NCBI_EFETCH_BASE}?${params.toString()}`;
}

/**
 * 批量 EFetch 解析 DOI，返回 Map(pubmedId -> doi或空字符串)
 */
async function efetchDoisForPubmedIds(pubmedIdsIterable) {
  const ids = Array.from(pubmedIdsIterable).map(String);
  const map = new Map();

  // helper: parse XML and fill map
  function parseXmlAndFill(xmlText) {
    const xml = xmlText || '';
    const articles = xml.match(/<PubmedArticle[\s\S]*?<\/PubmedArticle>/g) || [];
    for (const art of articles) {
      const pmidMatch = art.match(/<PMID[^>]*>(\d+)<\/PMID>/i);
      if (!pmidMatch) continue;
      const pmid = pmidMatch[1];
      const doiMatch = art.match(/<ArticleId[^>]*IdType="doi"[^>]*>([^<]+)<\/ArticleId>/i);
      if (doiMatch && doiMatch[1]) {
        map.set(pmid, doiMatch[1].trim());
      } else {
        if (!map.has(pmid)) map.set(pmid, '');
      }
    }
  }

  for (let i = 0; i < ids.length; i += NCBI_EFETCH_BATCH) {
    const chunk = ids.slice(i, i + NCBI_EFETCH_BATCH);

    let success = false;
    for (let attempt = 0; attempt < NCBI_EUTILS_MAX_RETRIES; attempt++) {
      try {
        // 优先使用 POST，避免长 URL 导致的连接问题
        const body = new URLSearchParams({
          db: 'pubmed',
          id: chunk.join(','),
          retmode: 'xml'
        });
        if (NCBI_TOOL) body.set('tool', NCBI_TOOL);
        if (NCBI_EMAIL) body.set('email', NCBI_EMAIL);
        if (NCBI_API_KEY) body.set('api_key', NCBI_API_KEY);

        const resp = await axios.post(NCBI_EFETCH_BASE, body.toString(), {
          headers: {
            ...COMMON_HEADERS,
            Accept: '*/*',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 45000,
          maxRedirects: 5
        });

        parseXmlAndFill(resp.data);
        success = true;
        break;
      } catch (err) {
        const delayMs = NCBI_EUTILS_RETRY_BASE_MS * Math.pow(2, attempt);
        console.error(`[ERROR] EFetch 失败: ids=${chunk.join(',')}, attempt=${attempt + 1}/${NCBI_EUTILS_MAX_RETRIES}, reason=${err.message}`);
        if (attempt < NCBI_EUTILS_MAX_RETRIES - 1) {
          await delay(delayMs);
        }
      }
    }

    if (!success) {
      // 失败兜底填空，保证后续流程不崩
      for (const pmid of chunk) if (!map.has(pmid)) map.set(pmid, '');
    }

    if (i + NCBI_EFETCH_BATCH < ids.length) {
      await delay(NCBI_EUTILS_INTERVAL_MS);
    }
  }
  return map;
}

function doiToKey(doi) {
  return doi.replace(/\//g, '_');
}

async function readPermanentDoiIndex() {
  try {
    const txt = await fs.readFile(path.join(WORK_DIR, 'paper_doi.index.txt'), 'utf-8');
    return new Set(txt.split('\n').map(s => s.trim()).filter(Boolean));
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}

function filterStorkByIndex(storkIds, storkDoiMap, permanentSet) {
  const kept = [];
  let removed = 0;
  for (const sid of storkIds) {
    const doi = (storkDoiMap.get(sid) || '').trim();
    if (doi && permanentSet.has(doiToKey(doi))) {
      removed++;
      continue;
    }
    kept.push(sid);
  }
  return { kept, removed };
}

function filterPubmedByIndex(pubmedIds, doiMap, permanentSet) {
  const kept = [];
  let removed = 0;
  for (const pid of pubmedIds) {
    const doi = (doiMap.get(String(pid)) || '').trim();
    if (doi && permanentSet.has(doiToKey(doi))) {
      removed++;
      continue;
    }
    kept.push(String(pid));
  }
  return { kept, removed };
}

async function writeStorkNewTmpWithDoi(storkIdsWithDoi, storkDoiMap) {
  try {
    const lines = storkIdsWithDoi.map(sid => `${sid}\t${(storkDoiMap.get(sid) || '').trim()}`);
    await fs.writeFile(NEW_STORK_TMP, lines.join('\n'));
    console.log(`[OK] 已写入主文献 storkid+doi（${storkIdsWithDoi.length} 条）到: ${NEW_STORK_TMP}`);
  } catch (err) {
    console.error(`[ERROR] 写入文件失败: ${NEW_STORK_TMP}, reason=${err.message}`);
  }
}

async function writePubmedTmp(pubmedIdsWithDoi, doiMap) {
  try {
    const idArr = Array.from(pubmedIdsWithDoi).map(String);
    const lines = idArr.map(pid => `${pid}\t${(doiMap.get(pid) || '').trim()}`);
    await fs.writeFile(PUBMED_IDS_TMP, lines.join('\n'));
    console.log(`\n[OK] 已写入相似文献 pubmedid+doi（${idArr.length} 条）到: ${PUBMED_IDS_TMP}`);
  } catch (err) {
    console.error(`[ERROR] 写入文件失败: ${PUBMED_IDS_TMP}, reason=${err.message}`);
  }
}

async function main() {
  console.log('--- fetch_pubmed_similars: 基于 storkid 获取主文献 pubmedID 并抓取相似 pubmed 列表 ---');
  console.log(`配置: num=${SIMILAR_NUM}, interval=${FETCH_INTERVAL_MS}ms`);

  const storkIds = await readStorkIds();
  if (storkIds.length === 0) {
    console.log('[INFO] 没有可处理的 storkid。');
    return;
  }

  const resultSet = new Set();
  let processed = 0;
  const storkDoiMap = new Map();

  for (let i = 0; i < storkIds.length; i++) {
    const storkid = storkIds[i];
    console.log(`[${i + 1}/${storkIds.length}] 处理 storkid=${storkid}`);

    // 1) 获取主文献页面并解析 pubmedID
    const html = await fetchShowPaperHtml(storkid);
    if (!html) {
      console.warn(`  - 跳过：无法获取页面 storkid=${storkid}`);
      // 进入下一条前节流
      if (i < storkIds.length - 1) await delay(FETCH_INTERVAL_MS);
      continue;
    }
    const pubmedId = parsePubmedIdFromHtml(html);
    if (!pubmedId) {
      console.warn(`  - 跳过：未解析到 pubmedID，storkid=${storkid}`);
      if (i < storkIds.length - 1) await delay(FETCH_INTERVAL_MS);
      continue;
    }
    console.log(`  - 解析到 pubmedID=${pubmedId}`);
    // 提取主文献 DOI（按首个 http://dx.doi.org/）
    const storkDoiSuffix = extractDoiSuffixFromHtml(html) || '';
    if (storkDoiSuffix) {
      console.log(`  - 解析到 DOI=${storkDoiSuffix}`);
    }
    storkDoiMap.set(storkid, storkDoiSuffix);

    // 2) 调用相似接口获取相似 pubmedid 列表（主接口为空或失败则回退至 NCBI ELink）
    const primarySimilars = await fetchSimilarPubmedIds(pubmedId, storkid);
    let finalSimilars = primarySimilars;
    let usedFallback = false;

    if (finalSimilars.length === 0) {
      console.log('  - 相似列表为空，尝试 NCBI ELink 备用来源...');
      finalSimilars = await fetchSimilarPubmedIdsViaNCBI(pubmedId);
      usedFallback = finalSimilars.length > 0;
    }

    if (finalSimilars.length === 0) {
      console.log('  - 相似列表为空（主+备用均无结果）');
    } else {
      // 确保不超过 SIMILAR_NUM
      finalSimilars = finalSimilars.slice(0, SIMILAR_NUM);
      console.log(`  - 相似条目 ${finalSimilars.length} 个${usedFallback ? '（来自 NCBI ELink）' : ''}`);
      for (const sid of finalSimilars) resultSet.add(String(sid));
    }

    processed++;
    // 3) 间隔
    if (i < storkIds.length - 1) {
      await delay(FETCH_INTERVAL_MS);
    }
  }

  console.log(`\n完成。处理主文献 ${processed}/${storkIds.length} 条。相似 pubmedid 唯一计数: ${resultSet.size}`);

  // 额外：为相似 pubmed 批量获取 DOI（可选）
  let pubmedDoiMap = new Map();
  if (FETCH_PUBMED_DOI && resultSet.size > 0) {
    console.log(`[INFO] 开始批量 EFetch 获取相似 PMID 的 DOI（批次=${NCBI_EFETCH_BATCH}, interval=${NCBI_EUTILS_INTERVAL_MS}ms）`);
    pubmedDoiMap = await efetchDoisForPubmedIds(resultSet);
  }

  // 读取永久索引并进行预过滤（基于 DOI）
  const permanentSet = await readPermanentDoiIndex();

  const storkFilter = filterStorkByIndex(storkIds, storkDoiMap, permanentSet);
  const pubmedFilter = filterPubmedByIndex(Array.from(resultSet), pubmedDoiMap, permanentSet);

  console.log(`[INFO] 主文献过滤：删除 ${storkFilter.removed} 条（命中永久 DOI），保留 ${storkFilter.kept.length} 条`);
  console.log(`[INFO] 相似文献过滤：删除 ${pubmedFilter.removed} 条（命中永久 DOI），保留 ${pubmedFilter.kept.length} 条`);

  // 进一步剔除“无 DOI”的条目（立即从两个临时 index 删除）
  const storkKeptWithDoi = storkFilter.kept.filter(sid => ((storkDoiMap.get(sid) || '').trim()));
  const pubmedKeptWithDoi = pubmedFilter.kept.filter(pid => ((pubmedDoiMap.get(String(pid)) || '').trim()));
  console.log(`[INFO] 主文献剔除无 DOI：删除 ${storkFilter.kept.length - storkKeptWithDoi.length} 条`);
  console.log(`[INFO] 相似文献剔除无 DOI：删除 ${pubmedFilter.kept.length - pubmedKeptWithDoi.length} 条`);

  // 覆盖写回两类临时索引（两列 TSV，仅保留有 DOI 的条目）
  await writeStorkNewTmpWithDoi(storkKeptWithDoi, storkDoiMap);
  await writePubmedTmp(new Set(pubmedKeptWithDoi), pubmedDoiMap);

  // 链式触发后续流程：页面抓取（fetch_stork_pages -> derive_doi_mapping -> html_to_md）
  if (storkKeptWithDoi.length === 0 && pubmedKeptWithDoi.length === 0) {
    console.log('[INFO] 过滤后无待抓取条目，终止链式触发。');
    return;
  }
  console.log('--- 相似抓取阶段完成，触发页面抓取 ---');
  await new Promise((resolve, reject) => {
    const p = spawn('node', [FETCH_PAGES_SCRIPT_PATH], { stdio: 'inherit' });
    p.on('close', (code) => {
      console.log(`--- 页面抓取脚本结束，退出码: ${code} ---`);
      code === 0 ? resolve() : reject(new Error(`页面抓取失败，退出码: ${code}`));
    });
    p.on('error', (err) => reject(err));
  });
}

main().catch(err => {
  console.error('[FATAL] 未处理异常: ', err);
  process.exit(1);
});