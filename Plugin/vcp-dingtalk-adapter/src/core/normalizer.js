/**
 * 从钉钉原始事件中提取图片信息
 * 钉钉图片消息格式：
 * - msgtype: 'picture'
 * - content: { downloadCode, picURL }
 */
function extractImageInfo(data) {
  const msgtype = String(data?.msgtype || data?.messageType || '').toLowerCase();

  if (msgtype !== 'picture' && msgtype !== 'image') {
    return null;
  }

  // 钉钉图片消息可能的字段
  const content = data?.content || data?.msgContent || {};

  // 优先使用 picURL（公网可访问的图片URL）
  const picURL = content?.picURL || content?.picUrl || content?.url || data?.picURL || '';

  // downloadCode 用于通过钉钉 API 下载图片
  const downloadCode = content?.downloadCode || data?.downloadCode || '';

  if (!picURL && !downloadCode) {
    return null;
  }

  return {
    type: 'image',
    url: picURL,
    downloadCode,
    fileName: content?.fileName || `image_${Date.now()}.jpg`,
  };
}

/**
 * 从钉钉原始事件中提取文件信息
 * 钉钉文件消息格式：
 * - msgtype: 'file'
 * - content: { downloadCode, fileName, fileSize }
 */
function extractFileInfo(data) {
  const msgtype = String(data?.msgtype || data?.messageType || '').toLowerCase();

  if (msgtype !== 'file') {
    return null;
  }

  const content = data?.content || data?.msgContent || {};

  const downloadCode = content?.downloadCode || data?.downloadCode || '';
  const fileName = content?.fileName || data?.fileName || 'unknown_file';

  if (!downloadCode) {
    return null;
  }

  return {
    type: 'file',
    downloadCode,
    fileName,
    fileSize: content?.fileSize || data?.fileSize || 0,
  };
}

/**
 * 从钉钉原始事件中提取音频信息
 * 钉钉语音消息格式：
 * - msgtype: 'voice'
 * - content: { downloadCode, duration }
 */
function extractAudioInfo(data) {
  const msgtype = String(data?.msgtype || data?.messageType || '').toLowerCase();

  if (msgtype !== 'voice' && msgtype !== 'audio') {
    return null;
  }

  const content = data?.content || data?.msgContent || {};

  const downloadCode = content?.downloadCode || data?.downloadCode || '';

  if (!downloadCode) {
    return null;
  }

  return {
    type: 'audio',
    downloadCode,
    duration: content?.duration || 0,
    fileName: `voice_${Date.now()}.amr`,
  };
}

export function normalizeIncomingMessage(rawEvent) {
  const data = rawEvent?.data || rawEvent || {};

  const text =
    data?.text?.content ||
    data?.content ||
    data?.msgContent?.text ||
    '';

  const conversationType = String(
    data?.conversationType ??
    data?.conversation?.conversationType ??
    '1'
  );

  const conversationId =
    data?.conversationId ||
    data?.conversation?.conversationId ||
    data?.cid ||
    '';

  if (!conversationId) {
    return null;
  }

  const rawMsgType = data?.msgtype || data?.messageType || (text ? 'text' : 'unknown');
  const msgTypeLower = String(rawMsgType).toLowerCase();

  // 提取媒体信息
  const imageInfo = extractImageInfo(data);
  const fileInfo = extractFileInfo(data);
  const audioInfo = extractAudioInfo(data);

  // 确定消息类型
  let messageType = 'text';
  let media = null;

  if (imageInfo) {
    messageType = 'image';
    media = imageInfo;
  } else if (fileInfo) {
    messageType = 'file';
    media = fileInfo;
  } else if (audioInfo) {
    messageType = 'audio';
    media = audioInfo;
  } else if (text) {
    messageType = 'text';
  } else {
    messageType = msgTypeLower || 'unknown';
  }

  return {
    messageId: data?.msgId || data?.messageId || `msg_${Date.now()}`,
    conversationId,
    conversationTitle: data?.conversationTitle || data?.title || '',
    userId: data?.senderStaffId || data?.senderId || '',
    senderNick: data?.senderNick || '',
    senderCorpId: data?.senderCorpId || '',
    isAdmin: Boolean(data?.isAdmin),
    chatType: conversationType === '2' ? 'group' : 'single',
    messageType,
    text: String(text || '').trim(),
    isAt: Boolean(data?.isInAtList),
    isFromSelf: false,
    robotCode: data?.robotCode || '',
    sessionWebhook: data?.sessionWebhook || '',
    sessionWebhookExpiredTime: Number(data?.sessionWebhookExpiredTime || 0),
    // 新增媒体字段
    media,
    raw: rawEvent,
  };
}