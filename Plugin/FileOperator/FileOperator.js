const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const glob = require('glob');
const { minimatch } = require('minimatch');

// Load environment variables
require('dotenv').config();

// Configuration
const ALLOWED_DIRECTORIES = (process.env.ALLOWED_DIRECTORIES || '')
  .split(',')
  .map(dir => dir.trim())
  .filter(dir => dir);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 10485760; // 10MB default
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

function isPathAllowed(targetPath) {
  const resolvedPath = path.resolve(targetPath);

  if (ALLOWED_DIRECTORIES.length === 0) {
    return true; // No restrictions if no directories specified
  }

  return ALLOWED_DIRECTORIES.some(allowedDir => {
    const resolvedAllowedDir = path.resolve(allowedDir);
    return resolvedPath.startsWith(resolvedAllowedDir);
  });
}

function formatFileSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

// File operation functions
async function readFile(filePath, encoding = 'utf8') {
  try {
    debugLog('Reading file', { filePath, encoding });

    if (!isPathAllowed(filePath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    const content = await fs.readFile(filePath, encoding);

    return {
      success: true,
      data: {
        content: content,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
        encoding: encoding,
      },
    };
  } catch (error) {
    debugLog('Error reading file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function writeFile(filePath, content, encoding = 'utf8') {
  try {
    debugLog('Writing file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    if (Buffer.byteLength(content, encoding) > MAX_FILE_SIZE) {
      throw new Error(`Content too large: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    await fs.writeFile(filePath, content, encoding);
    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
        message: 'File written successfully',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error writing file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function appendFile(filePath, content, encoding = 'utf8') {
  try {
    debugLog('Appending to file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath)) {
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

    return {
      success: true,
      data: {
        message: 'Content appended successfully',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error appending to file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function listDirectory(dirPath, showHidden = ENABLE_HIDDEN_FILES) {
  try {
    debugLog('Listing directory', { dirPath, showHidden });

    if (!isPathAllowed(dirPath)) {
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

    return {
      success: true,
      data: {
        path: dirPath,
        items: result,
        totalItems: result.length,
        truncated: items.length > MAX_DIRECTORY_ITEMS,
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
    debugLog('Getting file info', { filePath });

    if (!isPathAllowed(filePath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
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
    debugLog('Copying file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath) || !isPathAllowed(destinationPath)) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    const stats = await fs.stat(sourcePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large to copy: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    await fs.copyFile(sourcePath, destinationPath);
    const destStats = await fs.stat(destinationPath);

    return {
      success: true,
      data: {
        message: 'File copied successfully',
        source: sourcePath,
        destination: destinationPath,
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
    debugLog('Moving file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath) || !isPathAllowed(destinationPath)) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    await fs.rename(sourcePath, destinationPath);
    const stats = await fs.stat(destinationPath);

    return {
      success: true,
      data: {
        message: 'File moved successfully',
        source: sourcePath,
        destination: destinationPath,
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

async function deleteFile(filePath) {
  try {
    debugLog('Deleting file', { filePath });

    if (!isPathAllowed(filePath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    const fileInfo = {
      path: filePath,
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      type: stats.isDirectory() ? 'directory' : 'file',
    };

    if (stats.isDirectory()) {
      await fs.rmdir(filePath, { recursive: ENABLE_RECURSIVE_OPERATIONS });
    } else {
      await fs.unlink(filePath);
    }

    return {
      success: true,
      data: {
        message: `${fileInfo.type} deleted successfully`,
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
    debugLog('Creating directory', { dirPath });

    if (!isPathAllowed(dirPath)) {
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
    debugLog('Searching files', { searchPath, pattern, options });

    if (!isPathAllowed(searchPath)) {
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

    return {
      success: true,
      data: {
        searchPath: searchPath,
        pattern: pattern,
        results: results,
        totalResults: results.length,
        truncated: files.length >= MAX_SEARCH_RESULTS,
        options: options,
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

async function listAllowedDirectories() {
  debugLog('Listing allowed directories content');
  if (ALLOWED_DIRECTORIES.length === 0) {
    return {
      success: false,
      error: 'No allowed directories configured. Cannot list projects.',
    };
  }

  try {
    const allProjects = {};
    for (const dir of ALLOWED_DIRECTORIES) {
      const items = await fs.readdir(dir);
      const subItems = [];
      for (const item of items.slice(0, MAX_DIRECTORY_ITEMS)) {
        try {
          const itemPath = path.join(dir, item);
          const stats = await fs.stat(itemPath);
          subItems.push({
            name: item,
            type: stats.isDirectory() ? 'directory' : 'file',
          });
        } catch (e) {
          // Ignore items that can't be stat'd
        }
      }
      allProjects[dir] = subItems;
    }
    return { success: true, data: { allowedRoots: allProjects } };
  } catch (error) {
    debugLog('Error listing allowed directories', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Main execution function
async function processRequest(request) {
  // 适配 VCP 标准：将 'command' 字段作为 action，其余字段作为参数
  const { command, ...parameters } = request;
  const action = command;

  debugLog('Processing request', { action, parameters });

  switch (action) {
    case 'ListAllowedDirectories':
      return await listAllowedDirectories();

    case 'ReadFile':
      return await readFile(parameters.filePath, parameters.encoding);

    case 'WriteFile':
      return await writeFile(parameters.filePath, parameters.content, parameters.encoding);

    case 'AppendFile':
      return await appendFile(parameters.filePath, parameters.content, parameters.encoding);

    case 'ListDirectory':
      return await listDirectory(parameters.directoryPath, parameters.showHidden);

    case 'FileInfo':
      return await getFileInfo(parameters.filePath);

    case 'CopyFile':
      return await copyFile(parameters.sourcePath, parameters.destinationPath);

    case 'MoveFile':
      return await moveFile(parameters.sourcePath, parameters.destinationPath);

    case 'DeleteFile':
      return await deleteFile(parameters.filePath);

    case 'CreateDirectory':
      return await createDirectory(parameters.directoryPath);

    case 'SearchFiles':
      return await searchFiles(parameters.searchPath, parameters.pattern, parameters.options);

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
    return {
      status: 'success',
      result: JSON.stringify(response.data || response.message || 'Operation completed successfully'),
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
