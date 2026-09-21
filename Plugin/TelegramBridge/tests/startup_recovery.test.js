'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {TelegramApiError}=require('../src/telegramClient');
function plugin(){const file=path.resolve(__dirname,'../TelegramBridge.js');delete require.cache[file];return require(file);}
function raw(){return{TELEGRAM_MODE:'enabled',TELEGRAM_BOT_TOKEN:'fixture-token',TELEGRAM_ALLOWED_USER_IDS:'42',
 TELEGRAM_VCP_KEY:'fixture-key',TELEGRAM_ALLOWED_AGENTS:'ExampleAgent',TELEGRAM_DEFAULT_AGENT:'ExampleAgent',
 TELEGRAM_VCP_BASE_URL:'http://127.0.0.1:6005/v1',TELEGRAM_VCP_MODEL:'VCPModelAuto'};}
function runtime(probe,events){return{
 ensureDirectories(){},openState(){},probeTelegram:probe,async probeVcp(){},startHost(){events.push('host');},
 async recover(){events.push('recover');},startPoller(){events.push('poll');},snapshot(){return{};},
 beginDrain(){},abort(){events.push('abort');},async waitForIdle(){},markNeedsReview(){},stopHost(){},close(){events.push('close');}
};}
async function until(predicate){const end=Date.now()+1000;while(!predicate()){if(Date.now()>end)assert.fail('fixture deadline');await new Promise(r=>setTimeout(r,5));}}

test('transient Telegram startup failure recovers once without blocking host startup or duplicating a poller',async t=>{
 const p=plugin(),events=[],records=[];t.after(()=>p.shutdown());let attempts=0;
 await p.initialize(raw(),{startupRetryMs:10,onDiagnostic:r=>records.push(r),createRuntime:()=>{
  const n=++attempts;return runtime(async()=>{if(n===1)throw new TelegramApiError('TELEGRAM_NETWORK');},events);
 }});
 await until(()=>events.includes('poll'));
 assert.equal(attempts,2);assert.equal(events.filter(x=>x==='poll').length,1);
 assert.equal(events.filter(x=>x==='close').length,1);
 assert.ok(records.some(x=>x.stage==='telegram'&&x.error_code==='TELEGRAM_NETWORK'));
 assert.equal((await p.processToolCall({})).result.state,'ready');
});

test('authentication errors stay terminal and diagnostic output contains no raw error text',async t=>{
 const p=plugin(),records=[],events=[];t.after(()=>p.shutdown());let attempts=0;
 await assert.rejects(p.initialize(raw(),{startupRetryMs:10,onDiagnostic:r=>records.push(r),createRuntime:()=>{
  attempts++;return runtime(async()=>{const e=new TelegramApiError('TELEGRAM_AUTH');e.message='private failure fixture';throw e;},events);
 }}),e=>e.code==='BRIDGE_INITIALIZATION_FAILED'&&e.stage==='telegram');
 await new Promise(r=>setTimeout(r,35));
 assert.equal(attempts,1);assert.equal(events.includes('poll'),false);
 assert.ok(records.some(x=>x.error_code==='TELEGRAM_AUTH'));
 assert.doesNotMatch(JSON.stringify(records),/private failure fixture|fixture-key|fixture-token/);
});

test('shutdown cancels pending startup recovery and a late probe cannot start a host or poller',async()=>{
 const p=plugin(),events=[];let release;
 const initializing=p.initialize(raw(),{startupRetryMs:10,shutdownTimeoutMs:5,onDiagnostic(){},
  createRuntime:()=>runtime(()=>new Promise(r=>{release=r;}),events)});
 await until(()=>typeof release==='function');
 await p.shutdown();release();await initializing.catch(()=>{});
 await new Promise(r=>setTimeout(r,25));
 assert.equal(events.includes('host'),false);assert.equal(events.includes('poll'),false);
 assert.equal(events.filter(x=>x==='close').length,1);
 await assert.rejects(p.processToolCall({}),e=>e.code==='BRIDGE_NOT_READY');
});

test('shutdown during recovery backoff prevents additional attempts',async()=>{
 const p=plugin(),events=[];let attempts=0;
 await p.initialize(raw(),{startupRetryMs:30,onDiagnostic(){},createRuntime:()=>{
  attempts++;return runtime(async()=>{throw new TelegramApiError('TELEGRAM_NETWORK');},events);
 }});
 await p.shutdown();await new Promise(r=>setTimeout(r,70));
 assert.equal(attempts,1);assert.equal(events.includes('poll'),false);
});

test('shutdown during backoff permits immediate fresh initialization',async t=>{
 const p=plugin(),old=[],fresh=[];t.after(()=>p.shutdown());let newInstances=0;
 await p.initialize(raw(),{startupRetryMs:1000,onDiagnostic(){},createRuntime:()=>
  runtime(async()=>{throw new TelegramApiError('TELEGRAM_NETWORK');},old)});
 await p.shutdown();
 await p.initialize(raw(),{onDiagnostic(){},createRuntime:()=>{newInstances++;return runtime(async()=>{},fresh);}});
 assert.equal(newInstances,1);assert.equal(fresh.filter(x=>x==='poll').length,1);
 assert.equal((await p.processToolCall({})).result.state,'ready');
});

test('late aborted initialization cannot own or clear a fresh startup promise',async t=>{
 const p=plugin(),old=[],fresh=[];let releaseOld,releaseNew,newInstances=0;
 t.after(async()=>{releaseOld?.();releaseNew?.();await p.shutdown();});
 const first=p.initialize(raw(),{shutdownTimeoutMs:5,onDiagnostic(){},createRuntime:()=>
  runtime(()=>new Promise(r=>{releaseOld=r;}),old)}).catch(e=>e);
 await until(()=>!!releaseOld);await p.shutdown();
  const second=p.initialize(raw(),{onDiagnostic(){},createRuntime:()=>{newInstances++;
  return runtime(()=>new Promise(r=>{releaseNew=r;}),fresh);}});
 second.catch(()=>{});
 await until(()=>!!releaseNew);releaseOld();await first;
 const third=p.initialize(raw(),{createRuntime(){assert.fail('fresh startup must remain uniquely owned');}});
 releaseNew();await Promise.all([second,third]);
 assert.equal(newInstances,1);assert.equal(old.includes('host'),false);
 assert.equal(fresh.filter(x=>x==='poll').length,1);assert.equal((await p.processToolCall({})).result.state,'ready');
});
