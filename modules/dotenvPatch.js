// modules/dotenvPatch.js
const dotenv = require('dotenv');

// 自定义支持 @ 和 #%&^+-_ 符号的 LINE 正则
const CUSTOM_LINE = /(?:^|^)\s*(?:export\s+)?([\w.@#%&^+_\-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

// 重写 dotenv.parse
dotenv.parse = function (src) {
  const obj = {};

  // Convert buffer to string
  let lines = src.toString();

  // Convert line breaks to same format
  lines = lines.replace(/\r\n?/mg, '\n');

  let match;
  // 每次执行前重置正则的 lastIndex
  CUSTOM_LINE.lastIndex = 0;
  
  while ((match = CUSTOM_LINE.exec(lines)) != null) {
    const key = match[1];

    // Default undefined or null to empty string
    let value = (match[2] || '');

    // Remove whitespace
    value = value.trim();

    // Check if double quoted
    const maybeQuote = value[0];

    // Remove surrounding quotes
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');

    // Expand newlines if double quoted
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\r/g, '\r');
    }

    // Add to object
    obj[key] = value;
  }

  return obj;
};

console.log('[dotenvPatch] Successfully patched dotenv.parse to support @ and #%&^+-_ in keys.');