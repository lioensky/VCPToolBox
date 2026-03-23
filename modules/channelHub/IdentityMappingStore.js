// modules/channelHub/IdentityMappingStore.js
/**
 * 身份映射存储
 * 
 * 职责：
 * - 记录平台用户身份与 VCP 内部身份的映射关系
 * - 维护 userId / corpId / openId / unionId / qqId 等映射
 * - 预留同人跨平台合并能力
 * - 支持人工修正映射
 * 
 * 数据结构：
 * - 主键：platform + platformUserId
 * - 支持一个内部用户绑定多个平台身份
 * - 支持跨平台身份合并
 */

const StateStore = require('./StateStore');
const { nowTimestamp, createRequestId } = require('./utils');

class IdentityMappingStore {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.debugMode = options.debugMode || false;
  }

  /**
   * 获取身份映射
   * @param {Object} key - 查询键
   * @param {string} key.platform - 平台标识
   * @param {string} key.platformUserId - 平台用户ID
   * @returns {Promise<Object|null>} - 身份记录
   */
  async getIdentity(key) {
    const data = await this.stateStore.getIdentityMap();
    const mappings = Object.values(data.mappings || {});
    const record = mappings.find((item) => {
      if (key.id && item.id === key.id) return true;
      return item.platform === key.platform && item.platformUserId === key.platformUserId;
    });

    if (this.debugMode) {
      console.log('[IdentityMappingStore] getIdentity called with key:', key);
    }
    return record || null;
  }

  /**
   * 链接身份
   * @param {Object} record - 身份记录
   * @param {string} record.platform - 平台标识
   * @param {string} record.platformUserId - 平台用户ID
   * @param {string} record.internalUserId - 内部用户ID
   * @param {string} record.displayName - 显示名称
   * @param {Object} record.metadata - 附加元数据
   * @returns {Promise<Object>} - 创建的身份记录
   */
  async linkIdentity(record) {
    const existing = await this.getIdentity({
      id: record.id,
      platform: record.platform,
      platformUserId: record.platformUserId
    });

    if (existing) {
      const updated = {
        ...existing,
        ...record,
        updatedAt: nowTimestamp()
      };

      const data = await this.stateStore.getIdentityMap();
      data.mappings = data.mappings || {};
      data.mappings[updated.id] = updated;
      await this.stateStore.saveIdentityMap(data);
      return updated;
    }

    const identityRecord = {
      id: createRequestId('identity'),
      adapterId: record.adapterId || null,
      platform: record.platform,
      platformUserId: record.platformUserId,
      internalUserId: record.internalUserId,
      displayName: record.displayName,
      metadata: record.metadata || {},
      linkedAt: nowTimestamp(),
      linkedBy: record.linkedBy || 'system',
      updatedAt: nowTimestamp()
    };
    
    if (this.debugMode) {
      console.log('[IdentityMappingStore] linkIdentity created:', identityRecord.id);
    }

    const data = await this.stateStore.getIdentityMap();
    data.mappings = data.mappings || {};
    data.mappings[identityRecord.id] = identityRecord;
    await this.stateStore.saveIdentityMap(data);
    
    return identityRecord;
  }

  /**
   * 解除身份链接
   * @param {Object} key - 查询键
   * @returns {Promise<boolean>} - 是否成功
   */
  async unlinkIdentity(key) {
    const data = await this.stateStore.getIdentityMap();
    const mappings = data.mappings || {};
    const target = Object.entries(mappings).find(([id, item]) => {
      if (key.id && id === key.id) return true;
      return item.platform === key.platform && item.platformUserId === key.platformUserId;
    });

    if (this.debugMode) {
      console.log('[IdentityMappingStore] unlinkIdentity called for:', key);
    }

    if (!target) {
      return false;
    }

    delete mappings[target[0]];
    await this.stateStore.saveIdentityMap(data);
    return true;
  }

  /**
   * 查询身份列表
   * @param {Object} filter - 过滤条件
   * @param {string} filter.platform - 平台标识
   * @param {string} filter.internalUserId - 内部用户ID
   * @returns {Promise<Array>} - 身份记录列表
   */
  async queryIdentities(filter = {}) {
    const data = await this.stateStore.getIdentityMap();
    let mappings = Object.values(data.mappings || {});

    if (filter.adapterId) {
      mappings = mappings.filter((item) => item.adapterId === filter.adapterId);
    }
    if (filter.platform) {
      mappings = mappings.filter((item) => item.platform === filter.platform);
    }
    if (filter.externalId) {
      mappings = mappings.filter((item) => item.platformUserId === filter.externalId);
    }
    if (filter.internalUserId) {
      mappings = mappings.filter((item) => item.internalUserId === filter.internalUserId);
    }

    if (this.debugMode) {
      console.log('[IdentityMappingStore] queryIdentities called with filter:', filter);
    }
    return mappings;
  }

  /**
   * 合并跨平台身份
   * @param {string} targetInternalUserId - 目标内部用户ID
   * @param {Array} sourceIdentityIds - 源身份ID列表
   * @returns {Promise<Object>} - 合并结果
   */
  async mergeIdentities(targetInternalUserId, sourceIdentityIds) {
    const data = await this.stateStore.getIdentityMap();
    const mappings = data.mappings || {};
    let merged = 0;

    for (const sourceIdentityId of sourceIdentityIds) {
      if (!mappings[sourceIdentityId]) continue;
      mappings[sourceIdentityId] = {
        ...mappings[sourceIdentityId],
        internalUserId: targetInternalUserId,
        mergedAt: nowTimestamp(),
        updatedAt: nowTimestamp()
      };
      merged += 1;
    }

    await this.stateStore.saveIdentityMap(data);

    if (this.debugMode) {
      console.log('[IdentityMappingStore] mergeIdentities called:', {
        targetInternalUserId,
        sourceIdentityIds
      });
    }
    return { merged };
  }

  /**
   * 根据平台用户信息查找或创建内部用户
   * @param {Object} platformUserInfo - 平台用户信息
   * @returns {Promise<Object>} - 身份记录
   */
  async findOrCreateIdentity(platformUserInfo) {
    const existing = await this.getIdentity({
      platform: platformUserInfo.platform,
      platformUserId: platformUserInfo.platformUserId
    });
    
    if (existing) {
      return existing;
    }
    
    return this.linkIdentity({
      adapterId: platformUserInfo.adapterId,
      platform: platformUserInfo.platform,
      platformUserId: platformUserInfo.platformUserId,
      internalUserId: platformUserInfo.internalUserId || createRequestId('user'),
      displayName: platformUserInfo.displayName,
      metadata: platformUserInfo.metadata
    });
  }

  async list(filter = {}) {
    return this.queryIdentities(filter);
  }

  async delete(id) {
    return this.unlinkIdentity({ id });
  }
}

module.exports = IdentityMappingStore;
