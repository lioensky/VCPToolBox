'use strict';

function formatResponseText(payload) {
  const type = payload?.type;
  if (type === 'whoami') return `user_id=${payload.userId}\nchat_id=${payload.chatId}`;
  if (type === 'access_denied') return 'Access denied.';
  if (type === 'start') return 'TelegramBridge is ready. Use /help for commands.';
  if (type === 'help') return [
    'Commands: /status /agent /new /stop /retry /tasks /whoami',
    'Supports text, photo, document, voice, video and GIF input.',
    'Agent rich text is converted for Telegram; VCP images are sent as media.',
    'Tools may request approval, and asynchronous results return automatically.',
  ].join('\n');
  if (type === 'agent_list') return `Agents: ${payload.allowedAgents.join(', ')}\nActive: ${payload.activeAgent ?? 'unavailable'}`;
  if (type === 'agent_switched') return `Agent switched to ${payload.agent}.`;
  if (type === 'agent_not_allowed') return 'Agent is not allowed.';
  if (type === 'new_conversation') return `New ${payload.agent} conversation started.`;
  if (type === 'status') return [
    `Mode: ${payload.mode}; State: ${payload.state}; Agent: ${payload.agent}`,
    `VCP: ${payload.vcpReadiness}; Poller: ${payload.pollerState}`,
    `Active: ${payload.activeRequests}; Queued: ${payload.queuedRequests}; Dead letters: ${payload.deadLetters}`,
  ].join('\n');
  if (type === 'tasks') return payload.tasks.length === 0
    ? 'No asynchronous tasks.'
    : payload.tasks.map((task) => `${task.taskId}: ${task.status}`).join('\n');
  if (type === 'retry_accepted') return 'Retry queued.';
  if (type === 'retry_options') return payload.requests.length===0 ? '当前会话没有可重试记录。'
    : '可重试记录（状态不确定的任务可能已执行过工具，请确认后再重试）：\n'
      + payload.requests.map(row=>`/retry ${row.requestId} — ${row.status==='needs_review'?'结果待核对':'执行前失败'}`).join('\n');
  if (type === 'album_incomplete') return '这组相册有附件到达过晚或超过数量限制，请重新发送缺少的部分。';
  if (type === 'retry_refused' || type === 'retry_invalid') return 'Retry refused.';
  if (type === 'stop_result') return payload.stopped ? 'Stop requested.' : 'No active request.';
  if (type === 'no_active_request') return 'No active request.';
  if (type === 'command_invalid') return 'Invalid command.';
  return 'Unknown command.';
}

module.exports = { formatResponseText };
