/**
 * GitSearch Plugin — GitLab REST API v4 适配器
 *
 * 提供14个统一命令（部分命令 GitLab 不支持，返回友好提示）。
 * 项目ID使用 URL-encoded path: encodeURIComponent(`${owner}/${repo}`)。
 * 使用 axios 进行 HTTP 请求，通过 process.env.GITLAB_TOKEN 认证。
 */

const axios = require('axios');
const { createProxyAgent } = require('./proxy');
const { truncate } = require('./utils');

// ── axios 客户端配置 ──
const gitlabUrl = (process.env.GITLAB_URL || 'https://gitlab.com').replace(/\/$/, '');
const agent = createProxyAgent(process.env.GITLAB_PROXY);
const client = axios.create({
  baseURL: `${gitlabUrl}/api/v4`,
  headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN },
  httpAgent: agent,
  httpsAgent: agent,
  proxy: false
});

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 获取 URL-encoded 项目路径（GitLab 的项目ID格式）
 */
function encodedPath(owner, repo) {
  return encodeURIComponent(`${owner}/${repo}`);
}

/**
 * 统一错误处理
 */
function handleError(error) {
  if (error.response) {
    const status = error.response.status;
    const msg = error.response.data?.message || error.response.data?.error || '';
    if (status === 404) {
      throw new Error('Resource not found. Check owner/repo names.');
    }
    if (status === 401) {
      throw new Error('Authentication failed. Check your GITLAB_TOKEN in config.env.');
    }
    if (status === 403) {
      throw new Error('Permission denied. Check your GITLAB_TOKEN scope or project visibility.');
    }
    if (status === 429) {
      const retryAfter = error.response.headers?.['retry-after'] || 'unknown';
      throw new Error(`Rate limit exceeded. Retry after ${retryAfter} seconds.`);
    }
    throw new Error(`API error (${status}): ${msg || 'Unknown error'}`);
  }
  if (error.request) {
    throw new Error(`Network error: ${error.message}`);
  }
  throw new Error(`Error: ${error.message}`);
}

/**
 * 格式化日期为 YYYY-MM-DD HH:mm
 */
function formatDate(isoString) {
  if (!isoString) return 'N/A';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 验证必需参数
 */
function requireParam(params, name) {
  if (params[name] === undefined || params[name] === null || params[name] === '') {
    throw new Error(`Missing required parameter: ${name}`);
  }
}

/**
 * GitLab state 参数映射
 * issue state: open→opened, closed→closed, all→全部
 * MR state: open→opened, closed→closed, merged→merged, all→all
 */
function mapGitLabState(state, forIssue = false) {
  if (!state || state === 'all') return forIssue ? undefined : 'all';
  if (state === 'open') return 'opened';
  if (state === 'closed') return 'closed';
  if (state === 'merged') return 'merged';
  return state;
}

// ═══════════════════════════════════════════════════════════
// 命令实现
// ═══════════════════════════════════════════════════════════

/**
 * repo_get — 获取项目信息
 * GET /projects/{url-encoded-path}
 */
async function repo_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const { data } = await client.get(`/projects/${id}`);

    const md = [
      `### Project: ${data.name}`,
      '',
      `- **Description:** ${data.description || 'N/A'}`,
      `- **URL:** [${data.web_url}](${data.web_url})`,
      `- **Namespace:** ${data.namespace?.full_path || params.repo_owner}`,
      `- **Stars:** ${data.star_count || 0} ⭐`,
      `- **Forks:** ${data.forks_count || 0}`,
      `- **Default Branch:** \`${data.default_branch || 'N/A'}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Last Activity:** ${formatDate(data.last_activity_at)}`,
      `- **Topics:** ${(data.topics && data.topics.length) ? data.topics.join(', ') : 'N/A'}`,
      `- **Visibility:** ${data.visibility || 'N/A'}`,
      `- **Archived:** ${data.archived ? '✅ Yes' : '❌ No'}`,
      `- **ID:** ${data.id}`
    ].join('\n');

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_files — 获取文件内容或目录列表
 * 文件: GET /projects/{id}/repository/files/{encodedPath}/raw?ref=
 * 目录: GET /projects/{id}/repository/tree?path=&ref=
 */
async function repo_list_files(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const path = params.path || '';
    const ref = params.ref || '';

    // 如果 path 为空或末尾没有扩展名，先尝试目录列表
    // 如果明确请求文件（path有扩展名），先尝试文件内容
    const looksLikeFile = path && path.includes('.') && !path.endsWith('/');

    if (looksLikeFile) {
      // 尝试获取文件内容
      try {
        const encodedFilePath = encodeURIComponent(path);
        const { data } = await client.get(
          `/projects/${id}/repository/files/${encodedFilePath}/raw`,
          { params: ref ? { ref } : {} }
        );

        // raw 文件内容直接返回字符串
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        const ext = path.split('.').pop() || '';
        let md = [
          `### File: \`${path}\``,
          '',
          `- **Project:** ${params.repo_owner}/${params.repo_name}`,
          `- **Branch:** \`${ref || 'default'}\``,
          '',
          '```' + ext,
          content,
          '```'
        ].join('\n');
        return truncate(md);
      } catch (fileError) {
        // 如果文件请求失败（404），回退到目录列表
        if (fileError.response && fileError.response.status === 404) {
          // 回退到目录请求（path 可能是目录名）
        } else {
          throw fileError;
        }
      }
    }

    // 目录列表
    const qs = {};
    if (path) qs.path = path;
    if (ref) qs.ref = ref;

    const { data } = await client.get(
      `/projects/${id}/repository/tree`,
      { params: qs }
    );

    let md = `### Directory: \`${path || 'root'}\`\n\n`;
    md += `| Name | Type | Path |\n`;
    md += `|------|------|------|\n`;
    for (const item of data) {
      const type = item.type === 'blob' ? 'file' : (item.type === 'tree' ? 'directory' : item.type);
      md += `| \`${item.name}\` | ${type} | \`${item.path}\` |\n`;
    }
    md += `\n*Total: ${data.length} items*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_branches — 列出分支
 * GET /projects/{id}/repository/branches?page=&per_page=
 */
async function repo_list_branches(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const page = params.page || 1;
    const per_page = params.per_page || 30;

    const { data } = await client.get(
      `/projects/${id}/repository/branches`,
      { params: { page, per_page } }
    );

    let md = `### Branches: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| Branch | Commit (short) | Protected | Default |\n`;
    md += `|--------|----------------|-----------|---------|\n`;
    for (const b of data) {
      const sha = b.commit?.short_id || b.commit?.id?.slice(0, 7) || 'N/A';
      md += `| \`${b.name}\` | \`${sha}\` | ${b.protected ? '✅' : '❌'} | ${b.default ? '✅' : '❌'} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} branches*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_commits — 列出提交历史
 * GET /projects/{id}/repository/commits?ref_name=&path=&since=&until=&page=&per_page=
 */
async function repo_list_commits(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const qs = {};
    if (params.sha || params.ref) qs.ref_name = params.sha || params.ref;
    if (params.path) qs.path = params.path;
    if (params.since) qs.since = params.since;
    if (params.until) qs.until = params.until;
    qs.page = params.page || 1;
    qs.per_page = params.per_page || 30;

    const { data } = await client.get(
      `/projects/${id}/repository/commits`,
      { params: qs }
    );

    let md = `### Commits: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| SHA | Message | Author | Date |\n`;
    md += `|-----|---------|--------|------|\n`;
    for (const c of data) {
      const sha = c.short_id || c.id?.slice(0, 7) || 'N/A';
      const msg = (c.title || c.message || '').split('\n')[0].slice(0, 60);
      const author = c.author_name || c.author?.name || 'N/A';
      const date = formatDate(c.authored_date || c.created_at);
      md += `| \`${sha}\` | ${msg} | ${author} | ${date} |\n`;
    }
    md += `\n*Page ${qs.page}, showing ${data.length} commits*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_search_code — GitLab 不支持全局代码搜索
 */
async function repo_search_code(params) {
  requireParam(params, 'query');
  return `> **Command \_SEARCH\_CODE\_** is not supported on GitLab.\n\n` +
    `GitLab does not support global code search via REST API.\n\n` +
    `**Suggested alternative:** Use \`repo\_list\_files\` to browse repository files, ` +
    `then use \`repo\_list\_files\` with specific file paths to inspect content.`;
}

/**
 * repo_list_releases — 列出 Releases
 * GET /projects/{id}/releases?page=&per_page=
 */
async function repo_list_releases(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const page = params.page || 1;
    const per_page = params.per_page || 30;

    const { data } = await client.get(
      `/projects/${id}/releases`,
      { params: { page, per_page } }
    );

    let md = `### Releases: ${params.repo_owner}/${params.repo_name}\n\n`;

    if (!data || data.length === 0) {
      md += '*No releases found.*';
      return md;
    }

    md += `| Tag | Name | Created |\n`;
    md += `|-----|------|---------|\n`;
    for (const r of data) {
      md += `| \`${r.tag_name}\` | ${r.name || 'N/A'} | ${formatDate(r.created_at)} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} releases*\n\n`;

    // 详细信息
    md += `#### Details\n\n`;
    for (const r of data) {
      md += `##### ${r.name || r.tag_name}\n`;
      md += `- **Tag:** \`${r.tag_name}\`\n`;
      md += `- **URL:** [Release Page](${r._links?.self || '#no-link'})\n`;
      md += `- **Author:** ${r.author?.name || r.author?.username || 'N/A'}\n`;
      md += `- **Created:** ${formatDate(r.created_at)}\n`;
      if (r.description) {
        const bodyPreview = r.description.length > 200 ? r.description.slice(0, 200) + '...' : r.description;
        md += `- **Description:** ${bodyPreview}\n`;
      }
      md += '\n';
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_list — 列出 Issues
 * GET /projects/{id}/issues?state=&page=&per_page=
 */
async function issue_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = mapGitLabState(params.state, true);

    const qs = { page, per_page };
    if (state) qs.state = state;

    const { data } = await client.get(
      `/projects/${id}/issues`,
      { params: qs }
    );

    let md = `### Issues: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `**State:** ${state || 'all'}  ·  **Count:** ${data.length}\n\n`;

    if (!data || data.length === 0) {
      md += '*No issues found.*';
      return md;
    }

    md += `| # | Title | State | Author | Created | Comments |\n`;
    md += `|---|-------|-------|--------|---------|----------|\n`;
    for (const issue of data) {
      const title = (issue.title || '').replace(/\|/g, '\\|').slice(0, 50);
      const author = issue.author?.username || issue.author?.name || 'N/A';
      md += `| #${issue.iid} | [${title}](${issue.web_url}) | ${issue.state} | ${author} | ${formatDate(issue.created_at)} | ${issue.user_notes_count || 0} |\n`;
    }
    md += `\n*Page ${page}*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_get — 获取 Issue 详情
 * GET /projects/{id}/issues/{iid}
 */
async function issue_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'issue_number');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const { data } = await client.get(
      `/projects/${id}/issues/${params.issue_number}`
    );

    const labels = (data.labels || []).join(', ') || 'N/A';

    let md = [
      `### Issue #${data.iid}: ${data.title}`,
      '',
      `- **Project:** ${params.repo_owner}/${params.repo_name}`,
      `- **State:** ${data.state}`,
      `- **Author:** ${data.author?.username || data.author?.name || 'N/A'}`,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Comments:** ${data.user_notes_count || 0}`,
      `- **Labels:** ${labels}`,
      `- **URL:** [View in GitLab](${data.web_url})`,
      `- **Assignees:** ${(data.assignees || []).map(a => a.username || a.name).join(', ') || 'N/A'}`,
      `- **Confidential:** ${data.confidential ? '✅ Yes' : '❌ No'}`,
      ''
    ].join('\n');

    if (data.description) {
      md += `#### Description\n\n${data.description}\n`;
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_search — GitLab 不支持通过搜索API搜索issues
 */
async function issue_search(params) {
  requireParam(params, 'query');
  return `> **Command \_SEARCH\_ISSUES\_** is not supported on GitLab.\n\n` +
    `GitLab does not provide a unified search API for cross-project issue search via REST.\n\n` +
    `**Suggested alternative:** Use \`issue\_list\` to list issues within a specific project.`;
}

/**
 * pr_list — 列出 Merge Requests
 * GET /projects/{id}/merge_requests?state=&page=&per_page=
 */
async function pr_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = mapGitLabState(params.state);

    const qs = { page, per_page };
    if (state && state !== 'all') qs.state = state;

    const { data } = await client.get(
      `/projects/${id}/merge_requests`,
      { params: qs }
    );

    let md = `### Merge Requests: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `**State:** ${state || 'all'}  ·  **Count:** ${data.length}\n\n`;

    if (!data || data.length === 0) {
      md += '*No merge requests found.*';
      return md;
    }

    md += `| # | Title | State | Author | Branch → Target | Created |\n`;
    md += `|---|-------|-------|--------|-----------------|---------|\n`;
    for (const mr of data) {
      const title = (mr.title || '').replace(/\|/g, '\\|').slice(0, 40);
      const branchInfo = `\`${mr.source_branch}\` → \`${mr.target_branch}\``;
      const author = mr.author?.username || mr.author?.name || 'N/A';
      md += `| !${mr.iid} | [${title}](${mr.web_url}) | ${mr.state} | ${author} | ${branchInfo} | ${formatDate(mr.created_at)} |\n`;
    }
    md += `\n*Page ${page}*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * pr_get — 获取 Merge Request 详情
 * GET /projects/{id}/merge_requests/{iid}
 */
async function pr_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'pr_number');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const { data } = await client.get(
      `/projects/${id}/merge_requests/${params.pr_number}`
    );

    let md = [
      `### Merge Request !${data.iid}: ${data.title}`,
      '',
      `- **Project:** ${params.repo_owner}/${params.repo_name}`,
      `- **State:** ${data.state}`,
      `- **Author:** ${data.author?.username || data.author?.name || 'N/A'}`,
      `- **Branch:** \`${data.source_branch}\` → \`${data.target_branch}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Merged:** ${data.state === 'merged' ? '✅' : '❌'}`,
      `- **Merge Status:** ${data.merge_status || 'N/A'}`,
      `- **Commits:** ${data.user_notes_count || 0} notes`,
      `- **URL:** [View in GitLab](${data.web_url})`,
      ''
    ].join('\n');

    if (data.description) {
      md += `#### Description\n\n${data.description}\n`;
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * pr_get_diff — 获取 MR 的变更文件列表
 * GET /projects/{id}/merge_requests/{iid}/diffs?page=&per_page=
 */
async function pr_get_diff(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'pr_number');

    const id = encodedPath(params.repo_owner, params.repo_name);
    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get(
      `/projects/${id}/merge_requests/${params.pr_number}/diffs`,
      { params: { page, per_page } }
    );

    let md = `### MR !${params.pr_number} — Changed Files\n\n`;

    if (!data || data.length === 0) {
      md += '*No file changes found.*';
      return md;
    }

    md += `**Files changed:** ${data.length}\n\n`;

    md += `| Old Path | New Path | New File | Deleted |\n`;
    md += `|----------|----------|----------|---------|\n`;
    for (const diff of data) {
      md += `| \`${diff.old_path}\` | \`${diff.new_path}\` | ${diff.new_file ? '✅' : '❌'} | ${diff.deleted_file ? '✅' : '❌'} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} files*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * user_get_me — GitLab 不支持此命令
 */
async function user_get_me(params) {
  return `> **Command \_USER\_GET\_ME\_** is not supported on GitLab.\n\n` +
    `This plugin does not support retrieving the authenticated user profile from GitLab.\n\n` +
    `**Note:** You can verify your GITLAB_TOKEN by running \`repo\_get\` on an accessible project.`;
}

/**
 * user_search — 搜索用户
 * GET /users?search={query}&page=&per_page=
 */
async function user_search(params) {
  try {
    requireParam(params, 'query');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get('/users', {
      params: { search: params.query, page, per_page }
    });

    let md = `### User Search Results\n\n`;
    md += `**Query:** \`${params.query}\`  ·  **Results:** ${data.length}\n\n`;

    if (!data || data.length === 0) {
      md += '*No users found.*';
      return md;
    }

    md += `| Username | Name | ID | State |\n`;
    md += `|----------|------|----|-------|\n`;
    for (const user of data) {
      md += `| ${user.username || 'N/A'} | ${user.name || 'N/A'} | ${user.id} | ${user.state || 'N/A'} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} users*\n\n`;

    // 补充信息
    md += `#### Details\n\n`;
    for (const user of data) {
      md += `- **${user.username}** (${user.name || 'no display name'})`;
      if (user.web_url || user.html_url) {
        md += ` — [Profile](${user.web_url || user.html_url})`;
      }
      md += '\n';
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

// ═══════════════════════════════════════════════════════════
// 导出模块
// ═══════════════════════════════════════════════════════════

module.exports = {
  repo_get,
  repo_list_files,
  repo_list_branches,
  repo_list_commits,
  repo_search_code,
  repo_list_releases,
  issue_list,
  issue_get,
  issue_search,
  pr_list,
  pr_get,
  pr_get_diff,
  user_get_me,
  user_search
};
