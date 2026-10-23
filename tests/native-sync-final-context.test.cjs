'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),req=createRequire(path.join(root,'package.json'));
const {CentralStore}=req('./Plugin/NativeSync/sync/centralStore'),{ConversationExecution}=req('./Plugin/NativeSync/mobile/execution');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+2500;while(!fn()){assert.ok(Date.now()<end,'synthetic context condition timed out');await wait(5);}}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-context-')),store=new CentralStore(path.join(dir,'central.sqlite'));
 const topics=['a','b'].map(key=>({key,ownerType:'agent',ownerId:'synthetic-'+key,topicId:'shared',agentAlias:key,model:'synthetic'}));
 const agentManager={isAgent:()=>true,getAgentPrompt:async()=> 'synthetic system'};let engine=new ConversationExecution({store,topics,agentManager});
 const requests=[],gates=[];const server=http.createServer(async(q,r)=>{let raw='';for await(const b of q)raw+=b;const body=JSON.parse(raw);requests.push(body);await new Promise(resolve=>gates.push(resolve));if(!r.destroyed){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({choices:[{message:{content:'answer-'+body.requestId}}]}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint={url:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',key:'synthetic-only'};engine.setEndpoint(endpoint);
 t.after(async()=>{for(const g of gates)g();await engine.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,topics,requests,gates,endpoint,get engine(){return engine;},accept:(key,text)=>engine.accept('synthetic-session',{topicKey:key,requestId:'request-'+text,text}),async restart(){await engine.close();engine=new ConversationExecution({store,topics,agentManager});engine.setEndpoint(endpoint);}};
}
const contents=body=>body.messages.filter(m=>m.role!=='system').map(m=>m.content);
test('queued continuations include completed predecessor replies in turn order and exclude future submissions/other topics',async t=>{
 const f=await fixture(t),a1=f.accept('a','one');await until(()=>f.requests.length===1);
 const a2=f.accept('a','two'),a3=f.accept('a','three'),b=f.accept('b','other');await until(()=>f.requests.length===2);
 assert.equal(f.engine.get(a2.id).state,'queued');const i1=f.requests.findIndex(r=>r.requestId===a1.id);f.gates[i1]();await until(()=>f.requests.some(r=>r.requestId===a2.id));
 assert.deepEqual(contents(f.requests.find(r=>r.requestId===a2.id)),['one','answer-'+a1.id,'two']);
 const i2=f.requests.findIndex(r=>r.requestId===a2.id);f.gates[i2]();await until(()=>f.requests.some(r=>r.requestId===a3.id));
 assert.deepEqual(contents(f.requests.find(r=>r.requestId===a3.id)),['one','answer-'+a1.id,'two','answer-'+a2.id,'three']);
 for(const g of f.gates)g();await until(()=>[a1,a2,a3,b].every(j=>f.engine.get(j.id).state==='completed'));
 assert.equal(f.accept('a','two').replayed,true);assert.equal(f.requests.length,4);assert.equal(f.store.metrics().journalRows,8);
});
for(const action of ['upsert','delete'])test('latest predecessor reply '+action+' is respected without replaying later user input',async t=>{
 const f=await fixture(t),first=f.accept('a','first');await until(()=>f.requests.length===1);const second=f.accept('a','second');
 // Keep queued work paused after the predecessor completes, then edit/delete
 // that reply through the original central conflict/hash contract.
 f.engine.endpoint=null;f.gates[0]();await until(()=>f.engine.get(first.id).state==='completed');
 const id='reply_'+first.id,prior=f.store.db.prepare('select hash from messages where msg_id=?').get(id);
 f.store.apply({ownerType:'agent',ownerId:'synthetic-a',topicId:'shared',msgId:id,deviceId:'synthetic-desktop',opId:'edit-'+action,action,baseHash:prior.hash,...(action==='upsert'?{message:{id,role:'assistant',content:'edited predecessor',timestamp:Date.now()}}:{})});
 f.engine.setEndpoint(f.endpoint);await until(()=>f.requests.some(r=>r.requestId===second.id));
 assert.deepEqual(contents(f.requests.find(r=>r.requestId===second.id)),action==='upsert'?['first','edited predecessor','second']:['first','second']);
 f.gates.at(-1)();await until(()=>f.engine.get(second.id).state==='completed');
});
test('restart retains a queued continuation and its completed predecessor context; no uncertain task is replayed',async t=>{
 const f=await fixture(t),first=f.accept('a','before');await until(()=>f.requests.length===1);const second=f.accept('a','after');
 f.engine.endpoint=null;f.gates[0]();await until(()=>f.engine.get(first.id).state==='completed');await f.restart();
 await until(()=>f.requests.some(r=>r.requestId===second.id));assert.deepEqual(contents(f.requests.find(r=>r.requestId===second.id)),['before','answer-'+first.id,'after']);
 f.gates.at(-1)();await until(()=>f.engine.get(second.id).state==='completed');assert.equal(f.engine.get(first.id).attempts,1);assert.equal(f.engine.get(second.id).attempts,1);
});
