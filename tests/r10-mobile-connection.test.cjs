'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {CentralStore}=require('../Plugin/NativeSync/sync/centralStore');
const {MobilePortal}=require('../Plugin/NativeSync/mobile/portal');
const {MobileConnection,backendAddress}=require('../Plugin/NativeSync/mobile/connection');
const {ConversationExecution}=require('../Plugin/NativeSync/mobile/execution');
const backend='http://toolbox.example.invalid:6005',origin='https://mobile.example.invalid',key='synthetic-r10-unit-only';
const topics=[{key:'nova-one',ownerType:'agent',ownerId:'nova-existing',topicId:'old-one',agentAlias:'Nova',model:'model-nova',agentName:'Nova',topicName:'Existing one'},{key:'kerr-one',ownerType:'agent',ownerId:'kerr-existing',topicId:'old-two',agentAlias:'Kerr',model:'model-kerr',agentName:'Kerr',topicName:'Existing two'}];
const agents={isAgent:alias=>['Nova','Kerr'].includes(alias),getAgentPrompt:async()=> 'synthetic prompt'};
function database(){return new CentralStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'vcp-r10-unit-')),'central.sqlite'));}
async function fixture(t,{enabled=true,list=topics}={}){
 const store=database(),portal=new MobilePortal({store,agentManager:agents,config:{NativeMobileOrigin:origin,NativeMobileTopics:JSON.stringify(list),NativeMobileBackendUrl:backend,NativeMobileKeyExchangeEnabled:enabled,NativeMobileSessionHours:720}});
 portal.engine.beginDrain();portal.engine.endpoint={key};
 const app=express();app.set('trust proxy',true);app.use('/mobile',portal.router);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{await portal.close();store.close();await new Promise(r=>server.close(r));});
 const req=(route,{body,cookie,secure=true,requestOrigin=origin}={})=>fetch(`http://127.0.0.1:${server.address().port}/mobile/api/`+route,{method:body?'POST':'GET',headers:{...(secure?{'X-Forwarded-Proto':'https'}:{}),Origin:requestOrigin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
 const login=async cookie=>{const r=await req('connection/authenticate',{body:{serverUrl:backend,apiKey:key},cookie});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 return {store,portal,req,login};
}
test('backend identity preserves HTTP and rejects credentials, arbitrary targets and paths without forwarding',()=>{
 assert.equal(backendAddress(backend+'/'),backend);
 for(const value of ['file:///etc/passwd','http://user:synthetic@example.invalid','http://example.invalid/v1','http://example.invalid/?secret=x'])assert.throws(()=>backendAddress(value));
 const connection=new MobileConnection({NativeMobileBackendUrl:backend,NativeMobileKeyExchangeEnabled:true},()=>key);
 assert.throws(()=>connection.test('http://127.0.0.1:22'),e=>e.code==='SERVER_NOT_APPROVED');
 assert.throws(()=>new MobileConnection({NativeMobileBackendUrl:backend},()=>key).test(backend),e=>e.code==='PROTECTED_HOST_NOT_READY');
 const body={serverUrl:backend,apiKey:key};assert.equal(connection.authenticate(body,'peer').serverUrl,backend);assert.equal(body.apiKey,undefined);
});
test('credential submission requires protected HTTPS, exact Origin, explicit host readiness and valid key',async t=>{
 const {store,req}=await fixture(t);const body={serverUrl:backend,apiKey:key};
 assert.equal((await req('connection/authenticate',{body,secure:false})).status,403);
 assert.equal((await req('connection/authenticate',{body,requestOrigin:'https://evil.invalid'})).status,403);
 assert.equal((await req('connection/authenticate',{body:{...body,serverUrl:'http://other.invalid'}})).status,403);
 assert.equal((await req('connection/authenticate',{body:{...body,apiKey:'synthetic-wrong'}})).status,401);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mobile_sessions').get().n,0);
 const response=await req('connection/authenticate',{body});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
 assert.equal((await response.text()).includes(key),false);assert.equal(store.metrics().journalRows,0);
});
test('connection is disabled until explicitly configured and unauthenticated catalog remains private',async t=>{
 const {req}=await fixture(t,{enabled:false});assert.equal((await req('connection/test',{body:{serverUrl:backend}})).status,503);assert.equal((await req('agents')).status,401);
});
test('reauthentication rotates the token while preserving device task ownership; revoke persists',async t=>{
 const {portal,req,login,store}=await fixture(t);let cookie=await login();
 const session=portal.currentSession({headers:{cookie}});
 const job=portal.engine.accept(session.id,{topicKey:topics[0].key,requestId:'synthetic-r10-request',text:'synthetic old-topic continuation'});
 assert.equal((await req('selection',{body:{key:'kerr-one'},cookie})).status,200);
 assert.equal((await req('selection',{body:{key:'unselected'},cookie})).status,403);
 const previous=cookie;cookie=await login(cookie);assert.notEqual(cookie,previous);
 assert.equal((await req('session',{cookie:previous})).status,401);
 assert.equal(portal.currentSession({headers:{cookie}}).id,session.id);
 assert.equal((await(await req('session',{cookie})).json()).selectedTopic,'kerr-one');
 const history=await(await req('conversations/nova-one',{cookie})).json();assert.equal(history.executions.find(x=>x.id===job.id).own,true);
 assert.equal((await req('connection/disconnect',{body:{},cookie})).status,200);
 assert.equal((await req('session',{cookie})).status,401);assert.equal(store.db.prepare('SELECT count(*) AS n FROM mobile_sessions').get().n,0);
 assert.equal(portal.engine.get(job.id).state,'queued');assert.equal(store.metrics().liveMessages,1);
});
test('catalog publishes only allowlisted metadata, separates agents, and cannot change server models',async t=>{
 const {portal,req,login,store}=await fixture(t);const cookie=await login();
 const body={topics:[{ownerId:'nova-existing',ownerType:'agent',topicId:'old-one',agentName:'Nova daily',topicName:'Actual old title',updatedAt:1234}]};
 assert.deepEqual(portal.publishCatalog(body),{published:1});
 assert.throws(()=>portal.publishCatalog({topics:[{...body.topics[0],model:'injected'}]}));
 assert.throws(()=>portal.publishCatalog({topics:[{...body.topics[0],ownerId:'other'}]}),e=>e.code==='TOPIC_NOT_ALLOWED');
 assert.throws(()=>portal.publishCatalog({topics:[{...body.topics[0],avatar:'https://tracker.invalid/image'}]}),e=>e.code==='INVALID_AVATAR');
 const result=await(await req('session',{cookie})).json();assert.equal(result.agents.length,2);assert.equal(result.topics[0].model,'model-nova');assert.equal(result.topics[0].topicId,'old-one');assert.equal(result.topics[0].topicName,'Actual old title');assert.equal(result.topics[0].executable,true);assert.equal(store.metrics().journalRows,0);
});
test('an unavailable server Agent is explicitly read-only and cannot enqueue execution',async t=>{
 const {req,login,store}=await fixture(t,{list:[{...topics[0],agentAlias:null,model:null}]});const cookie=await login();
 const s=await(await req('session',{cookie})).json();assert.equal(s.agents[0].executable,false);
 assert.equal((await req('conversations/nova-one/messages',{cookie,body:{requestId:'synthetic-request',text:'synthetic'}})).status,409);assert.equal(store.metrics().journalRows,0);
});
test('an uncertain in-flight execution is never automatically repeated after restart',async()=>{
 const store=database();let engine=new ConversationExecution({store,topics,agentManager:agents});
 const body={topicKey:topics[0].key,requestId:'interrupted-request',text:'synthetic possibly side-effecting task'};
 const accepted=engine.accept('device',body);store.db.prepare("UPDATE mobile_executions SET state='running',attempts=1 WHERE id=?").run(accepted.id);await engine.close();
 engine=new ConversationExecution({store,topics,agentManager:agents});const replay=engine.accept('device',body);
 assert.equal(replay.state,'failed');assert.equal(replay.errorCode,'EXECUTION_INTERRUPTED_REVIEW_REQUIRED');assert.equal(replay.attempts,1);assert.equal(replay.replayed,true);assert.equal(store.metrics().journalRows,1);await engine.close();store.close();
});
test('restricted session and selected old topic survive closing and reopening the central SQLite store',async()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'vcp-r10-reopen-')),'central.sqlite');
 const config={NativeMobileOrigin:origin,NativeMobileTopics:JSON.stringify(topics)};
 let store=new CentralStore(file),portal=new MobilePortal({store,agentManager:agents,config}),cookie;
 portal.issueSession({setHeader:(_k,v)=>{cookie=v.split(';')[0];},json:()=>{}},JSON.stringify(topics.map(t=>t.key)));
 const row=portal.currentSession({headers:{cookie}});store.db.prepare('UPDATE mobile_sessions SET last_topic_key=? WHERE id=?').run('kerr-one',row.id);
 await portal.close();store.close();store=new CentralStore(file);portal=new MobilePortal({store,agentManager:agents,config});
 const restored=portal.currentSession({headers:{cookie}});assert.equal(restored.id,row.id);assert.equal(restored.last_topic_key,'kerr-one');assert.equal(portal.catalog({scopes:JSON.parse(restored.scopes)}).length,2);await portal.close();store.close();
});
test('a long existing history uses the original host execution endpoint with its context budget',async t=>{
 const http=require('node:http');let calls=0;
 const server=http.createServer(async(req,res)=>{let bytes='';for await(const b of req)bytes+=b;const request=JSON.parse(bytes);calls++;assert.equal(request.model,'model-nova');assert.equal(request.contextTokenLimit,48000);assert.equal(request.temperature,0.3);assert.equal(request.max_tokens,4000);assert.ok(request.messages.length>200);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'synthetic host final reply'}}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const store=database(),engine=new ConversationExecution({store,topics:topics.map(t=>({...t,contextTokenLimit:48000,temperature:0.3,maxOutputTokens:4000})),agentManager:agents});
 for(let i=0;i<201;i++)store.apply({ownerType:'agent',ownerId:'nova-existing',topicId:'old-one',msgId:'old-'+i,deviceId:'desktop',opId:'old-'+i,baseHash:null,action:'upsert',message:{id:'old-'+i,role:i%2?'assistant':'user',content:'synthetic old text '+i,timestamp:i+1}});
 const accepted=engine.accept('device',{topicKey:'nova-one',requestId:'long-history-continuation',text:'synthetic continuation'});
 engine.setEndpoint({url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,key:'synthetic-host-key'});
 const deadline=Date.now()+5000;while(engine.get(accepted.id).state!=='completed'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(engine.get(accepted.id).state,'completed');assert.equal(calls,1);assert.equal(store.metrics().liveMessages,203);await engine.close();store.close();
});
