const assert = require('node:assert/strict');
const test = require('node:test');

const TaskAssistant = require('../Plugin/VCPTaskAssistant/vcp-task-assistant.js');

const {
  normalizePromptText,
  parseTaskEcho,
  inferDiaryAnchors,
  normalizeDreamQuietWindow,
  isInDreamQuietWindow,
  getDreamQuietWindowEnd,
  alignRunTimeAfterDreamWindow
} = TaskAssistant._testHooks;

test('normalizePromptText turns escaped newlines into readable task prompts', () => {
  const normalized = normalizePromptText('【任务名称】巡检\\n\\n【公开落点】\\n- 必须写入 [大师的记忆整理]');

  assert.equal(normalized.includes('\\n'), false);
  assert.equal(normalized.includes('\n\n【公开落点】'), true);
});

test('delegation echoes with completion semantics are accepted as completed task echoes', () => {
  const echo = parseTaskEcho('【大师 委托回声】\n**梦系统整理线索巡检完成。** 已登记1条线索，落盘巡检纪要。');

  assert.equal(echo.found, true);
  assert.equal(echo.compatible, true);
  assert.equal(echo.status, 'completed');
});

test('parseTaskEcho chooses the real status block when multiple task echo markers appear', () => {
  const echo = parseTaskEcho([
    '【任务回声】模块。',
    '',
    '核心要点：已执行查看公共日常，并写入记录。',
    '',
    '【律曦 委托回声】',
    '让我把最终的回声封装好。',
    '【任务回声】',
    '',
    '**状态**：已完成',
    '',
    '**本轮主动动作**：',
    '- 查看公共日常并写入独立记录。',
    '',
    '**我留下的公开痕迹**：',
    '- [公共的日常] 共鸣心跳-律曦。',
    '',
    '**给未来自己的锚点**：',
    '- 本轮无需未来锚点。'
  ].join('\n'));

  assert.equal(echo.found, true);
  assert.equal(echo.status, 'completed');
  assert.equal(echo.statusText, '已完成');
  assert.equal(echo.raw.startsWith('【任务回声】\n\n**状态**'), true);
});

test('parseTaskEcho accepts markdown-bold status labels', () => {
  const echo = parseTaskEcho('【任务回声】\n**状态**：已完成\n【任务回声结束】');

  assert.equal(echo.found, true);
  assert.equal(echo.status, 'completed');
  assert.equal(echo.statusText, '已完成');
});

test('diary anchor inference ignores protocol markers and format placeholders', () => {
  const task = {
    payload: {
      promptTemplate: [
        '必须在 [大师的记忆整理] 新建本轮记录。',
        '[HH:MM] 记忆大师V2 梦系统整理线索登记',
        '完成纪要后，请用 [[TaskComplete]] 收束。'
      ].join('\n')
    },
    targets: { agents: ['大师'] }
  };

  const anchors = inferDiaryAnchors(task).map(anchor => anchor.diaryName);

  assert.deepEqual(anchors, ['大师的记忆整理']);
});


test('dream quiet window treats 01:00-08:00 as quiet time', () => {
  const windowConfig = normalizeDreamQuietWindow({ enabled: true, startHour: 1, endHour: 8 });

  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T00:59:00+08:00'), windowConfig), false);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T01:00:00+08:00'), windowConfig), true);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T07:59:00+08:00'), windowConfig), true);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T08:00:00+08:00'), windowConfig), false);
});

test('dream quiet window supports cross-midnight windows', () => {
  const windowConfig = normalizeDreamQuietWindow({ enabled: true, startHour: 22, endHour: 6 });

  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T21:59:00+08:00'), windowConfig), false);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T22:00:00+08:00'), windowConfig), true);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-04T05:59:00+08:00'), windowConfig), true);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-04T06:00:00+08:00'), windowConfig), false);
});

test('dream quiet window preserves midnight as a valid boundary', () => {
  const windowConfig = normalizeDreamQuietWindow({ enabled: true, startHour: 22, endHour: 0 });

  assert.equal(windowConfig.endHour, 0);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-03T23:30:00+08:00'), windowConfig), true);
  assert.equal(isInDreamQuietWindow(new Date('2026-05-04T00:00:00+08:00'), windowConfig), false);
});

test('quiet-time scheduled runs align to the window end', () => {
  const windowConfig = normalizeDreamQuietWindow({ enabled: true, startHour: 1, endHour: 8 });
  const quietTime = new Date('2026-05-03T02:30:00+08:00');
  const daytime = new Date('2026-05-03T12:30:00+08:00');

  assert.equal(getDreamQuietWindowEnd(quietTime, windowConfig).getHours(), 8);
  assert.equal(alignRunTimeAfterDreamWindow(quietTime).getHours(), 8);
  assert.equal(alignRunTimeAfterDreamWindow(daytime).getTime(), daytime.getTime());
});
