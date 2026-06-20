const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const mime = require('mime-types');
const TurndownService = require('turndown');
const { fileURLToPath } = require('url');
const pluginManager = require('../../Plugin.js');

let MailClient;
try {
  ({ MailClient } = require('@clawemail/node-sdk'));
} catch (error) {
  MailClient = null;
}

const PLACEHOLDER = '{{VCPClawMailInbox}}';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_LIMIT = 20;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

let config = {};
let dependencies = {};
let debugMode = false;
let pollTimer = null;
let clients = new Map();
let cache = {
  updatedAt: null,
  users: {},
  lastError: null
};
let turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

function log(...args) {
  if (debugMode) console.log('[VCPClawMail]', ...args);
}

function warn(...args) {
  console.warn('[VCPClawMail]', ...args);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return splitList(parsed);
      } catch (_) {
        // fall through
      }
    }
    return trimmed.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function getUsers() {
  const users = splitList(config.ClawMailUsers);
  const defaultUser = String(config.ClawMailDefaultUser || '').trim();
  if (defaultUser && !users.includes(defaultUser)) users.unshift(defaultUser);
  return users;
}

function getDefaultUser(explicitUser) {
  if (explicitUser) return String(explicitUser).trim();
  const defaultUser = String(config.ClawMailDefaultUser || '').trim();
  if (defaultUser) return defaultUser;
  const users = getUsers();
  if (users.length > 0) return users[0];
  throw new Error('未配置 ClawMailDefaultUser 或 ClawMailUsers，无法确定邮箱账号。');
}

function requireSdk() {
  if (!MailClient) {
    throw new Error('缺少 @clawemail/node-sdk。请在 Plugin/VCPClawMail 目录运行 npm install。');
  }
}

function getClient(user) {
  requireSdk();
  const apiKey = config.ClawMailKey || process.env.ClawMailKey || process.env.CLAW_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 ClawMailKey。请在 Plugin/VCPClawMail/config.env 中填写 ClawEmail API Key。');
  }
  const normalizedUser = getDefaultUser(user);
  if (!clients.has(normalizedUser)) {
    const client = new MailClient({
      apiKey,
      user: normalizedUser
    });
    clients.set(normalizedUser, client);
  }
  return clients.get(normalizedUser);
}

function getDataDir() {
  return path.join(__dirname, 'data');
}

function getAttachmentDir() {
  return path.join(getDataDir(), 'attachments');
}

async function ensureDataDirs() {
  await fsp.mkdir(getAttachmentDir(), { recursive: true });
}

function safeFilename(name, fallback = 'attachment.bin') {
  const base = path.basename(String(name || fallback)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return base || fallback;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function textPreview(value, max = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function mdInline(value, fallback = '无') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mdBlock(value, fallback = '无') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function mdBool(value, unknown = '未知') {
  if (value === true) return '是';
  if (value === false) return '否';
  return unknown;
}

function formatArrayForMd(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value || '';
}

function asAiText(markdown, meta = {}) {
  const text = mdBlock(markdown, '无内容');
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    meta: {
      plugin: 'VCPClawMail',
      format: 'markdown',
      ...meta
    }
  };
}

function normalizeAddressList(value) {
  const list = splitList(value);
  return list.length > 0 ? list : undefined;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeMailSummary(mail, user) {
  const id = pickFirst(mail.id, mail.mailId, mail.messageId, mail.uid, mail.mid);
  const subject = pickFirst(mail.subject, mail.title, '(无主题)');
  const from = pickFirst(mail.from, mail.sender, mail.fromAddress, mail.senderAddress);
  const to = pickFirst(mail.to, mail.recipients);
  const date = pickFirst(mail.date, mail.sentAt, mail.receivedAt, mail.createdAt, mail.time);
  const read = pickFirst(mail.read, mail.isRead, mail.seen);
  const hasAttachments = Boolean(pickFirst(mail.hasAttachments, mail.attachments?.length, mail.attachSize));
  const snippet = pickFirst(mail.snippet, mail.preview, mail.summary, mail.text, mail.body);
  return {
    user,
    id,
    mailId: id,
    subject,
    from,
    to,
    date,
    read: read === undefined ? undefined : Boolean(read),
    unread: read === undefined ? undefined : !Boolean(read),
    hasAttachments,
    attachSize: mail.attachSize,
    preview: textPreview(snippet)
  };
}

function extractImageUrlsFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const urls = [];
  const imgRe = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    urls.push(match[1]);
  }
  return [...new Set(urls)];
}

function normalizeAttachmentMeta(att, index = 0) {
  if (!att || typeof att !== 'object') return null;
  const filename = pickFirst(att.filename, att.name, att.fileName, `attachment-${index + 1}`);
  const id = pickFirst(att.id, att.attachmentId, att.partId, att.cid, att.contentId, filename);
  const contentType = pickFirst(att.contentType, att.mimeType, mime.lookup(filename), 'application/octet-stream');
  const url = pickFirst(att.url, att.downloadUrl, att.href);
  return {
    id,
    attachmentId: id,
    partId: att.partId,
    filename,
    contentType,
    size: pickFirst(att.size, att.byteLength, att.length),
    cid: pickFirst(att.cid, att.contentId),
    url
  };
}

function bodyContent(part) {
  if (!part) return undefined;
  if (typeof part === 'string') return part;
  if (typeof part.content === 'string') return part.content;
  return undefined;
}

function normalizeReadMail(mail, user, mailId) {
  const html = bodyContent(pickFirst(mail.html, mail.htmlBody, mail.bodyHtml));
  const text = bodyContent(pickFirst(mail.text, mail.textBody, mail.bodyText, mail.body, mail.content));
  const markdown = html ? turndown.turndown(html) : undefined;
  const attachments = Array.isArray(mail.attachments)
    ? mail.attachments.map(normalizeAttachmentMeta).filter(Boolean)
    : [];
  const imageUrls = [
    ...extractImageUrlsFromHtml(html),
    ...attachments.filter(a => String(a.contentType || '').startsWith('image/') && a.url).map(a => a.url)
  ];
  return {
    user,
    id: pickFirst(mail.id, mail.mailId, mail.messageId, mailId),
    mailId: pickFirst(mail.id, mail.mailId, mail.messageId, mailId),
    subject: pickFirst(mail.subject, mail.title, '(无主题)'),
    from: pickFirst(mail.from, mail.sender, mail.fromAddress, mail.senderAddress),
    to: pickFirst(mail.to, mail.recipients),
    cc: mail.cc,
    bcc: mail.bcc,
    date: pickFirst(mail.date, mail.sentAt, mail.receivedAt, mail.createdAt, mail.time),
    text,
    html,
    markdown,
    preview: textPreview(text || markdown || html, 600),
    imageUrls: [...new Set(imageUrls)],
    attachments,
    rawKeys: Object.keys(mail || {})
  };
}

function buildPlaceholderText() {
  const users = Object.keys(cache.users);
  const totalCached = users.reduce((sum, user) => sum + (cache.users[user]?.length || 0), 0);
  const lines = [];

  lines.push('# VCPClawMail 邮箱收件箱摘要');
  lines.push('');
  lines.push('> 这是给 AI 直接阅读的 Markdown 摘要。需要查看完整正文或附件时，请调用 `VCPClawMail` 工具。');
  lines.push('');
  lines.push('## 状态');
  lines.push('');
  lines.push(`- 插件状态：${cache.lastError && !cache.updatedAt ? '异常' : '可用'}`);
  lines.push(`- 更新时间：${cache.updatedAt || '尚未完成首次轮询'}`);
  lines.push(`- 缓存邮箱数：${users.length}`);
  lines.push(`- 缓存邮件数：${totalCached}`);
  if (cache.lastError) lines.push(`- 最近错误：${cache.lastError}`);
  lines.push('');

  if (users.length === 0) {
    lines.push('## 最近邮件');
    lines.push('');
    lines.push('暂无缓存邮件。可能原因：尚未完成首次轮询、未配置邮箱、或 SDK/API 暂不可用。');
  }

  for (const user of users) {
    const mails = cache.users[user] || [];
    lines.push(`## 邮箱：${user}`);
    lines.push('');
    if (mails.length === 0) {
      lines.push('暂无邮件摘要。');
      lines.push('');
      continue;
    }

    lines.push('| # | 状态 | mailId | 发件人 | 主题 | 时间 | 附件 | 预览 |');
    lines.push('|---:|---|---|---|---|---|---|---|');
    mails.forEach((mail, index) => {
      const status = mail.unread === true ? '未读' : (mail.read === true ? '已读' : '未知');
      lines.push(`| ${index + 1} | ${status} | \`${mdInline(mail.mailId, '未知')}\` | ${mdInline(formatArrayForMd(mail.from), '未知')} | ${mdInline(mail.subject, '(无主题)')} | ${mdInline(mail.date, '未知')} | ${mdBool(mail.hasAttachments)} | ${mdInline(mail.preview, '')} |`);
    });
    lines.push('');
    lines.push('### 推荐读取方式');
    lines.push('');
    lines.push('复制上表中的 `mailId` 后调用：');
    lines.push('');
    lines.push('```text');
    lines.push('<<<[TOOL_REQUEST]>>>');
    lines.push('tool_name:「始」VCPClawMail「末」,');
    lines.push('command:「始」read_mail「末」,');
    lines.push(`user:「始」${user}「末」,`);
    lines.push('mailId:「始」上表中的mailId「末」');
    lines.push('<<<[END_TOOL_REQUEST]>>>');
    lines.push('```');
    lines.push('');
  }

  lines.push('## 可用命令');
  lines.push('');
  lines.push('- `list_recent`：列出最近邮件摘要。');
  lines.push('- `read_mail`：读取单封邮件正文、图片 URL 与附件列表。');
  lines.push('- `send_mail`：发送邮件，可在正文或 `attachments` 参数中直接写 URL / `file://`。');
  lines.push('- `reply_mail`：回复邮件。');
  lines.push('- `download_attachment`：下载附件并返回可继续解析的 `file://` 路径。');

  return lines.join('\n');
}

function updatePlaceholder() {
  pluginManager.staticPlaceholderValues.set(PLACEHOLDER, { value: buildPlaceholderText(), serverId: 'local' });
}

async function callFirstAvailable(target, candidates, args) {
  for (const candidate of candidates) {
    const fn = candidate.split('.').reduce((obj, key) => obj && obj[key], target);
    if (typeof fn === 'function') {
      return await fn.apply(candidate.includes('.') ? candidate.split('.').slice(0, -1).reduce((obj, key) => obj && obj[key], target) : target, args);
    }
  }
  throw new Error(`当前 @clawemail/node-sdk 未暴露候选方法: ${candidates.join(', ')}。请运行 npm run inspect:sdk 查看实际 API。`);
}

async function listEmails(args = {}) {
  const user = getDefaultUser(args.user);
  const limit = normalizeInteger(args.limit, DEFAULT_POLL_LIMIT);
  const unreadOnly = normalizeBoolean(args.unreadOnly, false);
  const client = getClient(user);

  const payload = {
    user,
    limit,
    unreadOnly,
    unread: unreadOnly,
    fid: args.fid || args.folderId || 1
  };

  const result = client.transport && typeof client.transport.listMessages === 'function'
    ? await client.transport.listMessages({
      fid: String(payload.fid || 1),
      order: args.order || 'date',
      desc: args.desc === undefined ? true : normalizeBoolean(args.desc, true),
      limit,
      start: normalizeInteger(args.start, 0),
      unread: unreadOnly || undefined
    })
    : await callFirstAvailable(client, [
      'mail.list',
      'mail.search',
      'list',
      'search',
      'emails.list',
      'messages.list'
    ], [payload]);

  const rawList = Array.isArray(result)
    ? result
    : Array.isArray(result?.emails)
      ? result.emails
      : Array.isArray(result?.mails)
        ? result.mails
        : Array.isArray(result?.data)
          ? result.data
          : [];

  const emails = rawList.slice(0, limit).map(mail => normalizeMailSummary(mail, user));
  const lines = [];

  lines.push('# ClawEmail 最近邮件列表');
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 查询邮箱：${user}`);
  lines.push(`- 返回数量：${emails.length}`);
  lines.push(`- 原始数量：${rawList.length}`);
  lines.push(`- 仅未读：${mdBool(unreadOnly)}`);
  lines.push(`- 文件夹 fid：${payload.fid}`);
  lines.push(`- SDK 返回形态：${Array.isArray(result) ? 'array' : Object.keys(result || {}).join(', ') || 'unknown'}`);
  lines.push('');

  if (emails.length === 0) {
    lines.push('## 邮件');
    lines.push('');
    lines.push('没有匹配的邮件。');
  } else {
    lines.push('## 邮件');
    lines.push('');
    lines.push('| # | 状态 | mailId | 发件人 | 收件人 | 主题 | 时间 | 附件 | 预览 |');
    lines.push('|---:|---|---|---|---|---|---|---|---|');
    emails.forEach((mail, index) => {
      const status = mail.unread === true ? '未读' : (mail.read === true ? '已读' : '未知');
      lines.push(`| ${index + 1} | ${status} | \`${mdInline(mail.mailId, '未知')}\` | ${mdInline(formatArrayForMd(mail.from), '未知')} | ${mdInline(formatArrayForMd(mail.to), '未知')} | ${mdInline(mail.subject, '(无主题)')} | ${mdInline(mail.date, '未知')} | ${mdBool(mail.hasAttachments)} | ${mdInline(mail.preview, '')} |`);
    });
  }

  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  lines.push('如需读取正文，请用 `read_mail` 并传入表格中的 `mailId`。');

  return asAiText(lines.join('\n'), {
    command: 'list_recent',
    user,
    count: emails.length
  });
}

async function readMail(args = {}) {
  const user = getDefaultUser(args.user);
  const mailId = args.mailId || args.id;
  if (!mailId) throw new Error('read_mail 需要 mailId。');
  const markRead = args.markRead !== undefined
    ? normalizeBoolean(args.markRead, false)
    : normalizeBoolean(config.ClawMailAutoMarkRead, false);
  const client = getClient(user);
  const mail = await callFirstAvailable(client, [
    'mail.read',
    'read',
    'emails.read',
    'messages.read',
    'mail.get',
    'get'
  ], [{ id: mailId, mailId, markRead, user }]);
  const normalized = normalizeReadMail(mail || {}, user, mailId);
  const lines = [];

  lines.push('# ClawEmail 邮件详情');
  lines.push('');
  lines.push('## 基本信息');
  lines.push('');
  lines.push(`- 邮箱：${user}`);
  lines.push(`- mailId：\`${mdInline(normalized.mailId, mailId)}\``);
  lines.push(`- 主题：${mdInline(normalized.subject, '(无主题)')}`);
  lines.push(`- 发件人：${mdInline(formatArrayForMd(normalized.from), '未知')}`);
  lines.push(`- 收件人：${mdInline(formatArrayForMd(normalized.to), '未知')}`);
  if (normalized.cc) lines.push(`- 抄送：${mdInline(formatArrayForMd(normalized.cc), '无')}`);
  lines.push(`- 时间：${mdInline(normalized.date, '未知')}`);
  lines.push(`- 本次读取是否标记已读：${mdBool(markRead)}`);
  lines.push('');

  lines.push('## 正文预览');
  lines.push('');
  lines.push(mdBlock(normalized.preview, '无正文预览'));
  lines.push('');

  if (normalized.markdown) {
    lines.push('## HTML 正文转 Markdown');
    lines.push('');
    lines.push(normalized.markdown);
    lines.push('');
  }

  if (normalized.text) {
    lines.push('## 纯文本正文');
    lines.push('');
    lines.push(normalized.text);
    lines.push('');
  }

  if (normalized.imageUrls.length > 0) {
    lines.push('## 图片 URL');
    lines.push('');
    normalized.imageUrls.forEach((url, index) => {
      lines.push(`${index + 1}. ${url}`);
    });
    lines.push('');
    lines.push('这些图片 URL 可直接交给支持图片读取的 VCP 多模态工具。');
    lines.push('');
  }

  lines.push('## 附件');
  lines.push('');
  if (normalized.attachments.length === 0) {
    lines.push('无附件。');
  } else {
    lines.push('| # | attachmentId/partId | 文件名 | MIME | 大小 | 内联图片 |');
    lines.push('|---:|---|---|---|---:|---|');
    normalized.attachments.forEach((att, index) => {
      lines.push(`| ${index + 1} | \`${mdInline(att.attachmentId || att.partId, '未知')}\` | ${mdInline(att.filename, '未命名')} | ${mdInline(att.contentType, '未知')} | ${mdInline(att.size, '未知')} | ${att.cid ? '是' : '否'} |`);
    });
    lines.push('');
    lines.push('下载附件示例：');
    lines.push('');
    lines.push('```text');
    lines.push('<<<[TOOL_REQUEST]>>>');
    lines.push('tool_name:「始」VCPClawMail「末」,');
    lines.push('command:「始」download_attachment「末」,');
    lines.push(`user:「始」${user}「末」,`);
    lines.push(`mailId:「始」${normalized.mailId || mailId}「末」,`);
    lines.push('attachmentId:「始」上表中的attachmentId或partId「末」');
    lines.push('<<<[END_TOOL_REQUEST]>>>');
    lines.push('```');
  }
  lines.push('');

  lines.push('## 可执行后续动作');
  lines.push('');
  lines.push('- 回复：调用 `reply_mail`，传入当前 `mailId` 和 `body`。');
  lines.push('- 下载附件：调用 `download_attachment`。');
  lines.push('- 转发/新发：调用 `send_mail`，正文或 `attachments` 可包含 URL / `file://`。');

  return asAiText(lines.join('\n'), {
    command: 'read_mail',
    user,
    mailId: normalized.mailId || mailId,
    attachmentCount: normalized.attachments.length,
    imageCount: normalized.imageUrls.length
  });
}

function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s"'<>，。？！）\]\}]+|file:\/\/[^\s"'<>，。？！）\]\}]+/g);
  return matches ? [...new Set(matches)] : [];
}

function normalizeAttachmentInputs(value, body) {
  const explicit = splitList(value);
  const inlineUrls = extractUrlsFromText(body).filter(url => {
    return /\.(png|jpe?g|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?|txt|csv|zip|7z|rar)(?:[?#].*)?$/i.test(url);
  });
  return [...new Set([...explicit, ...inlineUrls])];
}

async function downloadUrlToAttachment(url) {
  await ensureDataDirs();

  if (url.startsWith('file://')) {
    const filePath = fileURLToPath(url);
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过限制 ${MAX_ATTACHMENT_BYTES} bytes: ${url}`);
    const filename = safeFilename(path.basename(filePath));
    const buffer = await fsp.readFile(filePath);
    return {
      filename,
      contentType: mime.lookup(filename) || 'application/octet-stream',
      content: buffer,
      path: filePath,
      sourceUrl: url
    };
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxContentLength: MAX_ATTACHMENT_BYTES,
    maxBodyLength: MAX_ATTACHMENT_BYTES
  });
  const contentType = response.headers['content-type'] || 'application/octet-stream';
  const urlPath = new URL(url).pathname;
  const ext = mime.extension(contentType) || path.extname(urlPath).replace(/^\./, '') || 'bin';
  const filename = safeFilename(path.basename(urlPath) || `${hashText(url)}.${ext}`);
  const buffer = Buffer.from(response.data);
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过限制 ${MAX_ATTACHMENT_BYTES} bytes: ${url}`);
  const localPath = path.join(getAttachmentDir(), `${Date.now()}-${hashText(url)}-${filename}`);
  await fsp.writeFile(localPath, buffer);
  return {
    filename,
    contentType,
    content: buffer,
    path: localPath,
    sourceUrl: url
  };
}

async function prepareAttachments(value, body) {
  const urls = normalizeAttachmentInputs(value, body);
  const attachments = [];
  const warnings = [];
  for (const url of urls) {
    try {
      attachments.push(await downloadUrlToAttachment(url));
    } catch (error) {
      warnings.push({ url, error: error.message });
    }
  }
  return { attachments, warnings };
}

async function sendMail(args = {}) {
  const user = getDefaultUser(args.user);
  const to = normalizeAddressList(args.to);
  if (!to || to.length === 0) throw new Error('send_mail 需要 to。');
  if (!args.subject) throw new Error('send_mail 需要 subject。');
  if (!args.body && !args.htmlBody) throw new Error('send_mail 需要 body。');

  const body = String(args.body || args.htmlBody || '');
  const html = normalizeBoolean(args.html, false);
  const { attachments, warnings } = await prepareAttachments(args.attachments, body);
  const client = getClient(user);

  const payload = {
    to,
    cc: normalizeAddressList(args.cc),
    bcc: normalizeAddressList(args.bcc),
    subject: String(args.subject),
    body,
    html,
    attachments: attachments.map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      path: att.path
    })).filter(att => att.path)
  };

  Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

  const result = await callFirstAvailable(client, [
    'mail.send',
    'send',
    'emails.send',
    'messages.send',
    'compose.send'
  ], [payload]);

  const lines = [];

  lines.push('# ClawEmail 发送结果');
  lines.push('');
  lines.push('## 状态');
  lines.push('');
  lines.push('- 结果：邮件发送请求已提交');
  lines.push(`- 发件邮箱：${user}`);
  lines.push(`- 收件人：${to.join(', ')}`);
  if (payload.cc) lines.push(`- 抄送：${payload.cc.join(', ')}`);
  if (payload.bcc) lines.push(`- 密送：${payload.bcc.join(', ')}`);
  lines.push(`- 主题：${mdInline(payload.subject, '(无主题)')}`);
  lines.push(`- HTML 模式：${mdBool(payload.html)}`);
  lines.push(`- 附件数量：${attachments.length}`);
  lines.push(`- SDK 状态：${mdInline(result?.status, '未知')}`);
  if (result?.messageId) lines.push(`- SDK messageId：\`${result.messageId}\``);
  lines.push('');

  lines.push('## 正文');
  lines.push('');
  lines.push(body);
  lines.push('');

  lines.push('## 附件处理');
  lines.push('');
  if (attachments.length === 0) {
    lines.push('没有成功附加本地附件。');
  } else {
    lines.push('| # | 文件名 | MIME | 来源 | 本地路径 |');
    lines.push('|---:|---|---|---|---|');
    attachments.forEach((att, index) => {
      lines.push(`| ${index + 1} | ${mdInline(att.filename)} | ${mdInline(att.contentType)} | ${mdInline(att.sourceUrl, '本地/未知')} | \`${mdInline(att.path)}\` |`);
    });
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('### 附件警告');
    lines.push('');
    warnings.forEach((warning, index) => {
      lines.push(`${index + 1}. ${warning.url}：${warning.error}`);
    });
  }

  return asAiText(lines.join('\n'), {
    command: 'send_mail',
    user,
    to,
    attachmentCount: attachments.length,
    warningCount: warnings.length
  });
}

async function replyMail(args = {}) {
  const user = getDefaultUser(args.user);
  const mailId = args.mailId || args.id;
  if (!mailId) throw new Error('reply_mail 需要 mailId。');
  if (!args.body) throw new Error('reply_mail 需要 body。');

  const client = getClient(user);
  const body = String(args.body);
  const { attachments, warnings } = await prepareAttachments(args.attachments, body);
  const payload = {
    id: mailId,
    body,
    html: normalizeBoolean(args.html, false),
    toAll: normalizeBoolean(args.toAll, false),
    cc: normalizeAddressList(args.cc),
    overrideTo: normalizeAddressList(args.overrideTo),
    attachments: attachments.map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      path: att.path
    })).filter(att => att.path)
  };

  try {
    const result = await callFirstAvailable(client, [
      'mail.reply',
      'reply',
      'emails.reply',
      'messages.reply'
    ], [payload]);
    const lines = [];

    lines.push('# ClawEmail 回复结果');
    lines.push('');
    lines.push('## 状态');
    lines.push('');
    lines.push('- 结果：邮件回复请求已提交');
    lines.push(`- 邮箱：${user}`);
    lines.push(`- 被回复 mailId：\`${mailId}\``);
    lines.push(`- 回复全部：${mdBool(payload.toAll)}`);
    if (payload.cc) lines.push(`- 抄送：${payload.cc.join(', ')}`);
    if (payload.overrideTo) lines.push(`- 覆盖收件人：${payload.overrideTo.join(', ')}`);
    lines.push(`- HTML 模式：${mdBool(payload.html)}`);
    lines.push(`- 附件数量：${attachments.length}`);
    lines.push(`- SDK 状态：${mdInline(result?.status, '未知')}`);
    if (result?.messageId) lines.push(`- SDK messageId：\`${result.messageId}\``);
    lines.push('');

    lines.push('## 回复正文');
    lines.push('');
    lines.push(body);
    lines.push('');

    if (attachments.length > 0) {
      lines.push('## 附件');
      lines.push('');
      lines.push('| # | 文件名 | MIME | 来源 | 本地路径 |');
      lines.push('|---:|---|---|---|---|');
      attachments.forEach((att, index) => {
        lines.push(`| ${index + 1} | ${mdInline(att.filename)} | ${mdInline(att.contentType)} | ${mdInline(att.sourceUrl, '本地/未知')} | \`${mdInline(att.path)}\` |`);
      });
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('## 附件警告');
      lines.push('');
      warnings.forEach((warning, index) => {
        lines.push(`${index + 1}. ${warning.url}：${warning.error}`);
      });
    }

    return asAiText(lines.join('\n'), {
      command: 'reply_mail',
      user,
      mailId,
      attachmentCount: attachments.length,
      warningCount: warnings.length
    });
  } catch (error) {
    throw new Error(`SDK 未能原生回复邮件：${error.message}。请改用 send_mail，并手动填写收件人和 Re: 主题。`);
  }
}

async function downloadAttachment(args = {}) {
  const user = getDefaultUser(args.user);
  const mailId = args.mailId || args.id;
  if (!mailId) throw new Error('download_attachment 需要 mailId。');

  if (args.url) {
    const attachment = await downloadUrlToAttachment(String(args.url));
    const fileUrl = `file://${attachment.path.replace(/\\/g, '/')}`;
    return asAiText([
      '# ClawEmail 附件下载结果',
      '',
      '## 状态',
      '',
      '- 结果：附件已下载',
      `- 邮箱：${user}`,
      `- mailId：\`${mailId}\``,
      `- 文件名：${mdInline(attachment.filename)}`,
      `- MIME：${mdInline(attachment.contentType)}`,
      `- 来源 URL：${attachment.sourceUrl}`,
      `- 本地路径：\`${attachment.path}\``,
      `- 可交给后续工具的 file URL：${fileUrl}`
    ].join('\n'), {
      command: 'download_attachment',
      user,
      mailId,
      fileUrl
    });
  }

  const attachmentId = args.attachmentId || args.partId;
  if (!attachmentId) throw new Error('download_attachment 需要 attachmentId、partId 或 url。');

  const client = getClient(user);
  const part = String(args.partId || attachmentId);
  const result = await client.mail.getAttachment({ id: mailId, part });

  await ensureDataDirs();
  const filename = safeFilename(result?.filename || `${attachmentId}.bin`);
  const contentType = result?.contentType || mime.lookup(filename) || 'application/octet-stream';
  const localPath = path.join(getAttachmentDir(), `${Date.now()}-${hashText(`${mailId}:${attachmentId}`)}-${filename}`);

  if (result && typeof result.writeFile === 'function') {
    await result.writeFile(localPath);
  } else if (result && typeof result.buffer === 'function') {
    await fsp.writeFile(localPath, await result.buffer());
  } else if (Buffer.isBuffer(result?.data)) {
    await fsp.writeFile(localPath, result.data);
  } else {
    throw new Error(`SDK 返回的附件格式无法识别，keys=${Object.keys(result || {}).join(',')}`);
  }

  const stat = await fsp.stat(localPath);
  const fileUrl = `file://${localPath.replace(/\\/g, '/')}`;
  return asAiText([
    '# ClawEmail 附件下载结果',
    '',
    '## 状态',
    '',
    '- 结果：附件已下载',
    `- 邮箱：${user}`,
    `- mailId：\`${mailId}\``,
    `- attachmentId/partId：\`${attachmentId}\``,
    `- 文件名：${mdInline(filename)}`,
    `- MIME：${mdInline(contentType)}`,
    `- 大小：${stat.size} bytes`,
    `- 本地路径：\`${localPath}\``,
    `- 可交给后续工具的 file URL：${fileUrl}`
  ].join('\n'), {
    command: 'download_attachment',
    user,
    mailId,
    attachmentId,
    fileUrl,
    size: stat.size
  });
}

async function pollOnce() {
  const users = getUsers();
  if (users.length === 0) {
    cache.lastError = '未配置 ClawMailUsers/ClawMailDefaultUser。';
    updatePlaceholder();
    return;
  }

  const nextUsers = {};
  for (const user of users) {
    try {
      const result = await listEmails({ user, limit: normalizeInteger(config.ClawMailPollLimit, DEFAULT_POLL_LIMIT) });
      nextUsers[user] = result.emails || [];
    } catch (error) {
      nextUsers[user] = cache.users[user] || [];
      cache.lastError = `${user}: ${error.message}`;
      warn('轮询失败:', cache.lastError);
    }
  }

  cache.users = nextUsers;
  cache.updatedAt = new Date().toISOString();
  updatePlaceholder();

  try {
    await ensureDataDirs();
    await fsp.writeFile(path.join(getDataDir(), 'mailbox-cache.json'), JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    warn('写入缓存失败:', error.message);
  }
}

function startPolling() {
  stopPolling();
  const interval = Math.max(10_000, normalizeInteger(config.ClawMailPollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  pollOnce().catch(error => {
    cache.lastError = error.message;
    updatePlaceholder();
  });
  pollTimer = setInterval(() => {
    pollOnce().catch(error => {
      cache.lastError = error.message;
      updatePlaceholder();
    });
  }, interval);
  if (pollTimer.unref) pollTimer.unref();
  log(`轮询已启动，interval=${interval}ms`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function initialize(initialConfig = {}, injectedDependencies = {}) {
  config = initialConfig || {};
  dependencies = injectedDependencies || {};
  debugMode = normalizeBoolean(config.DebugMode, false);
  await ensureDataDirs();

  if (!MailClient) {
    cache.lastError = '缺少 @clawemail/node-sdk，请在 Plugin/VCPClawMail 目录运行 npm install。';
    warn(cache.lastError);
  }

  pluginManager.staticPlaceholderValues.set(PLACEHOLDER, {
    value: 'ClawEmail 邮件助手已加载，正在等待首次轮询...',
    serverId: 'local'
  });

  startPolling();
}

async function processToolCall(params = {}) {
  const command = String(params.command || params.cmd || '').trim();
  if (!command) throw new Error('VCPClawMail 需要 command 参数。');

  switch (command) {
    case 'list_recent':
    case 'list':
      return await listEmails(params);
    case 'read_mail':
    case 'read':
      return await readMail(params);
    case 'send_mail':
    case 'send':
      return await sendMail(params);
    case 'reply_mail':
    case 'reply':
      return await replyMail(params);
    case 'download_attachment':
    case 'download':
      return await downloadAttachment(params);
    case 'poll_now':
      await pollOnce();
      return asAiText([
        '# ClawEmail 立即轮询结果',
        '',
        '- 结果：已触发立即轮询',
        `- 更新时间：${cache.updatedAt || '未知'}`,
        `- 缓存邮箱数：${Object.keys(cache.users).length}`,
        `- 缓存邮件数：${Object.values(cache.users).reduce((sum, mails) => sum + (mails?.length || 0), 0)}`,
        cache.lastError ? `- 最近错误：${cache.lastError}` : '- 最近错误：无'
      ].join('\n'), {
        command: 'poll_now'
      });
    case 'status':
      return asAiText([
        '# ClawEmail 插件状态',
        '',
        `- SDK 已加载：${mdBool(Boolean(MailClient))}`,
        `- 配置邮箱：${getUsers().join(', ') || '无'}`,
        `- 默认邮箱：${config.ClawMailDefaultUser || getUsers()[0] || '无'}`,
        `- 缓存更新时间：${cache.updatedAt || '尚未完成首次轮询'}`,
        `- 最近错误：${cache.lastError || '无'}`,
        '',
        '## 当前占位符内容',
        '',
        buildPlaceholderText()
      ].join('\n'), {
        command: 'status',
        sdkLoaded: Boolean(MailClient)
      });
    default:
      throw new Error(`未知 command: ${command}`);
  }
}

async function shutdown() {
  stopPolling();
  clients.clear();
  try {
    await ensureDataDirs();
    await fsp.writeFile(path.join(getDataDir(), 'mailbox-cache.json'), JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    warn('关闭时写入缓存失败:', error.message);
  }
}

module.exports = {
  initialize,
  processToolCall,
  shutdown,
  pollOnce,
  _private: {
    buildPlaceholderText,
    normalizeAttachmentInputs,
    splitList
  }
};