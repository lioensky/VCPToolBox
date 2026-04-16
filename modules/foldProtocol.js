const FOLD_REGEX = /^\[===vcp_fold:\s*([0-9.]+)(?:\s*::desc:\s*(.*?)\s*)?===\]\s*$/;

function parseFoldBlocks(content) {
  const blocks = [];
  let currentThreshold = 0.0;
  let currentDescription = '';
  let currentContent = [];
  let hasOpenedFoldBlock = false;

  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const match = line.match(FOLD_REGEX);
    if (match) {
      if (hasOpenedFoldBlock || currentContent.length > 0) {
        blocks.push({
          threshold: currentThreshold,
          description: currentDescription,
          content: currentContent.join('\n').trim()
        });
      }

      currentThreshold = parseFloat(match[1]);
      if (Number.isNaN(currentThreshold)) currentThreshold = 0.0;
      currentDescription = typeof match[2] === 'string' ? match[2].trim() : '';
      currentContent = [];
      hasOpenedFoldBlock = true;
    } else {
      currentContent.push(line);
    }
  }

  if (hasOpenedFoldBlock || currentContent.length > 0) {
    blocks.push({
      threshold: currentThreshold,
      description: currentDescription,
      content: currentContent.join('\n').trim()
    });
  }

  const validBlocks = blocks.filter(block => block && typeof block.content === 'string');
  if (validBlocks.length === 0) {
    return [{ threshold: 0.0, description: '', content: '配置文件中未找到有效内容。' }];
  }

  return validBlocks;
}

function hasFoldMarkers(content) {
  const text = String(content || '');
  return FOLD_REGEX.test(text) || text.split('\n').some(line => FOLD_REGEX.test(line));
}

function buildDynamicFoldObject({
  content,
  pluginDescription = '',
  strategy = 'toolbox_block_similarity',
  fallbackContent = '配置文件中未找到有效内容。'
} = {}) {
  const foldBlocks = parseFoldBlocks(content);
  const normalizedBlocks = Array.isArray(foldBlocks) && foldBlocks.length > 0
    ? foldBlocks
    : [{ threshold: 0.0, description: '', content: fallbackContent }];

  return {
    vcp_dynamic_fold: true,
    dynamic_fold_strategy: strategy,
    plugin_description: pluginDescription,
    fold_blocks: normalizedBlocks
  };
}

module.exports = {
  FOLD_REGEX,
  parseFoldBlocks,
  hasFoldMarkers,
  buildDynamicFoldObject
};