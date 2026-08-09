/**
 * GitSearch Plugin — GitHub REST API v3 适配器
 *
 * 提供14个统一命令，将 GitHub API 响应格式化为 markdown 字符串。
 * 使用 axios 进行 HTTP 请求，通过 process.env.GITHUB_TOKEN 认证。
 */

const axios = require('axios');
const { createProxyAgent } = require('./proxy');
const { truncate } = require('./utils');

// ── axios 客户端配置 ──
const headers = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'GitSearch-VCP-Plugin'
};
if (process.env.GITHUB_TOKEN) {
  headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
}
const agent = createProxyAgent(process.env.GITHUB_PROXY);
const client = axios.create({
  baseURL: 'https://api.github.com',
  headers,
  httpAgent: agent,
  httpsAgent: agent,
  proxy: false
});

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 统一错误处理：根据 HTTP 状态码返回清晰的错误消息
 */
function handleError(error) {
  if (error.response) {
    const status = error.response.status;
    const msg = error.response.data?.message || '';
    if (status === 404) {
      throw new Error('Resource not found. Check owner/repo names.');
    }
    if (status === 401 || status === 403) {
      throw new Error('Authentication failed. Check your GITHUB_TOKEN in config.env.');
    }
    if (status === 422) {
      throw new Error(`Validation failed (422): ${msg}`);
    }
    if (status === 429 || status === 403 && msg.includes('rate limit')) {
      const reset = error.response.headers?.['x-ratelimit-reset'];
      const retryAfter = error.response.headers?.['retry-after'];
      const waitSec = retryAfter || (reset ? Math.ceil((reset * 1000 - Date.now()) / 1000) : 'unknown');
      throw new Error(`Rate limit exceeded. Retry after ${waitSec} seconds.`);
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

// ═══════════════════════════════════════════════════════════
// 命令实现
// ═══════════════════════════════════════════════════════════

/**
 * repo_get — 获取仓库信息
 * GET /repos/{owner}/{repo}
 */
async function repo_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const { data } = await client.get(`/repos/${params.repo_owner}/${params.repo_name}`);

    const md = [
      `### Repository: ${data.full_name}`,
      '',
      `- **Description:** ${data.description || 'N/A'}`,
      `- **URL:** [${data.html_url}](${data.html_url})`,
      `- **Language:** ${data.language || 'N/A'}`,
      `- **Stars:** ${data.stargazers_count || 0} ⭐`,
      `- **Forks:** ${data.forks_count || 0}`,
      `- **Open Issues:** ${data.open_issues_count || 0}`,
      `- **Default Branch:** \`${data.default_branch}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Topics:** ${(data.topics && data.topics.length) ? data.topics.join(', ') : 'N/A'}`,
      `- **License:** ${data.license?.name || 'N/A'}`,
      `- **Visibility:** ${data.visibility || (data.private ? 'private' : 'public')}`
    ].join('\n');

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_files — 获取文件内容或目录列表
 * GET /repos/{owner}/{repo}/contents/{path}?ref={ref}
 */
async function repo_list_files(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const path = params.path || '';
    const ref = params.ref || '';
    const url = `/repos/${params.repo_owner}/${params.repo_name}/contents/${path}`;
    const { data } = await client.get(url, { params: ref ? { ref } : {} });

    // 如果是文件（返回对象而非数组）
    if (!Array.isArray(data)) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const lang = data.name.split('.').pop() || '';
      let md = [
        `### File: \`${data.path}\``,
        '',
        `- **Size:** ${data.size} bytes`,
        `- **SHA:** \`${data.sha}\``,
        `- **URL:** [View on GitHub](${data.html_url})`,
        '',
        '```' + lang,
        content,
        '```'
      ].join('\n');
      return truncate(md);
    }

    // 如果是目录（返回数组）
    let md = `### Directory: \`${path || 'root'}\`\n\n`;
    md += `| Name | Type | Size | Path |\n`;
    md += `|------|------|------|------|\n`;
    for (const item of data) {
      const size = item.type === 'file' ? item.size : '-';
      md += `| \`${item.name}\` | ${item.type} | ${size} | \`${item.path}\` |\n`;
    }
    md += `\n*Total: ${data.length} items*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_branches — 列出分支
 * GET /repos/{owner}/{repo}/branches?page=&per_page=
 */
async function repo_list_branches(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = params.per_page || 30;

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/branches`,
      { params: { page, per_page } }
    );

    let md = `### Branches: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| Branch | Commit SHA | Protected |\n`;
    md += `|--------|------------|-----------|\n`;
    for (const b of data) {
      md += `| \`${b.name}\` | \`${b.commit?.sha?.slice(0, 7) || 'N/A'}\` | ${b.protected ? '✅' : '❌'} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} branches*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_commits — 列出提交历史
 * GET /repos/{owner}/{repo}/commits?sha=&path=&since=&until=&page=&per_page=
 */
async function repo_list_commits(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const qs = {};
    if (params.sha || params.ref) qs.sha = params.sha || params.ref;
    if (params.path) qs.path = params.path;
    if (params.since) qs.since = params.since;
    if (params.until) qs.until = params.until;
    qs.page = params.page || 1;
    qs.per_page = params.per_page || 30;

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/commits`,
      { params: qs }
    );

    let md = `### Commits: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| SHA | Message | Author | Date |\n`;
    md += `|-----|---------|--------|------|\n`;
    for (const c of data) {
      const sha = c.sha?.slice(0, 7) || 'N/A';
      const msg = (c.commit?.message || '').split('\n')[0].slice(0, 60);
      const author = c.commit?.author?.name || 'N/A';
      const date = formatDate(c.commit?.author?.date);
      md += `| \`${sha}\` | ${msg} | ${author} | ${date} |\n`;
    }
    md += `\n*Page ${qs.page}, showing ${data.length} commits*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_search_code — 搜索代码
 * GET /search/code?q={query}&page=&per_page=
 */
async function repo_search_code(params) {
  try {
    requireParam(params, 'query');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get('/search/code', {
      params: { q: params.query, page, per_page }
    });

    let md = `### Code Search Results\n\n`;
    md += `**Query:** \`${params.query}\`  ·  **Total:** ${data.total_count}\n\n`;

    if (!data.items || data.items.length === 0) {
      md += '*No results found.*';
      return md;
    }

    md += `| Repository | File | Path | Language |\n`;
    md += `|------------|------|------|----------|\n`;
    for (const item of data.items) {
      const repo = item.repository?.full_name || 'N/A';
      const file = item.name || 'N/A';
      const path = item.path || 'N/A';
      const lang = item.language || 'N/A';
      md += `| ${repo} | \`${file}\` | \`${path}\` | ${lang} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.items.length} of ${data.total_count} results*\n\n`;

    // 列出每个结果的链接
    md += `#### Links\n`;
    for (const item of data.items) {
      md += `- [\`${item.path}\`](${item.html_url}) in ${item.repository?.full_name}\n`;
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_releases — 列出 Releases
 * GET /repos/{owner}/{repo}/releases?page=&per_page=
 */
async function repo_list_releases(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = params.per_page || 30;

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/releases`,
      { params: { page, per_page } }
    );

    let md = `### Releases: ${params.repo_owner}/${params.repo_name}\n\n`;

    if (!data || data.length === 0) {
      md += '*No releases found.*';
      return md;
    }

    md += `| Tag | Name | Draft | Prerelease | Published |\n`;
    md += `|-----|------|-------|------------|-----------|\n`;
    for (const r of data) {
      md += `| \`${r.tag_name}\` | ${r.name || 'N/A'} | ${r.draft ? '✅' : '❌'} | ${r.prerelease ? '✅' : '❌'} | ${formatDate(r.published_at)} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} releases*\n\n`;

    // 详细信息
    md += `#### Details\n\n`;
    for (const r of data) {
      md += `##### ${r.name || r.tag_name}\n`;
      md += `- **Tag:** \`${r.tag_name}\`\n`;
      md += `- **URL:** [Release Page](${r.html_url})\n`;
      md += `- **Author:** ${r.author?.login || 'N/A'}\n`;
      md += `- **Published:** ${formatDate(r.published_at)}\n`;
      if (r.body) {
        const bodyPreview = r.body.length > 200 ? r.body.slice(0, 200) + '...' : r.body;
        md += `- **Notes:** ${bodyPreview}\n`;
      }
      md += '\n';
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_list — 列出 Issues（过滤掉 PR）
 * GET /repos/{owner}/{repo}/issues?state=&page=&per_page=
 */
async function issue_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = params.state || 'open';

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/issues`,
      { params: { state, page, per_page } }
    );

    // 过滤掉 Pull Request（GitHub 在 issues 列表中会包含 PR）
    const issues = data.filter(item => !item.pull_request);

    let md = `### Issues: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `**State:** ${state}  ·  **Count:** ${issues.length} (filtered out ${data.length - issues.length} PRs)\n\n`;

    if (issues.length === 0) {
      md += '*No issues found.*';
      return md;
    }

    md += `| # | Title | State | Author | Created | Comments |\n`;
    md += `|---|-------|-------|--------|---------|----------|\n`;
    for (const issue of issues) {
      const title = (issue.title || '').replace(/\|/g, '\\|').slice(0, 50);
      md += `| #${issue.number} | [${title}](${issue.html_url}) | ${issue.state} | ${issue.user?.login || 'N/A'} | ${formatDate(issue.created_at)} | ${issue.comments} |\n`;
    }
    md += `\n*Page ${page}*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_get — 获取 Issue 详情
 * GET /repos/{owner}/{repo}/issues/{number}
 */
async function issue_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'issue_number');

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/issues/${params.issue_number}`
    );

    const labels = (data.labels || []).map(l => l.name).join(', ') || 'N/A';

    let md = [
      `### Issue #${data.number}: ${data.title}`,
      '',
      `- **Repository:** ${params.repo_owner}/${params.repo_name}`,
      `- **State:** ${data.state}`,
      `- **Author:** ${data.user?.login || 'N/A'}`,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Comments:** ${data.comments || 0}`,
      `- **Labels:** ${labels}`,
      `- **URL:** [View on GitHub](${data.html_url})`,
      `- **Assignees:** ${(data.assignees || []).map(a => a.login).join(', ') || 'N/A'}`,
      ''
    ].join('\n');

    if (data.body) {
      md += `#### Description\n\n${data.body}\n`;
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_search — 搜索 Issues
 * GET /search/issues?q={query}&page=&per_page=
 */
async function issue_search(params) {
  try {
    requireParam(params, 'query');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get('/search/issues', {
      params: { q: params.query, page, per_page }
    });

    let md = `### Issue Search Results\n\n`;
    md += `**Query:** \`${params.query}\`  ·  **Total:** ${data.total_count}\n\n`;

    if (!data.items || data.items.length === 0) {
      md += '*No results found.*';
      return md;
    }

    md += `| # | Title | State | Repository | Created | Comments |\n`;
    md += `|---|-------|-------|------------|---------|----------|\n`;
    for (const issue of data.items) {
      const repo = issue.repository_url?.split('/').slice(-2).join('/') || 'N/A';
      const title = (issue.title || '').replace(/\|/g, '\\|').slice(0, 40);
      md += `| #${issue.number} | [${title}](${issue.html_url}) | ${issue.state} | ${repo} | ${formatDate(issue.created_at)} | ${issue.comments} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.items.length} of ${data.total_count} results*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * pr_list — 列出 Pull Requests
 * GET /repos/{owner}/{repo}/pulls?state=&page=&per_page=
 */
async function pr_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = params.state || 'open';

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/pulls`,
      { params: { state, page, per_page } }
    );

    let md = `### Pull Requests: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `**State:** ${state}  ·  **Count:** ${data.length}\n\n`;

    if (!data || data.length === 0) {
      md += '*No pull requests found.*';
      return md;
    }

    md += `| # | Title | State | Author | Branch → Base | Created |\n`;
    md += `|---|-------|-------|--------|---------------|---------|\n`;
    for (const pr of data) {
      const title = (pr.title || '').replace(/\|/g, '\\|').slice(0, 40);
      const branchInfo = `\`${pr.head?.ref}\` → \`${pr.base?.ref}\``;
      md += `| #${pr.number} | [${title}](${pr.html_url}) | ${pr.state} | ${pr.user?.login || 'N/A'} | ${branchInfo} | ${formatDate(pr.created_at)} |\n`;
    }
    md += `\n*Page ${page}*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * pr_get — 获取 PR 详情
 * GET /repos/{owner}/{repo}/pulls/{number}
 */
async function pr_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'pr_number');

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/pulls/${params.pr_number}`
    );

    let md = [
      `### Pull Request #${data.number}: ${data.title}`,
      '',
      `- **Repository:** ${params.repo_owner}/${params.repo_name}`,
      `- **State:** ${data.state}`,
      `- **Author:** ${data.user?.login || 'N/A'}`,
      `- **Branch:** \`${data.head?.ref}\` → \`${data.base?.ref}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Merged:** ${data.merged ? '✅' : '❌'}`,
      `- **Mergeable:** ${data.mergeable === null ? 'Unknown' : (data.mergeable ? '✅ Yes' : '❌ Conflicts')}`,
      `- **Commits:** ${data.commits || 0} | **Additions:** ${data.additions || 0} | **Deletions:** ${data.deletions || 0}`,
      `- **URL:** [View on GitHub](${data.html_url})`,
      ''
    ].join('\n');

    if (data.body) {
      md += `#### Description\n\n${data.body}\n`;
    }

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * pr_get_diff — 获取 PR 变更文件列表
 * GET /repos/{owner}/{repo}/pulls/{number}/files?page=&per_page=
 */
async function pr_get_diff(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'pr_number');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/pulls/${params.pr_number}/files`,
      { params: { page, per_page } }
    );

    let md = `### PR #${params.pr_number} — Changed Files\n\n`;

    if (!data || data.length === 0) {
      md += '*No file changes found.*';
      return md;
    }

    // 汇总统计
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of data) {
      totalAdditions += f.additions || 0;
      totalDeletions += f.deletions || 0;
    }
    md += `**Files changed:** ${data.length}  ·  **Additions:** +${totalAdditions}  ·  **Deletions:** -${totalDeletions}\n\n`;

    md += `| File | Status | Additions | Deletions |\n`;
    md += `|------|--------|-----------|-----------|\n`;
    for (const f of data) {
      const statusMap = { added: '➕', removed: '➖', modified: '✏️', renamed: '🔀' };
      const icon = statusMap[f.status] || f.status;
      md += `| \`${f.filename}\` | ${icon} ${f.status} | +${f.additions || 0} | -${f.deletions || 0} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} files*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * user_get_me — 获取当前认证用户信息
 * GET /user
 */
async function user_get_me(params) {
  try {
    const { data } = await client.get('/user');

    let md = [
      `### Authenticated User`,
      '',
      `- **Login:** ${data.login}`,
      `- **Name:** ${data.name || 'N/A'}`,
      `- **ID:** ${data.id}`,
      `- **Profile:** [${data.html_url}](${data.html_url})`,
      `- **Bio:** ${data.bio || 'N/A'}`,
      `- **Company:** ${data.company || 'N/A'}`,
      `- **Location:** ${data.location || 'N/A'}`,
      `- **Email:** ${data.email || 'N/A'}`,
      `- **Blog:** ${data.blog || 'N/A'}`,
      `- **Public Repos:** ${data.public_repos || 0}`,
      `- **Followers:** ${data.followers || 0} | **Following:** ${data.following || 0}`,
      `- **Created:** ${formatDate(data.created_at)}`
    ].join('\n');

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * user_search — 搜索用户
 * GET /search/users?q={query}&page=&per_page=
 */
async function user_search(params) {
  try {
    requireParam(params, 'query');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get('/search/users', {
      params: { q: params.query, page, per_page }
    });

    let md = `### User Search Results\n\n`;
    md += `**Query:** \`${params.query}\`  ·  **Total:** ${data.total_count}\n\n`;

    if (!data.items || data.items.length === 0) {
      md += '*No users found.*';
      return md;
    }

    md += `| Login | Type | Profile |\n`;
    md += `|-------|------|---------|\n`;
    for (const user of data.items) {
      md += `| [${user.login}](${user.html_url}) | ${user.type} | [Profile](${user.html_url}) |\n`;
    }
    md += `\n*Page ${page}, showing ${data.items.length} of ${data.total_count} results*`;

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
