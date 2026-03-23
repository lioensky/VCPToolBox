/**
 * MediaGateway - 媒体文件网关
 * 
 * 职责：
 * - 处理媒体文件的上传、下载、转码
 * - 管理平台媒体存储映射
 * - 生成媒体访问URL
 * - 支持缩略图生成和格式转换
 * 
 * @module MediaGateway
 */

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { MediaError } = require('./errors');

/**
 * 媒体类型枚举
 */
const MediaType = {
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file'
};

/**
 * 支持的图片格式
 */
const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

/**
 * 支持的音频格式
 */
const SUPPORTED_AUDIO_FORMATS = ['mp3', 'wav', 'amr', 'm4a', 'ogg'];

/**
 * 支持的视频格式
 */
const SUPPORTED_VIDEO_FORMATS = ['mp4', 'mov', 'avi', 'mkv', 'webm'];

/**
 * MediaGateway 类
 * 负责媒体文件的处理和管理
 */
class MediaGateway {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.storagePath - 媒体存储根路径
   * @param {string} options.baseUrl - 媒体访问基础URL
   * @param {number} options.maxFileSize - 最大文件大小（字节）
   * @param {Object} options.transcodeOptions - 转码配置
   * @param {Object} options.thumbnailOptions - 缩略图配置
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || './media';
    this.baseUrl = options.baseUrl || '/media';
    this.maxFileSize = options.maxFileSize || 50 * 1024 * 1024; // 默认50MB
    this.transcodeOptions = options.transcodeOptions || {
      imageQuality: 85,
      thumbnailSize: 200
    };
    this.thumbnailOptions = options.thumbnailOptions || {
      width: 200,
      height: 200,
      quality: 80
    };
    
    // 媒体索引缓存
    this.mediaIndex = new Map();
    
    // 平台媒体ID映射
    this.platformMediaMap = new Map();
  }

  /**
   * 初始化媒体网关
   * @returns {Promise<void>}
   */
  async initialize() {
    // 确保存储目录存在
    await this._ensureDirectories();
    
    // 加载现有媒体索引
    await this._loadMediaIndex();
    
    console.log('[MediaGateway] 初始化完成');
  }

  /**
   * 确保必要的目录存在
   * @private
   * @returns {Promise<void>}
   */
  async _ensureDirectories() {
    const directories = [
      this.storagePath,
      path.join(this.storagePath, 'image'),
      path.join(this.storagePath, 'audio'),
      path.join(this.storagePath, 'video'),
      path.join(this.storagePath, 'file'),
      path.join(this.storagePath, 'thumbnail'),
      path.join(this.storagePath, 'temp')
    ];
    
    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  /**
   * 加载媒体索引
   * @private
   * @returns {Promise<void>}
   */
  async _loadMediaIndex() {
    const indexPath = path.join(this.storagePath, 'media-index.json');
    
    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(data);
      
      for (const [mediaId, info] of Object.entries(index)) {
        this.mediaIndex.set(mediaId, info);
      }
      
      console.log(`[MediaGateway] 加载 ${this.mediaIndex.size} 个媒体索引`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[MediaGateway] 加载媒体索引失败:', error.message);
      }
    }
  }

  /**
   * 保存媒体索引
   * @private
   * @returns {Promise<void>}
   */
  async _saveMediaIndex() {
    const indexPath = path.join(this.storagePath, 'media-index.json');
    const index = Object.fromEntries(this.mediaIndex);
    
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * 检测媒体类型
   * @param {string} filename - 文件名
   * @param {string} [mimeType] - MIME类型
   * @returns {string} 媒体类型
   */
  detectMediaType(filename, mimeType) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    
    if (mimeType) {
      if (mimeType.startsWith('image/')) return MediaType.IMAGE;
      if (mimeType.startsWith('audio/')) return MediaType.AUDIO;
      if (mimeType.startsWith('video/')) return MediaType.VIDEO;
    }
    
    if (SUPPORTED_IMAGE_FORMATS.includes(ext)) return MediaType.IMAGE;
    if (SUPPORTED_AUDIO_FORMATS.includes(ext)) return MediaType.AUDIO;
    if (SUPPORTED_VIDEO_FORMATS.includes(ext)) return MediaType.VIDEO;
    
    return MediaType.FILE;
  }

  /**
   * 生成媒体ID
   * @private
   * @param {string} adapterId - 适配器ID
   * @param {string} platformMediaId - 平台媒体ID
   * @returns {string} 媒体ID
   */
  _generateMediaId(adapterId, platformMediaId) {
    const hash = crypto.createHash('sha256');
    hash.update(`${adapterId}:${platformMediaId}:${Date.now()}`);
    return hash.digest('hex').substring(0, 32);
  }

  /**
   * 上传媒体文件
   * @param {Object} options - 上传选项
   * @param {string} options.adapterId - 适配器ID
   * @param {Buffer|ReadStream} options.data - 文件数据
   * @param {string} options.filename - 原始文件名
   * @param {string} [options.mimeType] - MIME类型
   * @param {string} [options.platformMediaId] - 平台媒体ID
   * @param {Object} [options.metadata] - 元数据
   * @returns {Promise<Object>} 上传结果
   */
  async uploadMedia(options) {
    const { adapterId, data, filename, mimeType, platformMediaId, metadata } = options;
    
    // 检测媒体类型
    const mediaType = this.detectMediaType(filename, mimeType);
    
    // 生成媒体ID
    const mediaId = this._generateMediaId(adapterId, platformMediaId || filename);
    
    // 构建存储路径
    const ext = path.extname(filename).toLowerCase();
    const subPath = path.join(mediaType, `${mediaId}${ext}`);
    const fullPath = path.join(this.storagePath, subPath);
    
    // 写入文件
    try {
      if (Buffer.isBuffer(data)) {
        await fs.writeFile(fullPath, data);
      } else {
        // 流式写入
        const writeStream = require('fs').createWriteStream(fullPath);
        await new Promise((resolve, reject) => {
          data.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
      }
    } catch (error) {
      throw new MediaError(`上传媒体文件失败: ${error.message}`);
    }
    
    // 获取文件信息
    const stats = await fs.stat(fullPath);
    
    // 创建媒体信息
    const mediaInfo = {
      mediaId,
      adapterId,
      platformMediaId,
      filename,
      mimeType: mimeType || 'application/octet-stream',
      mediaType,
      size: stats.size,
      path: subPath,
      url: `${this.baseUrl}/${subPath}`,
      createdAt: new Date().toISOString(),
      metadata: metadata || {}
    };
    
    // 更新索引
    this.mediaIndex.set(mediaId, mediaInfo);
    await this._saveMediaIndex();
    
    // 更新平台映射
    if (platformMediaId) {
      const mapKey = `${adapterId}:${platformMediaId}`;
      this.platformMediaMap.set(mapKey, mediaId);
    }
    
    console.log(`[MediaGateway] 上传媒体成功: ${mediaId} (${mediaType})`);
    
    return mediaInfo;
  }

  /**
   * 下载媒体文件
   * @param {string} mediaId - 媒体ID
   * @returns {Promise<Object>} 下载结果
   */
  async downloadMedia(mediaId) {
    const mediaInfo = this.mediaIndex.get(mediaId);
    
    if (!mediaInfo) {
      throw new MediaError(`媒体不存在: ${mediaId}`);
    }
    
    const fullPath = path.join(this.storagePath, mediaInfo.path);
    
    try {
      const buffer = await fs.readFile(fullPath);
      
      return {
        ...mediaInfo,
        data: buffer
      };
    } catch (error) {
      throw new MediaError(`下载媒体文件失败: ${error.message}`);
    }
  }

  /**
   * 获取媒体信息
   * @param {string} mediaId - 媒体ID
   * @returns {Object|null} 媒体信息
   */
  getMediaInfo(mediaId) {
    return this.mediaIndex.get(mediaId) || null;
  }

  /**
   * 通过平台媒体ID获取媒体信息
   * @param {string} adapterId - 适配器ID
   * @param {string} platformMediaId - 平台媒体ID
   * @returns {Object|null} 媒体信息
   */
  getMediaByPlatformId(adapterId, platformMediaId) {
    const mapKey = `${adapterId}:${platformMediaId}`;
    const mediaId = this.platformMediaMap.get(mapKey);
    
    if (!mediaId) return null;
    
    return this.mediaIndex.get(mediaId) || null;
  }

  /**
   * 获取媒体访问URL
   * @param {string} mediaId - 媒体ID
   * @param {Object} [options] - URL选项
   * @param {boolean} [options.thumbnail] - 是否获取缩略图
   * @param {number} [options.expiresIn] - URL过期时间（秒）
   * @returns {string|null} 访问URL
   */
  getMediaUrl(mediaId, options = {}) {
    const mediaInfo = this.mediaIndex.get(mediaId);
    
    if (!mediaInfo) return null;
    
    let url = mediaInfo.url;
    
    if (options.thumbnail && mediaInfo.mediaType === MediaType.IMAGE) {
      url = `${this.baseUrl}/thumbnail/${mediaId}`;
    }
    
    // TODO: 支持签名URL
    if (options.expiresIn) {
      // 生成带签名的临时URL
    }
    
    return url;
  }

  /**
   * 生成缩略图
   * @param {string} mediaId - 媒体ID
   * @param {Object} [options] - 缩略图选项
   * @param {number} [options.width] - 宽度
   * @param {number} [options.height] - 高度
   * @param {number} [options.quality] - 质量
   * @returns {Promise<Object>} 缩略图信息
   */
  async generateThumbnail(mediaId, options = {}) {
    const mediaInfo = this.mediaIndex.get(mediaId);
    
    if (!mediaInfo) {
      throw new MediaError(`媒体不存在: ${mediaId}`);
    }
    
    if (mediaInfo.mediaType !== MediaType.IMAGE) {
      throw new MediaError('只支持图片类型生成缩略图');
    }
    
    const { width = 200, height = 200, quality = 80 } = options;
    const thumbnailPath = path.join(this.storagePath, 'thumbnail', `${mediaId}.jpg`);
    
    // TODO: 使用 sharp 或其他图片处理库生成缩略图
    // 这里先创建一个占位实现
    console.log(`[MediaGateway] 生成缩略图: ${mediaId} (${width}x${height})`);
    
    return {
      mediaId,
      path: thumbnailPath,
      url: `${this.baseUrl}/thumbnail/${mediaId}`,
      width,
      height,
      quality
    };
  }

  /**
   * 转码媒体文件
   * @param {string} mediaId - 媒体ID
   * @param {Object} options - 转码选项
   * @param {string} options.format - 目标格式
   * @param {number} [options.quality] - 质量
   * @returns {Promise<Object>} 转码后的媒体信息
   */
  async transcodeMedia(mediaId, options) {
    const mediaInfo = this.mediaIndex.get(mediaId);
    
    if (!mediaInfo) {
      throw new MediaError(`媒体不存在: ${mediaId}`);
    }
    
    const { format, quality } = options;
    
    // TODO: 实现转码逻辑
    // 需要根据媒体类型调用不同的转码器
    console.log(`[MediaGateway] 转码媒体: ${mediaId} -> ${format}`);
    
    throw new MediaError('转码功能尚未实现');
  }

  /**
   * 删除媒体文件
   * @param {string} mediaId - 媒体ID
   * @returns {Promise<boolean>} 删除结果
   */
  async deleteMedia(mediaId) {
    const mediaInfo = this.mediaIndex.get(mediaId);
    
    if (!mediaInfo) {
      return false;
    }
    
    try {
      // 删除主文件
      const fullPath = path.join(this.storagePath, mediaInfo.path);
      await fs.unlink(fullPath);
      
      // 删除缩略图
      const thumbnailPath = path.join(this.storagePath, 'thumbnail', `${mediaId}.jpg`);
      try {
        await fs.unlink(thumbnailPath);
      } catch (e) {
        // 缩略图可能不存在
      }
      
      // 更新索引
      this.mediaIndex.delete(mediaId);
      await this._saveMediaIndex();
      
      // 更新平台映射
      if (mediaInfo.platformMediaId) {
        const mapKey = `${mediaInfo.adapterId}:${mediaInfo.platformMediaId}`;
        this.platformMediaMap.delete(mapKey);
      }
      
      console.log(`[MediaGateway] 删除媒体成功: ${mediaId}`);
      
      return true;
    } catch (error) {
      throw new MediaError(`删除媒体文件失败: ${error.message}`);
    }
  }

  /**
   * 清理临时文件
   * @param {number} [maxAge] - 最大保留时间（毫秒）
   * @returns {Promise<number>} 清理的文件数量
   */
  async cleanupTempFiles(maxAge = 24 * 60 * 60 * 1000) {
    const tempPath = path.join(this.storagePath, 'temp');
    const now = Date.now();
    let count = 0;
    
    try {
      const files = await fs.readdir(tempPath);
      
      for (const file of files) {
        const filePath = path.join(tempPath, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          count++;
        }
      }
      
      if (count > 0) {
        console.log(`[MediaGateway] 清理 ${count} 个临时文件`);
      }
      
      return count;
    } catch (error) {
      console.warn('[MediaGateway] 清理临时文件失败:', error.message);
      return 0;
    }
  }

  /**
   * 获取存储统计信息
   * @returns {Object} 统计信息
   */
  getStorageStats() {
    const stats = {
      totalFiles: this.mediaIndex.size,
      totalSize: 0,
      byType: {
        [MediaType.IMAGE]: { count: 0, size: 0 },
        [MediaType.AUDIO]: { count: 0, size: 0 },
        [MediaType.VIDEO]: { count: 0, size: 0 },
        [MediaType.FILE]: { count: 0, size: 0 }
      },
      byAdapter: {}
    };
    
    for (const [, info] of this.mediaIndex) {
      stats.totalSize += info.size;
      stats.byType[info.mediaType].count++;
      stats.byType[info.mediaType].size += info.size;
      
      if (!stats.byAdapter[info.adapterId]) {
        stats.byAdapter[info.adapterId] = { count: 0, size: 0 };
      }
      stats.byAdapter[info.adapterId].count++;
      stats.byAdapter[info.adapterId].size += info.size;
    }
    
    return stats;
  }

  /**
   * 导出媒体列表
   * @param {Object} [filter] - 过滤条件
   * @returns {Array<Object>} 媒体列表
   */
  exportMediaList(filter = {}) {
    const list = [];
    
    for (const [mediaId, info] of this.mediaIndex) {
      if (filter.adapterId && info.adapterId !== filter.adapterId) continue;
      if (filter.mediaType && info.mediaType !== filter.mediaType) continue;
      
      list.push({
        mediaId,
        ...info
      });
    }
    
    return list;
  }
}

module.exports = MediaGateway;
module.exports.MediaType = MediaType;
module.exports.SUPPORTED_IMAGE_FORMATS = SUPPORTED_IMAGE_FORMATS;
module.exports.SUPPORTED_AUDIO_FORMATS = SUPPORTED_AUDIO_FORMATS;
module.exports.SUPPORTED_VIDEO_FORMATS = SUPPORTED_VIDEO_FORMATS;