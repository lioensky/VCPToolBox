#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readText(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function listTrackedFiles() {
  const output = runGit(['ls-files', '-z']);
  return output.split('\0').filter(Boolean);
}

function hasLine(text, pattern) {
  return pattern.test(text);
}

const trackedFiles = listTrackedFiles();
const denyRules = [
  { label: 'actual config.env', pattern: /(^|\/)config\.env$/ },
  { label: 'env files', pattern: /(^|\/)\.env(\.|$)|(^|\/)config\.env\.local$/ },
  { label: 'chat/debug logs', pattern: /(^|\/)DebugLog\/|(^|\/)logs\/|\.log$/ },
  { label: 'runtime sqlite/db files', pattern: /\.(sqlite|sqlite-shm|sqlite-wal|db)$/ },
  { label: 'runtime vector stores', pattern: /(^|\/)VectorStore\/|^data\/(candidate-cache|chat-history-index|memory-vectors)\.json$/ },
  { label: 'daily note runtime content', pattern: /^dailynote\/(?!VCP桌面知识\/)/ },
  { label: 'plugin state directories', pattern: /^Plugin\/[^/]+\/state\// },
  { label: 'runtime auth code', pattern: /^Plugin\/UserAuth\/code\.bin$/ },
  { label: 'plugin generated caches', pattern: /^Plugin\/ArtistMatcher\/artist_cache\.json$/ },
  { label: 'generated Flux images', pattern: /^image\/fluxgen\// },
  { label: 'generated GPTImageGen images', pattern: /^image\/gptimagegen\// },
];

const allowedEnvTemplatePattern = /(^|\/)\.env\.(example|sample|template)$/;

function findDenyRule(file) {
  const normalized = file.replace(/\\/g, '/');
  if (allowedEnvTemplatePattern.test(normalized)) {
    return null;
  }
  return denyRules.find(rule => rule.pattern.test(normalized)) || null;
}

const violations = [];
for (const file of trackedFiles) {
  const rule = findDenyRule(file);
  if (rule) {
    violations.push(`${rule.label}: ${file}`);
  }
}

const requiredChecks = [];

const envExample = readText('config.env.example');
requiredChecks.push({
  label: 'config.env.example keeps DebugMode=false',
  ok: hasLine(envExample, /^DebugMode=false$/m),
});
requiredChecks.push({
  label: 'config.env.example keeps CHAT_LOG_ENABLED=false',
  ok: hasLine(envExample, /^CHAT_LOG_ENABLED=false$/m),
});
requiredChecks.push({
  label: 'config.env.example does not enable AI image agent route',
  ok: !hasLine(envExample, /^ENABLE_AI_IMAGE_AGENTS_ROUTE\s*=\s*true$/mi),
});
requiredChecks.push({
  label: 'config.env.example does not enable AI image real execution',
  ok: !hasLine(envExample, /^ENABLE_AI_IMAGE_REAL_EXECUTION\s*=\s*true$/mi),
});
requiredChecks.push({
  label: 'config.env.example does not enable pipeline execution',
  ok: !hasLine(envExample, /^AIGENT_PIPELINE_ALLOW_EXECUTION\s*=\s*true$/mi),
});

const server = readText('server.js');
requiredChecks.push({
  label: 'AI image admin route is gated by ENABLE_AI_IMAGE_AGENTS_ROUTE',
  ok: server.includes("process.env.ENABLE_AI_IMAGE_AGENTS_ROUTE === 'true'"),
});
requiredChecks.push({
  label: 'AI image real execution is gated by ENABLE_AI_IMAGE_REAL_EXECUTION',
  ok: server.includes("process.env.ENABLE_AI_IMAGE_REAL_EXECUTION === 'true'"),
});

const safetyGate = readText('modules/pipelineSafetyGate.js');
requiredChecks.push({
  label: 'pipeline safety gate requires AIGENT_PIPELINE_ALLOW_EXECUTION',
  ok: safetyGate.includes('AIGENT_PIPELINE_ALLOW_EXECUTION'),
});

requiredChecks.push({
  label: 'baseline deny rules catch nested env files',
  ok: [
    'AdminPanel-Vue/.env.production',
    'Plugin/Example/.env',
    'Plugin/Example/config.env.local',
  ].every(file => findDenyRule(file)?.label === 'env files'),
});
requiredChecks.push({
  label: 'baseline deny rules allow env templates',
  ok: [
    'Plugin/Example/.env.example',
    'Plugin/Example/.env.sample',
    'Plugin/Example/.env.template',
  ].every(file => findDenyRule(file) === null),
});

const aiImageRoute = readText('routes/admin/aiImageAgents.js');
requiredChecks.push({
  label: 'AI image route keeps dry-run forcing path',
  ok: aiImageRoute.includes('forceDryRun: true') && aiImageRoute.includes('resolveDryRunMode'),
});

requiredChecks.push({
  label: 'GPTImageGen stays disabled by default on prod stable',
  ok: trackedFiles.includes('Plugin/GPTImageGen/plugin-manifest.json.block')
    && !trackedFiles.includes('Plugin/GPTImageGen/plugin-manifest.json'),
});

const failedChecks = requiredChecks.filter((check) => !check.ok);

if (violations.length > 0 || failedChecks.length > 0) {
  console.error('[prod-baseline] failed');

  if (violations.length > 0) {
    console.error('\nTracked forbidden/runtime files:');
    for (const item of violations) {
      console.error(`- ${item}`);
    }
  }

  if (failedChecks.length > 0) {
    console.error('\nMissing or unsafe baseline checks:');
    for (const check of failedChecks) {
      console.error(`- ${check.label}`);
    }
  }

  process.exit(1);
}

console.log(`[prod-baseline] ok: ${trackedFiles.length} tracked files checked, ${requiredChecks.length} safety checks passed`);
