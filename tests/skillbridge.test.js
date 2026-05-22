const test = require('node:test');
const assert = require('node:assert/strict');

const { runSkillBridge } = require('../Plugin/SkillBridge/SkillBridge.js');

test('SkillBridge should still emit stdout when local index persistence fails', async () => {
  let stdoutValue = '';
  const warnings = [];

  const result = await runSkillBridge({
    collectEntries: async () => ([
      {
        name: 'demo-skill',
        skillPath: 'SKILL/demo-skill/SKILL.md',
        summary: 'Demo summary'
      }
    ]),
    writeFile: async () => {
      throw new Error('disk is read-only');
    },
    stdout: {
      write(chunk) {
        stdoutValue += chunk;
      }
    },
    warn(message) {
      warnings.push(message);
    }
  });

  assert.equal(result.persisted, false);
  assert.match(stdoutValue, /当前共暴露 1 个 Skill 索引。/);
  assert.match(stdoutValue, /- Skill: demo-skill/);
  assert.match(stdoutValue, /- 路径: SKILL\/demo-skill\/SKILL\.md/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /写入本地索引失败/);
});
