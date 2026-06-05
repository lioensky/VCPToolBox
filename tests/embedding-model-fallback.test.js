const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { getEmbeddingsBatch } = require('../EmbeddingUtils');
const { chunkText } = require('../TextChunker');
const ragDiaryPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

async function withEmbeddingEnv(vars, fn) {
  const keys = [
    'API_URL',
    'API_Key',
    'EMBEDDING_API_URL',
    'EMBEDDING_API_KEY',
    'WhitelistEmbeddingModel',
    'EmbeddingModelBackups',
    'EmbeddingModelBackup',
    ...Array.from({ length: 9 }, (_, index) => `EmbeddingModelBackup${index + 1}`),
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('EmbeddingUtils switches to configured model backup on primary model failure', async (t) => {
  const seenModels = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    const body = await readJsonBody(req);
    seenModels.push(body.model);

    if (body.model === 'primary-model') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'primary unavailable' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: body.input.map((_, index) => ({
        index,
        embedding: [0.1, 0.2, 0.3],
      })),
    }));
  });

  const port = await listen(server);
  t.after(() => server.close());

  await withEmbeddingEnv({ EmbeddingModelBackup1: 'backup-model' }, async () => {
    const vectors = await getEmbeddingsBatch(['hello world'], {
      apiUrl: `http://127.0.0.1:${port}`,
      model: 'primary-model',
    });

    assert.deepEqual(vectors, [[0.1, 0.2, 0.3]]);
  });

  assert.deepEqual(seenModels, ['primary-model', 'backup-model']);
});

test('EmbeddingUtils uses WhitelistEmbeddingModel when config model is omitted', async (t) => {
  const seenModels = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    const body = await readJsonBody(req);
    seenModels.push(body.model);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: body.input.map((_, index) => ({
        index,
        embedding: [0.4, 0.5, 0.6],
      })),
    }));
  });

  const port = await listen(server);
  t.after(() => server.close());

  await withEmbeddingEnv({ WhitelistEmbeddingModel: 'env-embedding-model' }, async () => {
    const vectors = await getEmbeddingsBatch(['hello from env model'], {
      apiUrl: `http://127.0.0.1:${port}`,
    });

    assert.deepEqual(vectors, [[0.4, 0.5, 0.6]]);
  });

  assert.deepEqual(seenModels, ['env-embedding-model']);
});

test('RAGDiaryPlugin embedding methods use shared EmbeddingUtils backend', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    const body = await readJsonBody(req);
    requests.push({ model: body.model, input: body.input });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [body.input.length, index + 1, String(text).length],
      })),
    }));
  });

  const port = await listen(server);
  t.after(() => server.close());

  await withEmbeddingEnv({
    EMBEDDING_API_URL: `http://127.0.0.1:${port}`,
    WhitelistEmbeddingModel: 'rag-shared-model',
  }, async () => {
    const single = await ragDiaryPlugin.getSingleEmbedding('  hello  ');
    assert.deepEqual(single, [1, 1, 5]);

    const batch = await ragDiaryPlugin.getBatchEmbeddings(['alpha', '', 'beta']);
    assert.deepEqual(batch, [[2, 1, 5], null, [2, 2, 4]]);
  });

  assert.deepEqual(requests, [
    { model: 'rag-shared-model', input: ['hello'] },
    { model: 'rag-shared-model', input: ['alpha', 'beta'] },
  ]);
});

test('RAGDiaryPlugin rejects partial vectors for split single embeddings', async (t) => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    const body = await readJsonBody(req);
    requestCount += 1;

    if (body.input.some((text) => String(text).includes('sentence 0'))) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'one chunk failed' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [body.input.length, index + 1, String(text).length],
      })),
    }));
  });

  const port = await listen(server);
  t.after(() => server.close());

  await withEmbeddingEnv({
    EMBEDDING_API_URL: `http://127.0.0.1:${port}`,
    WhitelistEmbeddingModel: 'rag-shared-model',
    EmbeddingModelBackup1: 'rag-shared-backup',
  }, async () => {
    const longText = Array.from(
      { length: 80 },
      (_, index) => `sentence ${index} ${'alpha '.repeat(100)}.`
    ).join(' ');
    const single = await ragDiaryPlugin.getSingleEmbedding(longText);
    assert.equal(single, null);
  });

  assert.ok(requestCount >= 3);
});

test('RAGDiaryPlugin uses token-weighted average for split single embeddings', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/embeddings');

    const body = await readJsonBody(req);
    requests.push({ model: body.model, input: body.input });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [String(text).length, 1],
      })),
    }));
  });

  const port = await listen(server);
  t.after(() => server.close());

  await withEmbeddingEnv({
    EMBEDDING_API_URL: `http://127.0.0.1:${port}`,
    WhitelistEmbeddingModel: 'rag-shared-model',
  }, async () => {
    const longText = Array.from(
      { length: 80 },
      (_, index) => `sentence ${index} ${'alpha '.repeat(100)}.`
    ).join(' ');
    const chunks = chunkText(longText);
    assert.ok(chunks.length > 1);

    const weights = chunks.map(chunk => Math.max(1, ragDiaryPlugin._estimateTokens(chunk)));
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const expectedFirstDimension = chunks.reduce((sum, chunk, index) => {
      return sum + String(chunk).length * (weights[index] / weightSum);
    }, 0);

    const single = await ragDiaryPlugin.getSingleEmbedding(longText);
    assert.ok(single);
    assert.equal(single.length, 2);
    assert.ok(Math.abs(single[0] - expectedFirstDimension) < 1e-9);
    assert.equal(single[1], 1);
  });

  assert.ok(requests.length > 0);
});
