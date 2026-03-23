// 临时测试脚本：验证所有 ChannelHub 模块能否正常 require
const modules = [
  './modules/channelHub/constants',
  './modules/channelHub/errors',
  './modules/channelHub/utils',
  './modules/channelHub/StateStore',
  './modules/channelHub/AdapterRegistry',
  './modules/channelHub/AdapterAuthManager',
  './modules/channelHub/SignatureValidator',
  './modules/channelHub/EventSchemaValidator',
  './modules/channelHub/B1CompatTranslator',
  './modules/channelHub/EventDeduplicator',
  './modules/channelHub/MessageNormalizer',
  './modules/channelHub/SessionBindingStore',
  './modules/channelHub/IdentityMappingStore',
  './modules/channelHub/AgentRoutingPolicy',
  './modules/channelHub/RuntimeGateway',
  './modules/channelHub/ReplyNormalizer',
  './modules/channelHub/CapabilityRegistry',
  './modules/channelHub/CapabilityDowngrader',
  './modules/channelHub/MediaGateway',
  './modules/channelHub/DeliveryOutbox',
  './modules/channelHub/AuditLogger',
  './modules/channelHub/MetricsCollector',
  './modules/channelHub/ChannelHubService'
];

const results = [];
for (const mod of modules) {
  try {
    require(mod);
    results.push('OK ' + mod.split('/').pop());
  } catch (e) {
    results.push('FAIL ' + mod.split('/').pop() + ': ' + e.message.split('\n')[0]);
  }
}

try {
  require('./routes/internal/channelHub');
  results.push('OK routes/internal/channelHub');
} catch (e) {
  results.push('FAIL routes/internal/channelHub: ' + e.message.split('\n')[0]);
}

const c = require('./modules/channelHub/constants');
const expected = ['ADAPTER_STATUS','DELIVERY_STATUS','PRIORITY','DEDUP_TTL_MS','CHANNELS','CAPABILITY_FLAGS'];
const missing = expected.filter(k => !c[k]);
results.push(missing.length === 0 ? 'OK constants exports complete' : 'FAIL constants missing: ' + missing.join(', '));

console.log(results.join('\n'));
process.exit(0);