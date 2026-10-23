'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process');
const entry = path.resolve(__dirname, '../Plugin/NativeSync/native-sync.js');

test('disabled plugin loads without SQLite or optional dependencies and creates no data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sync-disabled-'));
    const target = path.join(dir, 'data');
    const code = `const Module=require('node:module'),original=Module._load;Module._load=function(id,...args){if(id==='node:sqlite'||id==='express')throw Error('OPTIONAL_MODULE_MUST_NOT_LOAD');return original.call(this,id,...args)};const p=require(${JSON.stringify(entry)});p.initialize({NativeSyncEnabled:false,NativeSyncDataDir:${JSON.stringify(target)}}).then(()=>{if(p.snapshot().ready)process.exitCode=1})`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(fs.existsSync(target), false); fs.rmSync(dir, { recursive: true });
});

test('unsupported runtime rejects opt-in before creating storage or importing SQLite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sync-runtime-')), target = path.join(dir, 'data');
    const code = `Object.defineProperty(process.versions,'node',{value:'20.0.0'});const p=require(${JSON.stringify(entry)});p.initialize({NativeSyncEnabled:true,NativeSyncDataDir:${JSON.stringify(target)}}).then(()=>process.exitCode=1,e=>{if(e.code!=='NATIVE_SYNC_NODE_24_REQUIRED')process.exitCode=2})`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(fs.existsSync(target), false); fs.rmSync(dir, { recursive: true });
});
