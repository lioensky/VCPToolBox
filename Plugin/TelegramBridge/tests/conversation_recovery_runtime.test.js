'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const Database=require('better-sqlite3');

test('partial album failure preserves the input, validated received image and missing-image state for a later greeting',async t=>{
  const pluginPath=path.resolve(__dirname,'../TelegramBridge.js');delete require.cache[pluginPath];
  const plugin=require(pluginPath),pluginRoot=path.dirname(pluginPath);
  const stateDir=fs.mkdtempSync(path.join(pluginRoot,'.partial-context-test-'));
  let db;
  t.after(async()=>{db?.close();await plugin.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  const pm=new EventEmitter();pm.getIntegrationCapabilities=()=>({hostIntegrationVersion:1,
    approvalCorrelationVersion:1,asyncCorrelationVersion:1,approvalResponseMethod:'handleApprovalResponse'});
  pm.handleApprovalResponse=()=>true;
  const bodies=[],diagnostics=[];
  let polls=0,nextPoll;
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const message=(id,text)=>({update_id:id,message:{message_id:id,from:{id:42},chat:{id:42,type:'private'},
    date:Math.floor(Date.now()/1000),text}});
  const album=[1,2].map(id=>({update_id:id,message:{message_id:id,from:{id:42},chat:{id:42,type:'private'},
    date:Math.floor(Date.now()/1000)-3600,media_group_id:'partial-album',...(id===1?{caption:'compare these pictures'}:{}),
    document:{file_id:`image${id}`,file_unique_id:`unique${id}`,file_name:'image.png',mime_type:'image/png',file_size:png.length}}}));
  const response=(url,result)=>{const r=new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});
    Object.defineProperty(r,'url',{value:String(url)});return r;};
  const fetchImpl=async(url,options={})=>{
    const method=String(url).split('/').at(-1);
    if(method==='getUpdates'){
      if(++polls===1)return response(url,album);
      return new Promise((resolve,reject)=>{nextPoll=updates=>resolve(response(url,updates));
        options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
    }
    if(method==='getFile')return response(url,{file_path:JSON.parse(options.body).file_id==='image1'?'photos/one.png':'photos/missing.png'});
    if(method==='one.png'){const r=new Response(png);Object.defineProperty(r,'url',{value:String(url)});return r;}
    if(method==='missing.png')throw new Error('fixture download unavailable');
    if(String(url).endsWith('/chat/completions')){
      bodies.push(JSON.parse(options.body));
      const chunks=[{choices:[{delta:{content:'The earlier upload was incomplete.'},finish_reason:null}]},
        {id:'chatcmpl-VCP-final-stop-123',choices:[{delta:{},finish_reason:'stop'}]}];
      const r=new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});Object.defineProperty(r,'url',{value:String(url)});return r;
    }
    return response(url,method==='getMe'?{id:99,is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:''}:{message_id:500});
  };
  await plugin.initialize({TELEGRAM_MODE:'enabled',TELEGRAM_BOT_TOKEN:'123456789:fixture_token_material_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    TELEGRAM_ALLOWED_USER_IDS:'42',TELEGRAM_VCP_KEY:'fixture-key',TELEGRAM_ALLOWED_AGENTS:'ExampleAgent',TELEGRAM_DEFAULT_AGENT:'ExampleAgent',
    TELEGRAM_VCP_BASE_URL:'http://127.0.0.1:6005/v1',TELEGRAM_VCP_MODEL:'VCPModelAuto',TELEGRAM_STATE_DIR:path.basename(stateDir)},
    {pluginManager:pm,fetchImpl,onDiagnostic:record=>diagnostics.push(record)});
  db=new Database(path.join(stateDir,'telegram.sqlite3'),{readonly:true});
  let deadline=Date.now()+4000;
  while(db.prepare('SELECT status FROM requests WHERE request_id=?').get('tg-1')?.status!=='retryable_failed'){
    if(Date.now()>deadline)assert.fail('fixture failed-download deadline');await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(bodies.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM conversation_inputs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM attachments WHERE conversation_id IS NOT NULL').get().n,1);
  nextPoll([message(3,'还在吗')]);
  deadline=Date.now()+2000;while(!bodies.length){if(Date.now()>deadline)assert.fail('fixture follow-up deadline');await new Promise(r=>setTimeout(r,10));}
  assert.equal(bodies.length,1,'no automatic replay of the failed album');
  const history=bodies[0].messages.filter(m=>m.role==='user');
  assert.equal(history.at(-1).content,'还在吗');
  assert.equal(history[0].content.filter(c=>c.type==='image_url').length,1);
  assert.match(history[0].content[0].text,/compare these pictures/);
  assert.match(history[0].content[0].text,/部分不可用/);
  assert.ok(bodies[0].messages.some(m=>m.role==='system'&&/failed/.test(m.content)));
  assert.ok(diagnostics.some(r=>r.receipt_lag_ms>=3599000));
});
