'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { JevToolCallExp } = require('../modules/jevToolCallExp');
const { parseFoldBlocks } = require('../modules/foldProtocol');
const planner = new JevToolCallExp({ jevClient: { isConfigured: () => false } });
const plan = s => planner.plan(s, { maid: 'Nova' });
test('日程增删查与清理，使用真实原生字段', async () => {
 for (const [expr, expected] of [
  ['添加日程【检查报告】[2026-10-06 10:00]', { command: 'AddSchedule', content: '检查报告', time: '2026-10-06 10:00', maid: 'Nova' }],
  ['查看日程', { command: 'ListSchedules', maid: 'Nova' }],
  ['删除日程【1735564800000】', { command: 'DeleteSchedule', id: '1735564800000', maid: 'Nova' }],
  ['清理过期日程', { command: 'ClearExpired', maid: 'Nova' }]
 ]) assert.deepEqual((await plan('{日用工具} `日程` '+expr))[0].args, expected);
});
test('未注册的日用工具名直接拒绝，不猜测执行', async () => {
 await assert.rejects(plan('{日用工具} `TopicSponsor` [操作:CreateTopic]【正文】'), /没有工具 "TopicSponsor"|没有工具 'TopicSponsor'/);
});
test('两条通讯路由一致，时间归一化，查询和取消无需伪造收件人', async () => {
 const a = (await plan('{通讯协作} `AgentAssistant` [Nova][临时通讯][timely_contact:2026-10-06 10:30][上下文:last:3]【请查看任务】'))[0];
 const b = (await plan('{日用工具} `女仆通讯` [Nova][临时通讯][timely_contact:2026-10-06 10:30][上下文:last:3]【请查看任务】'))[0];
 assert.deepEqual(a.args,b.args); assert.equal(a.args.timely_contact,'2026-10-06-10:30');assert.equal(a.river,'last:3');
 for (const key of ['query_delegation','cancel_delegation']) {
  const call=(await plan('{通讯协作} `AgentAssistant` ['+key+':aa-delegation-example]'))[0];
  assert.deepEqual(call.args,{[key]:'aa-delegation-example',maid:'Nova'});
 }
});
test('生图不改变显式尺寸，图片数组、组图和模型查询映射正确',async()=>{
 const g=(await plan('{图片生成} `GPT生图`【图标】[size:1536x1024][quality:high][background:transparent][n:2]'))[0];
 assert.equal(g.args.size,'1536x1024');assert.equal(g.args.n,'2');assert.equal(g.args.background,'transparent');
 const edit=(await plan('{图片生成} `GPT生图`【改背景】[https://example.com/a.png][https://example.com/b.png]'))[0];
 assert.equal(edit.args.command,'GPTEditImage');assert.equal(edit.args.image.length,2);
 const compose=(await plan('{图片生成} `豆包`【融合】[https://example.com/a.png][https://example.com/b.png][4K]'))[0];
 assert.equal(compose.args.command,'compose');assert.equal(compose.args.resolution,'4K');
 const group=(await plan('{图片生成} `豆包` [操作:group]【连贯组图】[max_images:6]'))[0];assert.equal(group.args.max_images,'6');
 for(const [tool,command] of [['GPT生图','GPTListModels'],['豆包','list_models']]) assert.equal((await plan('{图片生成} `'+tool+'` [操作:'+command+']'))[0].args.command,command);
});
test('缺参、非法日期、未知字段及互斥操作必须报错',async()=>{
 for(const expr of [
  '{日用工具} `日程` 添加日程【事项】[明天下午3点]',
  '{日用工具} `日程` 添加日程【事项】[2026-02-30 10:00]',
  '{日用工具} `日程` [操作:ListSchedules][time:2026-10-06 10:00]',
  '{通讯协作} `AgentAssistant` [query_delegation:x][cancel_delegation:y]',
  '{通讯协作} `AgentAssistant` [Nova][timely_contact:2026-10-06 25:00]【消息】',
  '{通讯协作} `AgentAssistant` [Nova][foo:bar]【消息】',
  '{图片生成} `GPT生图`【图】[n:0]',
  '{图片生成} `GPT生图`【图】[size:1024x1024][size:1536x1024]',
  '{图片生成} `豆包` [操作:compose]【融合】[https://example.com/a.png]',
  '{图片生成} `豆包` [操作:group]【图】[max_images:16]'
 ]) await assert.rejects(plan(expr),/JEV/,expr);
});
test('提示词折叠节中的官方插件示例均可离线规划',async()=>{
 const fs = require('node:fs'), path = require('node:path');
 const jev = fs.readFileSync(path.join(__dirname,'../TVStxt','JevToolCall.txt'),'utf8');
 const names=['LightMemo','NanoBananaGen2','ZImageTurboGen','AnySearch','TavilySearch','VSearch','BilibiliFetch','UrlFetch','AgentMessage','SciCalculator','VCPSleep','ScheduleManager','AgentAssistant','GPTImageGen','DoubaoGen','ServerFileOperator','ServerSearchController'];
 let examples=0;
 for(const name of names){
  const block=parseFoldBlocks(jev).find(b=>b.description?.startsWith(name+' '));assert.ok(block,name);
  // 「按 JEVArgs…」示例依赖同块的 JEVArgs 载荷，单行规划不适用，跳过。
  for(const m of block.content.matchAll(/JEV:「始」([^\r\n]+?)「末」/g)) {
   if (m[1].includes('JEVArgs')) continue;
   assert.equal((await plan(m[1])).length,1,m[1]); examples++;
  }
 }
 assert.ok(examples>=30,'提示词示例数量异常: '+examples);
});
