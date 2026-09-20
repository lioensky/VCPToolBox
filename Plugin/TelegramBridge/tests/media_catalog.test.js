'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgentMediaContext } = require('../src/mediaCatalog');

test('catalog includes only verified unchanged images for the selected Agent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'image'));
  fs.writeFileSync(path.join(root, 'image', 'cuddle.png'), 'fixture');
  const entry = { agent: 'ExampleAgent', path: 'cuddle.png', description: '张开双臂，贴贴和拥抱',
    sha256: crypto.createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(path.join(root, 'media-catalog.json'), JSON.stringify({ version: 1, entries: [entry] }));
  assert.match(getAgentMediaContext(root, path.join(root, 'image'), 'ExampleAgent'), /贴贴和拥抱/);
  assert.equal(getAgentMediaContext(root, path.join(root, 'image'), 'SecondAgent'), '');
  fs.writeFileSync(path.join(root, 'image', 'cuddle.png'), 'changed');
  assert.equal(getAgentMediaContext(root, path.join(root, 'image'), 'ExampleAgent'), '');
});
