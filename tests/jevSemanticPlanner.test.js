'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {JevToolCallExp} = require('../modules/jevToolCallExp');
const {JevToolCatalog} = require('../modules/jevToolCatalog');
const {JevSemanticPlanner} = require('../modules/jevSemanticPlanner');
const offline = () => new JevToolCallExp({jevClient:{isConfigured:()=>false}});
const answer = choice => ({choice,confidence:0.98});
const fakeCatalog = () => new JevToolCatalog({data:{
 version:1,categories:{file_tools:{label:'文件管理',aliases:[]}},excluded:[],tools:{
  SafeDocument:{category:'file_tools',distributed:false,description:'Write documents or find matching documents',commands:[
   {id:'WriteDocument',fixedArgs:{command:'write'},fields:['command','filePath','content'],description:'Write exact content to filePath. Both are required.'},
   {id:'FindDocument',fixedArgs:{command:'find'},fields:['command','query'],description:'Find documents by required query.'}
  ]}
 }
}});
function mocked(callback, catalog=fakeCatalog()){
 const requests=[];const client={isConfigured:()=>true,decide:async(state,questions)=>{requests.push({state,questions});return {answers:callback(state,questions)};}};
 return {planner:new JevToolCallExp({catalog,jevClient:client}),requests};
}

test('日记短句在本地映射，不要求主模型输出 JSON 参数表',async()=>{
 const p=offline();const text='[19:30] 第一行。\nTag: 设计, 无损';
 const [call]=await p.plan('{记忆管理} `DailyNote` 记日记【'+text+'】[日期:2026-09-26][索引:Nova的知识]',{maid:'Nova'});
 assert.equal(call.name,'DailyNote');
 assert.deepEqual(call.args,{command:'create',Date:'2026-09-26',folder:'Nova的知识',Content:text,maid:'Nova'});
 await assert.rejects(p.plan('{记忆管理} `DailyNote` 记日记【正文】',{maid:'Nova'}),/Date/);
 const [update]=await p.plan('{记忆管理} `DailyNote` 更新日记[原文内容至少十五字符用于准确定位]【完整的新内容】',{maid:'Nova'});
 assert.equal(update.args.command,'update');assert.equal(update.args.replace,'完整的新内容');
});

test('明确服务器且动作唯一时不请求 Jev，也不误选前端',async()=>{
 const [call]=await offline().plan('{文件管理} 服务器读取文件【C:/work/a.txt】');
 assert.equal(call.name,'ServerFileOperator');assert.equal(call.args.filePath,'C:/work/a.txt');
});

test('泛化语义调用只选择白名单动作和字段，完整正文由代码复制',async()=>{
 const body='const config = {a:[1,2]};\n'+('正文保持空白和格式。'.repeat(1000));
 const {planner,requests}=mocked((state,q)=>q.action?{action:answer('WriteDocument')}:{slot0:answer('filePath'),slot1:answer('content'),ready:answer('ready')});
 const [call]=await planner.plan('{文件管理} `SafeDocument` 请保存这份文档【'+body+'】[C:/work/a.txt]');
 assert.deepEqual(call.args,{command:'write',filePath:'C:/work/a.txt',content:body});
 assert.equal(requests.length,2);
 assert.equal(Object.keys(requests[1].questions).length,3);
 assert.ok(requests[1].state.anchors.every(a=>a.preview.length<=160));
 assert.ok(!JSON.stringify(requests).includes(body));
});

test('无匹配、低置信度、未知枚举和缺失置信度都停止，不回退猜测',async()=>{
 for(const value of [{choice:'__no_match__',confidence:1},{choice:'WriteDocument',confidence:0.4},{choice:'DeleteEverything',confidence:1},{choice:'WriteDocument'}]){
  const {planner}=mocked(()=>({action:value}));
  await assert.rejects(planner.plan('{文件管理} `SafeDocument` 保存【内容】[C:/a.txt]'),/无法可靠/);
 }
});

test('两个锚点映射同一字段时拒绝覆盖，不静默丢掉正文',async()=>{
 const {planner}=mocked((state,q)=>q.action?{action:answer('WriteDocument')}:{slot0:answer('content'),slot1:answer('content'),ready:answer('ready')});
 await assert.rejects(planner.plan('{文件管理} `SafeDocument` 保存【正文】[C:/a.txt]'),/重复/);
});

test('参数分配不能注入审批或其他控制字段',async()=>{
 const {planner}=mocked((state,q)=>q.action?{action:answer('WriteDocument')}:{slot0:answer('skipApproval'),slot1:answer('content'),ready:answer('ready')});
 await assert.rejects(planner.plan('{文件管理} `SafeDocument` 保存【正文】[C:/a.txt]'),/无法可靠/);
 const second=mocked(()=>({action:answer('WriteDocument')}));
 await assert.rejects(second.planner.plan('{文件管理} `SafeDocument` 保存【正文】[skipApproval:true]'),/控制字段/);
});

test('缺失必要信息的完整性判断失败时不执行',async()=>{
 const {planner}=mocked((state,q)=>q.action?{action:answer('WriteDocument')}:{slot0:answer('content'),ready:answer('__no_match__')});
 await assert.rejects(planner.plan('{文件管理} `SafeDocument` 保存【正文】'),/无法可靠/);
});

test('工具选择限制在能力目录，未知名字或未说明的机器边界不能被模型绕过',async()=>{
 const client={isConfigured:()=>true,decide:async()=>({answers:{tool:answer('ServerFileOperator')}})};
 const p=new JevToolCallExp({jevClient:client});
 await assert.rejects(p.plan('{文件管理} 读取文件【C:/a.txt】'),/服务器还是前端/);
 const c={isConfigured:()=>true,decide:async()=>({answers:{tool:answer('not-in-catalog')}})};
 await assert.rejects(new JevToolCallExp({jevClient:c}).plan('{浏览器} 请感知屏幕'),/无法可靠/);
});

test('帮助默认不展开 JSON 参数手册，类别和单操作可以按需查询',()=>{
 const p=offline();const overview=p.getHelp('{工具目录}');
 assert.ok(!overview.includes('ServerFileOperator'));
 assert.match(p.getHelp('{工具目录}【文件管理】'),/ServerFileOperator/);
 const brief=p.getHelp('{工具目录} `DailyNote`');assert.match(brief,/记日记/);assert.ok(!brief.includes('JEVArgs:'));
 const detail=p.getHelp('{工具目录} `DailyNote` [操作:create]');assert.match(detail,/Content/);
 assert.throws(()=>p.getHelp('{工具目录} `DailyNote` [操作:unknown]'),/没有能力/);
});

test('无可靠选择器的批量契约不被当作默认动作执行',()=>{
 const engine=new JevSemanticPlanner({catalog:new JevToolCatalog(),jevClient:{isConfigured:()=>false}});
 for(const op of engine.operations('AgentDream'))assert.ok(!op.fields.some(field=>/\d+$/.test(field)));
});
test('被否定的动作不能因词面匹配而执行',async()=>{
 await assert.rejects(offline().plan('{文件管理} 在服务器不要删除文件【C:/a.txt】'),/否定/);
});

test('多能力插件不能把不支持的比较动作退回普通检索',async()=>{
 await assert.rejects(offline().plan('{记忆管理} `LightMemo` 对比 TagMemo 的三种引擎【测试词】'),/尚无可靠/);
});

test('编号选项不是编号命令，不应阻断合法的单动作契约',()=>{
 const p=offline();const ops=p.semantic.operations('MimoDubbing');
 assert.ok(ops.length>=2,`上游声明的能力数异常: ${ops.length}`);
 assert.ok(ops.every(op=>Array.isArray(op.fields)));
});

test('空值或非法阈值不会悄悄关闭置信度门槛',()=>{
 for(const minConfidence of ['',null,0,NaN,2])assert.equal(new JevSemanticPlanner({catalog:fakeCatalog(),jevClient:{},minConfidence}).minConfidence,0.8);
 assert.equal(new JevSemanticPlanner({catalog:fakeCatalog(),jevClient:{},minConfidence:0.9}).minConfidence,0.9);
});
