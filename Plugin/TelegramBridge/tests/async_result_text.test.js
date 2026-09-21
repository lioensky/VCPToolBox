'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extractAsyncResultText}=require('../src/asyncResultText');
const {normalizeVcpRichText}=require('../src/richTextNormalizer');
test('structured VCP results expose content and resources but never route identifiers',()=>{
  const text=extractAsyncResultText({taskId:'secret-task',telegramChatId:'secret-chat',result:{text:'完成',files:[{url:'https://cdn.example/report.pdf'}],images:['https://cdn.example/a.png']}});
  assert.match(text,/完成/);assert.match(text,/结果文件/);assert.match(text,/!\[结果图片\]/);
  assert.doesNotMatch(text,/secret-task|secret-chat/);
  assert.equal(extractAsyncResultText({result:'simple'}),'simple');
});

test('structured local images remain file-resource candidates for the allowlisted resolver',()=>{
  const text=extractAsyncResultText({result:{image_url:'file:///output/generated.png'}});
  const result=normalizeVcpRichText(text);
  assert.equal(result.media.length,1);
  assert.equal(result.media[0].kind,'file');
  assert.equal(result.media[0].sourceKind,'file-local');
});
