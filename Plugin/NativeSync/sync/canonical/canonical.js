"use strict";

const { computeMessageFingerprint } = require("./hash");

const MAX_WARNING_SAMPLES = 8;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_SQLITE_INTEGER = BigInt("9223372036854775807");

class SyncProtocolError extends Error {
  constructor(message, code = "SYNC_PROTOCOL_INVALID") {
    super(message);
    this.name = "SyncProtocolError";
    this.code = code;
  }
}

class BoundedWarnings {
  constructor(limit = MAX_WARNING_SAMPLES) {
    this.limit = limit;
    this.count = 0;
    this.samples = [];
  }

  push(message) {
    this.count += 1;
    if (this.samples.length < this.limit) {
      this.samples.push(message);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncProtocolError(`${field} must be a non-empty string`);
  }
  return value;
}

function canonicalSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function readHashField(object, key) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] === null) {
    return { kind: "missing" };
  }
  const hash = canonicalSha256(object[key]);
  return hash ? { kind: "valid", hash } : { kind: "invalid" };
}

function normalizeNonNegativeInteger(value, field) {
  let parsed;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SyncProtocolError(`${field} must be a non-negative safe integer`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new SyncProtocolError(
      `${field} must be a non-negative integer or integer string`,
    );
  }

  if (parsed > MAX_SQLITE_INTEGER || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SyncProtocolError(`${field} exceeds the supported integer range`);
  }
  return Number(parsed);
}

function normalizeAttachmentSize(value, field) {
  if (value === undefined || value === null) return 0;
  return normalizeNonNegativeInteger(value, field);
}

function canonicalizeAttachment(value, messageId, index, warnings) {
  if (!isPlainObject(value)) {
    throw new SyncProtocolError(
      `Message ${messageId} attachment ${index} must be an object`,
    );
  }

  const object = { ...value };
  let nested = null;
  if (Object.prototype.hasOwnProperty.call(object, "_fileManagerData")) {
    const rawNested = object._fileManagerData;
    if (rawNested !== null && !isPlainObject(rawNested)) {
      warnings.push(
        `message=${messageId} attachment=${index}: invalid _fileManagerData`,
      );
      return null;
    }
    if (isPlainObject(rawNested)) nested = { ...rawNested };
  }

  const topHash = readHashField(object, "hash");
  const nestedHash = nested
    ? readHashField(nested, "hash")
    : { kind: "missing" };

  let hash = null;
  if (topHash.kind === "valid" && nestedHash.kind === "valid") {
    if (topHash.hash === nestedHash.hash) hash = topHash.hash;
  } else if (topHash.kind === "valid") {
    hash = topHash.hash;
  } else if (nestedHash.kind === "valid") {
    hash = nestedHash.hash;
  }

  if (!hash) {
    warnings.push(
      `message=${messageId} attachment=${index}: missing, invalid, or conflicting SHA-256`,
    );
    return null;
  }

  const selectPublic = (key) => {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
    return nested && Object.prototype.hasOwnProperty.call(nested, key)
      ? nested[key]
      : undefined;
  };

  const attachment = {
    type: typeof object.type === "string" ? object.type : "",
    name: typeof object.name === "string" ? object.name : "unnamed",
    size: normalizeAttachmentSize(
      object.size,
      `Message ${messageId} attachment ${index} size`,
    ),
    hash,
  };

  const extractedText = selectPublic("extractedText");
  if (extractedText !== undefined && extractedText !== null) {
    if (typeof extractedText !== "string") {
      throw new SyncProtocolError(
        `Message ${messageId} attachment ${index} extractedText must be a string`,
      );
    }
    attachment.extractedText = extractedText;
  }

  const imageFrames = selectPublic("imageFrames");
  if (imageFrames !== undefined && imageFrames !== null) {
    if (
      !Array.isArray(imageFrames) ||
      imageFrames.some((frame) => typeof frame !== "string")
    ) {
      throw new SyncProtocolError(
        `Message ${messageId} attachment ${index} imageFrames must contain strings`,
      );
    }
    attachment.imageFrames = [...imageFrames];
  }

  const createdAt = selectPublic("createdAt");
  if (createdAt !== undefined && createdAt !== null) {
    attachment.createdAt = normalizeNonNegativeInteger(
      createdAt,
      `Message ${messageId} attachment ${index} createdAt`,
    );
  }

  return attachment;
}

function canonicalizeMessage(value, topicId, warnings = new BoundedWarnings(), rewrites) {
  if (!isPlainObject(value)) {
    throw new SyncProtocolError(`Topic ${topicId} contains a non-object message`);
  }

  const id = requireNonEmptyString(value.id, `Topic ${topicId} message id`);
  const role = requireNonEmptyString(value.role, `Message ${id} role`);
  // topicId 是来源元数据而非消息身份：frame topic 才是双端存储权威，消息指纹
  // 也不含 topicId。话题分支会合法地让消息携带旧话题的 topicId（1.0 时代从未
  // 校验过），因此早期引入的"topicId 必须等于 frame topic"硬校验
  // 降级为 frame 权威归一化：不一致（或非字符串）时重写为 frame topic。
  // 注意：重写计数不得混入 warnings（附件告警在 push 路径是硬失败门禁）。
  if (
    Object.prototype.hasOwnProperty.call(value, "topicId") &&
    value.topicId !== null &&
    value.topicId !== topicId
  ) {
    if (rewrites) {
      rewrites.push(
        `message=${id}: topicId ${JSON.stringify(value.topicId)} normalized to frame topic ${topicId}`,
      );
    }
    value = { ...value, topicId };
  }
  if (
    value.status === "removed" ||
    (Object.prototype.hasOwnProperty.call(value, "deletedAt") &&
      value.deletedAt !== null)
  ) {
    throw new SyncProtocolError(
      `Tombstoned message ${id} must not appear in a live pull frame`,
    );
  }

  const message = {
    id,
    role,
  };
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== "string") {
      throw new SyncProtocolError(`Message ${id} name must be a string`);
    }
    message.name = value.name;
  }
  if (value.content !== undefined && value.content !== null && typeof value.content !== "string") {
    throw new SyncProtocolError(`Message ${id} content must be a string`);
  }
  message.content = typeof value.content === "string" ? value.content : "";
  message.timestamp = normalizeNonNegativeInteger(
    value.timestamp,
    `Message ${id} timestamp`,
  );
  if (
    value.updatedAt !== undefined &&
    value.updatedAt !== null &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  ) {
    message.updatedAt = value.updatedAt;
  }

  for (const [key, type] of [
    ["agentId", "string"],
    ["groupId", "string"],
    ["topicId", "string"],
    ["isGroupMessage", "boolean"],
  ]) {
    const fieldValue = value[key];
    if (fieldValue !== undefined && fieldValue !== null) {
      if (typeof fieldValue !== type) {
        throw new SyncProtocolError(`Message ${id} ${key} must be a ${type}`);
      }
      message[key] = fieldValue;
    }
  }

  for (const key of ["finishReason"]) {
    const fieldValue = value[key];
    if (fieldValue !== undefined && fieldValue !== null) {
      if (typeof fieldValue !== "string") {
        throw new SyncProtocolError(`Message ${id} ${key} must be a string`);
      }
      message[key] = fieldValue;
    }
  }

  if (value.attachments !== undefined && value.attachments !== null) {
    if (!Array.isArray(value.attachments)) {
      throw new SyncProtocolError(`Message ${id} attachments must be an array or null`);
    }
    const attachments = [];
    for (let index = 0; index < value.attachments.length; index += 1) {
      const attachment = canonicalizeAttachment(
        value.attachments[index],
        id,
        index,
        warnings,
      );
      if (attachment) attachments.push(attachment);
    }
    if (attachments.length > 0) message.attachments = attachments;
  }

  return message;
}

function messageContentHash(message) {
  return computeMessageFingerprint(message);
}

function canonicalizeTopicFrame(value) {
  if (!isPlainObject(value)) {
    throw new SyncProtocolError("NDJSON frame must be an object");
  }
  const topicId = requireNonEmptyString(value.topicId, "NDJSON frame topicId");
  const hasOwnerType = value.ownerType !== undefined && value.ownerType !== null;
  const hasOwnerId = value.ownerId !== undefined && value.ownerId !== null;
  if (hasOwnerType !== hasOwnerId) {
    throw new SyncProtocolError(
      `NDJSON frame for ${topicId} requires ownerType and ownerId together`,
    );
  }
  let ownerIdentity = {};
  if (hasOwnerType) {
    if (value.ownerType !== "agent" && value.ownerType !== "group") {
      throw new SyncProtocolError(
        `NDJSON frame for ${topicId} has unsupported ownerType`,
      );
    }
    ownerIdentity = {
      ownerType: value.ownerType,
      ownerId: requireNonEmptyString(
        value.ownerId,
        `NDJSON frame ${topicId} ownerId`,
      ),
    };
  }
  if (!Array.isArray(value.messages)) {
    throw new SyncProtocolError(`NDJSON frame for ${topicId} requires messages array`);
  }

  const warnings = new BoundedWarnings();
  if (
    value.legacyAttachmentWarnings !== undefined &&
    value.legacyAttachmentWarnings !== null
  ) {
    const upstreamCount = normalizeNonNegativeInteger(
      value.legacyAttachmentWarnings,
      `NDJSON frame ${topicId} legacyAttachmentWarnings`,
    );
    const upstreamSamples = value.warningSamples ?? [];
    if (
      !Array.isArray(upstreamSamples) ||
      upstreamSamples.some((sample) => typeof sample !== "string")
    ) {
      throw new SyncProtocolError(
        `NDJSON frame ${topicId} warningSamples must contain strings`,
      );
    }
    warnings.count = upstreamCount;
    warnings.samples = upstreamSamples.slice(0, warnings.limit);
  }
  const seen = new Set();
  const topicIdRewrites = new BoundedWarnings();
  const messages = value.messages.map((rawMessage) => {
    const message = canonicalizeMessage(rawMessage, topicId, warnings, topicIdRewrites);
    if (seen.has(message.id)) {
      throw new SyncProtocolError(
        `Topic ${topicId} contains duplicate message ${message.id}`,
      );
    }
    seen.add(message.id);
    message.contentHash = messageContentHash(message);
    return message;
  });

  return {
    frame: {
      topicId,
      ...ownerIdentity,
      messages,
      ...(warnings.count > 0
        ? {
            legacyAttachmentWarnings: warnings.count,
            warningSamples: [...warnings.samples],
          }
        : {}),
    },
    warningCount: warnings.count,
    warningSamples: [...warnings.samples],
    topicIdRewrites: topicIdRewrites.count,
    topicIdRewriteSamples: [...topicIdRewrites.samples],
  };
}

function canonicalizeHistory(history, topicId) {
  if (!Array.isArray(history)) {
    throw new SyncProtocolError(`History root for ${topicId} must be an array`);
  }
  return canonicalizeTopicFrame({ topicId, messages: history });
}

module.exports = {
  BoundedWarnings,
  MAX_WARNING_SAMPLES,
  SyncProtocolError,
  canonicalSha256,
  canonicalizeAttachment,
  canonicalizeHistory,
  canonicalizeMessage,
  canonicalizeTopicFrame,
  messageContentHash,
  normalizeNonNegativeInteger,
};
