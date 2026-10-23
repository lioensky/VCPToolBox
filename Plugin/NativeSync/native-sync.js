'use strict';
const fs = require('node:fs');
const path = require('node:path');
let service = null, store = null, dataDir = null;
let mobile = null;
let mobileHostAuthority = null;
const lifecycle = { initialized: 0, namespacedRegistrations: 0, compatibilityRegistrations: 0, shutdowns: 0 };
const mounted = new WeakSet();

async function initialize(config = {}) {
    await shutdown();
    if (config.NativeSyncEnabled !== true) return;
    // Keep older hosts usable while disabled; SQLite is loaded only on opt-in.
    if (Number(process.versions.node.split('.')[0]) < 24) throw Object.assign(new Error('NATIVE_SYNC_NODE_24_REQUIRED'), { code: 'NATIVE_SYNC_NODE_24_REQUIRED' });
    const { CentralStore } = require('./sync/centralStore');
    const { createSyncHttpService } = require('./sync/httpService');
    if (typeof config.NativeSyncDataDir !== 'string' || !path.isAbsolute(config.NativeSyncDataDir)) throw new Error('NATIVE_SYNC_EXPLICIT_ABSOLUTE_DATA_DIR_REQUIRED');
    const target = path.resolve(config.NativeSyncDataDir);
    const project = path.resolve(config.PROJECT_BASE_PATH || __dirname);
    if (target === project || target === path.parse(target).root) throw new Error('NATIVE_SYNC_DEDICATED_DATA_DIR_REQUIRED');
    // Reject aliases rather than letting the SQLite file escape its owner path.
    let current = path.parse(target).root;
    for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('NATIVE_SYNC_DATA_DIR_ALIAS');
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const dbPath = path.join(target, 'central.sqlite');
    if (fs.existsSync(dbPath) && (fs.lstatSync(dbPath).isSymbolicLink() || fs.statSync(dbPath).nlink > 1)) throw new Error('NATIVE_SYNC_DB_ALIAS');
    store = new CentralStore(dbPath); dataDir = target;
    service = createSyncHttpService(store); lifecycle.initialized++;
    try {
        if (config.NativeMobileEnabled === true) {
            mobile = new (require('./mobile/portal').MobilePortal)({ store, config, agentManager: mobileHostAuthority?.agentManager || require('../../modules/agentManager') });
            if(mobileHostAuthority?.verifyKey)mobile.connection.verifyKey=mobileHostAuthority.verifyKey;
        }
    } catch (error) {
        await shutdown();
        throw error;
    }
}
function dispatch(req, res) {
    if (service) return service.handle(req, res);
    res.status(503).json({ error: { code: 'SYNC_SERVICE_DISABLED', message: 'Native sync service is not initialized' } });
}
function registerApiRoutes(router) {
    router.use('/sync', dispatch); lifecycle.namespacedRegistrations++;
    router.post('/mobile/pairing', (_req,res) => {
        if (!mobile) return res.status(503).json({error:{code:'MOBILE_DISABLED'}});
        res.set('Cache-Control','no-store');res.json(mobile.createPairing());
    });
    router.post('/mobile/catalog', (req,res) => {
        if (!mobile) return res.status(503).json({error:{code:'MOBILE_DISABLED'}});
        try { res.set('Cache-Control','no-store');res.json(mobile.publishCatalog(req.body)); }
        catch(e) { res.status(e.status||400).json({error:{code:e.code||'INVALID_CATALOG'}}); }
    });
}
function registerRoutes(app, _adminApiRouter, _config, _projectBasePath) {
    if (mounted.has(app)) return;
    // Supported VCPToolBox legacy service registration preserves the R4 client
    // URL/wire contract. server.js installs its global Bearer gate before this.
    app.use('/api/v1/sync', dispatch); mounted.add(app); lifecycle.compatibilityRegistrations++;
}
async function shutdown() {
    if (!service) return;
    const closing = service;
    service = null;
    await mobile?.close(); mobile = null;
    await closing.close(); store = null; dataDir = null; lifecycle.shutdowns++;
}
function snapshot() {
    return { ready: Boolean(service), dataDir, lifecycle: { ...lifecycle }, mobile:mobile?.snapshot()??null, metrics: store?.metrics() ?? null, entries: store ? store.db.prepare('SELECT owner_type AS ownerType, owner_id AS ownerId, topic_id AS topicId, msg_id AS msgId, hash, deleted, last_seq AS seq FROM messages ORDER BY owner_type,owner_id,topic_id,msg_id').all() : [] };
}
function handleMobile(req,res) { if(!mobile)return res.status(503).json({error:{code:'MOBILE_DISABLED'}});return mobile.router(req,res,()=>res.status(404).end()); }
function setExecutionEndpoint(value) { mobile?.engine.setEndpoint(value); }
function beginDrain() { mobile?.beginDrain(); }
function setMobileHostAuthority(value) {
    if(!value?.agentManager||typeof value.agentManager.isAgent!=='function'||typeof value.agentManager.getAgentPrompt!=='function'||typeof value.verifyKey!=='function')throw new Error('INVALID_MOBILE_HOST_AUTHORITY');
    mobileHostAuthority=value;
    if(mobile){mobile.agentManager=value.agentManager;mobile.engine.agentManager=value.agentManager;mobile.connection.verifyKey=value.verifyKey;}
}
function mobileConnectionInfo(){return mobile?.connection.information() || {credentialExchangeAllowed:false};}
module.exports = { initialize, registerApiRoutes, registerRoutes, shutdown, snapshot, handleMobile, setExecutionEndpoint, beginDrain, setMobileHostAuthority, mobileConnectionInfo };
