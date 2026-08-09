/**
 * GitSearch Plugin — Gitee REST API v5 适配器
 *
 * 提供14个统一命令（部分命令 Gitee 不支持，返回友好提示）。
 * Token 通过 query parameter ?access_token=TOKEN 传递。
 * 使用 axios 进行 HTTP 请求。
 */

const axios = require('axios');
const { createProxyAgent } = require('./proxy');
const { truncate } = require('./utils');

// ── axios 客户端配置 ──
const agent = createProxyAgent(process.env.GITEE_PROXY);
const client = axios.create({
  baseURL: 'https://gitee.com/api/v5',
  headers: { 'User-Agent': 'GitSearch-VCP-Plugin' },
  httpAgent: agent,
  httpsAgent: agent,
  proxy: false
});

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 统一错误处理
 */
function handleError(error) {
  if (error.response) {
    const status = error.response.status;
    // Gitee 的错误响应格式: { message: '...' }
    const msg = error.response.data?.message || error.response.data?.error || '';
    if (status === 404) {
      throw new Error('Resource not found. Check owner/repo names.');
    }
    if (status === 401 || status === 403) {
      throw new Error('Authentication failed. Check your GITEE_TOKEN in config.env.');
    }
    if (status === 422) {
      throw new Error(`Validation failed (422): ${msg}`);
    }
    if (status === 429 || status === 403) {
      const retryAfter = error.response.headers?.['retry-after'];
      throw new Error(`Rate limit exceeded.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Please retry later.'}`);
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
 * 获取带 access_token 的请求参数
 * Gitee 需要在每个请求的 query params 中附加 access_token
 */
function withToken(extraParams = {}) {
  const token = process.env.GITEE_TOKEN;
  const params = { ...extraParams };
  if (token) {
    params.access_token = token;
  }
  return params;
}

// ═══════════════════════════════════════════════════════════
// 命令实现
// ═══════════════════════════════════════════════════════════

/**
 * repo_get — 获取仓库信息
 * GET /repos/{owner}/{repo}?access_token={token}
 */
async function repo_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}`,
      { params: withToken() }
    );

    const md = [
      `### Repository: ${data.full_name || data.path_with_namespace || params.repo_owner + '/' + params.repo_name}`,
      '',
      `- **Description:** ${data.description || 'N/A'}`,
      `- **URL:** [${data.html_url}](${data.html_url})`,
      `- **Language:** ${data.language || 'N/A'}`,
      `- **Stars:** ${data.stargazers_count || data.stars_count || 0} ⭐`,
      `- **Forks:** ${data.forks_count || 0}`,
      `- **Open Issues:** ${data.open_issues_count || 0}`,
      `- **Default Branch:** \`${data.default_branch || 'N/A'}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Owner:** ${data.owner?.login || data.owner?.name || 'N/A'}`,
      `- **Private:** ${data.private ? '✅ Yes' : '❌ No'}`
    ].join('\n');

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_files — 获取文件内容或目录列表
 * GET /repos/{owner}/{repo}/contents/{path}?ref={ref}&access_token={token}
 */
async function repo_list_files(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const path = params.path || '';
    const ref = params.ref || '';

    const qs = withToken();
    if (ref) qs.ref = ref;

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/contents/${path}`,
      { params: qs }
    );

    // 如果是文件（返回对象，包含content字段）
    if (!Array.isArray(data)) {
      const content = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '(empty file)';
      const lang = data.name ? (data.name.split('.').pop() || '') : '';
      let md = [
        `### File: \`${data.path}\``,
        '',
        `- **Size:** ${data.size || 0} bytes`,
        `- **SHA:** \`${data.sha || 'N/A'}\``,
        `- **URL:** [View on Gitee](${data.html_url})`,
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
      const size = item.type === 'file' ? (item.size || 0) : '-';
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
 * GET /repos/{owner}/{repo}/branches?page=&per_page=&access_token={token}
 */
async function repo_list_branches(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/branches`,
      { params: withToken({ page, per_page }) }
    );

    let md = `### Branches: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| Branch | Protected |\n`;
    md += `|--------|-----------|\n`;
    for (const b of data) {
      md += `| \`${b.name}\` | ${b.protected ? '✅' : '❌'} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} branches*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_list_commits — 列出提交历史
 * GET /repos/{owner}/{repo}/commits?sha=&path=&since=&until=&page=&per_page=&access_token={token}
 */
async function repo_list_commits(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const qs = withToken();
    if (params.sha || params.ref) qs.sha = params.sha || params.ref;
    if (params.path) qs.path = params.path;
    if (params.since) qs.since = params.since;
    if (params.until) qs.until = params.until;
    qs.page = params.page || 1;
    qs.per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/commits`,
      { params: qs }
    );

    let md = `### Commits: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `| SHA | Message | Author | Date |\n`;
    md += `|-----|---------|--------|------|\n`;
    for (const c of data) {
      const sha = c.sha ? c.sha.slice(0, 7) : 'N/A';
      const msg = (c.commit?.message || c.message || '').split('\n')[0].slice(0, 60);
      const author = c.commit?.author?.name || c.author?.login || c.author?.name || 'N/A';
      const date = formatDate(c.commit?.author?.date || c.created_at || c.authored_date);
      md += `| \`${sha}\` | ${msg} | ${author} | ${date} |\n`;
    }
    md += `\n*Page ${qs.page}, showing ${data.length} commits*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * repo_search_code — Gitee 不支持代码搜索
 */
async function repo_search_code(params) {
  requireParam(params, 'query');
  return `> **Command \_SEARCH\_CODE\_** is not supported on Gitee.\n\n` +
    `Gitee code search API is not available for this operation.\n\n` +
    `**Suggested alternative:** Use \`repo\_list\_files\` to browse repository files.`;
}

/**
 * repo_list_releases — 列出 Releases
 * GET /repos/{owner}/{repo}/releases?page=&per_page=&access_token={token}
 */
async function repo_list_releases(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/releases`,
      { params: withToken({ page, per_page }) }
    );

    let md = `### Releases: ${params.repo_owner}/${params.repo_name}\n\n`;

    if (!data || data.length === 0) {
      md += '*No releases found.*';
      return md;
    }

    md += `| Tag | Name | Author | Published |\n`;
    md += `|-----|------|--------|-----------|\n`;
    for (const r of data) {
      md += `| \`${r.tag_name}\` | ${r.name || 'N/A'} | ${r.author?.login || 'N/A'} | ${formatDate(r.published_at || r.created_at)} |\n`;
    }
    md += `\n*Page ${page}, showing ${data.length} releases*\n\n`;

    // 详细信息
    md += `#### Details\n\n`;
    for (const r of data) {
      md += `##### ${r.name || r.tag_name}\n`;
      md += `- **Tag:** \`${r.tag_name}\`\n`;
      if (r.tarball_url) md += `- **Download:** [tar.gz](${r.tarball_url}) · [zip](${r.zipball_url})\n`;
      md += `- **Author:** ${r.author?.login || 'N/A'}\n`;
      md += `- **Published:** ${formatDate(r.published_at || r.created_at)}\n`;
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
 * issue_list — 列出 Issues
 * GET /repos/{owner}/{repo}/issues?state=&page=&per_page=&access_token={token}
 */
async function issue_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = params.state || 'open';

    const qs = withToken({ state, page, per_page });

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/issues`,
      { params: qs }
    );

    let md = `### Issues: ${params.repo_owner}/${params.repo_name}\n\n`;
    md += `**State:** ${state}  ·  **Count:** ${data.length}\n\n`;

    if (!data || data.length === 0) {
      md += '*No issues found.*';
      return md;
    }

    md += `| # | Title | State | Author | Created | Comments |\n`;
    md += `|---|-------|-------|--------|---------|----------|\n`;
    for (const issue of data) {
      const title = (issue.title || '').replace(/\|/g, '\\|').slice(0, 50);
      md += `| #${issue.number} | [${title}](${issue.html_url}) | ${issue.state} | ${issue.user?.login || 'N/A'} | ${formatDate(issue.created_at)} | ${issue.comments || 0} |\n`;
    }
    md += `\n*Page ${page}*`;

    return truncate(md);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * issue_get — 获取 Issue 详情
 * GET /repos/{owner}/{repo}/issues/{number}?access_token={token}
 */
async function issue_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'issue_number');

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/issues/${params.issue_number}`,
      { params: withToken() }
    );

    const labels = (data.labels || []).map(l => typeof l === 'string' ? l : l.name).join(', ') || 'N/A';

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
      `- **URL:** [View on Gitee](${data.html_url})`,
      `- **Assignee:** ${data.assignee?.login || 'N/A'}`,
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
 * issue_search — Gitee 不支持 issue 搜索
 */
async function issue_search(params) {
  requireParam(params, 'query');
  return `> **Command \_SEARCH\_ISSUES\_** is not supported on Gitee.\n\n` +
    `Gitee does not provide a cross-repository issue search API.\n\n` +
    `**Suggested alternative:** Use \`issue\_list\` to list issues within a specific repository.`;
}

/**
 * pr_list — 列出 Pull Requests
 * GET /repos/{owner}/{repo}/pulls?state=&page=&per_page=&access_token={token}
 */
async function pr_list(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);
    const state = params.state || 'open';

    const qs = withToken({ state, page, per_page });

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/pulls`,
      { params: qs }
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
      const headRef = pr.head?.ref || pr.head_branch || 'N/A';
      const baseRef = pr.base?.ref || pr.base_branch || 'N/A';
      const branchInfo = `\`${headRef}\` → \`${baseRef}\``;
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
 * GET /repos/{owner}/{repo}/pulls/{number}?access_token={token}
 */
async function pr_get(params) {
  try {
    requireParam(params, 'repo_owner');
    requireParam(params, 'repo_name');
    requireParam(params, 'pr_number');

    const { data } = await client.get(
      `/repos/${params.repo_owner}/${params.repo_name}/pulls/${params.pr_number}`,
      { params: withToken() }
    );

    const headRef = data.head?.ref || data.head_branch || 'N/A';
    const baseRef = data.base?.ref || data.base_branch || 'N/A';

    let md = [
      `### Pull Request #${data.number}: ${data.title}`,
      '',
      `- **Repository:** ${params.repo_owner}/${params.repo_name}`,
      `- **State:** ${data.state}`,
      `- **Author:** ${data.user?.login || 'N/A'}`,
      `- **Branch:** \`${headRef}\` → \`${baseRef}\``,
      `- **Created:** ${formatDate(data.created_at)}`,
      `- **Updated:** ${formatDate(data.updated_at)}`,
      `- **Merged:** ${data.merged ? '✅' : '❌'}`,
      `- **Mergeable:** ${data.mergeable === null ? 'Unknown' : (data.mergeable ? '✅ Yes' : '❌ Conflicts')}`,
      `- **URL:** [View on Gitee](${data.html_url})`,
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
 * pr_get_diff — Gitee 不支持获取文件级差异
 */
async function pr_get_diff(params) {
  requireParam(params, 'repo_owner');
  requireParam(params, 'repo_name');
  requireParam(params, 'pr_number');
  return `> **Command \_PR\_GET\_DIFF\_** is not supported on Gitee.\n\n` +
    `Gitee API returns diff but not file-level structured data.\n\n` +
    `**Suggested alternative:** View the diff directly on Gitee at:\n` +
    `https://gitee.com/${params.repo_owner}/${params.repo_name}/pulls/${params.pr_number}`;
}

/**
 * user_get_me — 获取当前认证用户信息
 * GET /user?access_token={token}
 */
async function user_get_me(params) {
  try {
    const { data } = await client.get('/user', {
      params: withToken()
    });

    let md = [
      `### Authenticated User`,
      '',
      `- **Login:** ${data.login || data.name || 'N/A'}`,
      `- **Name:** ${data.name || 'N/A'}`,
      `- **ID:** ${data.id || 'N/A'}`,
      `- **Profile:** [${data.html_url || '#no-link'}](${data.html_url || '#'})`,
      `- **Bio:** ${data.bio || 'N/A'}`,
      `- **Company:** ${data.company || 'N/A'}`,
      `- **Location:** ${data.location || data.address || 'N/A'}`,
      `- **Email:** ${data.email || 'N/A'}`,
      `- **Blog:** ${data.blog || data.url || 'N/A'}`,
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
 * GET /search/users?q=&page=&per_page=&access_token={token}
 */
async function user_search(params) {
  try {
    requireParam(params, 'query');

    const page = params.page || 1;
    const per_page = Math.min(params.per_page || 30, 100);

    const { data } = await client.get('/search/users', {
      params: withToken({ q: params.query, page, per_page })
    });

    let md = `### User Search Results\n\n`;
    md += `**Query:** \`${params.query}\`\n\n`;

    // Gitee 返回的结果结构可能是数组或包含 total_count 的对象
    const users = Array.isArray(data) ? data : (data.users || data.items || []);
    const total = data.total_count || users.length;

    if (!users || users.length === 0) {
      md += '*No users found.*';
      return md;
    }

    md += `| Login | Name | Profile |\n`;
    md += `|-------|------|---------|\n`;
    for (const user of users) {
      const login = user.login || user.name || 'N/A';
      const name = user.name || user.login || 'N/A';
      const url = user.html_url || `https://gitee.com/${login}`;
      md += `| ${login} | ${name} | [Profile](${url}) |\n`;
    }
    md += `\n*Page ${page}, showing ${users.length} of ${total} results*`;

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
