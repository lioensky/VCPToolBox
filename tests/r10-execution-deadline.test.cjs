'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {CentralStore}=require('../Plugin/NativeSync/sync/centralStore'),{ConversationExecution}=require('../Plugin/NativeSync/mobile/execution'),{MobilePortal}=require('../Plugin/NativeSync/mobile/portal');
const topic={key:'deadline-topic',ownerType:'agent',ownerId:'synthetic-owner',topicId:'topic',agentAlias:'synthetic',model:'synthetic'};
const agent={isAgent:()=>true,getAgentPrompt:async()=> 'synthetic only'};
function store(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r10-deadline-')),s=new CentralStore(path.join(dir,'central.sqlite'));t.after(()=>{s.close();assert.ok(path.basename(dir).startsWith('r10-deadline-'));fs.rmSync(dir,{recursive:true,force:true});});return s;}
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Synthetic deadline condition timed out');await new Promise(r=>setTimeout(r,10));}}
test('execution deadline retains the old default and rejects unbounded/invalid values',async t=>{
 const s=store(t),e=new ConversationExecution({store:s,topics:[topic],agentManager:agent});assert.equal(e.executionTimeoutMs,120000);assert.equal(e.maxConcurrency,4);await e.close();
 for(const executionTimeoutMs of [0,999,300001,1.5,NaN])assert.throws(()=>new ConversationExecution({store:{},topics:[topic],agentManager:agent,executionTimeoutMs}),e=>e.code==='INVALID_EXECUTION_TIMEOUT');
});
test('timeout requires review, releases the Topic only after cleanup and never replays the failed job',async t=>{
 let calls=0,firstAborted=false;const server=http.createServer(async(q,r)=>{for await(const _ of q){}calls++;if(calls===1){r.once('close',()=>{firstAborted=true;});return;}r.setHeader('Content-Type','application/json');r.end('{"choices":[{"message":{"content":"synthetic queued reply"}}]}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const s=store(t),e=new ConversationExecution({store:s,topics:[topic],agentManager:agent,executionTimeoutMs:1000});t.after(async()=>{await e.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 e.setEndpoint({url:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',key:'synthetic'});
 const body={topicKey:topic.key,requestId:'timeout-request-1',text:'synthetic slow result'},first=e.accept('device',body),second=e.accept('device',{...body,requestId:'timeout-request-2'});
 await until(()=>calls===1);assert.equal(e.get(second.id).state,'queued');assert.equal(e.runningTopics.has(topic.key),true);
 await until(()=>e.get(second.id).state==='completed'&&firstAborted);assert.equal(e.get(first.id).state,'failed');assert.equal(e.get(first.id).error_code,'EXECUTION_TIMEOUT_REVIEW_REQUIRED');assert.equal(e.accept('device',body).replayed,true);assert.equal(calls,2);assert.equal(s.metrics().journalRows,3);await e.close();assert.equal(e.inFlight.size,0);
});
test('existing MobilePortal configuration passes the bounded deadline to the same executor',async t=>{
 const s=store(t),p=new MobilePortal({store:s,agentManager:agent,config:{NativeMobileOrigin:'https://synthetic.invalid',NativeMobileTopics:JSON.stringify([topic]),NativeMobileExecutionTimeoutMs:'300000'}});assert.equal(p.engine.executionTimeoutMs,300000);assert.equal(p.engine.maxConcurrency,4);await p.close();
});
