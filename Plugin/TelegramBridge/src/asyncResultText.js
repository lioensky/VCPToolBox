'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');

function extractAsyncResultText(value) {
  const pieces=[];
  const seen=new Set();
  function resource(raw,image=false) {
    if(typeof raw!=='string'||raw.length>4096) return;
    let url;
    try { url=path.isAbsolute(raw)?pathToFileURL(raw):new URL(raw); } catch { return; }
    if(!['http:','https:','file:'].includes(url.protocol)||url.username||url.password) return;
    if(seen.has(url.href)) return;
    seen.add(url.href);
    const isImage=image||/\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname);
    pieces.push(`${isImage&&url.protocol!=='file:'?'!':''}[${isImage?'结果图片':'结果文件'}](<${url.href}>)`);
  }
  function visit(node,depth=0) {
    if(depth>3||pieces.length>=50||node===null) return;
    if(typeof node==='string') { if(node.trim()) pieces.push(node); return; }
    if(Array.isArray(node)) { for(const item of node.slice(0,20)) visit(item,depth+1); return; }
    if(typeof node!=='object') return;
    if(node.type==='image_url') { resource(node.image_url?.url,true); return; }
    if(node.type==='text') {visit(node.text,depth+1);return;}
    for(const field of ['text','message','result','content']) if(Object.hasOwn(node,field)) visit(node[field],depth+1);
    for(const field of ['url','image_url','video_url','file_url','download_url','imageUrl','videoUrl','filePath','file_path']) {
      if(typeof node[field]==='string') resource(node[field],/image/i.test(field));
    }
    for(const field of ['files','images','videos']) if(Array.isArray(node[field])) {
      for(const item of node[field].slice(0,20)) typeof item==='string'?resource(item,field==='images'):visit(item,depth+1);
    }
  }
  visit(value);
  return pieces.join('\n\n').trim();
}
module.exports={extractAsyncResultText};
