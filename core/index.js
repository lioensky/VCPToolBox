// core/index.js
/**
 * @fileoverview VCP 方案 2 核心模块统一导出入口
 */

'use strict';

const VcpCoreEngine = require('./VcpCoreEngine');
const types = require('./types');
const pipelineUtils = require('./pipelineUtils');
const upstreamFetch = require('./upstreamFetch');

module.exports = {
  VcpCoreEngine,
  ...types,
  pipelineUtils,
  upstreamFetch
};
