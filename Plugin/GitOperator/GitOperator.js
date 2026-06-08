#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAuthCode } = require('../../modules/captchaDecoder');

// ============================================================
// GitOperator - VCP Git 仓库管理器
// Version: 1.0.1
// Author: Nova & hjhjd
// ============================================================

const REPOS_FILE = path.resolve(__dirname, 'repos.json');
const ENV_FILE = path.resolve(__dirname, 'config.env');
const DEBUG_LOG = path.resolve(__dirname, 'debug.log');
const AUDIT_LOG = path.resolve(__dirname, 'audit.log');

// --- 工具函数 ---

function loadEnvConfig() {
  const config = {};
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        config[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
      }
    }
  }
  return config;
}

function loadRepos() {
  if (!fs.existsSync(REPOS_FILE)) {
    fs.writeFileSync(REPOS_FILE, JSON.stringify({ defaultProfile: '', profiles: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
}

function saveRepos(repos) {
  fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

function success(data) {
  console.log(JSON.stringify({ status: 'success', result: data }));
}

function error(message) {
  console.log(JSON.stringify({ status: 'error', error: message }));
}

function debugLog(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* ignore */ }
}

function auditLog(command, profileName, status, detail) {
  try {
    const entry = `[${new Date().toISOString()}] ${command} by profile "${profileName || 'unknown'}" - ${status}${detail ? ' | ' + detail : ''}`;
    fs.appendFileSync(AUDIT_LOG, entry + '\n');
  } catch (e) { /* ignore */ }
}

function sanitizeOutput(text, token) {
  if (!token || !text) return text;
  const masked = token.slice(0, 4) + '****' + token.slice(-4);
  let sanitized = text.split(token).join(masked);
  // 清理 URL 中可能残留的 token（URL 编码等情况）
  sanitized = sanitized.replace(/https?:\/\/[^@\s]+@/g, 'https://[REDACTED]@');
  return sanitized;
}

// --- Stale Lock 清理 & 进程级文件锁 ---

const LOCK_STALE_THRESHOLD_MS = 60000; // 60秒判定为残留锁
const LOCK_RETRY_INTERVAL_MS = 500;    // 等待间隔
const LOCK_MAX_RETRIES = 60;           // 最多等待30秒

/**
 * 清理残留的 git index.lock 文件
 * 超过 LOCK_STALE_THRESHOLD_MS 未更新的锁文件视为残留，自动删除
 */
function cleanStaleLock(cwd) {
  const lockPath = path.join(cwd, '.git', 'index.lock');
  try {
    if (!fs.existsSync(lockPath)) return false;
    const stat = fs.statSync(lockPath);
    const age = Date.now() - stat.mtimeMs;
    if (age > LOCK_STALE_THRESHOLD_MS) {
      fs.unlinkSync(lockPath);
      debugLog(`[Lock] Cleaned stale index.lock (age: ${Math.round(age / 1000)}s) at ${cwd}`);
      return true;
    } else {
      debugLog(`[Lock] index.lock exists but fresh (age: ${Math.round(age / 1000)}s), not cleaning`);
      return false;
    }
  } catch (e) {
    debugLog(`[Lock] Error checking/cleaning stale lock: ${e.message}`);
    return false;
  }
}

/**
 * 获取 VCP 进程级文件锁 (零依赖，基于 fs.openSync exclusive create)
 * @returns {boolean} 是否成功获取锁
 */
function acquireVCPLock(cwd) {
  const vcpLockPath = path.join(cwd, '.git', 'vcp-git.lock');
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const fd = fs.openSync(vcpLockPath, 'wx');
      fs.writeFileSync(vcpLockPath, JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
        date: new Date().toISOString()
      }));
      fs.closeSync(fd);
      debugLog(`[Lock] Acquired VCP lock (attempt ${attempt + 1}) at ${cwd}`);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') {
        // 锁已存在，检查是否是残留锁
        try {
          const stat = fs.statSync(vcpLockPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > LOCK_STALE_THRESHOLD_MS) {
            fs.unlinkSync(vcpLockPath);
            debugLog(`[Lock] Cleaned stale VCP lock (age: ${Math.round(age / 1000)}s)`);
            continue; // 重试获取
          }
        } catch (statErr) {
          // 锁文件可能已被其它进程释放，继续重试
        }
        if (attempt < LOCK_MAX_RETRIES - 1) {
          // 同步等待
          const waitStart = Date.now();
          while (Date.now() - waitStart < LOCK_RETRY_INTERVAL_MS) {
            // busy wait (同步插件，无法用 setTimeout)
          }
        }
      } else {
        debugLog(`[Lock] Unexpected error acquiring lock: ${e.message}`);
        return true; // 非 EEXIST 错误（如权限问题），不阻塞执行
      }
    }
  }
  debugLog(`[Lock] Failed to acquire VCP lock after ${LOCK_MAX_RETRIES} attempts at ${cwd}`);
  return false; // 超时未获取到锁
}

/**
 * 释放 VCP 进程级文件锁
 */
function releaseVCPLock(cwd) {
  const vcpLockPath = path.join(cwd, '.git', 'vcp-git.lock');
  try {
    if (fs.existsSync(vcpLockPath)) {
      fs.unlinkSync(vcpLockPath);
      debugLog(`[Lock] Released VCP lock at ${cwd}`);
    }
  } catch (e) {
    debugLog(`[Lock] Error releasing VCP lock: ${e.message}`);
  }
}

// --- 危险操作配置表 ---

const DANGEROUS_COMMANDS = {
  ForcePush: { requireAuth: true },
  ResetHard: { requireAuth: true },
  BranchDelete: { requireAuth: true },
  Rebase: { requireAuth: true },
  CherryPick: { requireAuth: true }
};

async function validateDangerousOperation(command, args, profileName) {
  const config = DANGEROUS_COMMANDS[command];
  if (!config) return { allowed: true };

  if (!args.requireAdmin) {
    auditLog(command, profileName, 'REJECTED', 'missing requireAdmin');
    return { allowed: false, error: `"${command}" 是危险操作，需要 requireAdmin 验证码。` };
  }

  const codePath = path.join(__dirname, '..', 'UserAuth', 'code.bin');
  const realCode = await getAuthCode(codePath);
  if (!realCode) {
    auditLog(command, profileName, 'FAILED', 'cannot read auth code file');
    return { allowed: false, error: '无法读取认证码文件，拒绝执行危险操作。' };
  }
  if (String(args.requireAdmin).trim() !== realCode) {
    auditLog(command, profileName, 'FAILED', 'invalid captcha');
    return { allowed: false, error: '验证码错误，拒绝执行危险操作。' };
  }

  auditLog(command, profileName, 'AUTHORIZED', 'captcha verified');
  return { allowed: true };
}

function resolveProfile(args, repos) {
  const profileName = args.profile || repos.defaultProfile;
  if (!profileName) return { error: '未指定 profile，且未设置 defaultProfile。请用 ProfileAdd 创建或指定 profile 参数。' };
  const profile = repos.profiles[profileName];
  if (!profile) return { error: `Profile "${profileName}" 不存在。可用: ${Object.keys(repos.profiles).join(', ') || '无'}` };
  if (!profile.localPath || !fs.existsSync(profile.localPath)) {
    return { error: `Profile "${profileName}" 的 localPath "${profile.localPath}" 不存在或未配置。` };
  }
  // --- 字段归一化：兼容嵌套结构和扁平结构 ---
  if (profile.push) {
    if (!profile.pushUrl) profile.pushUrl = profile.push.url;
    if (!profile.pushRemote) profile.pushRemote = profile.push.remote;
    if (!profile.pushBranch) profile.pushBranch = profile.push.branch;
  }
  if (profile.pull) {
    if (!profile.pullUrl) profile.pullUrl = profile.pull.url;
    if (!profile.pullRemote) profile.pullRemote = profile.pull.remote;
    if (!profile.pullBranch) profile.pullBranch = profile.pull.branch;
  }
  if (profile.credentials) {
    if (!profile.token) profile.token = profile.credentials.token;
    if (!profile.email) profile.email = profile.credentials.email;
    if (!profile.username) profile.username = profile.credentials.username;
  }
  return { profileName, profile };
}

function validateWorkPath(localPath, envConfig) {
  const allowedPaths = (envConfig.PLUGIN_WORK_PATHS || '../../').split(',').map(p => {
    const resolved = path.resolve(__dirname, p.trim());
    return resolved;
  });
  const resolvedLocal = path.resolve(localPath);
  const isAllowed = allowedPaths.some(ap => resolvedLocal.startsWith(ap));
  if (!isAllowed) {
    debugLog(`[Security] Path validation failed: ${resolvedLocal} not in allowed paths: ${allowedPaths.join(', ')}`);
  }
  return isAllowed;
}

function execGit(cmd, cwd, token, options = {}) {
  const defaultOptions = {
    timeout: 25000,
    maxBuffer: 5 * 1024 * 1024,
    ...options
  };

  // --- Stale Lock 清理 + VCP 进程锁 ---
  cleanStaleLock(cwd);
  const lockAcquired = acquireVCPLock(cwd);
  if (!lockAcquired) {
    debugLog(`[execGit] WARNING: Could not acquire VCP lock for ${cwd}, proceeding anyway`);
  }

  try {
    const result = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      ...defaultOptions
    });

    debugLog(`[execGit] OK: ${cmd.substring(0, 100)}`);
    return {
      ok: true,
      output: sanitizeOutput(result.trim(), token),
      code: 0
    };
  } catch (e) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const errorMsg = stderr || stdout || e.message;

    debugLog(`[execGit] FAIL: ${cmd.substring(0, 100)} | ${errorMsg.substring(0, 200)}`);
    return {
      ok: false,
      output: sanitizeOutput(errorMsg, token),
      code: e.status || 1,
      isGitError: !!stderr
    };
  } finally {
    releaseVCPLock(cwd);
  }
}

function injectCredentials(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

// --- 串行指令解析 ---

function parseSerialCommands(input) {
  const commands = [];
  let i = 1;

  // 只有明确存在 command1 时才进入串行解析路径
  while (input[`command${i}`]) {
    const cmd = input[`command${i}`];
    const args = {};
    const suffix = String(i);
    for (const [key, value] of Object.entries(input)) {
      if (key === `command${i}`) continue;
      if (key.endsWith(suffix) && key !== `command${suffix}`) {
        const baseKey = key.slice(0, -suffix.length);
        args[baseKey] = value;
      }
    }

    // 继承全局 profile
    if (input.profile && !args.profile) args.profile = input.profile;

    commands.push({ command: cmd, args });
    i++;
  }

  // 单指令 fallback：command1 不存在，但 command 存在 -> 直接透传全部参数
  if (commands.length === 0 && input.command) {
    const args = { ...input };
    delete args.command;
    commands.push({ command: input.command, args });
  }

  return commands;
}

// --- 指令实现 ---

function cmdStatus(args, profile, envConfig) {
  const { ok, output } = execGit('git status', profile.localPath, profile.token);
  if (!ok) return error(`git status 失败: ${output}`);
  success({ command: 'Status', output });
}

function cmdLog(args, profile, envConfig) {
  const maxCount = parseInt(args.maxCount) || 20;
  const branch = args.branch || '';
  const format = '--pretty=format:{"hash":"%H","short":"%h","author":"%an","date":"%ai","subject":"%s"}';
  const { ok, output } = execGit(`git log ${format} -${maxCount} ${branch}`.trim(), profile.localPath, profile.token);
  if (!ok) return error(`git log 失败: ${output}`);
  try {
    const logs = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    success({ command: 'Log', count: logs.length, logs });
  } catch {
    success({ command: 'Log', output });
  }
}

function cmdDiff(args, profile, envConfig) {
  const target = args.target || '';
  const maxLines = parseInt(args.maxLines) || 200;
  const cmd = target ? `git diff ${target}` : 'git diff';
  const { ok, output } = execGit(cmd, profile.localPath, profile.token);
  if (!ok) return error(`git diff 失败: ${output}`);
  const lines = output.split('\n');
  const truncated = lines.length > maxLines;
  success({
    command: 'Diff',
    totalLines: lines.length,
    truncated,
    output: truncated ? lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} lines truncated)` : output
  });
}

function cmdBranchList(args, profile, envConfig) {
  const { ok, output } = execGit('git branch -a', profile.localPath, profile.token);
  if (!ok) return error(`git branch 失败: ${output}`);
  success({ command: 'BranchList', output });
}

function cmdRemoteInfo(args, profile, envConfig) {
  const { ok, output } = execGit('git remote -v', profile.localPath, profile.token);
  if (!ok) return error(`git remote 失败: ${output}`);
  success({ command: 'RemoteInfo', output: sanitizeOutput(output, profile.token) });
}

function cmdStashList(args, profile, envConfig) {
  const { ok, output } = execGit('git stash list', profile.localPath, profile.token);
  if (!ok) return error(`git stash list 失败: ${output}`);
  success({ command: 'StashList', output: output || '(no stash entries)' });
}

function cmdTagList(args, profile, envConfig) {
  const { ok, output } = execGit('git tag -l', profile.localPath, profile.token);
  if (!ok) return error(`git tag 失败: ${output}`);
  success({ command: 'TagList', output: output || '(no tags)' });
}

function cmdProfileList(args, repos) {
  const list = {};
  for (const [name, p] of Object.entries(repos.profiles)) {
    list[name] = {
      localPath: p.localPath,
      pushRemote: p.pushRemote || 'origin',
      pushBranch: p.pushBranch || 'main',
      pullRemote: p.pullRemote || 'upstream',
      pullBranch: p.pullBranch || 'main',
      mergeStrategy: p.mergeStrategy || 'merge',
      hasToken: !!p.token
    };
  }
  success({ command: 'ProfileList', defaultProfile: repos.defaultProfile, profiles: list });
}

function cmdAdd(args, profile, envConfig) {
  if (!args.files) return error('Add 指令需要 "files" 参数。用 "." 表示全部，多个文件空格分隔。');
  const { ok, output } = execGit(`git add ${args.files}`, profile.localPath, profile.token);
  if (!ok) return error(`git add 失败: ${output}`);
  success({ command: 'Add', files: args.files, output: output || 'staged successfully' });
}

function cmdCommit(args, profile, envConfig) {
  if (!args.message) return error('Commit 指令需要 "message" 参数。');
  const safeMsg = args.message.replace(/"/g, '\\"');
  const { ok, output } = execGit(`git commit -m "${safeMsg}"`, profile.localPath, profile.token);
  if (!ok) return error(`git commit 失败: ${output}`);
  success({ command: 'Commit', output });
}

function cmdPull(args, profile, envConfig) {
  const source = args.source || 'pull';
  let remote, branch;
  if (source === 'push') {
    remote = profile.pushRemote || 'origin';
    branch = profile.pushBranch || 'main';
  } else {
    remote = profile.pullRemote || 'upstream';
    branch = profile.pullBranch || 'main';
  }
  const { ok, output } = execGit(`git pull ${remote} ${branch}`, profile.localPath, profile.token);
  if (!ok) return error(`git pull 失败: ${output}`);
  success({ command: 'Pull', remote, branch, output });
}

function cmdPush(args, profile, envConfig) {
  const remote = profile.pushRemote || 'origin';
  const branch = profile.pushBranch || 'main';
  const pushUrl = profile.pushUrl;
  let cmd;
  if (pushUrl && profile.token) {
    const authedUrl = injectCredentials(pushUrl, profile.token);
    cmd = `git push ${authedUrl} HEAD:${branch}`;
  } else {
    cmd = `git push ${remote} ${branch}`;
  }
  const { ok, output } = execGit(cmd, profile.localPath, profile.token);
  if (!ok) return error(`git push 失败: ${sanitizeOutput(output, profile.token)}`);
  success({ command: 'Push', remote, branch, output: sanitizeOutput(output, profile.token) || 'pushed successfully' });
}

function cmdFetch(args, profile, envConfig) {
  const source = args.source || 'pull';
  let remote;
  if (source === 'push') {
    remote = profile.pushRemote || 'origin';
  } else {
    remote = profile.pullRemote || 'upstream';
  }
  const { ok, output } = execGit(`git fetch ${remote}`, profile.localPath, profile.token);
  if (!ok) return error(`git fetch 失败: ${output}`);
  success({ command: 'Fetch', remote, output: output || 'fetched successfully' });
}

function cmdBranchCreate(args, profile, envConfig) {
  if (!args.branchName) return error('BranchCreate 需要 "branchName" 参数。');
  const startPoint = args.startPoint || 'HEAD';
  const { ok, output } = execGit(`git branch ${args.branchName} ${startPoint}`, profile.localPath, profile.token);
  if (!ok) return error(`git branch 创建失败: ${output}`);
  success({ command: 'BranchCreate', branchName: args.branchName, output: output || 'branch created' });
}

function cmdCheckout(args, profile, envConfig) {
  if (!args.branch) return error('Checkout 需要 "branch" 参数。');
  const { ok, output } = execGit(`git checkout ${args.branch}`, profile.localPath, profile.token);
  if (!ok) return error(`git checkout 失败: ${output}`);
  success({ command: 'Checkout', branch: args.branch, output: output || 'switched' });
}

function cmdMerge(args, profile, envConfig) {
  if (!args.branch) return error('Merge 需要 "branch" 参数（源分支名）。');
  const { ok, output } = execGit(`git merge ${args.branch}`, profile.localPath, profile.token);
  if (!ok) {
    execGit('git merge --abort', profile.localPath, profile.token);
    const conflictR = execGit('git diff --name-only --diff-filter=U', profile.localPath, profile.token);
    const conflictFiles = conflictR.ok && conflictR.output.trim() ? conflictR.output.trim().split('\n') : [];
    if (conflictFiles.length > 0) {
      return success({
        command: 'Merge', status: 'conflict', branch: args.branch,
        conflictFiles,
        suggestions: [
          `git diff --check 查看具体冲突位置`,
          `手动解决冲突后执行: git add . && git commit`,
          `放弃合并: git merge --abort`
        ],
        rawOutput: output
      });
    }
    return error(`git merge 失败: ${output}`);
  }
  success({ command: 'Merge', branch: args.branch, output });
}

function cmdClone(args) {
  if (!args.url) return error('Clone 需要 "url" 参数。');
  if (!args.localPath) return error('Clone 需要 "localPath" 参数。');
  const { ok, output } = execGit(`git clone ${args.url} ${args.localPath}`, process.cwd(), null);
  if (!ok) return error(`git clone 失败: ${output}`);
  if (args.profile) {
    const repos = loadRepos();
    repos.profiles[args.profile] = { localPath: path.resolve(args.localPath) };
    if (!repos.defaultProfile) repos.defaultProfile = args.profile;
    saveRepos(repos);
  }
  success({ command: 'Clone', output: output || 'cloned successfully' });
}



// --- 危险操作 ---

function cmdForcePush(args, profile, envConfig) {
  const remote = profile.pushRemote || 'origin';
  const branch = profile.pushBranch || 'main';
  const pushUrl = profile.pushUrl;
  let cmd;
  if (pushUrl && profile.token) {
    cmd = `git push --force ${injectCredentials(pushUrl, profile.token)} HEAD:${branch}`;
  } else {
    cmd = `git push --force ${remote} ${branch}`;
  }
  const { ok, output } = execGit(cmd, profile.localPath, profile.token);
  if (!ok) return error(`ForcePush 失败: ${sanitizeOutput(output, profile.token)}`);
  success({ command: 'ForcePush', output: sanitizeOutput(output, profile.token) || 'force pushed' });
}

function cmdResetHard(args, profile, envConfig) {
  const target = args.target || 'HEAD';
  const { ok, output } = execGit(`git reset --hard ${target}`, profile.localPath, profile.token);
  if (!ok) return error(`ResetHard 失败: ${output}`);
  success({ command: 'ResetHard', target, output });
}

function cmdBranchDelete(args, profile, envConfig) {
  if (!args.branchName) return error('BranchDelete 需要 "branchName" 参数。');
  const { ok, output } = execGit(`git branch -D ${args.branchName}`, profile.localPath, profile.token);
  if (!ok) return error(`BranchDelete 失败: ${output}`);
  success({ command: 'BranchDelete', branchName: args.branchName, output });
}

function cmdRebase(args, profile, envConfig) {
  if (!args.onto) return error('Rebase 需要 "onto" 参数。');
  const { ok, output } = execGit(`git rebase ${args.onto}`, profile.localPath, profile.token);
  if (!ok) {
    const conflictR = execGit('git diff --name-only --diff-filter=U', profile.localPath, profile.token);
    const conflictFiles = conflictR.ok && conflictR.output.trim() ? conflictR.output.trim().split('\n') : [];
    execGit('git rebase --abort', profile.localPath, profile.token);
    if (conflictFiles.length > 0) {
      return success({
        command: 'Rebase', status: 'conflict', onto: args.onto,
        conflictFiles,
        suggestions: [
          `git diff --check 查看具体冲突位置`,
          `手动解决冲突后执行: git add . && git rebase --continue`,
          `放弃变基: git rebase --abort`
        ],
        rawOutput: output
      });
    }
    return error(`Rebase 失败 (已自动 abort): ${output}`);
  }
  success({ command: 'Rebase', onto: args.onto, output });
}

function cmdCherryPick(args, profile, envConfig) {
  if (!args.commitHash) return error('CherryPick 需要 "commitHash" 参数。');
  const { ok, output } = execGit(`git cherry-pick ${args.commitHash}`, profile.localPath, profile.token);
  if (!ok) {
    const conflictR = execGit('git diff --name-only --diff-filter=U', profile.localPath, profile.token);
    const conflictFiles = conflictR.ok && conflictR.output.trim() ? conflictR.output.trim().split('\n') : [];
    execGit('git cherry-pick --abort', profile.localPath, profile.token);
    if (conflictFiles.length > 0) {
      return success({
        command: 'CherryPick', status: 'conflict', commitHash: args.commitHash,
        conflictFiles,
        suggestions: [
          `git diff --check 查看具体冲突位置`,
          `手动解决冲突后执行: git add . && git cherry-pick --continue`,
          `放弃摘取: git cherry-pick --abort`
        ],
        rawOutput: output
      });
    }
    return error(`CherryPick 失败 (已自动 abort): ${output}`);
  }
  success({ command: 'CherryPick', commitHash: args.commitHash, output });
}

// --- Profile 管理 ---

function cmdProfileAdd(args) {
  if (!args.profileName) return error('ProfileAdd 需要 "profileName" 参数。');
  if (!args.localPath) return error('ProfileAdd 需要 "localPath" 参数。');
  const repos = loadRepos();
  if (repos.profiles[args.profileName]) return error(`Profile "${args.profileName}" 已存在。请用 ProfileEdit 修改。`);
  const newProfile = { localPath: path.resolve(args.localPath) };
  const fields = ['pushUrl', 'pushRemote', 'pushBranch', 'pullUrl', 'pullRemote', 'pullBranch', 'email', 'username', 'token', 'mergeStrategy'];
  for (const f of fields) {
    if (args[f]) newProfile[f] = args[f];
  }
  repos.profiles[args.profileName] = newProfile;
  if (!repos.defaultProfile) repos.defaultProfile = args.profileName;
  saveRepos(repos);

  // auto-configure git remotes
  const cwd = newProfile.localPath;
  if (fs.existsSync(cwd)) {
    if (newProfile.pushUrl) {
      execGit(`git remote set-url ${newProfile.pushRemote || 'origin'} ${newProfile.pushUrl}`, cwd, null);
    }
    if (newProfile.pullUrl) {
      const pullRemote = newProfile.pullRemote || 'upstream';
      const checkRemote = execGit(`git remote get-url ${pullRemote}`, cwd, null);
      if (!checkRemote.ok) {
        execGit(`git remote add ${pullRemote} ${newProfile.pullUrl}`, cwd, null);
      } else {
        execGit(`git remote set-url ${pullRemote} ${newProfile.pullUrl}`, cwd, null);
      }
    }
    if (newProfile.email) execGit(`git config user.email "${newProfile.email}"`, cwd, null);
    if (newProfile.username) execGit(`git config user.name "${newProfile.username}"`, cwd, null);

    // configure safe.directory
    execGit(`git config --global --add safe.directory ${cwd.replace(/\\/g, '/')}`, cwd, null);
  }

  success({ command: 'ProfileAdd', profileName: args.profileName, profile: { ...newProfile, token: newProfile.token ? '****' : undefined } });
}

function cmdProfileEdit(args) {
  if (!args.profileName) return error('ProfileEdit 需要 "profileName" 参数。');
  const repos = loadRepos();
  if (!repos.profiles[args.profileName]) return error(`Profile "${args.profileName}" 不存在。`);
  const profile = repos.profiles[args.profileName];
  const fields = ['localPath', 'pushUrl', 'pushRemote', 'pushBranch', 'pullUrl', 'pullRemote', 'pullBranch', 'email', 'username', 'token', 'mergeStrategy'];
  for (const f of fields) {
    if (args[f] !== undefined) {
      profile[f] = f === 'localPath' ? path.resolve(args[f]) : args[f];
    }
  }
  saveRepos(repos);
  success({ command: 'ProfileEdit', profileName: args.profileName, updated: Object.keys(args).filter(k => fields.includes(k)) });
}

function cmdProfileRemove(args) {
  if (!args.profileName) return error('ProfileRemove 需要 "profileName" 参数。');
  const repos = loadRepos();
  if (!repos.profiles[args.profileName]) return error(`Profile "${args.profileName}" 不存在。`);
  delete repos.profiles[args.profileName];
  if (repos.defaultProfile === args.profileName) repos.defaultProfile = Object.keys(repos.profiles)[0] || '';
  saveRepos(repos);
  success({ command: 'ProfileRemove', profileName: args.profileName });
}

// --- 指令分发 ---

async function dispatchCommand(command, args, repos, envConfig) {
  debugLog(`Dispatch: ${command} | args: ${JSON.stringify(args)}`);

  // 无需 profile 的指令
  const noProfileCmds = ['ProfileList', 'ProfileAdd', 'ProfileEdit', 'ProfileRemove', 'Clone'];
  if (noProfileCmds.includes(command)) {
    switch (command) {
      case 'ProfileList': return cmdProfileList(args, repos);
      case 'ProfileAdd': return cmdProfileAdd(args);
      case 'ProfileEdit': return cmdProfileEdit(args);
      case 'ProfileRemove': return cmdProfileRemove(args);
      case 'Clone': return cmdClone(args);
    }
  }

  // 需要 profile 的指令
  const resolved = resolveProfile(args, repos);
  if (resolved.error) return error(resolved.error);
  const { profileName, profile } = resolved;

  if (!validateWorkPath(profile.localPath, envConfig)) {
    return error(`安全限制: "${profile.localPath}" 不在允许的工作路径内。请检查 .env 的 PLUGIN_WORK_PATHS。`);
  }

  // 危险操作统一验证
  if (DANGEROUS_COMMANDS[command]) {
    const validation = await validateDangerousOperation(command, args, profileName);
    if (!validation.allowed) return error(validation.error);
  }

  switch (command) {
    case 'Status': return cmdStatus(args, profile, envConfig);
    case 'Log': return cmdLog(args, profile, envConfig);
    case 'Diff': return cmdDiff(args, profile, envConfig);
    case 'BranchList': return cmdBranchList(args, profile, envConfig);
    case 'RemoteInfo': return cmdRemoteInfo(args, profile, envConfig);
    case 'StashList': return cmdStashList(args, profile, envConfig);
    case 'TagList': return cmdTagList(args, profile, envConfig);
    case 'Add': return cmdAdd(args, profile, envConfig);
    case 'Commit': return cmdCommit(args, profile, envConfig);
    case 'Pull': return cmdPull(args, profile, envConfig);
    case 'Push': return cmdPush(args, profile, envConfig);
    case 'Fetch': return cmdFetch(args, profile, envConfig);
    case 'BranchCreate': return cmdBranchCreate(args, profile, envConfig);
    case 'Checkout': return cmdCheckout(args, profile, envConfig);
    case 'Merge': return cmdMerge(args, profile, envConfig);
    
    case 'ForcePush': { cmdForcePush(args, profile, envConfig); auditLog('ForcePush', profileName, 'EXECUTED'); return; }
    case 'ResetHard': { cmdResetHard(args, profile, envConfig); auditLog('ResetHard', profileName, 'EXECUTED', `target=${args.target || 'HEAD'}`); return; }
    case 'BranchDelete': { cmdBranchDelete(args, profile, envConfig); auditLog('BranchDelete', profileName, 'EXECUTED', `branch=${args.branchName}`); return; }
    case 'Rebase': { cmdRebase(args, profile, envConfig); auditLog('Rebase', profileName, 'EXECUTED', `onto=${args.onto}`); return; }
    case 'CherryPick': { cmdCherryPick(args, profile, envConfig); auditLog('CherryPick', profileName, 'EXECUTED', `commit=${args.commitHash}`); return; }
    default: return error(`未知指令: "${command}"。`);
  }
}

// --- 主入口 ---

function main() {
  let inputData = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { inputData += chunk; });
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(inputData.trim());

      const envConfig = loadEnvConfig();

      // 注入代理环境变量到当前进程，使子进程自动继承
      const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
      for (const key of proxyKeys) {
        if (envConfig[key]) {
          process.env[key] = envConfig[key];
          debugLog(`[Proxy] Injected env var: ${key}=${envConfig[key]}`);
        }
      }

      const repos = loadRepos();

      const serialCommands = parseSerialCommands(input);

      if (serialCommands.length === 0) {
        return error('未提供任何指令。');
      }

      if (serialCommands.length === 1) {
        // 单指令直接执行
        const { command, args } = serialCommands[0];
        await dispatchCommand(command, args, repos, envConfig);
      } else {
        // 串行执行多条指令
        const results = [];
        for (const { command, args } of serialCommands) {
          try {
            // 捕获 stdout
            const origLog = console.log;
            let captured = '';
            console.log = (msg) => { captured = msg; };
            await dispatchCommand(command, args, repos, envConfig);
            console.log = origLog;

            const parsed = JSON.parse(captured);
            results.push(parsed);

            if (parsed.status === 'error') {
              // 串行中遇到错误，中断后续指令
              results.push({ status: 'aborted', reason: `"${command}" 执行失败，后续指令已中止。` });
              break;
            }
          } catch (e) {
            results.push({ status: 'error', command, error: e.message });
            break;
          }
        }
        console.log(JSON.stringify({ status: 'success', result: { serialMode: true, totalCommands: serialCommands.length, executed: results.length, results } }));
      }
    } catch (e) {
      error(`输入解析失败: ${e.message}`);
    }
  });
}

main();