const test = require('node:test');
const assert = require('node:assert/strict');

async function loadAdapter() {
  return import('../Plugin/NanoBananaGen2/responseAdapter.mjs');
}

test('extractImageAndTextFromMessage 能从 markdown base64 图片中提取图片与文本', async () => {
  const { extractImageAndTextFromMessage } = await loadAdapter();
  const message = {
    content: '生成完成\n\n![result](data:image/png;base64,AAAABBBB)'
  };

  const result = extractImageAndTextFromMessage(message);

  assert.equal(result.imageUrl, 'data:image/png;base64,AAAABBBB');
  assert.equal(result.textContent, '生成完成');
});

test('extractImageAndTextFromMessage 能处理数组 content 并回退到 images 字段', async () => {
  const { extractImageAndTextFromMessage } = await loadAdapter();
  const message = {
    content: [
      { type: 'text', text: '第一行说明' },
      { type: 'text', text: '第二行说明' }
    ],
    images: [
      {
        image_url: {
          url: 'https://example.com/generated.png'
        }
      }
    ]
  };

  const result = extractImageAndTextFromMessage(message);

  assert.equal(result.imageUrl, 'https://example.com/generated.png');
  assert.equal(result.textContent, '第一行说明\n第二行说明');
});
