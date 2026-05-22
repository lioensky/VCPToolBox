const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadVCPTavernClass() {
  const pluginPath = path.join(__dirname, '..', 'Plugin', 'VCPTavern', 'VCPTavern.js');
  const source = `${fs.readFileSync(pluginPath, 'utf8')}\nmodule.exports.__VCPTavernClass = VCPTavern;`;
  const sandboxModule = { exports: {} };
  const sandbox = {
    require,
    module: sandboxModule,
    exports: sandboxModule.exports,
    __dirname: path.dirname(pluginPath),
    console,
    process
  };
  vm.runInNewContext(source, sandbox, { filename: pluginPath });
  return sandboxModule.exports.__VCPTavernClass;
}

function makeMessages(presetName) {
  return [
    { role: 'system', content: `Name: PrivacyTest\n{{VCPTavern::${presetName}::session-a}}` },
    { role: 'user', content: 'hello' }
  ];
}

test('VCPTavern skips access log identity when preset has no access-time variables', async () => {
  const VCPTavern = loadVCPTavernClass();
  const tavern = new VCPTavern();
  let saveCalls = 0;
  tavern._saveAccessLogs = async () => {
    saveCalls += 1;
  };
  tavern.presets.set('plain', {
    rules: [
      {
        enabled: true,
        type: 'relative',
        position: 'after',
        target: 'system',
        content: 'Current date is {{Date}}.'
      }
    ]
  });

  const result = await tavern.processMessages(makeMessages('plain'), {});

  assert.equal(saveCalls, 0);
  assert.equal(tavern.accessLogs.size, 0);
  assert.ok(result.some((message) => String(message.content).includes('Current date is')));
});

test('VCPTavern records access log only when preset uses last-chat variables', async () => {
  const VCPTavern = loadVCPTavernClass();
  const tavern = new VCPTavern();
  let saveCalls = 0;
  tavern._saveAccessLogs = async () => {
    saveCalls += 1;
  };
  tavern.presets.set('tracked', {
    rules: [
      {
        enabled: true,
        type: 'relative',
        position: 'after',
        target: 'system',
        content: 'Memory marker: {{LastChatTime}} {{TimeSinceLastChat}}'
      }
    ]
  });

  const result = await tavern.processMessages(makeMessages('tracked'), {});

  assert.equal(saveCalls, 1);
  assert.equal(tavern.accessLogs.has('tracked:session-a'), true);
  assert.ok(result.some((message) => String(message.content).includes('Memory marker:')));
});
