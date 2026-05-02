function toAttachmentArray(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  if (Array.isArray(candidate.attachments)) return candidate.attachments;
  if (Array.isArray(candidate.vcp_attachments)) return candidate.vcp_attachments;
  return [];
}

function normalizeAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  const serverAttachmentId = String(item.serverAttachmentId || item.id || '').trim();
  const name = String(item.name || item.fileName || '').trim();
  const downloadUrl = String(item.downloadUrl || '').trim();

  if (!serverAttachmentId || !name || !downloadUrl) return null;

  return {
    serverAttachmentId,
    name,
    type: item.type || item.mimeType || 'application/octet-stream',
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
    src: item.src || item.sourceUrl || undefined,
    hash: item.hash || undefined,
    downloadUrl,
    disposition: item.disposition || 'download',
    createdAt: item.createdAt || undefined,
    expiresAt: item.expiresAt || undefined
  };
}

function collectAttachmentsFromRaw(raw) {
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    candidates.push(...toAttachmentArray(value));
    if (value.result) visit(value.result, depth + 1);
    if (value.data) visit(value.data, depth + 1);
    if (value.raw) visit(value.raw, depth + 1);
  };

  visit(raw);
  const deduped = new Map();
  for (const attachment of candidates.map(normalizeAttachment).filter(Boolean)) {
    deduped.set(attachment.serverAttachmentId, attachment);
  }
  return Array.from(deduped.values());
}

function collectAttachmentsFromToolResults(toolResults = []) {
  const deduped = new Map();
  for (const result of toolResults) {
    for (const attachment of collectAttachmentsFromRaw(result?.raw)) {
      deduped.set(attachment.serverAttachmentId, attachment);
    }
  }
  return Array.from(deduped.values());
}

function buildAttachmentChunk({ model = 'unknown', attachments = [] } = {}) {
  return {
    id: `chatcmpl-VCP-attachments-${Date.now()}`,
    object: 'vcp.attachment.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    vcp_attachments: attachments,
    attachments
  };
}

module.exports = {
  buildAttachmentChunk,
  collectAttachmentsFromRaw,
  collectAttachmentsFromToolResults,
  normalizeAttachment
};
