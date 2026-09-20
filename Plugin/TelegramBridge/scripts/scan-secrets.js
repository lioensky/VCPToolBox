'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const forbiddenPaths = /(?:^|\/)(?:config\.env|state|node_modules|\.git|logs?|media)(?:\/|$)|\.sqlite(?:3)?(?:-(?:wal|shm|journal))?$|\.pem$/i;
const rules = Object.freeze([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['telegram-token', /\b[1-9]\d{4,19}:[A-Za-z0-9_-]{20,200}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['assigned-secret', /\b(?:TELEGRAM_BOT_TOKEN|TELEGRAM_VCP_KEY|AUTH_CODE|API_KEY|SECRET_KEY)\s*[=:]\s*["']?[A-Za-z0-9_./+=:-]{12,}/i],
]);
const placeholder = /fixture|example|placeholder|redacted|your[_ -]|<[^>]+>|process\.env|\$\{\{\s*secrets\.|secret-scan:\s*allow-fixture/i;

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.toString('utf8').split('\0').filter(Boolean).sort();
}

function scan() {
  const findings = [];
  for (const relative of trackedFiles()) {
    const normalized = relative.replace(/\\/g, '/');
    if (forbiddenPaths.test(normalized)) {
      findings.push({ path: normalized, rule: 'forbidden-path', line: 0 });
      continue;
    }
    const absolute = path.resolve(root, ...normalized.split('/'));
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0) || bytes.length > 4 * 1024 * 1024) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (placeholder.test(line)) return;
      for (const [rule, pattern] of rules) {
        if (pattern.test(line)) findings.push({ path: normalized, rule, line: index + 1 });
      }
    });
  }
  return findings;
}

const findings = scan();
if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line} ${finding.rule}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write('Repository secret scan passed.\n');
}

module.exports = Object.freeze({ scan });
