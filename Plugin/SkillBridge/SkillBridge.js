#!/usr/bin/env node

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const PLUGIN_ROOT = __dirname;
const SKILL_ROOT = path.join(PLUGIN_ROOT, 'SKILL');
const OUTPUT_FILE = path.join(PLUGIN_ROOT, 'skill-index.txt');
const CONFIG_FILE = path.join(PLUGIN_ROOT, 'config.env');
const DEFAULT_HEADER_TEXT = '这里是Skill技能目录，若你需要对应技能，请使用文件管理插件的Ink模式读取技能。';
const DEFAULT_SKILL_THRESHOLD = 0.35;
const DEFAULT_PATH_MODE = 'absolute_windows';

function loadLocalConfigEnv() {
  try {
    if (!fsSync.existsSync(CONFIG_FILE)) {
      return;
    }

    const content = fsSync.readFileSync(CONFIG_FILE, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eqIndex = line.indexOf('=');
      if (eqIndex <= 0) continue;

      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();

      if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn(`[SkillBridge] 读取 config.env 失败: ${error.message}`);
  }
}

loadLocalConfigEnv();

function getHeaderText() {
  const value = String(process.env.SKILLBRIDGE_HEADER_TEXT || '').trim();
  return value || DEFAULT_HEADER_TEXT;
}

function getSkillThreshold() {
  const rawValue = String(process.env.SKILLBRIDGE_DEFAULT_THRESHOLD || '').trim();
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return DEFAULT_SKILL_THRESHOLD;
}

function getPathMode() {
  const value = String(process.env.SKILLBRIDGE_PATH_MODE || '').trim().toLowerCase();
  if (value === 'relative') return 'relative';
  if (value === 'absolute_windows') return 'absolute_windows';
  return DEFAULT_PATH_MODE;
}

function formatSkillPath(skillMdPath) {
  const resolvedPath = path.resolve(skillMdPath);
  if (getPathMode() === 'relative') {
    return path.relative(PLUGIN_ROOT, resolvedPath).replace(/\\/g, '/');
  }
  return resolvedPath.replace(/\//g, '\\');
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/\u0000/g, '')
    .trim();
}

function flattenText(text) {
  return normalizeText(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ');
}

function extractFrontmatter(rawContent) {
  const content = String(rawContent || '');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  return match ? match[1] : '';
}

function extractDescriptionFromFrontmatter(frontmatter) {
  if (!frontmatter) return '';

  const lines = frontmatter.split('\n');
  let description = '';
  let captureMode = false;
  let baseIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!captureMode) {
      const foldedMatch = line.match(/^description:\s*[>|][+-]?\s*$/);
      if (foldedMatch) {
        captureMode = true;
        continue;
      }

      const inlineMatch = line.match(/^description:\s*(.+?)\s*$/);
      if (inlineMatch) {
        return inlineMatch[1].trim();
      }
      continue;
    }

    if (!line.trim()) {
      description += '\n';
      continue;
    }

    const indentMatch = line.match(/^(\s+)/);
    const currentIndent = indentMatch ? indentMatch[1].length : 0;

    if (baseIndent === null) {
      if (currentIndent === 0) {
        break;
      }
      baseIndent = currentIndent;
    }

    if (currentIndent < baseIndent) {
      break;
    }

    description += `${line.slice(baseIndent)}\n`;
  }

  return description.trim();
}

function extractFallbackSnippet(rawContent, maxChars = 400) {
  const content = normalizeText(rawContent).replace(/^---[\s\S]*?\n---\s*/m, '').trim();
  return content.slice(0, maxChars).trim();
}

async function collectSkillEntries() {
  const dirents = await fs.readdir(SKILL_ROOT, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;

    const skillDirName = dirent.name;
    const skillMdPath = path.join(SKILL_ROOT, skillDirName, 'SKILL.md');

    try {
      const rawContent = await fs.readFile(skillMdPath, 'utf8');
      const frontmatter = extractFrontmatter(rawContent);
      const description = extractDescriptionFromFrontmatter(frontmatter);
      const summary = flattenText(description || extractFallbackSnippet(rawContent, 400));

      entries.push({
        name: skillDirName,
        skillPath: formatSkillPath(skillMdPath),
        summary
      });
    } catch (error) {
      entries.push({
        name: skillDirName,
        skillPath: formatSkillPath(skillMdPath),
        summary: `读取失败：${error.message}`
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return entries;
}

function buildFoldOutput(entries) {
  const headerText = getHeaderText();
  const skillThreshold = getSkillThreshold();
  const lines = [];

  lines.push('[===vcp_fold: 0.0 ===]');
  lines.push(headerText);
  lines.push('');
  lines.push(`当前共暴露 ${entries.length} 个 Skill 索引。`);

  for (const entry of entries) {
    lines.push('');
    lines.push(`[===vcp_fold: ${skillThreshold} ::desc: 《${entry.summary}》===]`);
    lines.push(`- Skill: ${entry.name}`);
    lines.push(`- 路径: ${entry.skillPath}`);
  }

  return lines.join('\n').trim();
}

async function main() {
  try {
    const entries = await collectSkillEntries();
    const output = buildFoldOutput(entries);
    await fs.writeFile(OUTPUT_FILE, output + '\n', 'utf8');
    process.stdout.write(output);
  } catch (error) {
    const fallback = [
      '[===vcp_fold: 0.0 ===]',
      getHeaderText(),
      '',
      `[SkillBridge] 构建 Skill 索引失败：${error.message}`
    ].join('\n');
    process.stdout.write(fallback);
    process.exitCode = 1;
  }
}

main();