/**
 * GitSearch Plugin — 共享工具函数
 */

/**
 * 截断过长内容。
 * 通过环境变量 MAX_OUTPUT_LENGTH 控制，设为 0 或不设则不截断。
 */
function truncate(content, maxLen) {
  const limit = maxLen !== undefined
    ? maxLen
    : (parseInt(process.env.MAX_OUTPUT_LENGTH, 10) || 0);
  if (!limit || !content || content.length <= limit) return content;
  return content.slice(0, limit) +
    `\n\n---\n*Content truncated. Total length exceeds ${limit} characters.*`;
}

module.exports = {
  truncate
};
