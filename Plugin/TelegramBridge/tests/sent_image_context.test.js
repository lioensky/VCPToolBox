'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const DB=require('better-sqlite3');
function find(db,scope) {
  let lookup;
  try { lookup=require('../src/sentImageContext').findLastSentImage; } catch(e) {if(e.code!=='MODULE_NOT_FOUND')throw e;}
  assert.equal(typeof lookup,'function','last-sent-image lookup must exist');
  return lookup(db,scope);
}
const image={mediaKind:'photo',relativePath:'photo.png',mime:'image/png',size:12,sha256:'a'.repeat(64),alt:'image'};
test('explicit references to already-sent Bot images do not capture new drawing instructions',()=>{
  const lookup=require('../src/sentImageContext').asksForSentImage;
  assert.equal(typeof lookup,'function');
  for(const text of ['你的图是什么','你刚才发的图片','你画的图','你发的那张图是什么','参考你的图再画一张','what is the picture you sent'])assert.equal(lookup(text),true,text);
  for(const text of ['你画一张一样的图','你生成一张示例角色','还在吗','这个少女是谁','示例角色你画一张看看','画一张你的表情包'])assert.equal(lookup(text),false,text);
});
function fixture(t) {
  const db=new DB(':memory:');t.after(()=>db.close());
  const migrations=path.join(__dirname,'../migrations');
  for(const f of fs.readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.join(migrations,f),'utf8'));
  const scope='telegram:42:0:ExampleAgent';
  db.prepare('INSERT INTO scopes(scope_key,chat_id,thread_id,current_agent,conversation_id,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1)')
    .run(scope,'42','0','ExampleAgent','current');
  let next=0;
  function add({kind='rich_media',sourceType='telegram_rich_media',payload=image,conversation='current',status='delivered',withMessage=true,plugin='OtherPlugin'}={}) {
    const n=++next,request='req-'+n,task='task-'+n;
    db.prepare('INSERT INTO requests(request_id,message_id,scope_key,status,started_at,updated_at,owner_user_id) VALUES(?,?,?,\'completed\',1,1,\'42\')')
      .run(request,'request-msg-'+n,scope);
    if(sourceType==='async_task')db.prepare('INSERT INTO async_tasks(task_key,plugin_name,task_id,request_id,scope_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)')
      .run(task,plugin,task,request,scope,'delivered');
    if(withMessage)db.prepare('INSERT INTO messages(message_id,scope_key,conversation_id,turn_id,turn_seq,position,role,content_json,content_bytes,created_at) VALUES(?,?,?,?,?,0,?,?,?,1)')
      .run('msg-'+n,scope,conversation,'turn-'+request,n,'assistant','"reply"',7);
    db.prepare('INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,status,created_at,updated_at,delivered_at,payload_json) VALUES(?,?,?,?,?,?,1,1,?,?)')
      .run('delivery-'+n,scope,kind,sourceType,sourceType==='async_task'?task:request,status,n,JSON.stringify(payload));
    return task;
  }
  return {db,scope,add};
}
test('sent photo remains eligible after later document delivery',t=>{
  const f=fixture(t);f.add();f.add({payload:{...image,mediaKind:'document',mime:'application/pdf'}});
  assert.deepEqual(find(f.db,f.scope),image);
});
test('generic async image is found through its parent conversation',t=>{
  const f=fixture(t);f.add({kind:'async_media',sourceType:'async_task',payload:{media:image}});
  assert.deepEqual(find(f.db,f.scope),image);
});
test('new conversation, unsent rows and unbound operator proofs cannot become image context',t=>{
  const f=fixture(t);f.add({conversation:'previous'});f.add({status:'pending'});f.add({withMessage:false});
  assert.equal(find(f.db,f.scope),null);assert.equal(find(f.db,'telegram:43:0:ExampleAgent'),null);
});
test('Unsupported artifact payloads do not shadow an earlier photo',t=>{
  const f=fixture(t);f.add();
  f.add({kind:'async_media',sourceType:'async_task',plugin:'ExampleGenerator',payload:{taskId:'example-task',artifact:{type:'video',mime:'video/mp4',relativePath:'video.mp4'}}});
  f.add({kind:'async_media',sourceType:'async_task',payload:{taskId:'unrelated',artifact:{type:'image',mime:'image/png',relativePath:'image.png'}}});
  assert.deepEqual(find(f.db,f.scope),image);
});
