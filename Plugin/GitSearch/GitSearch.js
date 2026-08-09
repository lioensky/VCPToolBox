#!/usr/bin/env node
'use strict';

/**
 * GitSearch — VCP synchronous plugin main entry point.
 *
 * Reads JSON requests from stdin, dispatches them to platform-specific
 * adapters (github / gitlab / gitee), and writes JSON responses to stdout.
 * Supports single-call and batch-call (command1, command2, …) modes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Stdin reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the entire contents of process.stdin until it closes.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Input parser — single & batch calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses the incoming JSON object into an array of request objects.
 *
 * Batch mode is detected by the presence of a `command1` key.  When found,
 * every key ending in a number is grouped by that suffix; the suffix is
 * stripped to produce the per-request parameter name.
 *
 * Single mode returns a one-element array.
 *
 * @param {object} json
 * @returns {object[]}
 */
function parseRequests(json) {
  if (json === null || typeof json !== 'object') {
    throw new Error('Invalid JSON input: expected an object');
  }

  // Detect batch mode by checking for command1 key
  if ('command1' in json) {
    return parseBatchRequests(json);
  }

  // Single request mode
  return [json];
}

/**
 * Parses a batch request object (keys with numeric suffixes) into an array
 * of individual request objects.
 *
 * @param {object} json
 * @returns {object[]}
 */
function parseBatchRequests(json) {
  const groups = new Map(); // number -> { key: value }

  for (const [key, value] of Object.entries(json)) {
    // Match keys that end with one or more digits
    const match = key.match(/^(.+)(\d+)$/);
    if (match) {
      const paramName = match[1];
      const groupNum = parseInt(match[2], 10);

      if (!groups.has(groupNum)) {
        groups.set(groupNum, {});
      }
      groups.get(groupNum)[paramName] = value;
    }
  }

  if (groups.size === 0) {
    throw new Error('Batch mode detected (command1 present) but no valid parameter groups found');
  }

  // Sort by group number to preserve call order
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
  return sortedKeys.map((num) => groups.get(num));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Platform adapter loader
// ─────────────────────────────────────────────────────────────────────────────

const AVAILABLE_COMMANDS = [
  'repo_get',
  'repo_list_files',
  'repo_list_branches',
  'repo_list_commits',
  'repo_search_code',
  'repo_list_releases',
  'issue_list',
  'issue_get',
  'issue_search',
  'pr_list',
  'pr_get',
  'pr_get_diff',
  'user_get_me',
  'user_search'
];

const AVAILABLE_PLATFORMS = ['github', 'gitlab', 'gitee'];

/**
 * Loads the adapter module for the given platform.
 *
 * @param {string} platform
 * @returns {object}
 */
function getAdapter(platform) {
  if (!platform) {
    throw new Error('Missing required parameter: platform');
  }

  switch (platform) {
    case 'github':
      return require('./adapters/github');
    case 'gitlab':
      return require('./adapters/gitlab');
    case 'gitee':
      return require('./adapters/gitee');
    default:
      throw new Error(
        `Unknown platform: ${platform}. Must be one of: ${AVAILABLE_PLATFORMS.join(', ')}.`
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Command dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatches a single request to the appropriate adapter method.
 *
 * @param {object} request
 * @returns {Promise<string>} markdown result from the adapter
 */
async function dispatch(request) {
  const { platform, command, ...params } = request;

  if (!platform) {
    throw new Error('Missing required parameter: platform');
  }
  if (!command) {
    throw new Error('Missing required parameter: command');
  }

  const adapter = getAdapter(platform);
  const handler = adapter[command];

  if (!handler) {
    throw new Error(
      `Unknown command: ${command}. Available commands: ${AVAILABLE_COMMANDS.join(', ')}.`
    );
  }

  return await handler(params);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Batch executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes an array of requests sequentially, collecting results.
 * Each result is tagged with ok:true/false so partial failures are preserved.
 *
 * @param {object[]} requests
 * @returns {object[]}
 */
async function executeBatch(requests) {
  const results = [];

  for (const req of requests) {
    try {
      const result = await dispatch(req);
      results.push({
        ok: true,
        command: req.command,
        platform: req.platform,
        result
      });
    } catch (e) {
      results.push({
        ok: false,
        command: req.command,
        platform: req.platform,
        error: e.message
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Result formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the collected results into the final stdout JSON object.
 *
 * - Single successful call   → { status: 'success', result: '...' }
 * - Single failed call       → { status: 'error',   error:  '...' }
 * - Batch (any number)       → { status: 'success', result: markdown summary }
 *
 * @param {object[]} results
 * @returns {object}
 */
function formatResults(results) {
  // Single request fast-path
  if (results.length === 1) {
    const r = results[0];
    if (r.ok) {
      return { status: 'success', result: r.result };
    }
    return { status: 'error', error: r.error };
  }

  // Batch results rendered as markdown
  let md = '### 批量操作结果\n\n';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    md += `**操作 ${i + 1}** (平台: ${r.platform || 'N/A'}, 命令: ${r.command || 'N/A'}): `;
    if (r.ok) {
      md += '\u2705 成功\n\n';
      md += r.result + '\n\n';
    } else {
      md += '\u274c 失败 \u2014 ' + r.error + '\n\n';
    }
    if (i < results.length - 1) {
      md += '---\n\n';
    }
  }
  return { status: 'success', result: md };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Main entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const input = await readStdin();

    if (!input) {
      throw new Error('No input received');
    }

    let json;
    try {
      json = JSON.parse(input);
    } catch (parseErr) {
      throw new Error('Invalid JSON input: ' + parseErr.message);
    }

    const requests = parseRequests(json);

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error('No valid requests parsed from input');
    }

    const results = await executeBatch(requests);
    const output = formatResults(results);

    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: e.message }));
    process.exit(1);
  }
}

// Only run main when this file is executed directly (not when required).
if (require.main === module) {
  main();
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports — used by unit tests and programmatic consumers
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  readStdin,
  parseRequests,
  parseBatchRequests,
  getAdapter,
  dispatch,
  executeBatch,
  formatResults,
  AVAILABLE_COMMANDS,
  AVAILABLE_PLATFORMS
};
