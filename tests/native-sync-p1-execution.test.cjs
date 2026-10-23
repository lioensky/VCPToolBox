'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {CentralStore}=require('../Plugin/NativeSync/sync/centralStore');
const {ConversationExecution}=require('../Plugin/NativeSync/mobile/execution');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+2500;while(!fn()){if(Date.now()>end)throw Error('Synthetic execution condition timed out');await pause(5);}}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const topics=['a','b','c','d'].map(key=>({key,ownerType:'agent',ownerId:'synthetic-'+key,topicId:'topic',agentAlias:key,model:'synthetic'}));
const agent={isAgent:()=>true,getAgentPrompt:async alias=>'synthetic agent '+alias};
function fixture(t,{beforeClose=()=>{},...options}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-p1-execution-')),store=new CentralStore(path.join(dir,'central.sqlite'));
 const engine=new ConversationExecution({store,topics,agentManager:agent,...options});
 t.after(async()=>{beforeClose();await engine.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,store,engine,accept:(key,id)=>engine.accept('synthetic-device',{topicKey:key,requestId:'request-'+id,text:'synthetic '+id})};
}
async function model(t){
 const requests=[],gates=[];let active=0,maxActive=0;
 const server=http.createServer(async(q,r)=>{
  let raw='';for await(const chunk of q)raw+=chunk;
  const body=JSON.parse(raw),gate=deferred();gates.push(gate);requests.push(body.requestId);active++;maxActive=Math.max(maxActive,active);
  await gate.promise;active--;if(!r.destroyed){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({choices:[{message:{content:'synthetic reply '+body.requestId}}]}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const gate of gates)gate.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {url:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',requests,gates,get maxActive(){return maxActive;}};
}

test('P1-A: default four topics execute concurrently, same-topic FIFO survives reentrant ticks',async t=>{
 const remote=await model(t),{engine,store,accept}=fixture(t);
 engine.setEndpoint({url:remote.url,key:'synthetic-model-key'});
 const a1=accept('a','a-first'),a2=accept('a','a-second'),b=accept('b','b'),c=accept('c','c'),d=accept('d','d');
 for(let i=0;i<30;i++)engine.tick();
 await until(()=>remote.requests.length===4);
 assert.equal(engine.inFlight.size,4);assert.equal(engine.runningTopics.size,4);assert.equal(engine.get(a2.id).state,'queued');
 assert.deepEqual(new Set(remote.requests),new Set([a1.id,b.id,c.id,d.id]));assert.equal(remote.maxActive,4);
 remote.gates[remote.requests.indexOf(a1.id)].resolve();await until(()=>remote.requests.includes(a2.id));
 assert.equal(engine.get(a1.id).state,'completed');assert.equal(engine.get(b.id).state,'running');
 for(const gate of remote.gates)gate.resolve();await until(()=>[a1,a2,b,c,d].every(j=>engine.get(j.id).state==='completed'));
 assert.equal(store.metrics().liveMessages,10);assert.equal(store.metrics().journalRows,10);
 for(const job of [a1,a2,b,c,d])assert.equal(engine.get(job.id).attempts,1);
 assert.equal(accept('a','a-second').replayed,true);assert.equal(store.metrics().journalRows,10);
 await until(()=>engine.inFlight.size===0);assert.equal(engine.runningTopics.size,0);
 t.diagnostic(JSON.stringify({configured:engine.maxConcurrency,observedMaxHttpConcurrency:remote.maxActive,startOrder:remote.requests.map(id=>[a1,a2,b,c,d].findIndex(j=>j.id===id)),jobOrder:['A1','A2','B','C','D'],journalRows:10,attemptsPerJob:1,remainingInFlight:engine.inFlight.size,remainingTopicLocks:engine.runningTopics.size}));
});

test('P1-A: configured concurrency two is enforced and invalid bounds are rejected',async t=>{
 const remote=await model(t),{engine,accept}=fixture(t,{maxConcurrency:2});engine.setEndpoint({url:remote.url,key:'synthetic'});
 const jobs=['a','b','c','d'].map(k=>accept(k,k));await until(()=>remote.requests.length===2);
 assert.equal(engine.inFlight.size,2);assert.equal(remote.maxActive,2);
 remote.gates[0].resolve();remote.gates[1].resolve();await until(()=>remote.requests.length===4);
 for(const gate of remote.gates)gate.resolve();await until(()=>jobs.every(j=>engine.get(j.id).state==='completed'));
 for(const maxConcurrency of [0,-1,1.5,65,NaN])assert.throws(()=>new ConversationExecution({store:{},topics,agentManager:agent,maxConcurrency}),e=>e.code==='INVALID_EXECUTION_CONCURRENCY');
});

test('P1-B: cancellation retains its topic lock through cleanup; other topics finish independently',async t=>{
 const gates=new Map(['a','b','c'].map(k=>[k,deferred()]));
 const manager={isAgent:()=>true,getAgentPrompt:async key=>{await gates.get(key)?.promise;return 'synthetic '+key;}};
 const remote=await model(t),{engine,accept}=fixture(t,{agentManager:manager,beforeClose:()=>{for(const gate of gates.values())gate.resolve();}});
 engine.setEndpoint({url:remote.url,key:'synthetic'});
 const a1=accept('a','cancel-me'),a2=accept('a','after-cancel'),b=accept('b','keep-b'),c=accept('c','keep-c');
 await until(()=>engine.active.size===3);
 assert.equal(engine.cancel(a1.id,'synthetic-device').state,'cancelling');
 assert.equal(engine.runningTopics.has('a'),true);for(let i=0;i<10;i++)engine.tick();assert.equal(engine.get(a2.id).state,'queued');
 gates.get('b').resolve();gates.get('c').resolve();await until(()=>remote.requests.length===2);
 for(const gate of remote.gates)gate.resolve();await until(()=>engine.get(b.id).state==='completed'&&engine.get(c.id).state==='completed');
 assert.equal(engine.runningTopics.has('a'),true);assert.equal(engine.get(a1.id).state,'cancelling');
 gates.get('a').resolve();await until(()=>engine.get(a1.id).state==='cancelled');
 await until(()=>remote.requests.includes(a2.id));remote.gates.at(-1).resolve();await until(()=>engine.get(a2.id).state==='completed');
 assert.equal(remote.requests.includes(a1.id),false);assert.equal(engine.get(a2.id).attempts,1);
});

test('P1-B: synchronous drain blocks starts and close awaits every running cleanup',async t=>{
 const gates=new Map(['a','b','c'].map(k=>[k,deferred()]));
 const manager={isAgent:()=>true,getAgentPrompt:async key=>{await gates.get(key)?.promise;return 'synthetic '+key;}};
 const {engine,accept}=fixture(t,{agentManager:manager,maxConcurrency:3,beforeClose:()=>{for(const gate of gates.values())gate.resolve();}});
 engine.setEndpoint({url:'http://127.0.0.1:1/v1/chat/completions',key:'synthetic-no-network'});
 const jobs=['a','b','c'].map(k=>accept(k,k));await until(()=>engine.active.size===3);const queued=accept('d','queued');
 assert.equal(engine.beginDrain(),undefined);let closed=false;const closing=engine.close().then(()=>closed=true);
 engine.tick();await pause(20);assert.equal(closed,false);assert.equal(engine.get(queued.id).state,'queued');
 gates.get('a').resolve();gates.get('b').resolve();await until(()=>engine.inFlight.size===1);assert.equal(closed,false);assert.equal(engine.runningTopics.has('c'),true);
 gates.get('c').resolve();await closing;assert.equal(engine.inFlight.size,0);assert.equal(engine.runningTopics.size,0);
 assert.equal(engine.get(queued.id).attempts,0);for(const job of jobs)assert.equal(engine.get(job.id).error_code,'EXECUTION_INTERRUPTED_REVIEW_REQUIRED');
});

test('P1-B: queued/preparing/publishing recovery preserves IDs and never repeats uncertain work',async t=>{
 const {engine,store,accept}=fixture(t);engine.beginDrain();const schema=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
 const uncertain=accept('a','uncertain'),queued=accept('b','queued');
 store.db.prepare("UPDATE mobile_executions SET state='running',attempts=1 WHERE id=?").run(uncertain.id);
 let crash='accepted-intent';engine.fault=point=>{if(point===crash)throw Error('synthetic interruption');};
 assert.throws(()=>accept('c','preparing'),/synthetic interruption/);const preparing=store.db.prepare("SELECT id FROM mobile_executions WHERE state='preparing'").get();
 engine.fault=()=>{};const publishing=accept('d','publishing');
 const topic=topics[3],replyId='synthetic-durable-reply';const op={ownerType:topic.ownerType,ownerId:topic.ownerId,topicId:topic.topicId,msgId:replyId,deviceId:'server:synthetic',opId:'reply:'+publishing.id,action:'upsert',baseHash:null,message:{id:replyId,role:'assistant',content:'synthetic persisted intent',timestamp:100}};
 store.db.prepare("UPDATE mobile_executions SET state='publishing',pending_operation=? WHERE id=?").run(JSON.stringify(op),publishing.id);
 await engine.close();const recovered=new ConversationExecution({store,topics,agentManager:agent});t.after(()=>recovered.close());recovered.beginDrain();
 assert.equal(recovered.get(uncertain.id).state,'failed');assert.equal(recovered.get(uncertain.id).error_code,'EXECUTION_INTERRUPTED_REVIEW_REQUIRED');assert.equal(recovered.get(uncertain.id).attempts,1);
 assert.equal(recovered.get(queued.id).state,'queued');assert.equal(recovered.get(preparing.id).state,'queued');assert.equal(recovered.get(publishing.id).state,'completed');
 const count=store.metrics().journalRows;recovered.recover();assert.equal(store.metrics().journalRows,count);assert.equal(recovered.get(publishing.id).reply_message_id,replyId);
 assert.deepEqual(store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(),schema);
});
