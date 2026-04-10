const fs = require('node:fs/promises');
const path = require('node:path');

function createMemoStore({ runtimeContext, memoFormat }) {
  const memoIndex = new Map();
  const locks = new Map();

  return {
    async create({ memoId = memoFormat.createMemoId(), content, source = 'api', tags = null, attachments = [], createdAt = new Date() }) {
      const toolContent = buildToolContent({
        content,
        attachments: attachments.map((item) => item.url),
        metadata: {
          memoId,
          source,
        },
        tags: Array.isArray(tags) ? tags : [],
        includeTagLine: Array.isArray(tags) && tags.length > 0,
      });

      const toolName = Array.isArray(tags) && tags.length > 0 ? 'DailyNote' : 'DailyNoteWrite';
      const result = await callCreateTool({
        runtimeContext,
        toolName,
        memoId,
        createdAt,
        toolContent,
        tags,
      });

      const savedFilePath = await resolveSavedFilePath({
        result,
        memoId,
        runtimeContext,
      });
      const filename = path.basename(savedFilePath);
      memoIndex.set(memoId, {
        filename,
        deleted: false,
        createdAt: filename,
      });

      return readMemoFromFile({
        filePath: savedFilePath,
        memoId,
        deleted: false,
        memoFormat,
      });
    },

    async getById(memoId) {
      await rebuildIndex();
      const entry = memoIndex.get(memoId);
      if (!entry || entry.deleted) {
        throw new Error('MEMO_NOT_FOUND');
      }

      return readMemoFromFile({
        filePath: path.join(runtimeContext.memoRootPath, entry.filename),
        memoId,
        deleted: false,
        memoFormat,
      });
    },

    async list({ limit = 20, cursor = null } = {}) {
      await rebuildIndex();
      const items = [];
      const filenames = Array.from(memoIndex.values())
        .filter((entry) => !entry.deleted)
        .map((entry) => entry.filename)
        .sort()
        .reverse();

      const filtered = cursor ? filenames.filter((filename) => filename < cursor) : filenames;
      const page = filtered.slice(0, Math.min(limit, 100));
      for (const filename of page) {
        const memoId = memoFormat.extractMemoIdFromFileName(filename);
        items.push(
          await readMemoFromFile({
            filePath: path.join(runtimeContext.memoRootPath, filename),
            memoId,
            deleted: false,
            memoFormat,
          }),
        );
      }

      return {
        items,
        nextCursor: filtered.length > page.length ? page[page.length - 1] : null,
      };
    },

    async update(memoId, patch) {
      return withLock(memoId, async () => {
        const current = await this.getById(memoId);
        const nextContent = patch.content ?? current.content;
        const nextTags = patch.tags ?? current.tags;
        const nextRaw = memoFormat.formatMemoContent({
          createdAt: current.createdAt,
          maidName: current.header.maidName,
          content: nextContent,
          attachments: current.attachments,
          metadata: current.meta,
          tags: nextTags,
        });
        const filePath = path.join(runtimeContext.memoRootPath, memoIndex.get(memoId).filename);
        const tempFilePath = `${filePath}.tmp`;
        await fs.writeFile(tempFilePath, nextRaw, 'utf8');
        await fs.rename(tempFilePath, filePath);
        return readMemoFromFile({
          filePath,
          memoId,
          deleted: false,
          memoFormat,
        });
      });
    },

    async softDelete(memoId) {
      return withLock(memoId, async () => {
        const entry = await requireActiveEntry(memoId);
        const sourcePath = path.join(runtimeContext.memoRootPath, entry.filename);
        const targetPath = path.join(runtimeContext.memoTrashPath, entry.filename);
        await fs.rename(sourcePath, targetPath);
        memoIndex.set(memoId, { ...entry, deleted: true });
      });
    },

    async restore(memoId) {
      return withLock(memoId, async () => {
        await rebuildIndex();
        const entry = memoIndex.get(memoId);
        if (!entry || !entry.deleted) {
          throw new Error('MEMO_NOT_FOUND');
        }

        const sourcePath = path.join(runtimeContext.memoTrashPath, entry.filename);
        const targetPath = path.join(runtimeContext.memoRootPath, entry.filename);
        await fs.rename(sourcePath, targetPath);
        memoIndex.set(memoId, { ...entry, deleted: false });
      });
    },

    async purge(memoId) {
      return withLock(memoId, async () => {
        await rebuildIndex();
        const entry = memoIndex.get(memoId);
        if (!entry) {
          throw new Error('MEMO_NOT_FOUND');
        }

        const basePath = entry.deleted ? runtimeContext.memoTrashPath : runtimeContext.memoRootPath;
        await fs.rm(path.join(basePath, entry.filename), { force: true });
        memoIndex.delete(memoId);
      });
    },

    async listTrash() {
      await rebuildIndex();
      const items = [];
      const filenames = Array.from(memoIndex.values())
        .filter((entry) => entry.deleted)
        .map((entry) => entry.filename)
        .sort()
        .reverse();

      for (const filename of filenames) {
        const memoId = memoFormat.extractMemoIdFromFileName(filename);
        items.push(
          await readMemoFromFile({
            filePath: path.join(runtimeContext.memoTrashPath, filename),
            memoId,
            deleted: true,
            memoFormat,
          }),
        );
      }

      return { items };
    },

    async rebuildIndex() {
      await rebuildIndex();
    },
  };

  async function rebuildIndex() {
    memoIndex.clear();
    await scanDirectory(runtimeContext.memoRootPath, false);
    await scanDirectory(runtimeContext.memoTrashPath, true);
  }

  async function scanDirectory(directoryPath, deleted) {
    let fileNames = [];
    try {
      fileNames = await fs.readdir(directoryPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const filename of fileNames) {
      if (!filename.endsWith('.txt')) {
        continue;
      }
      const memoId = memoFormat.extractMemoIdFromFileName(filename);
      if (!memoId) {
        continue;
      }
      memoIndex.set(memoId, {
        filename,
        deleted,
        createdAt: filename,
      });
    }
  }

  async function requireActiveEntry(memoId) {
    await rebuildIndex();
    const entry = memoIndex.get(memoId);
    if (!entry || entry.deleted) {
      throw new Error('MEMO_NOT_FOUND');
    }
    return entry;
  }

  async function withLock(memoId, fn) {
    const previous = locks.get(memoId) || Promise.resolve();
    const current = previous.then(fn, fn);
    locks.set(memoId, current);
    try {
      return await current;
    } finally {
      if (locks.get(memoId) === current) {
        locks.delete(memoId);
      }
    }
  }
}

async function callCreateTool({
  runtimeContext,
  toolName,
  memoId,
  createdAt,
  toolContent,
  tags,
}) {
  const dateString = normalizeDate(createdAt);
  if (toolName === 'DailyNote') {
    return runtimeContext.pluginManager.processToolCall('DailyNote', {
      command: 'create',
      maid: `[${runtimeContext.memoDiaryName}]${runtimeContext.memoMaidName}`,
      Date: dateString,
      Content: toolContent,
      Tag: Array.isArray(tags) ? tags.join(', ') : undefined,
      fileName: memoId,
    });
  }

  return runtimeContext.pluginManager.processToolCall('DailyNoteWrite', {
    maidName: `[${runtimeContext.memoDiaryName}]${runtimeContext.memoMaidName}`,
    dateString,
    contentText: toolContent,
    fileName: memoId,
  });
}

async function resolveSavedFilePath({ result, memoId, runtimeContext }) {
  const resolvedFromResult = extractSavedFilePath(result);
  if (resolvedFromResult) {
    return resolvedFromResult;
  }

  const scannedFilePath = await findMemoFilePathById({
    memoId,
    runtimeContext,
  });
  if (scannedFilePath) {
    return scannedFilePath;
  }

  throw new Error(
    `MEMO_CREATE_FAILED:${JSON.stringify(result, null, 2)}`,
  );
}

function extractSavedFilePath(result) {
  const candidates = [result && result.message, result && result.result]
    .filter(Boolean)
    .map((value) => String(value));

  if (result && result.original_plugin_output) {
    candidates.push(String(result.original_plugin_output));
  }

  for (const candidate of candidates) {
    let match = candidate.match(/Diary saved to (.+)$/);
    if (match) {
      return match[1];
    }

    match = candidate.match(/Successfully created diary file:\s*(.+)$/);
    if (match) {
      return match[1];
    }
  }

  if (result && typeof result.filePath === 'string' && result.filePath) {
    return result.filePath;
  }

  if (result && result.data && typeof result.data.filePath === 'string' && result.data.filePath) {
    return result.data.filePath;
  }

  if (result && result.savedFilePath) {
    return String(result.savedFilePath);
  }

  if (result && result.path) {
    return String(result.path);
  }

  return null;
}

async function findMemoFilePathById({ memoId, runtimeContext }) {
  const candidates = [runtimeContext.memoRootPath, runtimeContext.memoTrashPath];
  for (const basePath of candidates) {
    let fileNames = [];
    try {
      fileNames = await fs.readdir(basePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    const matchedName = fileNames.find((fileName) => fileName.endsWith(`-${memoId}.txt`));
    if (matchedName) {
      return path.join(basePath, matchedName);
    }
  }

  return null;
}

async function readMemoFromFile({ filePath, memoId, deleted, memoFormat }) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = memoFormat.parseMemoContent(raw);
  const stat = await fs.stat(filePath);

  return {
    memoId,
    header: parsed.header,
    content: parsed.content,
    attachments: parsed.attachments,
    tags: parsed.tags,
    meta: parsed.meta,
    createdAt: new Date(stat.mtimeMs).toISOString(),
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    deleted,
    filename: path.basename(filePath),
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function buildToolContent({ content, attachments = [], metadata = {}, tags = [], includeTagLine }) {
  const lines = [String(content || '').trim()];

  if (attachments.length > 0) {
    lines.push(`Attachments: ${attachments.join(', ')}`);
  }

  const metaEntries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  if (metaEntries.length > 0) {
    lines.push(`Meta: ${metaEntries.join(', ')}`);
  }

  if (includeTagLine && tags.length > 0) {
    lines.push(`Tag: ${tags.join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = {
  createMemoStore,
};
