'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entriesOf, collectStreamToolCalls, admitNativeCalls, buildNativeToolMessages, NATIVE_CALL_ID } = require('../modules/nativeToolLoop');
const f = (name, args, id) => ({ id, function:{name, arguments:args} });
const frame = delta => 'data: '+JSON.stringify({choices:[{index:0,delta}]});
test('mixed batch: unique canonical IDs only for admitted calls; next turn independent', () => {
 const good = f('vcptools',{tool_name:'Demo', items:[1,2]},'x');
 const batch = admitNativeCalls([good,f('vcptools','{','bad'),{functionCall:{name:'Demo',args:{x:1}},id:'x'},f('missing',{}),f('Demo',{tool_name:'other'})], n=>n==='Demo');
 assert.deepEqual(batch.rejected,['1:invalid_json','3:unknown_or_conflicting_name','4:unknown_or_conflicting_name']);
 const ids = batch.calls.map(c=>c.id);
 assert.equal(ids[0],'x'); assert.notEqual(ids[1],'x');
 assert.deepEqual(batch.normalized.map(c=>c[NATIVE_CALL_ID]),ids);
 assert.deepEqual(buildNativeToolMessages(batch.calls,[]).map(m=>m.tool_call_id),ids);
 assert.deepEqual(admitNativeCalls([good]).calls[0].id,'x');
});
test('interleaved slots: malformed object/string mix poisons only its slot',()=>{
 const entries = collectStreamToolCalls([frame({tool_calls:[{index:0,...f('vcptools','{"tool_')},{index:2,...f('vcptools',{})}]}),frame({tool_calls:[{index:2,function:{arguments:'x'}},{index:0,function:{arguments:'name":"Demo"}'}}]})]);
 const batch = admitNativeCalls(entries); assert.equal(batch.calls.length,1); assert.equal(batch.normalized[0].name,'Demo'); assert.deepEqual(batch.rejected,['1:fragment_conflict']);
});
test('legacy string fragments, object singleton and missing ID',()=>{
 const entries = collectStreamToolCalls([frame({function_call:{name:'vcptools',arguments:'{"JEV":'}}),frame({function_call:{arguments:'"demo"}'}})]);
 assert.equal(admitNativeCalls(entries).normalized[0].name,'JEV');
 assert.ok(admitNativeCalls(entriesOf({tool_calls:f('vcptools',{tool_name:'Demo'})})).calls[0].id);
});