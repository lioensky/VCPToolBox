const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { getEmbeddingsBatch } = require('../EmbeddingUtils');

async function withEmbeddingEnv(vars, fn) {
  const keys = [
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
