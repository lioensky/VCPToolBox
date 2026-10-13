'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { JevToolCallExp } = require('../modules/jevToolCallExp');
const planner = new JevToolCallExp({ jevClient: { isConfigured: () => false } });
const plan = async (text, args = {}) => (await planner.plan('{联网搜索} `AnySearch` '+text,args))[0].args;
// Load only the plugin's pure argument compilers; remove CLI entry and forbid I/O.
const pluginPath = path.join(__dirname,'../Plugin/AnySearch/AnySearch.js');
const source = fs.readFileSync(pluginPath,'utf8').replace(/\bmain\(\);\s*$/, '');
const requirePlugin = createRequire(pluginPath);
const sandbox = { require: name => name === 'http' || name === 'https' ? {} : requirePlugin(name), process: {
 stdin: { setEncoding() {}, on() { throw Error('unexpected stdin'); } },
 stdout: { setDefaultEncoding() {}, write(s) { throw Error(s); } }, exit() { throw Error('unexpected exit'); }
} };
vm.runInNewContext(source+'\nglobalThis.compile=compileSearchTasks;globalThis.builders=ARGUMENT_BUILDERS;',sandbox);
const plain = value => JSON.parse(JSON.stringify(value));

test('目录与提取只传对应字段，通过插件自身参数编译',async()=>{
 for(const [input, command, expected] of [
  ['查询子域【finance】','get_sub_domains',{domain:'finance'}],
  ['[操作:get_sub_domains][domains:finance,academic]','get_sub_domains',{domains:['finance','academic']}],
  ['提取正文【https://example.com/a】','extract',{url:'https://example.com/a'}],
  ['[操作:extract][https://example.com/a]','extract',{url:'https://example.com/a'}]
 ]) {
  const args=await plan(input);assert.equal(args.command,command);
  assert.deepEqual(plain(sandbox.builders[command](args)),expected);assert.equal(args.max_results,undefined);
 }
});
test('垂直检索params保留原文，并由插件编译为对象',async()=>{
 const args=await plan('【Jinja2漏洞】[sub_domain:security.vuln][params:type=package,value=PyPI:jinja2@2.4.1][数量:3]');
 assert.equal(args.query,'Jinja2漏洞');assert.equal(args.params,'type=package,value=PyPI:jinja2@2.4.1');
 const [route]=sandbox.compile(args);assert.deepEqual(plain(route.params),{type:'package',value:'PyPI:jinja2@2.4.1'});assert.equal(route.max_results,3);
});
test('同条件批量与不连续编号继承、覆盖结果符合插件契约',async()=>{
 const batch=await plan('[操作:batch_search]【AI|EV】[zone:intl][数量:4]');
 const routes=plain(sandbox.compile(batch));assert.equal(routes.length,2);assert.deepEqual(routes.map(r=>r.query),['AI','EV']);assert.ok(routes.every(r=>r.zone==='intl'&&r.max_results===4));
 const numbered=await plan('【共同问题】[zone:intl][数量:5][sub_domain1:code.doc][params1:library=golang][query3:另一个问题][zone3:cn][max_results3:2]');
 const result=plain(sandbox.compile(numbered));assert.equal(result.length,2);assert.equal(result[0].query,'共同问题');assert.equal(result[0].zone,'intl');assert.equal(result[1].query,'另一个问题');assert.equal(result[1].zone,'cn');assert.equal(result[1].max_results,2);
});
test('JEVArgs复杂对象保留结构而不拼接或丢失字段',async()=>{
 const payload={query:'合同',sub_domain:'legal.case',params:{keywords:['甲','乙'],filter:{year:2026}},zone:'intl'};
 const args=await plan('',{JEVArgs:JSON.stringify(payload)});assert.deepEqual(args.params,payload.params);assert.deepEqual(plain(sandbox.compile(args)[0].params),payload.params);
});
test('冲突、未知字段、无查询路线和越界批量在规划时拒绝',async()=>{
 for(const text of [
  '[操作:extract]','[操作:extract]【file:///a】','[操作:extract]【https://example.com】[数量:2]',
  '[操作:get_sub_domains]','[操作:get_sub_domains]【finance】[domains:code]',
  '[操作:batch_search]【a|b|c|d|e|f】','[操作:batch_search]【a||b】',
  '[queries:a|b][query1:c]','【公共】[queries:a|b]','[sub_domain1:code.doc]',
  '[query6:x]','【a】[zone3:us]','【a】[max_results2:11]',
  '【a】[数量:2][max_results:3]','【a】[domain:code][sub_domain:finance.news]'
 ]) await assert.rejects(plan(text),/JEV AnySearch/,text);
 await assert.rejects(plan('【重复】',{JEVArgs:'{"query":"a"}'}),/不要重复/);
});
