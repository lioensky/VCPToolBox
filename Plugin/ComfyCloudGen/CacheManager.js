/**
 * CacheManager.js — 工作流缓存管理
 * 
 * save_as: 将组装后的工作流保存为缓存
 * load_cached: 从缓存加载工作流
 * FIFO淘汰：超过COMFY_CACHE_MAX时删除最旧的
 */

const fs = require('fs');
const path = require('path');

class CacheManager {
  constructor(cacheDir, maxCount) {
    this.cacheDir = cacheDir;
    this.maxCount = (typeof maxCount === 'number' && maxCount >= 0) ? maxCount : 10;
    this.indexPath = path.join(cacheDir, '_cache_index.json');

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  }

  save(name, workflow, meta) {
    if (this.maxCount <= 0) return;

    const safeName = this._sanitize(name);
    fs.writeFileSync(
      path.join(this.cacheDir, safeName + '.json'),
      JSON.stringify(workflow, null, 2),
      'utf8'
    );

    const index = this._loadIndex();
    index[safeName] = {
      created: new Date().toISOString(),
      node_count: Object.keys(workflow).length,
      ...(meta || {})
    };
    this._saveIndex(index);
    this._evict(index);
  }

  load(name) {
    const safeName = this._sanitize(name);
    const filePath = path.join(this.cacheDir, safeName + '.json');
    if (!fs.existsSync(filePath)) {
      throw new Error(`缓存 "${safeName}" 不存在。可用: ${Object.keys(this._loadIndex()).join(', ') || '(空)'}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  list() {
    return this._loadIndex();
  }

  _evict(index) {
    const names = Object.keys(index);
    if (names.length <= this.maxCount) return;

    const sorted = names.sort((a, b) =>
      new Date(index[a].created).getTime() - new Date(index[b].created).getTime()
    );
    const toDelete = sorted.slice(0, names.length - this.maxCount);

    for (const n of toDelete) {
      const fp = path.join(this.cacheDir, n + '.json');
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      delete index[n];
    }
    this._saveIndex(index);
  }

  _loadIndex() {
    if (!fs.existsSync(this.indexPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); }
    catch { return {}; }
  }

  _saveIndex(index) {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  _sanitize(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('缓存名称不能为空');
    const s = name.trim();
    if (s.includes('..') || s.includes('/') || s.includes('\\')) {
      throw new Error('缓存名称不能包含路径字符');
    }
    return s;
  }
}

module.exports = CacheManager;