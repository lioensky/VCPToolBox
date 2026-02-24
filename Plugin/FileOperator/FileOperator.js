const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const glob = require('glob');
const { minimatch } = require('minimatch');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const axios = require('axios');
const { validateCode } = require('./CodeValidator.js');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, 'config.env') });

// Configuration
const CANVAS_DIRECTORY = process.env.CANVAS_DIRECTORY || path.join(__dirname, '..', '..', 'AppData', 'Canvas');
const ALLOWED_DIRECTORIES = (process.env.ALLOWED_DIRECTORIES || '')
  .split(',')
  .map(dir => dir.trim())
  .filter(dir => dir);

// The canvas directory is no longer automatically added to the allowed list.
// It can be added manually to config.env if needed for a specific setup.
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 20971520; // 20MB default
const MAX_DIRECTORY_ITEMS = parseInt(process.env.MAX_DIRECTORY_ITEMS) || 1000;
const MAX_SEARCH_RESULTS = parseInt(process.env.MAX_SEARCH_RESULTS) || 100;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const ENABLE_RECURSIVE_OPERATIONS = process.env.ENABLE_RECURSIVE_OPERATIONS !== 'false';
const ENABLE_HIDDEN_FILES = process.env.ENABLE_HIDDEN_FILES === 'true';

// Utility functions
function debugLog(message, data = null) {
  if (DEBUG_MODE) {
    const timestamp = new Date().toISOString();
    console.error(`[DEBUG ${timestamp}] ${message}`);
    if (data) console.error(JSON.stringify(data, null, 2));
  }
}

function isPathAllowed(targetPath, operationType = 'generic') {
  const resolvedPath = path.resolve(targetPath);

  // 1. 如果在允许的目录内，则授予所有权限。
  if (ALLOWED_DIRECTORIES.length > 0) {
    const isInAllowedDir = ALLOWED_DIRECTORIES.some(allowedDir => {
      const resolvedAllowedDir = path.resolve(allowedDir);
      // Normalize to lower case for case-insensitive comparison, crucial for Windows
      return resolvedPath.toLowerCase().startsWith(resolvedAllowedDir.toLowerCase());
    });
    if (isInAllowedDir) {
      debugLog(`Path is within allowed directories. Access granted.`, { targetPath, operationType });
      return true;
    }
  } else {
    // 如果没有配置允许的目录，则允许所有操作（保持原有灵活性）。
    debugLog('No ALLOWED_DIRECTORIES configured, allowing access to all paths.');
    return true;
  }

  // 2. 如果路径在允许的目录之外，则只对只读操作开绿灯。
  const readOnlyBypassOperations = ['ReadFile', 'FileInfo'];
  if (readOnlyBypassOperations.includes(operationType) && path.isAbsolute(targetPath)) {
    debugLog(`Path is outside allowed directories, but operation is a read-only bypass. Access granted.`, { targetPath, operationType });
    return true;
  }

  // 3. 对于所有其他情况（例如，在沙箱外的写/删除操作），一律拒绝。
  debugLog(`Access denied. Path is outside allowed directories and operation is not a read-only bypass.`, { targetPath, operationType });
  return false;
}

function formatFileSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

function getUniqueFilePath(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return { newPath: filePath, renamed: false };
  }

  let counter = 1;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  let newPath;

  while (true) {
    newPath = path.join(dir, `${baseName}(${counter})${ext}`);
    if (!fsSync.existsSync(newPath)) {
      return { newPath: newPath, renamed: true };
    }
    counter++;
  }
}

function applyDiffLogic(originalContent, diffContent) {
  const diffBlocks = diffContent.split('<<<<<<< SEARCH').slice(1);
  if (diffBlocks.length === 0) {
    throw new Error('Invalid diff format: No SEARCH blocks found.');
  }

  let modifiedContent = originalContent;

  // Per user feedback, only process the first SEARCH block.
  const block = diffBlocks[0];
  const parts = block.split('=======');
  if (parts.length !== 2) {
    throw new Error('Invalid diff format: Missing ======= separator.');
  }

  const searchPart = parts[0];
  const replacePart = parts[1].split('>>>>>>> REPLACE')[0];

  // This logic correctly ignores line numbers and only takes content after '-------'
  const searchContent = searchPart.substring(searchPart.indexOf('-------') + '-------'.length).trim();
  const replaceContent = replacePart.trim();

  if (modifiedContent.includes(searchContent)) {
    // .replace() will only replace the first occurrence found in the file.
    modifiedContent = modifiedContent.replace(searchContent, replaceContent);
  } else {
    throw new Error(`Diff application failed: SEARCH content not found in the original file. Content not found: "${searchContent}"`);
  }

  return modifiedContent;
}

function resolveAndNormalizePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return inputPath; // Return as-is if invalid input
  }

  const originalPath = inputPath.trim();

  // 1. Sanitize each component of the path to remove leading/trailing spaces.
  const parts = originalPath.split(/[/\\]+/);
  const trimmedParts = parts.map(part => part.trim());
  const sanitizedPath = path.join(...trimmedParts);

  // 原样返回 Windows 绝对路径
  if (/^[a-zA-Z]:[\\/]/.test(originalPath)) {
    return path.win32.normalize(originalPath);
  }

  // 🔧 关键修改：幂等性保护 - 如果路径已经在 FileOperator 目录下，直接返回
  const resolvedInput = path.resolve(originalPath);
  const fileOperatorRoot = path.resolve(__dirname);

  // 使用 startsWith 检查是否已经是 FileOperator 下的绝对路径
  // 注意：Windows 下路径大小写不敏感，但这里主要是解决 Linux/Mac 的双写问题
  if (resolvedInput.toLowerCase().startsWith(fileOperatorRoot.toLowerCase())) {
    return resolvedInput;
  }

  // 虚拟根逻辑：将 /xxx 映射到 FileOperator/xxx
  if (originalPath.startsWith('/')) {
    const relativePath = originalPath.slice(1); // 去掉开头的 /
    return path.resolve(__dirname, relativePath);
  }

  // 2. Handle absolute paths. Check originalPath as sanitizing might alter it.
  if (path.isAbsolute(originalPath)) {
    // On Windows, path.join(['', 'foo']) becomes '\\foo'.
    // path.resolve correctly handles this, ensuring a drive letter.
    return path.resolve(sanitizedPath);
  }

  // 3. Handle all relative paths.
  const normalized = path.normalize(sanitizedPath);

  // Check if the path starts with './' or '../' in an OS-agnostic way.
  const startsWithDot = normalized.startsWith(`.${path.sep}`);
  const startsWithDotDot = normalized.startsWith(`..${path.sep}`);

  if (!startsWithDot && !startsWithDotDot) {
    // Path is like 'foo/bar', so treat it as relative to the project root.
    // The project root is two levels up from this script's directory.
    return path.resolve(__dirname, '..', '..', normalized);
  } else {
    // Path is like './foo' or '../foo', so it's explicitly relative to this script's directory.
    return path.resolve(__dirname, normalized);
  }
}

// Helper function to run validation and attach results
async function runValidationAndAttachResults(result, filePath, fileContent) {
  if (result.success && fileContent) {
    try {
      const validationResults = await validateCode(filePath, fileContent);
      if (validationResults && validationResults.length > 0) {
        result.data.validation = validationResults;
        result.data.message += ' (with validation)';
      }
    } catch (error) {
      debugLog('Code validation failed', { filePath, error: error.message });
      // We don't fail the whole operation if validation fails
    }
  }
  return result;
}

// File operation functions
async function webReadFile(fileUrl) {
  try {
    const fileDir = path.join(__dirname, '..', '..', '..', 'AppData', 'file');
    await fs.mkdir(fileDir, { recursive: true }); // Ensure directory exists

    // Extract filename from URL, handling potential query strings
    const url = new URL(fileUrl);
    const fileName = path.basename(url.pathname);
    const localFilePath = path.join(fileDir, fileName);

    debugLog('Downloading file from web', { fileUrl, localFilePath });

    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream'
    });

    const writer = fsSync.createWriteStream(localFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    debugLog('File downloaded successfully. Reading local file.', { localFilePath });
    const result = await readFile(localFilePath);

    if (result.success) {
      result.data.localPath = localFilePath;
      result.data.originalUrl = fileUrl;
      // Prepend a message to reflect the web origin
      if (Array.isArray(result.data.content)) {
        result.data.content.unshift({ type: 'text', text: `已从网络地址读取文件 '${result.data.fileName}' 并保存到本地。` });
      }
    }

    return result;

  } catch (error) {
    debugLog('Error reading web file', { fileUrl, error: error.message });
    return {
      success: false,
      error: `Failed to read or download file from URL: ${error.message}`,
    };
  }
}

async function readFile(filePath, encoding = 'utf8') {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Reading file', { filePath, encoding });

    if (!isPathAllowed(filePath, 'ReadFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    const extension = path.extname(filePath).toLowerCase();
    let content;
    let isExtracted = false;

    // Read file as buffer for parsers
    const fileBuffer = await fs.readFile(filePath);

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'];
    const videoExtensions = ['.mp4', '.webm', '.mov'];

    if (extension === '.pdf') {
      const data = await pdf(fileBuffer);
      content = data.text;
      isExtracted = true;
    } else if (extension === '.docx') {
      const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
      content = value;
      isExtracted = true;
    } else if (['.xlsx', '.xls', '.csv'].includes(extension)) {
      const workbook = new ExcelJS.Workbook();
      if (extension === '.csv') {
        const worksheet = await workbook.csv.read(new (require('stream').Readable)({
          read() { this.push(fileBuffer); this.push(null); }
        }));
      } else {
        await workbook.xlsx.load(fileBuffer);
      }
      let sheetContent = '';
      workbook.eachSheet((worksheet, sheetId) => {
        sheetContent += `--- Sheet: ${worksheet.name} ---\n`;
        worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
          sheetContent += row.values.slice(1).join('\t') + '\n';
        });
      });
      content = sheetContent;
      isExtracted = true;
    } else if (imageExtensions.includes(extension)) {
      const mimeType = `image/${extension.slice(1).replace('jpg', 'jpeg')}`;
      content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      isExtracted = true;
    } else if (audioExtensions.includes(extension)) {
      const mimeType = `audio/${extension.slice(1).replace('mp3', 'mpeg')}`;
      content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      isExtracted = true;
    } else if (videoExtensions.includes(extension)) {
      const mimeType = `video/${extension.slice(1)}`;
      content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      isExtracted = true;
    } else {
      // Fallback for plain text files
      content = fileBuffer.toString(encoding);
    }

    const returnData = {
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      lastModified: stats.mtime.toISOString(),
      encoding: isExtracted ? 'utf8' : encoding,
      isExtracted: isExtracted,
      fileName: path.basename(filePath)
    };

    const headerText = `已读取文件 '${returnData.fileName}' (${returnData.sizeFormatted})。`;

    if (isExtracted && content.startsWith('data:image')) {
      returnData.content = [
        { type: 'text', text: headerText },
        { type: 'image_url', image_url: { url: content } }
      ];
    } else if (isExtracted && (content.startsWith('data:audio') || content.startsWith('data:video'))) {
      returnData.content = [
        { type: 'text', text: headerText },
        { type: 'image_url', image_url: { url: content } }
      ];
    } else {
      // For text-based files
      let language = extension.slice(1).toLowerCase();
      const codeLangs = {
        'js': 'javascript', 'py': 'python', 'md': 'markdown', 'ts': 'typescript',
        'html': 'html', 'css': 'css', 'json': 'json', 'sh': 'bash', 'yml': 'yaml', 'yaml': 'yaml'
      };
      language = codeLangs[language] || language;
      if (isExtracted) language = '';

      const backticks = content.includes('```') ? '````' : '```';

      returnData.content = [
        { type: 'text', text: `${headerText}\n${backticks}${language}\n${content}\n${backticks}` }
      ];
    }

    return {
      success: true,
      data: returnData,
    };
  } catch (error) {
    debugLog('Error reading file', { filePath, error: error.message });
    return {
      success: false,
      error: `Failed to read or process file: ${error.message}`,
    };
  }
}

async function writeFile(filePath, content, encoding = 'utf8') {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Writing file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'WriteFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    if (Buffer.byteLength(content, encoding) > MAX_FILE_SIZE) {
      throw new Error(`Content too large: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    const { newPath, renamed } = getUniqueFilePath(filePath);

    await fs.writeFile(newPath, content, encoding);
    const stats = await fs.stat(newPath);

    const message = renamed
      ? `已存在同名文件 "${path.basename(filePath)}"，已为您创建为 "${path.basename(newPath)}"`
      : '文件写入成功';

    let result = {
      success: true,
      data: {
        message: message,
        path: newPath,
        originalPath: filePath,
        renamed: renamed,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };

    return await runValidationAndAttachResults(result, newPath, content);
  } catch (error) {
    debugLog('Error writing file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}
async function writeEscapedFile(filePath, content, encoding = 'utf8') {
  filePath = resolveAndNormalizePath(filePath);
  debugLog('Writing file with escaped delimiters', { filePath, contentLength: content.length });
  // Replace the escaped delimiters with the actual ones
  // Replace all escaped delimiters with the actual ones
  const processedContent = content
    .replace(/「始exp」/g, '「始」')
    .replace(/「末exp」/g, '「末」')
    .replace(/<<<\[TOOL_REQUEST_EXP\]>>>/g, '<<<[TOOL_REQUEST]>>>')
    .replace(/<<<\[END_TOOL_REQUEST_EXP\]>>>/g, '<<<[END_TOOL_REQUEST]>>>');

  // Delegate the actual writing to the original writeFile function
  // This reuses all the safety checks, unique file naming, etc.
  const result = await writeFile(filePath, processedContent, encoding);

  // Optionally, modify the success message to be more specific
  if (result.success) {
    result.data.message = `文件内容已转义处理，并成功写入。详情: ${result.data.message}`;
  }

  return result;
}


async function appendFile(filePath, content, encoding = 'utf8') {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Appending to file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'AppendFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    // Check total size after append
    let existingSize = 0;
    try {
      const stats = await fs.stat(filePath);
      existingSize = stats.size;
    } catch (e) {
      // File doesn't exist, which is fine
    }

    const newContentSize = Buffer.byteLength(content, encoding);
    if (existingSize + newContentSize > MAX_FILE_SIZE) {
      throw new Error(`File would be too large after append: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    await fs.appendFile(filePath, content, encoding);
    const stats = await fs.stat(filePath);

    let result = {
      success: true,
      data: {
        message: 'Content appended successfully',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };

    // For append, we need to read the whole file to validate
    const updatedContent = await fs.readFile(filePath, encoding);
    return await runValidationAndAttachResults(result, filePath, updatedContent);
  } catch (error) {
    debugLog('Error appending to file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function editFile(filePath, content, encoding = 'utf8') {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Editing file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'EditFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    // Ensure the file exists before attempting to edit it.
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        throw new Error(`Path points to a directory, not a file. Cannot edit.`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`File not found at '${filePath}'. Use WriteFile to create a new file.`);
      }
      throw e; // Re-throw other errors
    }

    if (Buffer.byteLength(content, encoding) > MAX_FILE_SIZE) {
      throw new Error(`Content too large: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    await fs.writeFile(filePath, content, encoding);
    const stats = await fs.stat(filePath);

    let result = {
      success: true,
      data: {
        message: '文件编辑成功',
        path: filePath,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };

    return await runValidationAndAttachResults(result, filePath, content);
  } catch (error) {
    debugLog('Error editing file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function listDirectory(dirPath, showHidden = ENABLE_HIDDEN_FILES) {
  try {
    dirPath = resolveAndNormalizePath(dirPath);
    debugLog('Listing directory', { dirPath, showHidden });

    if (!isPathAllowed(dirPath, 'ListDirectory')) {
      throw new Error(`Access denied: Path '${dirPath}' is not in allowed directories`);
    }

    const items = await fs.readdir(dirPath);
    const result = [];

    for (const item of items.slice(0, MAX_DIRECTORY_ITEMS)) {
      if (!showHidden && item.startsWith('.')) {
        continue;
      }

      const itemPath = path.join(dirPath, item);
      try {
        const stats = await fs.stat(itemPath);
        result.push({
          name: item,
          path: itemPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : null,
          sizeFormatted: stats.isFile() ? formatFileSize(stats.size) : null,
          lastModified: stats.mtime.toISOString(),
          permissions: stats.mode,
          isHidden: item.startsWith('.'),
        });
      } catch (itemError) {
        debugLog('Error getting item stats', { itemPath, error: itemError.message });
        // Skip items we can't stat
      }
    }

    const message = `Directory listing of \`${dirPath}\` (${result.length} items${items.length > MAX_DIRECTORY_ITEMS ? ', truncated' : ''})`;

    let markdownTable = `| 名称 | 类型 | 大小 | 修改时间 | 隐藏 |\n|---|---|---|---|---|\n`;
    for (const item of result) {
      const typeStr = item.type === 'directory' ? '📁' : '📄';
      const sizeStr = item.sizeFormatted || '-';
      const timeStr = new Date(item.lastModified).toLocaleString();
      const hiddenStr = item.isHidden ? '是' : '否';
      markdownTable += `| ${typeStr} **${item.name}** | ${item.type} | ${sizeStr} | ${timeStr} | ${hiddenStr} |\n`;
    }

    return {
      success: true,
      data: {
        path: dirPath,
        items: result,
        totalItems: result.length,
        truncated: items.length > MAX_DIRECTORY_ITEMS,
        message: message,
        content: [
          { type: 'text', text: message + '\n\n' + markdownTable }
        ]
      },
    };
  } catch (error) {
    debugLog('Error listing directory', { dirPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function getFileInfo(filePath) {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Getting file info', { filePath });

    if (!isPathAllowed(filePath, 'FileInfo')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);

    const fileData = {
      path: filePath,
      name: path.basename(filePath),
      directory: path.dirname(filePath),
      extension: path.extname(filePath),
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      lastModified: stats.mtime.toISOString(),
      lastAccessed: stats.atime.toISOString(),
      created: stats.birthtime.toISOString(),
      permissions: stats.mode,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
    };

    const markdownList = `**文件信息**: \`${fileData.name}\`
- **路径**: \`${fileData.path}\`
- **目录**: \`${fileData.directory}\`
- **类型**: ${fileData.type === 'directory' ? '📁 目录' : '📄 文件'}
- **大小**: ${fileData.sizeFormatted} (${fileData.size} Bytes)
- **修改时间**: ${new Date(fileData.lastModified).toLocaleString()}
- **访问时间**: ${new Date(fileData.lastAccessed).toLocaleString()}
- **创建时间**: ${new Date(fileData.created).toLocaleString()}
- **权限**: ${fileData.permissions.toString(8)}
- **状态**: ${fileData.isDirectory ? '目录' : ''}${fileData.isFile ? '文件' : ''}${fileData.isSymbolicLink ? ' 符号链接' : ''}`;

    return {
      success: true,
      data: {
        ...fileData,
        message: `File info for ${filePath}`,
        content: [
          { type: 'text', text: markdownList }
        ]
      },
    };
  } catch (error) {
    debugLog('Error getting file info', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function copyFile(sourcePath, destinationPath) {
  try {
    sourcePath = resolveAndNormalizePath(sourcePath);
    destinationPath = resolveAndNormalizePath(destinationPath);
    debugLog('Copying file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'CopyFile') || !isPathAllowed(destinationPath, 'CopyFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    const stats = await fs.stat(sourcePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large to copy: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    const { newPath, renamed } = getUniqueFilePath(destinationPath);

    await fs.copyFile(sourcePath, newPath);
    const destStats = await fs.stat(newPath);

    const message = renamed
      ? `已存在同名文件 "${path.basename(destinationPath)}"，已为您复制为 "${path.basename(newPath)}"`
      : '文件复制成功';

    return {
      success: true,
      data: {
        message: message,
        source: sourcePath,
        destination: newPath,
        originalDestination: destinationPath,
        renamed: renamed,
        size: destStats.size,
        sizeFormatted: formatFileSize(destStats.size),
      },
    };
  } catch (error) {
    debugLog('Error copying file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function moveFile(sourcePath, destinationPath) {
  try {
    sourcePath = resolveAndNormalizePath(sourcePath);
    destinationPath = resolveAndNormalizePath(destinationPath);
    debugLog('Moving file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'MoveFile') || !isPathAllowed(destinationPath, 'MoveFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    const { newPath, renamed } = getUniqueFilePath(destinationPath);

    await fs.rename(sourcePath, newPath);
    const stats = await fs.stat(newPath);

    const message = renamed
      ? `移动目标位置已存在同名文件 "${path.basename(destinationPath)}"，已为您移动并重命名为 "${path.basename(newPath)}"`
      : '文件移动成功';

    return {
      success: true,
      data: {
        message: message,
        source: sourcePath,
        destination: newPath,
        originalDestination: destinationPath,
        renamed: renamed,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
      },
    };
  } catch (error) {
    debugLog('Error moving file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function renameFile(sourcePath, destinationPath) {
  try {
    sourcePath = resolveAndNormalizePath(sourcePath);
    destinationPath = resolveAndNormalizePath(destinationPath);
    debugLog('Renaming file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'RenameFile') || !isPathAllowed(destinationPath, 'RenameFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    // Check if source file exists
    try {
      await fs.stat(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Source file not found: '${sourcePath}'`);
      }
      throw error;
    }

    // Check if destination file already exists
    if (fsSync.existsSync(destinationPath)) {
      throw new Error(`Destination file already exists: '${destinationPath}'. Please choose a different name.`);
    }

    await fs.rename(sourcePath, destinationPath);
    const stats = await fs.stat(destinationPath);

    return {
      success: true,
      data: {
        message: 'File renamed successfully',
        source: sourcePath,
        destination: destinationPath,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
      },
    };
  } catch (error) {
    debugLog('Error renaming file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function deleteFile(filePath) {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Deleting file', { filePath });

    if (!isPathAllowed(filePath, 'DeleteFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    const fileInfo = {
      path: filePath,
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      type: stats.isDirectory() ? 'directory' : 'file',
    };

    // Dynamically import the trash module which is ESM-only
    const { default: trash } = await import('trash');
    await trash(filePath);

    return {
      success: true,
      data: {
        message: `${fileInfo.type} moved to trash successfully`,
        deletedItem: fileInfo,
      },
    };
  } catch (error) {
    debugLog('Error deleting file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function createDirectory(dirPath) {
  try {
    dirPath = resolveAndNormalizePath(dirPath);
    debugLog('Creating directory', { dirPath });

    if (!isPathAllowed(dirPath, 'CreateDirectory')) {
      throw new Error(`Access denied: Path '${dirPath}' is not in allowed directories`);
    }

    await fs.mkdir(dirPath, { recursive: true });
    const stats = await fs.stat(dirPath);

    return {
      success: true,
      data: {
        message: 'Directory created successfully',
        path: dirPath,
        created: stats.birthtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error creating directory', { dirPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function searchFiles(searchPath, pattern, options = {}) {
  try {
    searchPath = resolveAndNormalizePath(searchPath);
    debugLog('Searching files', { searchPath, pattern, options });

    if (!isPathAllowed(searchPath, 'SearchFiles')) {
      throw new Error(`Access denied: Path '${searchPath}' is not in allowed directories`);
    }

    const {
      caseSensitive = false,
      includeHidden = ENABLE_HIDDEN_FILES,
      fileType = 'all', // 'file', 'directory', 'all'
    } = options;

    const globPattern = path.join(searchPath, '**', pattern);
    const globOptions = {
      dot: includeHidden,
      nocase: !caseSensitive,
      maxDepth: ENABLE_RECURSIVE_OPERATIONS ? undefined : 1,
    };

    const files = glob.sync(globPattern, globOptions).slice(0, MAX_SEARCH_RESULTS);
    const results = [];

    for (const file of files) {
      try {
        const stats = await fs.stat(file);
        const isDirectory = stats.isDirectory();

        if (fileType === 'file' && isDirectory) continue;
        if (fileType === 'directory' && !isDirectory) continue;

        results.push({
          path: file,
          name: path.basename(file),
          directory: path.dirname(file),
          type: isDirectory ? 'directory' : 'file',
          size: isDirectory ? null : stats.size,
          sizeFormatted: isDirectory ? null : formatFileSize(stats.size),
          lastModified: stats.mtime.toISOString(),
          relativePath: path.relative(searchPath, file),
        });
      } catch (statError) {
        debugLog('Error getting stats for search result', { file, error: statError.message });
      }
    }

    const message = `Search results for "${pattern}" in \`${searchPath}\` (${results.length} results${files.length >= MAX_SEARCH_RESULTS ? ', truncated' : ''})`;

    let markdownList = `**搜索结果**: \`${pattern}\`\n\n`;
    if (results.length === 0) {
      markdownList += "*未找到匹配的文件或目录。*";
    } else {
      for (const [index, item] of results.entries()) {
        const typeIcon = item.type === 'directory' ? '📁' : '📄';
        markdownList += `${index + 1}. ${typeIcon} **${item.name}**\n   - 相对路径: \`${item.relativePath}\`\n   - 绝对路径: \`${item.path}\`\n`;
        if (item.type === 'file') {
          markdownList += `   - 大小: ${item.sizeFormatted} | 修改时间: ${new Date(item.lastModified).toLocaleString()}\n`;
        }
      }
    }

    return {
      success: true,
      data: {
        searchPath: searchPath,
        pattern: pattern,
        results: results,
        totalResults: results.length,
        truncated: files.length >= MAX_SEARCH_RESULTS,
        options: options,
        message: message,
        content: [
          { type: 'text', text: message + '\n\n' + markdownList }
        ]
      },
    };
  } catch (error) {
    debugLog('Error searching files', { searchPath, pattern, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function downloadFile(url) {
  try {
    // Automatically parse filename from URL
    const parsedUrl = new URL(url);
    const fileName = path.basename(parsedUrl.pathname);

    // Construct the full destination path in the designated AppData/file directory
    const baseDir = path.join(__dirname, '..', '..', '..', 'AppData', 'file');
    const destinationPath = path.join(baseDir, fileName);

    debugLog('Initiating asynchronous file download', { url, destinationPath });

    if (!isPathAllowed(destinationPath, 'WriteFile')) {
      throw new Error(`Access denied: Path '${destinationPath}' is not in allowed directories`);
    }

    // Synchronously ensure the destination directory exists to safely predict the final path
    const destDir = path.dirname(destinationPath);
    fsSync.mkdirSync(destDir, { recursive: true });

    // Determine the final, non-conflicting path before starting the download
    const { newPath, renamed } = getUniqueFilePath(destinationPath);

    // Fire-and-forget the download process. Do not await.
    axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    }).then(response => {
      const writer = fsSync.createWriteStream(newPath);
      response.data.pipe(writer);

      writer.on('finish', () => {
        debugLog('Background download completed successfully.', { sourceUrl: url, destination: newPath });
      });
      writer.on('error', (err) => {
        debugLog('Background download failed.', { sourceUrl: url, destination: newPath, error: err.message });
        // Attempt to clean up the partially downloaded file
        fs.unlink(newPath).catch(e => debugLog('Failed to clean up partial download.', { path: newPath }));
      });
    }).catch(err => {
      debugLog('Failed to initiate download stream.', { url, error: err.message });
    });

    // Immediately return a success message to the AI
    const message = `文件下载任务已在后台启动。将从URL自动解析文件名并保存到: ${newPath}`;
    return {
      success: true,
      data: {
        message: message,
        path: newPath,
        originalPath: destinationPath,
        renamed: renamed,
        sourceUrl: url,
      },
    };

  } catch (error) {
    debugLog('Error initiating file download', { url, error: error.message });
    return {
      success: false,
      error: `Failed to initiate download: ${error.message}`,
    };
  }
}

async function listAllowedDirectories() {
  debugLog('Listing allowed directories content');
  if (ALLOWED_DIRECTORIES.length === 0) {
    return {
      success: false,
      error: 'No allowed directories configured. Cannot list projects.',
    };
  }

  const allProjects = {};
  for (const dir of ALLOWED_DIRECTORIES) {
    try {
      // Resolve relative paths like '.' against the project root
      const resolvedDir = path.resolve(dir);
      if (!fsSync.existsSync(resolvedDir)) {
        debugLog(`Allowed directory not found, skipping: ${resolvedDir}`);
        allProjects[dir] = [{ name: '(Directory not found)', type: 'error' }];
        continue;
      }

      const items = await fs.readdir(resolvedDir);
      if (items.length === 0) {
        allProjects[dir] = [{ name: '(Directory is empty)', type: 'info' }];
        continue;
      }

      const subItems = [];
      for (const item of items.slice(0, MAX_DIRECTORY_ITEMS)) {
        try {
          const itemPath = path.join(resolvedDir, item);
          const stats = await fs.stat(itemPath);
          subItems.push({
            name: item,
            type: stats.isDirectory() ? 'directory' : 'file',
          });
        } catch (e) {
          // Ignore items that can't be stat'd, e.g. due to permissions
          debugLog(`Could not stat item: ${itemPath}`, { error: e.message });
        }
      }
      allProjects[dir] = subItems;

    } catch (error) {
      debugLog(`Error processing directory ${dir}`, { error: error.message });
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        allProjects[dir] = [{ name: '(Permission Denied)', type: 'error' }];
      } else {
        allProjects[dir] = [{ name: `(Error: ${error.message})`, type: 'error' }];
      }
    }
  }
  let markdownContent = '**配置的允许访问目录及内容总览:**\n\n';
  for (const [dirPath, items] of Object.entries(allProjects)) {
    markdownContent += `### 📁 \`${dirPath}\`\n`;
    if (items.length === 0) {
      markdownContent += `*(空目录)*\n\n`;
    } else if (items.length === 1 && (items[0].type === 'error' || items[0].type === 'info')) {
      markdownContent += `*${items[0].name}*\n\n`;
    } else {
      markdownContent += `| 名称 | 类型 |\n|---|---|\n`;
      for (const item of items) {
        const typeIcon = item.type === 'directory' ? '📁' : '📄';
        markdownContent += `| ${typeIcon} **${item.name}** | ${item.type} |\n`;
      }
      markdownContent += '\n';
    }
  }

  return {
    success: true,
    data: {
      allowedRoots: allProjects,
      message: 'Allowed directories listed',
      content: [
        { type: 'text', text: markdownContent }
      ]
    }
  };
}

async function createCanvas(fileName, content, encoding = 'utf8') {
  try {
    debugLog('Creating canvas file', { fileName });

    // Ensure the canvas directory exists before writing to it.
    await fs.mkdir(CANVAS_DIRECTORY, { recursive: true });

    const filePath = path.join(CANVAS_DIRECTORY, fileName);

    // Use the existing writeFile function which handles unique filenames and permissions
    const writeResult = await writeFile(filePath, content, encoding);

    if (!writeResult.success) {
      throw new Error(`Failed to write file: ${writeResult.error}`);
    }

    // This is the special object that will be caught by VCPDistributedServer.js
    return {
      success: true,
      data: {
        // This is a special action key that VCPDistributedServer will look for
        _specialAction: 'create_canvas',
        // Payload for the main process handler
        payload: {
          filePath: writeResult.data.path,
        },
        // This message is for the AI
        message: `Canvas file '${path.basename(writeResult.data.path)}' created successfully. The user has been notified to view it.`
      }
    };

  } catch (error) {
    debugLog('Error creating canvas file', { fileName, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function updateHistory(filePath, searchString, replaceString, encoding = 'utf8') {
  try {
    filePath = resolveAndNormalizePath(filePath);
    debugLog('Updating history file', { filePath, searchString, replaceString });

    if (!isPathAllowed(filePath, 'UpdateHistory')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    // 1. Read the file content
    const fileContent = await fs.readFile(filePath, encoding);

    // 2. Parse the JSON content
    const history = JSON.parse(fileContent);

    if (!Array.isArray(history)) {
      throw new Error('Invalid history format: root is not an array.');
    }

    let updateApplied = false;

    // 3. Iterate through the history to find and replace the content
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (entry.role === 'assistant' && typeof entry.content === 'string' && entry.content.includes(searchString)) {
        // Replace only the first occurrence found
        entry.content = entry.content.replace(searchString, replaceString);
        updateApplied = true;
        debugLog(`Found and replaced content in message at index ${i}.`);
        break; // Stop after the first successful replacement
      }
    }

    if (!updateApplied) {
      throw new Error(`Content to replace was not found in any assistant message. Search string: "${searchString}"`);
    }

    // 4. Stringify the modified history and write it back to the file
    const updatedContent = JSON.stringify(history, null, 2); // Pretty print JSON
    await fs.writeFile(filePath, updatedContent, encoding);

    return {
      success: true,
      data: {
        message: 'History file updated successfully.',
        path: filePath,
      },
    };

  } catch (error) {
    debugLog('Error updating history file', { filePath, error: error.message });
    return {
      success: false,
      error: `Failed to update history: ${error.message}`,
    };
  }
}

async function applyDiff(parameters) {
  try {
    const { filePath, diffContent, searchString, replaceString, encoding } = parameters;

    const readResult = await readFile(filePath, encoding);
    if (!readResult.success) {
      throw new Error(`Failed to read file for applying diff: ${readResult.error}`);
    }
    // We can only apply diff to string content.
    // Note: readFile now returns content as an array of objects.
    // We need to find the text content.
    let originalContent = '';
    if (Array.isArray(readResult.data.content)) {
      // The first text part is usually the header, the second is the content
      const textParts = readResult.data.content.filter(p => p.type === 'text');
      if (textParts.length >= 2) {
        originalContent = textParts[1].text;
      } else if (textParts.length === 1 && !textParts[0].text.startsWith('已读取文件')) {
        originalContent = textParts[0].text;
      }
    } else if (typeof readResult.data.content === 'string') {
      originalContent = readResult.data.content;
    }

    if (!originalContent && readResult.data.isExtracted) {
      throw new Error('ApplyDiff can only be used on plain text files or extracted text content.');
    }

    let newContent;
    if (diffContent) {
      // Use the existing diff logic if diffContent is provided
      newContent = applyDiffLogic(originalContent, diffContent);
    } else if (searchString !== undefined && replaceString !== undefined) {
      // Handle the legacy format with searchString and replaceString
      if (!originalContent.includes(searchString)) {
        // Make error more specific for debugging
        throw new Error(`Diff application failed: searchString content not found in the original file. Content not found: "${searchString}"`);
      }
      // Per user feedback, use .replace() to only replace the first occurrence.
      newContent = originalContent.replace(searchString, replaceString);
    } else {
      throw new Error('ApplyDiff requires either "diffContent" or both "searchString" and "replaceString" parameters.');
    }

    const editResult = await editFile(filePath, newContent, encoding);
    if (editResult.success) {
      editResult.data.message = '文件编辑成功';
    }
    return await runValidationAndAttachResults(editResult, filePath, newContent);
  } catch (error) {
    return { success: false, error: `Failed to apply diff: ${error.message}` };
  }
}

// Batch processing for legacy format with robust content and action aggregation
async function processBatchRequest(request) {
  debugLog('Processing legacy batch request with robust aggregation', { request });

  const aggregatedContent = [];
  const summaryMessages = [];
  let i = 1;
  let successCount = 0;
  let failureCount = 0;

  while (request[`command${i}`]) {
    const command = request[`command${i}`];
    const parameters = {};
    Object.keys(request).forEach(key => {
      if (key.endsWith(i.toString()) && key !== `command${i}`) {
        const paramName = key.slice(0, -i.toString().length);
        parameters[paramName] = request[key];
      }
    });

    let result;
    try {
      switch (command) {
        case 'ReadFile':
        case 'WebReadFile':
          const filePath = parameters.filePath || parameters.url;
          result = command === 'ReadFile' ? await readFile(filePath) : await webReadFile(filePath);
          if (result.success) {
            // Add a text header for the file content
            aggregatedContent.push({ type: 'text', text: `--- Content of ${result.data.fileName || filePath} ---` });
            if (Array.isArray(result.data.content)) {
              aggregatedContent.push(...result.data.content);
            } else if (typeof result.data.content === 'string') {
              aggregatedContent.push({ type: 'text', text: result.data.content });
            }
          }
          break;
        case 'ListDirectory':
          result = await listDirectory(parameters.directoryPath, parameters.showHidden);
          if (result.success && result.data.content) {
            aggregatedContent.push({ type: 'text', text: `--- Directory listing of ${parameters.directoryPath} ---` });
            aggregatedContent.push(...result.data.content);
          }
          break;
        case 'FileInfo':
          result = await getFileInfo(parameters.filePath);
          if (result.success && result.data.content) {
            aggregatedContent.push({ type: 'text', text: `--- File info of ${parameters.filePath} ---` });
            aggregatedContent.push(...result.data.content);
          }
          break;
        case 'SearchFiles':
          result = await searchFiles(parameters.searchPath, parameters.pattern, parameters.options);
          if (result.success && result.data.content) {
            aggregatedContent.push({ type: 'text', text: `--- Search results for "${parameters.pattern}" in ${parameters.searchPath} ---` });
            aggregatedContent.push(...result.data.content);
          }
          break;
        case 'CopyFile':
          result = await copyFile(parameters.sourcePath, parameters.destinationPath);
          break;
        case 'MoveFile':
          result = await moveFile(parameters.sourcePath, parameters.destinationPath);
          break;
        case 'RenameFile':
          result = await renameFile(parameters.sourcePath, parameters.destinationPath);
          break;
        case 'DeleteFile':
          result = await deleteFile(parameters.filePath);
          break;
        case 'CreateDirectory':
          result = await createDirectory(parameters.directoryPath);
          break;
        case 'WriteFile':
          result = await writeFile(parameters.filePath, parameters.content, parameters.encoding);
          break;
        case 'AppendFile':
          result = await appendFile(parameters.filePath, parameters.content, parameters.encoding);
          break;
        case 'EditFile':
          result = await editFile(parameters.filePath, parameters.content, parameters.encoding);
          break;
        case 'DownloadFile':
          result = await downloadFile(parameters.url);
          break;
        case 'CreateCanvas':
          result = await createCanvas(parameters.fileName, parameters.content, parameters.encoding);
          break;
        case 'UpdateHistory':
          result = await updateHistory(parameters.filePath, parameters.searchString, parameters.replaceString, parameters.encoding);
          break;
        case 'ApplyDiff':
          result = await applyDiff(parameters);
          break;
        case 'ListAllowedDirectories':
          result = await listAllowedDirectories();
          if (result.success && result.data.content) {
            aggregatedContent.push({ type: 'text', text: `--- Allowed Directories ---` });
            aggregatedContent.push(...result.data.content);
          }
          break;
        default:
          result = { success: false, error: `Unsupported batch command: ${command}` };
      }
    } catch (error) {
      result = { success: false, error: error.message };
    }

    if (result.success) {
      successCount++;
      // For non-read operations, generate a summary message instead of pushing to content
      const contentCommands = ['ReadFile', 'WebReadFile', 'ListDirectory', 'FileInfo', 'SearchFiles', 'ListAllowedDirectories'];
      if (!contentCommands.includes(command)) {
        summaryMessages.push(result.data.message);
      }
    } else {
      failureCount++;
      // Add error messages to the summary as well
      summaryMessages.push(`Error executing ${command}: ${result.error}`);
    }
    i++;
  }

  // Prepend summary of all non-read operations to the aggregated content
  if (summaryMessages.length > 0) {
    const summaryText = `Batch Operations Summary:\n- ${summaryMessages.join('\n- ')}`;
    aggregatedContent.unshift({ type: 'text', text: summaryText });
  }

  // If there's any content (from reads or summaries), return the aggregated multimodal response.
  if (aggregatedContent.length > 0) {
    return {
      success: true,
      data: {
        message: `Batch processing complete. Succeeded: ${successCount}, Failed: ${failureCount}.`,
        content: aggregatedContent,
      },
    };
  }

  // Fallback for batches with no read operations and no successful write operations
  return {
    success: true,
    data: {
      message: `Batch processing complete. Succeeded: ${successCount}, Failed: ${failureCount}.`,
      details: summaryMessages.join('\n'),
    },
  };
}

// Main execution function
async function processRequest(request) {
  // Legacy batch request detection
  if (request.command1) {
    return await processBatchRequest(request);
  }

  // Standard VCP request processing
  const { command, ...parameters } = request;
  const action = command;

  debugLog('Processing request', { action, parameters });

  switch (action) {
    case 'ListAllowedDirectories':
      return await listAllowedDirectories();
    case 'ReadFile':
      return await readFile(parameters.filePath, parameters.encoding);
    case 'WebReadFile':
      return await webReadFile(parameters.url || parameters.filePath);
    case 'WriteFile':
      return await writeFile(parameters.filePath, parameters.content, parameters.encoding);
    case 'WriteEscapedFile':
      return await writeEscapedFile(parameters.filePath, parameters.content, parameters.encoding);
    case 'AppendFile':
      return await appendFile(parameters.filePath, parameters.content, parameters.encoding);
    case 'EditFile':
      return await editFile(parameters.filePath, parameters.content, parameters.encoding);
    case 'ListDirectory':
      return await listDirectory(parameters.directoryPath, parameters.showHidden);
    case 'FileInfo':
      return await getFileInfo(parameters.filePath);
    case 'CopyFile':
      return await copyFile(parameters.sourcePath, parameters.destinationPath);
    case 'MoveFile':
      return await moveFile(parameters.sourcePath, parameters.destinationPath);
    case 'RenameFile':
      return await renameFile(parameters.sourcePath, parameters.destinationPath);
    case 'DeleteFile':
      return await deleteFile(parameters.filePath);
    case 'CreateDirectory':
      return await createDirectory(parameters.directoryPath);
    case 'SearchFiles':
      return await searchFiles(parameters.searchPath, parameters.pattern, parameters.options);
    case 'DownloadFile':
      return await downloadFile(parameters.url);
    case 'CreateCanvas':
      return await createCanvas(parameters.fileName, parameters.content, parameters.encoding);
    case 'UpdateHistory':
      return await updateHistory(parameters.filePath, parameters.searchString, parameters.replaceString, parameters.encoding);
    case 'ApplyDiff':
      return await applyDiff(parameters);
    default:
      return {
        success: false,
        error: `Unknown action: ${action}`,
      };
  }
}

// Setup stdio communication
process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  try {
    const lines = data.toString().trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const request = JSON.parse(line); // This is now the flat object from VCP
      const response = await processRequest(request);

      // Convert internal format to VCP protocol format
      const vcpResponse = convertToVCPFormat(response);
      console.log(JSON.stringify(vcpResponse));
    }
  } catch (error) {
    const errorResponse = {
      status: 'error',
      error: `Invalid request format: ${error.message}`,
    };
    console.log(JSON.stringify(errorResponse));
  }
});

// Convert internal response format to VCP protocol format
function convertToVCPFormat(response) {
  if (response.success) {
    const data = response.data || {};

    // Special action handling
    if (data._specialAction) {
      debugLog('Converting response with special action', {
        action: data._specialAction,
        payload: data.payload
      });

      return {
        status: 'success',
        _specialAction: data._specialAction,
        payload: data.payload,
        result: {
          content: [{ type: 'text', text: data.message || 'Operation completed successfully' }],
          details: data.payload
        },
      };
    }

    let contentArray = [];

    // 1. Handle content if present
    if (data.content) {
      if (Array.isArray(data.content)) {
        contentArray.push(...data.content);
      } else {
        contentArray.push({ type: 'text', text: data.content });
      }
    }

    // 2. Handle message if present
    if (data.message) {
      // Check if message is already represented in content
      const alreadyHasMessage = contentArray.some(part => part.type === 'text' && part.text.includes(data.message));
      if (!alreadyHasMessage) {
        contentArray.unshift({ type: 'text', text: data.message });
      }
    }

    // 3. Handle details/items/results if content is still empty
    if (contentArray.length === 0) {
      if (data.items) {
        contentArray.push({ type: 'text', text: `Items found (${data.totalItems || data.items.length}):\n${JSON.stringify(data.items, null, 2)}` });
      } else if (data.results) {
        contentArray.push({ type: 'text', text: `Search results (${data.totalResults || data.results.length}):\n${JSON.stringify(data.results, null, 2)}` });
      } else if (data.details) {
        contentArray.push({ type: 'text', text: typeof data.details === 'string' ? data.details : JSON.stringify(data.details, null, 2) });
      }
    }

    // 4. Add validation results if present
    if (data.validation && Array.isArray(data.validation)) {
      contentArray.push({ type: 'text', text: `Code Validation Results:\n${JSON.stringify(data.validation, null, 2)}` });
    }

    // 5. Fallback for other structured data
    if (contentArray.length === 0) {
      const { content, message, details, validation, ...rest } = data;
      if (Object.keys(rest).length > 0) {
        contentArray.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
      } else {
        contentArray.push({ type: 'text', text: 'Operation completed successfully' });
      }
    }

    return {
      status: 'success',
      result: {
        content: contentArray,
        details: data
      },
    };
  } else {
    return {
      status: 'error',
      error: response.error || 'Unknown error occurred',
    };
  }
}

// Handle process termination
process.on('SIGTERM', () => {
  debugLog('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  debugLog('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

debugLog('FileOperator plugin started and listening for requests');
