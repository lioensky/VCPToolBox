const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const pluginDir = path.join(repoRoot, 'Plugin', 'GPTImageGen');
const pluginScript = path.join(pluginDir, 'GPTImageGen.js');
const zImagePluginDir = path.join(repoRoot, 'Plugin', 'ZImageTurboGen');
const zImagePluginScript = path.join(zImagePluginDir, 'ZImageTurboGen.mjs');
const zImageDnsFixture = path.join(repoRoot, 'tests', 'fixtures', 'zimage-dns-private-fixture.mjs');

function zImageTestEnv(overrides = {}) {
  return {
    ...process.env,
    ZIMAGE_API_KEY: 'test-only-key',
    PROJECT_BASE_PATH: repoRoot,
    SERVER_PORT: '5890',
    IMAGESERVER_IMAGE_KEY: 'test-image-key',
    VarHttpUrl: 'http://127.0.0.1',
    VarHttpsUrl: 'https://example.invalid',
    DebugMode: 'false',
    HTTP_PROXY: '',
    http_proxy: '',
    HTTPS_PROXY: '',
    https_proxy: '',
    ...overrides
  };
}

test('GPTImageGen is present but disabled by default on prod stable', () => {
  assert.equal(fs.existsSync(path.join(pluginDir, 'plugin-manifest.json.block')), true);
  assert.equal(fs.existsSync(path.join(pluginDir, 'plugin-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(pluginDir, 'config.env.example')), true);
  assert.equal(fs.existsSync(path.join(pluginDir, 'config.env')), false);
});

test('GPTImageGen keeps local image reads bounded to project image directory', () => {
  const source = fs.readFileSync(pluginScript, 'utf8');

  assert.match(source, /PROJECT_IMAGE_ROOT/);
  assert.match(source, /isPathInside\(resolved, PROJECT_IMAGE_ROOT\)/);
  assert.match(source, /本地图片路径仅允许位于项目 image\/ 目录下/);
});

test('GPTImageGen blocks obvious local/private URL image inputs', () => {
  const source = fs.readFileSync(pluginScript, 'utf8');

  assert.match(source, /isBlockedLocalHostname/);
  assert.match(source, /resolveImageDownloadUrl/);
  assert.match(source, /localhost/);
  assert.equal(source.includes('192\\.168'), true);
  assert.match(source, /downloadImage\(input, MAX_IMAGE_SIZE\)/);
});

test('GPTImageGen validates redirect targets and preserves download limits', () => {
  const source = fs.readFileSync(pluginScript, 'utf8');

  assert.match(source, /resolveImageDownloadUrl\(res\.headers\.location, parsedUrl\.href\)/);
  assert.match(source, /downloadImage\(redirectUrl\.href, maxBytes, redirectCount \+ 1\)/);
  assert.match(source, /图片下载重定向次数过多/);
});

test('GPTImageGen rejects private URL edit inputs before network calls', () => {
  const child = spawnSync(process.execPath, [pluginScript], {
    cwd: repoRoot,
    input: JSON.stringify({
      command: 'GPTEditImage',
      prompt: 'offline safety check',
      image: 'http://127.0.0.1/latest/meta-data',
      size: '1024x1024'
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAI_API_KEY: 'test-only-key',
      PROJECT_BASE_PATH: repoRoot,
      DebugMode: 'false'
    }
  });

  assert.notEqual(child.status, 0);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'error');
  assert.match(parsed.error, /不允许指向本机、链路本地或私有网段地址/);
  assert.equal(child.stderr, '');
});

test('GPTImageGen parses JSON array string edit inputs before URL safety checks', () => {
  const child = spawnSync(process.execPath, [pluginScript], {
    cwd: repoRoot,
    input: JSON.stringify({
      command: 'GPTEditImage',
      prompt: 'offline safety check',
      image: JSON.stringify(['http://127.0.0.1/latest/meta-data']),
      size: '1024x1024'
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAI_API_KEY: 'test-only-key',
      PROJECT_BASE_PATH: repoRoot,
      DebugMode: 'false'
    }
  });

  assert.notEqual(child.status, 0);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'error');
  assert.match(parsed.error, /不允许指向本机、链路本地或私有网段地址/);
  assert.equal(child.stderr, '');
});

test('GPTImageGen exits before any API call when API key is absent', () => {
  const child = spawnSync(process.execPath, [pluginScript], {
    cwd: repoRoot,
    input: JSON.stringify({
      command: 'GPTGenerateImage',
      prompt: 'offline safety check',
      size: '1024x1024'
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      PROJECT_BASE_PATH: repoRoot,
      DebugMode: 'false'
    }
  });

  assert.notEqual(child.status, 0);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'error');
  assert.match(parsed.error, /OPENAI_API_KEY/);
  assert.equal(child.stderr, '');
});

test('ZImageTurboGen keeps edit image inputs bounded before Gitee upload', () => {
  const source = fs.readFileSync(zImagePluginScript, 'utf8');

  assert.match(source, /import dns from 'dns\/promises';/);
  assert.match(source, /import net from 'net';/);
  assert.match(source, /ZIMAGE_INPUT_IMAGE_ROOT/);
  assert.match(source, /isPathInside\(resolved, ZIMAGE_INPUT_IMAGE_ROOT\)/);
  assert.match(source, /isBlockedLocalHostname/);
  assert.match(source, /assertImageInputHostnameIsSafe/);
  assert.match(source, /dns\.lookup\(hostname, \{ all: true, verbatim: true \}\)/);
  assert.match(source, /expandIpv6Address/);
  assert.match(source, /extractIPv4FromIPv6/);
  assert.match(source, /resolveImageInputUrl\(response\.headers\.get\('location'\), parsedUrl\.href\)/);
  assert.match(source, /normalizeImageMimeType/);
  assert.match(source, /MAX_INPUT_IMAGE_SIZE/);
});

test('ZImageTurboGen rejects private URL edit inputs before network calls', () => {
  const child = spawnSync(process.execPath, [zImagePluginScript], {
    cwd: repoRoot,
    input: JSON.stringify({
      command: 'EditImage',
      prompt: 'offline safety check',
      image: 'http://127.0.0.1/latest/meta-data'
    }),
    encoding: 'utf8',
    env: zImageTestEnv()
  });

  assert.notEqual(child.status, 0);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'error');
  assert.match(parsed.error, /不允许指向本机、链路本地或私有网段地址/);
  assert.equal(child.stderr, '');
});

test('ZImageTurboGen rejects hostnames that resolve to private image inputs before network calls', () => {
  const child = spawnSync(process.execPath, [zImagePluginScript], {
    cwd: repoRoot,
    input: JSON.stringify({
      command: 'EditImage',
      prompt: 'offline safety check',
      image: 'http://image-private.test:9/latest/meta-data'
    }),
    encoding: 'utf8',
    env: zImageTestEnv({
      NODE_OPTIONS: `--import=${pathToFileURL(zImageDnsFixture).href}`,
      ZIMAGE_TEST_DNS_PRIVATE_HOST: 'image-private.test'
    })
  });

  assert.notEqual(child.status, 0);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'error');
  assert.match(parsed.error, /不允许解析到本机、链路本地或私有网段地址/);
  assert.equal(child.stderr, '');
});

test('ZImageTurboGen rejects IPv6 private and IPv4-mapped edit URLs before network calls', () => {
  const blockedUrls = [
    'http://[fd00::1]/latest/meta-data',
    'http://[fe80::1]/latest/meta-data',
    'http://[::ffff:127.0.0.1]/latest/meta-data'
  ];

  for (const image of blockedUrls) {
    const child = spawnSync(process.execPath, [zImagePluginScript], {
      cwd: repoRoot,
      input: JSON.stringify({
        command: 'EditImage',
        prompt: 'offline safety check',
        image
      }),
      encoding: 'utf8',
      env: zImageTestEnv()
    });

    assert.notEqual(child.status, 0, image);
    const parsed = JSON.parse(child.stdout);
    assert.equal(parsed.status, 'error', image);
    assert.match(parsed.error, /不允许指向本机、链路本地或私有网段地址/, image);
    assert.equal(child.stderr, '', image);
  }
});

test('ZImageTurboGen rejects file URL edit inputs outside project image directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zimage-safety-'));
  const outsideImage = path.join(tempDir, 'outside.png');
  fs.writeFileSync(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const child = spawnSync(process.execPath, [zImagePluginScript], {
      cwd: repoRoot,
      input: JSON.stringify({
        command: 'EditImage',
        prompt: 'offline safety check',
        image: pathToFileURL(outsideImage).href
      }),
      encoding: 'utf8',
      env: zImageTestEnv()
    });

    assert.notEqual(child.status, 0);
    const parsed = JSON.parse(child.stdout);
    assert.equal(parsed.status, 'error');
    assert.match(parsed.error, /本地图片路径仅允许位于项目 image\/ 目录下/);
    assert.equal(child.stderr, '');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PluginSourceViewer manifest example uses the registered tool name', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Plugin', 'PluginSourceViewer', 'plugin-manifest.json'), 'utf8'));
  const description = manifest?.capabilities?.invocationCommands?.[0]?.description || '';

  assert.equal(manifest.name, 'ServerPluginSourceViewer');
  assert.match(description, /tool_name:「始」ServerPluginSourceViewer「末」/);
  assert.doesNotMatch(description, /tool_name:「始」PluginSourceViewer「末」/);
});

test('VolcSearch keeps summary or snippet text when full content is absent', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'Plugin', 'VolcSearch', 'VolcSearch.js'), 'utf8');

  assert.match(source, /const summary = item\.Summary \|\| '';/);
  assert.match(source, /const snippet = item\.Snippet \|\| '';/);
  assert.match(source, /const displayText = content \|\| summary \|\| snippet;/);
  assert.match(source, /const \{ LogoUrl, \.\.\.rest \} = item;/);
});

test('LightMemo scoped maid searches still filter by signature', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'Plugin', 'LightMemo', 'LightMemo.js'), 'utf8');

  assert.match(source, /if \(!searchAll && maid\) \{/);
  assert.doesNotMatch(source, /targetFolders\.length === 0 && maid/);
});
