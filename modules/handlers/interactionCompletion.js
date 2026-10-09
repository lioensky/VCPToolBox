'use strict';

// 上游整轮有效 + HTTP finish 才提交；任何失败只结算当前 pending turn。
function createInteractionCompletion({ res, signal, oneRingModule, oneRingMeta, messages, tavernInteraction }) {
  let outcome = null;
  let finished = res.writableFinished === true;
  let settled = false;
  const run = (label, action) => {
    Promise.resolve().then(action).catch(error => console.error(`[${label}] 交互结算失败:`, error));
  };
  const cleanup = () => {
    res.off('finish', onFinish);
    res.off('close', onClose);
    res.off('error', fail);
    signal?.removeEventListener('abort', fail);
  };
  const settle = (completed) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (oneRingModule) {
      run('OneRing', () => {
        if (!completed && typeof oneRingModule.markAIResponseAborted === 'function') {
          return oneRingModule.markAIResponseAborted(oneRingMeta);
        }
        const state = { completed };
        const text = completed ? outcome.aiText : '';
        return oneRingMeta && typeof oneRingModule.recordAIResponseWithMeta === 'function'
          ? oneRingModule.recordAIResponseWithMeta(oneRingMeta, text, state)
          : oneRingModule.recordAIResponseFromMessages?.(messages, text, state);
      });
    }
    if (completed && typeof tavernInteraction?.commit === 'function') {
      run('VCPTavern', () => tavernInteraction.commit());
    }
  };
  function fail() { settle(false); }
  function check() {
    if (signal?.aborted || (res.destroyed && !finished)) return fail();
    if (!outcome) return;
    if (outcome.completed !== true) return fail();
    if (finished) settle(true);
  }
  function onFinish() { finished = true; check(); }
  function onClose() {
    if (!finished && res.writableFinished !== true) fail();
    else { finished = true; check(); }
  }
  res.once('finish', onFinish);
  res.once('close', onClose);
  res.once('error', fail);
  signal?.addEventListener('abort', fail, { once: true });
  check();
  return {
    accept(result) {
      if (settled || outcome) return;
      outcome = result || { completed: false };
      check();
    },
    fail
  };
}

module.exports = { createInteractionCompletion };