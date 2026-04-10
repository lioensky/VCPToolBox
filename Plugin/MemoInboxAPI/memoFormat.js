function createMemoId() {
  return `memo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildMemoFileName({ createdAt, memoId }) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const datePart = date.toISOString().slice(0, 10);
  const timePart = date.toISOString().slice(11, 19).replace(/:/g, '_');
  return `${datePart}-${timePart}-${memoId}.txt`;
}

function formatMemoContent({
  createdAt,
  maidName,
  content,
  attachments = [],
  metadata = {},
  tags = [],
}) {
  const headerDate = normalizeDate(createdAt);
  const lines = [`[${headerDate}] - ${maidName}`, String(content || '').trim()];

  if (attachments.length > 0) {
    lines.push(`Attachments: ${attachments.join(', ')}`);
  }

  const metaEntries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  if (metaEntries.length > 0) {
    lines.push(`Meta: ${metaEntries.join(', ')}`);
  }

  if (tags.length > 0) {
    lines.push(`Tag: ${tags.join(', ')}`);
  }

  return lines.join('\n');
}

function parseMemoContent(rawContent) {
  const lines = String(rawContent || '').replace(/\r\n/g, '\n').split('\n');
  const headerLine = lines[0] || '';
  const bodyLines = lines.slice(1);
  const parsed = {
    header: parseHeaderLine(headerLine),
    content: '',
    attachments: [],
    meta: {},
    tags: [],
  };

  const contentLines = [];
  for (const line of bodyLines) {
    if (line.startsWith('Attachments: ')) {
      parsed.attachments = line
        .slice('Attachments: '.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    if (line.startsWith('Meta: ')) {
      parsed.meta = parseMetaLine(line.slice('Meta: '.length));
      continue;
    }

    if (line.startsWith('Tag: ')) {
      parsed.tags = line
        .slice('Tag: '.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    contentLines.push(line);
  }

  parsed.content = contentLines.join('\n').trim();
  return parsed;
}

function extractMemoIdFromFileName(fileName) {
  const match = String(fileName || '').match(/(memo_[a-z0-9]+)\.txt$/i);
  return match ? match[1] : null;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function parseHeaderLine(headerLine) {
  const match = String(headerLine || '').match(/^\[(\d{4}-\d{2}-\d{2})\]\s*-\s*(.+)$/);
  if (!match) {
    return {
      date: '',
      maidName: '',
    };
  }

  return {
    date: match[1],
    maidName: match[2].trim(),
  };
}

function parseMetaLine(metaLine) {
  const result = {};
  for (const item of String(metaLine || '').split(',')) {
    const [key, ...rest] = item.split('=');
    if (!key || rest.length === 0) {
      continue;
    }

    result[key.trim()] = rest.join('=').trim();
  }
  return result;
}

module.exports = {
  createMemoId,
  buildMemoFileName,
  formatMemoContent,
  parseMemoContent,
  extractMemoIdFromFileName,
};
