'use strict';
const path = require('node:path'), fs = require('node:fs'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), source = path.join(root, 'apps/mobile');
const vite = path.join(path.dirname(require.resolve('vite/package.json', { paths: [source] })), 'bin/vite.js');
const out = path.resolve(process.argv[2] || path.join(root, 'Plugin/NativeSync/mobile-dist'));
if (fs.existsSync(out) && fs.readdirSync(out).length) throw Error('MOBILE_BUILD_REQUIRES_EMPTY_OUTPUT');
execFileSync(process.execPath, [vite, 'build', source, '--outDir', out], { cwd: source, stdio: 'inherit' });
