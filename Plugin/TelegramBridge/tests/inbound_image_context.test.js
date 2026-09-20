'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const D=require('better-sqlite3');
function api(){let x;try{x=require('../src/inboundImageContext');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}assert.equal(typeof x?.rememberInboundImages,'function');return x;}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tg-image-context-'));fs.mkdirSync(path.join(root,'inbox'));
 const db=new D(':memory:');const md=path.join(__dirname,'../migrations');for(const f of fs.readdirSync(md).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.join(md,f),'utf8'));
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const scope='telegram:42:0:ExampleAgent',context={scopeKey:scope,conversationId:'current',ownerUserId:'42'};
 db.prepare('INSERT INTO scopes(scope_key,chat_id,thread_id,current_agent,conversation_id,is_active,created_at,updated_at) VALUES(?,\'42\',\'0\',\'ExampleAgent\',\'current\',1,1,1)').run(scope);
 let n=0;
 function add({owner='42',photo=true,caption='',conv=null,modified=false}={}){
  const id=String(++n),r='r'+id,relative='inbox/'+id+'.jpg';const bytes=Buffer.from([255,216,255,224,n]);fs.writeFileSync(path.join(root,relative),bytes);
  db.prepare('INSERT INTO updates(update_id,next_offset,update_type,status,received_at,updated_at,payload_json) VALUES(?,?,\'message\',\'completed\',?,?,?)')
   .run(id,String(n+1),n,n,JSON.stringify({message:{message_id:n,from:{id:Number(owner)},chat:{id:42,type:'private'},...(photo?{photo:[{file_id:'f'}]}:{text:caption})}}));
  db.prepare('INSERT INTO requests(request_id,message_id,update_id,scope_key,status,started_at,updated_at,owner_user_id) VALUES(?,?,?,?,\'completed\',?,?,?)').run(r,'m'+id,id,scope,n,n,owner);
  db.prepare('INSERT INTO attachments(attachment_id,scope_key,request_id,telegram_message_id,relative_path,mime,size,sha256,status,created_at,updated_at,conversation_id) VALUES(?,?,?,?,?,\'image/jpeg\',?,?,\'ready\',?,?,?)')
   .run(id,scope,r,id,relative,bytes.length,crypto.createHash('sha256').update(bytes).digest('hex'),n,n,conv);
  if(modified)fs.appendFileSync(path.join(root,relative),'x');
  return{requestId:r,data:'data:image/jpeg;base64,'+bytes.toString('base64')};
 }
 return{root,db,context,add};
}
test('follow-up text receives the actual latest uploaded image, including after an interrupted answer',t=>{
 const f=fixture(t),a=f.add();const x=api();x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 assert.deepEqual(x.readRecentInboundImages(f.db,f.context,f.root),[a.data]);
 assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM attachments').all()),/base64/);
});
test('new conversations, other owners and a Bot image quoted by text cannot replace uploaded image context',t=>{
 const f=fixture(t),x=api(),a=f.add();x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 const bot=f.add({photo:false,caption:'quoted bot'});x.rememberInboundImages(f.db,{...f.context,requestId:bot.requestId});
 const other=f.add({owner:'43'});x.rememberInboundImages(f.db,{...f.context,ownerUserId:'43',requestId:other.requestId});
 assert.deepEqual(x.readRecentInboundImages(f.db,f.context,f.root),[a.data]);
 f.db.prepare("UPDATE scopes SET conversation_id='new'").run();
 assert.deepEqual(x.readRecentInboundImages(f.db,{...f.context,conversationId:'new'},f.root),[]);
});
test('changed latest image fails closed without quietly falling back to an older picture',t=>{
 const f=fixture(t),x=api();for(const modified of [false,true]){const a=f.add({modified});x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});}
 assert.deepEqual(x.readRecentInboundImages(f.db,f.context,f.root),[]);
});

test('historical images stay on their original user turn rather than the current greeting or drawing request',t=>{
 const f=fixture(t),x=api(),a=f.add();x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 assert.equal(typeof x.attachHistoryImages,'function');
 const history=[{role:'user',content:'who is this',requestId:a.requestId},{role:'assistant',content:'uncertain'},
  {role:'user',content:'draw another',requestId:'no-image',requestState:'interrupted'}];
 const actual=x.attachHistoryImages(f.db,f.context,history,f.root);
 assert.deepEqual(actual[0].images,[a.data]);assert.equal(actual[2].images,undefined);
 assert.equal(actual[2].content,'draw another');assert.equal(history[0].images,undefined);
});

test('new uploads take media budget priority and omitted history is explicit without changing user intent',t=>{
 const f=fixture(t),x=api(),a=f.add();x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 assert.equal(typeof x.attachHistoryImages,'function');
 const history=[{role:'user',content:'old question',requestId:a.requestId}];
 const actual=x.attachHistoryImages(f.db,f.context,history,f.root,{currentImages:Array(10).fill(a.data)});
 assert.equal(actual[0].images,undefined);assert.match(actual[0].content,/历史图片.*未附/);
 assert.doesNotMatch(actual[0].content,/不是新的生成任务/);
});

test('a changed historical image is marked unavailable at that exact turn, not replaced',t=>{
 const f=fixture(t),x=api(),a=f.add(),b=f.add({modified:true});
 x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 x.rememberInboundImages(f.db,{...f.context,requestId:b.requestId});
 assert.equal(typeof x.attachHistoryImages,'function');
 const actual=x.attachHistoryImages(f.db,f.context,[{role:'user',content:'first',requestId:a.requestId},
  {role:'user',content:'second',requestId:b.requestId}],f.root);
 assert.deepEqual(actual[0].images,[a.data]);assert.equal(actual[1].images,undefined);
 assert.match(actual[1].content,/历史图片.*不可用/);
});

test('historical image hydration refuses other owners and conversation IDs',t=>{
 const f=fixture(t),x=api(),a=f.add();x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 assert.equal(typeof x.attachHistoryImages,'function');
 const history=[{role:'user',content:'image',requestId:a.requestId}];
 for(const context of [{...f.context,ownerUserId:'43'},{...f.context,conversationId:'other'}]){
  assert.deepEqual(x.attachHistoryImages(f.db,context,history,f.root),history);
 }
});

test('an original image whose download never completed is explicitly unavailable, not silently absent',t=>{
 const f=fixture(t),x=api(),a=f.add();
 const actual=x.attachHistoryImages(f.db,f.context,[{role:'user',content:'upload failed',requestId:a.requestId}],f.root);
 assert.equal(actual[0].images,undefined);assert.match(actual[0].content,/历史图片.*不可用/);
});

test('historical album order follows Telegram messages even when attachment timestamps tie',t=>{
 const f=fixture(t),x=api(),a=f.add(),b=f.add();
 f.db.prepare("UPDATE updates SET album_parent_update_id='1' WHERE update_id='2'").run();
 f.db.prepare("UPDATE attachments SET request_id=?,created_at=10,attachment_id=CASE telegram_message_id WHEN '1' THEN 'z' ELSE 'a' END").run(a.requestId);
 x.rememberInboundImages(f.db,{...f.context,requestId:a.requestId});
 const actual=x.attachHistoryImages(f.db,f.context,[{role:'user',content:'compare',requestId:a.requestId}],f.root);
 assert.deepEqual(actual[0].images,[a.data,b.data]);
});
