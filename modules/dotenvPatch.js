// modules/dotenvPatch.js
const dotenv = require('dotenv');

const SPECIAL_KEY_LINE = /(?:^|^)\s*(?:export\s+)?([\w.@#%&^+_-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

function parseWithSpecialKeys(src) {
    const obj = {};
    let lines = src.toString();

    lines = lines.replace(/\r\n?/mg, '\n');

    let match;
    SPECIAL_KEY_LINE.lastIndex = 0;

    while ((match = SPECIAL_KEY_LINE.exec(lines)) != null) {
        const key = match[1];
        let value = (match[2] || '').trim();
        const maybeQuote = value[0];

        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');

        if (maybeQuote === '"') {
            value = value.replace(/\\n/g, '\n');
            value = value.replace(/\\r/g, '\r');
        }

        obj[key] = value;
    }

    return obj;
}

dotenv.parse = parseWithSpecialKeys;

module.exports = dotenv;
