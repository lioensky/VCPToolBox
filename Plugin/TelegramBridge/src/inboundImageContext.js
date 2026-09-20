'use strict';
const path=require('node:path');
const {prepareVcpInput}=require('./inboundContent');

const actualUpload=`EXISTS(SELECT 1 FROM updates u
  WHERE (u.update_id=r.update_id OR u.album_parent_update_id=r.update_id)
    AND CAST(json_extract(u.payload_json,'$.message.message_id') AS TEXT)=a.telegram_message_id
    AND (json_type(u.payload_json,'$.message.photo')='array'
      OR json_extract(u.payload_json,'$.message.document.mime_type') LIKE 'image/%'))`;

function rememberInboundImages(database,{requestId,scopeKey,conversationId,ownerUserId}) {
  database.prepare(`UPDATE attachments AS a SET conversation_id=?
    WHERE a.request_id=? AND a.scope_key=? AND a.status='ready' AND a.mime LIKE 'image/%'
      AND EXISTS(SELECT 1 FROM requests r JOIN scopes s ON s.scope_key=r.scope_key
        WHERE r.request_id=a.request_id AND r.owner_user_id=? AND s.conversation_id=? AND ${actualUpload})`)
    .run(conversationId,requestId,scopeKey,ownerUserId,conversationId);
}

function readRecentInboundImages(database,{scopeKey,conversationId,ownerUserId},stateDir) {
  const rows=database.prepare(`SELECT a.request_id,a.relative_path,a.mime,a.size,a.sha256,a.attachment_id
    FROM attachments a JOIN requests r ON r.request_id=a.request_id
    JOIN scopes s ON s.scope_key=a.scope_key
    WHERE a.scope_key=? AND a.conversation_id=? AND s.conversation_id=a.conversation_id
      AND r.owner_user_id=? AND a.status='ready' AND a.mime IN ('image/jpeg','image/png','image/webp','image/gif')
      AND ${actualUpload}
    ORDER BY a.created_at DESC,a.attachment_id DESC LIMIT 10`).all(scopeKey,conversationId,ownerUserId);
  if(!rows.length)return [];
  const requestId=rows[0].request_id;
  const latest=rows.filter(row=>row.request_id===requestId).reverse();
  try {
    return prepareVcpInput(latest.map(row=>({absolutePath:path.join(stateDir,row.relative_path),
      attachmentId:row.attachment_id,mime:row.mime,size:row.size,sha256:row.sha256})),stateDir).images;
  } catch { return []; } // Do not silently substitute an older or Bot-authored image.
}

// Rehydrate on the original historical user message. Never turn a greeting or
// explicit generation instruction into a new image-analysis request.
function attachHistoryImages(database,identity,history,stateDir,options={}) {
  const current=[...(options.currentImages??[]),...(options.currentMedia??[])];
  let count=current.length;
  let bytes=current.reduce((n,data)=>n+Buffer.byteLength(data.slice(data.indexOf(',')+1),'base64'),0);
  const result=history.map(message=>({...message}));
  const query=database.prepare(`SELECT a.relative_path,a.mime,a.size,a.sha256,a.attachment_id
    FROM attachments a JOIN requests r ON r.request_id=a.request_id JOIN scopes s ON s.scope_key=a.scope_key
    WHERE a.request_id=? AND a.scope_key=? AND a.conversation_id=? AND s.conversation_id=a.conversation_id
      AND r.owner_user_id=? AND a.status='ready' AND a.mime IN ('image/jpeg','image/png','image/webp','image/gif')
      AND ${actualUpload} ORDER BY length(a.telegram_message_id),a.telegram_message_id,a.attachment_id LIMIT 10`);
  const expectedUploads=database.prepare(`SELECT COUNT(*) n FROM requests r JOIN scopes s ON s.scope_key=r.scope_key
    JOIN updates u ON u.update_id=r.update_id OR u.album_parent_update_id=r.update_id
    WHERE r.request_id=? AND r.scope_key=? AND r.owner_user_id=? AND s.conversation_id=?
      AND (json_type(u.payload_json,'$.message.photo')='array'
        OR json_extract(u.payload_json,'$.message.document.mime_type') LIKE 'image/%')`);
  for(let index=result.length-1;index>=0;index--) {
    const message=result[index];
    if(message.role!=='user'||!message.requestId)continue;
    const rows=query.all(message.requestId,identity.scopeKey,identity.conversationId,identity.ownerUserId);
    const expected=expectedUploads.get(message.requestId,identity.scopeKey,identity.ownerUserId,identity.conversationId).n;
    if(!rows.length){
      if(expected)message.content+='\n[桥接附件状态：此条历史图片当前不可用，不能根据其他图片代替判断。]';
      continue;
    }
    const size=rows.reduce((n,row)=>n+row.size,0);
    if(count+rows.length>10||bytes+size>20_000_000) {
      message.content+='\n[桥接附件状态：此条历史图片因本轮附件容量限制未附，不代表用户重新上传。]';
      continue;
    }
    try {
      const prepared=prepareVcpInput(rows.map(row=>({absolutePath:path.join(stateDir,row.relative_path),
        attachmentId:row.attachment_id,mime:row.mime,size:row.size,sha256:row.sha256})),stateDir);
      message.images=prepared.images;
      if(rows.length<expected)message.content+='\n[桥接附件状态：此条历史图片有部分不可用，已附仅为成功接收的部分。]';
      count+=prepared.images.length;bytes+=size;
    }catch {
      message.content+='\n[桥接附件状态：此条历史图片当前不可用，不能根据其他图片代替判断。]';
    }
  }
  return result;
}

module.exports=Object.freeze({rememberInboundImages,readRecentInboundImages,attachHistoryImages});
