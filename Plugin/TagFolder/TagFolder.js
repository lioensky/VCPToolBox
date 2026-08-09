const fs = require('fs');

const LIST_PATH = process.env.LIST_PATH
  || './list.md';

function readTagList(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

function buildFoldBlocks(tags) {
  if (tags.length === 0) {
    return [{ threshold: 0.0, content: '[TagFolder] list.md 中暂无折叠标签配置。' }];
  }

  const tagListStr = tags.map(t => '[' + t + ']').join('、');
  const tagPatterns = tags.map(t => '• [' + t + ':AgentName]...[/' + t + ']').join('\n');

  const fullInstruction = '【上下文折叠规则 · 完整版】\n'
    + '以下标签包裹的上下文块默认为"折叠状态"，在理解和回复时应将其视为压缩的背景信息：\n\n'
    + tagPatterns + '\n\n'
    + '处理规则：\n'
    + '1. 折叠块中的内容（已执行的任务、注入的文件内容等）默认以摘要形式感知，不逐行展开分析。\n'
    + '2. 当用户明确提问"刚才执行了什么"、"那个文件里写了什么"等时，才展开对应折叠块详细处理。\n'
    + '3. 折叠块的存在本身是有意义的信息——它说明该操作已被执行或该文件已被注入。\n'
    + '4. AgentName 部分可为任意值，不影响折叠规则的匹配。\n\n'
    + '当前折叠白名单共 ' + tags.length + ' 个标签：' + tagListStr;

  const summaryInstruction = '【上下文折叠提示】\n'
    + '当前上下文中可能包含以下折叠标签的内容块，默认压缩处理：\n'
    + tagListStr + '\n如需了解具体内容，请直接提问。';

  const fallbackInstruction = '[TagFolder · 折叠白名单: ' + tagListStr + ']（被以上标签包裹的上下文块默认折叠）';

  return [
    { threshold: 0.5, content: fullInstruction },
    { threshold: 0.2, content: summaryInstruction },
    { threshold: 0.0, content: fallbackInstruction }
  ];
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(LIST_PATH, 'utf-8');
  } catch (e) {
    void e;
    const fallback = {
      vcp_dynamic_fold: true,
      plugin_description: '上下文折叠管理器，用于折叠对话中由 nvim 系列标签包裹的执行记录、文件内容、任务块等上下文，减少无关 Token 干扰。',
      fold_blocks: [{ threshold: 0.0, content: '[TagFolder] list.md 未找到，折叠规则未加载。' }]
    };
    console.log(JSON.stringify(fallback, null, 2));
    process.exit(0);
  }

  const tags = readTagList(raw);

  const description = tags.length > 0
    ? '上下文折叠管理器。负责将对话历史中由以下标签包裹的内容块（已执行的任务记录、注入的文件内容、批量操作结果等）进行折叠压缩，避免无关上下文占用注意力：'
      + tags.join(', ')
      + '。当用户讨论刚刚执行的操作、查看文件内容、复盘任务结果时相关。'
    : '上下文折叠管理器（list.md 暂无配置）。';

  const output = {
    vcp_dynamic_fold: true,
    plugin_description: description,
    fold_blocks: buildFoldBlocks(tags)
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

main();
