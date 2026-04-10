const fs = require('node:fs/promises');
const path = require('node:path');

function getConfigValue(config, key, fallback) {
  const value = config && config[key];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value;
}

function buildRuntimeContext({ config = {}, projectBasePath, pluginManager = null }) {
  const memoDiaryName = getConfigValue(config, 'MemoDiaryName', 'MyMemos');
  const memoImageSubdir = getConfigValue(config, 'MemoImageSubdir', 'memo-inbox');
  const memoMaidName = getConfigValue(config, 'MemoMaidName', 'MemoInbox');
  const memoDiaryRoot =
    process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(projectBasePath, 'dailynote');
  const memoRootPath = path.join(memoDiaryRoot, memoDiaryName);

  return {
    projectBasePath,
    pluginManager,
    memoDiaryName,
    memoMaidName,
    memoImageSubdir,
    memoRootPath,
    memoTrashPath: path.join(memoRootPath, '.trash'),
    memoImageRootPath: path.join(projectBasePath, 'image', memoImageSubdir),
    imageServerKey:
      process.env.IMAGESERVER_IMAGE_KEY ||
      process.env.Image_Key ||
      getConfigValue(config, 'Image_Key', null),
  };
}

async function ensureRuntimeDirectories(runtimeContext) {
  await fs.mkdir(runtimeContext.memoRootPath, { recursive: true });
  await fs.mkdir(runtimeContext.memoTrashPath, { recursive: true });
  await fs.mkdir(runtimeContext.memoImageRootPath, { recursive: true });
}

module.exports = {
  buildRuntimeContext,
  ensureRuntimeDirectories,
};
