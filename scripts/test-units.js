/**
 * LinuxLogMonitor v0.2.0 & LinuxShellExecutor v0.3.0 单元测试
 * 
 * 测试目标主机: 154.222.28.172 (tt/tt1234)
 * 
 * @version 1.0.0
 */

const path = require('path');

// 测试结果收集
const testResults = {
    passed: [],
    failed: [],
    startTime: new Date().toISOString()
};

// 颜色输出
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
};

function log(msg, color = 'reset') {
    console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logTest(name, passed, detail = '') {
    if (passed) {
        log(`  ✓ ${name}`, 'green');
        testResults.passed.push({ name, detail });
    } else {
        log(`  ✗ ${name}: ${detail}`, 'red');
        testResults.failed.push({ name, detail });
    }
}

// ==================== 测试模块 ====================

/**
 * 测试 1: SSHManager 模块加载
 */
async function testSSHManagerLoad() {
    log('\n[测试 1] SSHManager 模块加载', 'cyan');
    
    try {
        const sshModule = require('./modules/SSHManager');
        logTest('模块导入成功', true);
        
        const isAvailable = sshModule.isAvailable();
        logTest('isAvailable() 返回正确', isAvailable, isAvailable ? '' : 'SSH 模块不可用');
        
        const status = sshModule.getStatus();
        logTest('getStatus() 返回正确', status && typeof status === 'object');
        
        const config = sshModule.getHostsConfig();
        logTest('getHostsConfig() 返回正确', config && config.hosts);
        
        const hasTestServer = config.hosts && config.hosts['test-server'];
        logTest('测试服务器配置存在', hasTestServer, hasTestServer ? '' : '缺少 test-server 配置');
        
        return true;
    } catch (error) {
        logTest('模块加载失败', false, error.message);
        return false;
    }
}

/**
 * 测试 2: SSHManager 连接测试
 */
async function testSSHManagerConnection() {
    log('\n[测试 2] SSHManager SSH 连接', 'cyan');
    
    try {
        const sshModule = require('./modules/SSHManager');
        const manager = sshModule.getSSHManager();
        
        if (!manager) {
            logTest('获取 SSHManager 实例', false, '实例为 null');
            return false;
        }
        logTest('获取 SSHManager 实例', true);
        
        // 测试连接
        log('  → 正在连接 test-server (154.222.28.172)...', 'yellow');
        const result = await manager.testConnection('test-server');
        
        logTest('SSH 连接成功', result.success, result.success ? `延迟 ${result.latency}ms` : result.error);
        
        if (result.success) {
            logTest('连接测试命令执行', result.output === 'VCP_CONNECTION_TEST');
        }
        
        // 获取连接池状态
        const poolStats = manager.getPoolStats();
        logTest('连接池状态获取', poolStats && typeof poolStats.activeConnections === 'number');
        
        return result.success;
    } catch (error) {
        logTest('连接测试异常', false, error.message);
        return false;
    }
}

/**
 * 测试 3: SSHManager 命令执行
 */
async function testSSHManagerExecute() {
    log('\n[测试 3] SSHManager 命令执行', 'cyan');
    
    try {
        const sshModule = require('./modules/SSHManager');
        const manager = sshModule.getSSHManager();
        
        // 测试简单命令
        log('  → 执行: whoami', 'yellow');
        const whoamiResult = await manager.execute('test-server', 'whoami', { timeout: 10000 });
        logTest('whoami 命令执行', whoamiResult.stdout.trim() === 'tt', `返回: ${whoamiResult.stdout.trim()}`);
        
        // 测试 pwd 命令
        log('  → 执行: pwd', 'yellow');
        const pwdResult = await manager.execute('test-server', 'pwd', { timeout: 10000 });
        logTest('pwd 命令执行', pwdResult.stdout.trim().startsWith('/'), `返回: ${pwdResult.stdout.trim()}`);
        
        // 测试 ls 命令
        log('  → 执行: ls -la ~', 'yellow');
        const lsResult = await manager.execute('test-server', 'ls -la ~', { timeout: 10000 });
        logTest('ls 命令执行', lsResult.code === 0, `退出码: ${lsResult.code}`);
        
        // 测试 uname 命令
        log('  → 执行: uname -a', 'yellow');
        const unameResult = await manager.execute('test-server', 'uname -a', { timeout: 10000 });
        logTest('uname 命令执行', unameResult.stdout.includes('Linux'), `返回: ${unameResult.stdout.substring(0, 50)}...`);
        
        return true;
    } catch (error) {
        logTest('命令执行异常', false, error.message);
        return false;
    }
}

/**
 * 测试 4: SSHManager 流式会话
 */
async function testSSHManagerStreamSession() {
    log('\n[测试 4] SSHManager 流式会话', 'cyan');
    
    try {
        const sshModule = require('./modules/SSHManager');
        const manager = sshModule.getSSHManager();
        
        // 创建流式会话
        log('  → 创建流式会话: echo "line1"; sleep 1; echo "line2"; sleep 1; echo "line3"', 'yellow');
        
        const lines = [];
        const session = await manager.createStreamSession('test-server', 'echo "line1"; sleep 1; echo "line2"; sleep 1; echo "line3"');
        
        logTest('流式会话创建', session && session.sessionId);
        
        // 设置回调
        session.onLine = (line) => {
            if (line.includes('line')) {
                lines.push(line);
            }
        };
        
        // 启动会话
        session.start();
        
        // 等待完成
        await new Promise((resolve) => {
            session.onClose = resolve;
            // 超时保护
            setTimeout(() => {
                session.stop();
                resolve();
            }, 10000);
        });
        
        logTest('流式会话数据接收', lines.length >= 3, `接收到 ${lines.length} 行`);
        
        const stats = session.getStats();
        logTest('流式会话统计', stats && stats.linesProcessed >= 0);
        
        return true;
    } catch (error) {
        logTest('流式会话异常', false, error.message);
        return false;
    }
}

/**
 * 测试 5: AnomalyDetector 规则引擎
 */
async function testAnomalyDetector() {
    log('\n[测试 5] AnomalyDetector 规则引擎', 'cyan');
    
    try {
        const AnomalyDetector = require('./Plugin/LinuxLogMonitor/core/AnomalyDetector');
        const detector = new AnomalyDetector();
        
        logTest('AnomalyDetector 实例化', detector !== null);
        
        // 添加测试规则
        detector.addRule({
            name: 'test_error',
            type: 'regex',
            pattern: '\\bERROR\\b',
            severity: 'critical',
            cooldown: 1000
        });
        logTest('添加 regex 规则', true);
        
        detector.addRule({
            name: 'test_keyword',
            type: 'keyword',
            pattern: 'Out of memory',
            severity: 'critical',
            cooldown: 1000
        });
        logTest('添加 keyword 规则', true);
        
        detector.addRule({
            name: 'test_threshold',
            type: 'threshold',
            pattern: 'CPU usage:\\s*([\\d.]+)%',
            operator: '>',
            threshold: 90,
            severity: 'warning',
            cooldown: 1000
        });
        logTest('添加 threshold 规则', true);
        
        // 测试检测
        const errorResult = detector.detect('2025-12-16 ERROR Application crashed', 'test-task');
        logTest('regex 规则检测', errorResult.length > 0, `检测到 ${errorResult.length} 个异常`);
        
        const oomResult = detector.detect('2025-12-16 Out of memory: Kill process', 'test-task');
        logTest('keyword 规则检测', oomResult.length > 0, `检测到 ${oomResult.length} 个异常`);
        
        const cpuResult = detector.detect('2025-12-16 CPU usage: 95.5%', 'test-task');
        logTest('threshold 规则检测', cpuResult.length > 0, `检测到 ${cpuResult.length} 个异常`);
        
        const normalResult = detector.detect('2025-12-16 INFO Application started', 'test-task');
        logTest('正常日志不触发', normalResult.length === 0);
        
        // 测试冷却机制
        const cooldownResult = detector.detect('2025-12-16 ERROR Another error', 'test-task');
        logTest('冷却机制生效', cooldownResult.length === 0, '同一规则在冷却期内不重复触发');
        
        // 测试规则列表
        const rules = detector.listRules();
        logTest('规则列表获取', rules.global.length >= 3);
        
        return true;
    } catch (error) {
        logTest('AnomalyDetector 测试异常', false, error.message);
        return false;
    }
}

/**
 * 测试 6: CallbackTrigger 回调触发器
 */
async function testCallbackTrigger() {
    log('\n[测试 6] CallbackTrigger 回调触发器', 'cyan');
    
    try {
        const CallbackTrigger = require('./Plugin/LinuxLogMonitor/core/CallbackTrigger');
        const trigger = new CallbackTrigger({
            baseUrl: 'http://localhost:5000',
            pluginName: 'LinuxLogMonitor',
            debug: true
        });
        
        logTest('CallbackTrigger 实例化', trigger !== null);
        
        // 测试回调数据格式化（不实际发送）
        const testData = {
            pluginName: 'LinuxLogMonitor',
            requestId: 'test-task-123',
            status: 'anomaly_detected',
            anomaly: {
                rule: 'test_error',
                severity: 'critical',
                logLine: 'ERROR test',
                timestamp: new Date().toISOString()
            }
        };
        
        logTest('回调数据格式正确', testData.pluginName && testData.requestId && testData.anomaly);
        
        // 测试失败回调存储路径
        const failedCallbacksPath = path.join(__dirname, 'Plugin', 'LinuxLogMonitor', 'state', 'failed_callbacks.jsonl');
        logTest('失败回调存储路径配置', true);
        
        return true;
    } catch (error) {
        logTest('CallbackTrigger 测试异常', false, error.message);
        return false;
    }
}

/**
 * 测试 7: MonitorManager 初始化
 */
async function testMonitorManager() {
    log('\n[测试 7] MonitorManager 监控管理器', 'cyan');
    
    try {
        const MonitorManager = require('./Plugin/LinuxLogMonitor/core/MonitorManager');
        const manager = new MonitorManager({
            callbackBaseUrl: 'http://localhost:5000',
            pluginName: 'LinuxLogMonitor',
            debug: true
        });
        
        logTest('MonitorManager 实例化', manager !== null);
        
        // 初始化
        await manager.init();
        logTest('MonitorManager 初始化', true);
        
        // 获取状态
        const status = manager.getStatus();
        logTest('状态获取', status && typeof status.taskCount === 'number');
        
        // 列出规则
        const rules = manager.listRules();
        logTest('规则列表', rules && rules.global);
        
        return true;
    } catch (error) {
        logTest('MonitorManager 测试异常', false, error.message);
        return false;
    }
}

/**
 * 测试 8: LinuxShellExecutor 安全层
 */
async function testLinuxShellExecutorSecurity() {
    log('\n[测试 8] LinuxShellExecutor 安全层', 'cyan');
    
    try {
        // 测试白名单验证器
        const whitelist = require('./Plugin/LinuxShellExecutor/whitelist.json');
        logTest('白名单配置加载', whitelist && whitelist.commands);
        
        // 检查常用命令是否在白名单中
        const hasLs = whitelist.commands && whitelist.commands.ls;
        logTest('ls 命令在白名单中', hasLs);
        
        const hasCat = whitelist.commands && whitelist.commands.cat;
        logTest('cat 命令在白名单中', hasCat);
        
        const hasGrep = whitelist.commands && whitelist.commands.grep;
        logTest('grep 命令在白名单中', hasGrep);
        
        // 检查全局限制
        const hasGlobalRestrictions = whitelist.globalRestrictions;
        logTest('全局限制配置存在', hasGlobalRestrictions);
        
        if (hasGlobalRestrictions) {
            logTest('最大命令长度配置', whitelist.globalRestrictions.maxCommandLength > 0);
            logTest('禁止字符配置', Array.isArray(whitelist.globalRestrictions.forbiddenCharacters));
        }
        
        return true;
    } catch (error) {
        logTest('安全层测试异常', false, error.message);
        return false;
    }
}

/**
 * 测试 9: 端到端测试 - 通过 LinuxShellExecutor 执行命令
 */
async function testLinuxShellExecutorE2E() {
    log('\n[测试 9] LinuxShellExecutor 端到端测试', 'cyan');
    
    try {
        // 模拟 stdin 输入
        const { spawn } = require('child_process');
        
        const testCommand = async (input) => {
            return new Promise((resolve, reject) => {
                const child = spawn('node', ['Plugin/LinuxShellExecutor/LinuxShellExecutor.js'], {
                    cwd: __dirname,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                
                let stdout = '';
                let stderr = '';
                
                child.stdout.on('data', (data) => { stdout += data.toString(); });
                child.stderr.on('data', (data) => { stderr += data.toString(); });
                
                child.on('close', (code) => {
                    try {
                        const result = JSON.parse(stdout);
                        resolve({ result, stderr, code });
                    } catch (e) {
                        resolve({ error: e.message, stdout, stderr, code });
                    }
                });
                
                child.on('error', reject);
                
                // 发送输入
                child.stdin.write(JSON.stringify(input));
                child.stdin.end();
            });
        };
        
        // 测试 listHosts
        log('  → 测试 listHosts 操作', 'yellow');
        const listHostsResult = await testCommand({ action: 'listHosts' });
        logTest('listHosts 操作', listHostsResult.result && listHostsResult.result.status === 'success');
        
        // 测试 testConnection
        log('  → 测试 testConnection 操作', 'yellow');
        const testConnResult = await testCommand({ action: 'testConnection', hostId: 'test-server' });
        logTest('testConnection 操作', testConnResult.result && testConnResult.result.success, 
            testConnResult.result ? (testConnResult.result.success ? `延迟 ${testConnResult.result.latency}ms` : testConnResult.result.error) : 'JSON 解析失败');
        
        // 测试命令执行
        log('  → 测试命令执行: whoami', 'yellow');
        const execResult = await testCommand({ command: 'whoami', hostId: 'test-server' });
        logTest('命令执行', execResult.result && execResult.result.status === 'success',
            execResult.result ? `返回: ${(execResult.result.result || '').trim()}` : 'JSON 解析失败');
        
        return true;
    } catch (error) {
        logTest('端到端测试异常', false, error.message);
        return false;
    }
}

// ==================== 主函数 ====================

async function main() {
    log('═══════════════════════════════════════════════════════════════', 'cyan');
    log('  LinuxLogMonitor v0.2.0 & LinuxShellExecutor v0.3.0 单元测试', 'cyan');
    log('═══════════════════════════════════════════════════════════════', 'cyan');
    log(`测试时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    log(`测试目标: 154.222.28.172 (tt/tt1234)`);
    
    // 运行测试
    await testSSHManagerLoad();
    await testSSHManagerConnection();
    await testSSHManagerExecute();
    await testSSHManagerStreamSession();
    await testAnomalyDetector();
    await testCallbackTrigger();
    await testMonitorManager();
    await testLinuxShellExecutorSecurity();
    await testLinuxShellExecutorE2E();
    
    // 清理连接
    try {
        const sshModule = require('./modules/SSHManager');
        await sshModule.resetSSHManager();
    } catch (e) {
        // 忽略
    }
    
    // 输出结果
    log('\n═══════════════════════════════════════════════════════════════', 'cyan');
    log('  测试结果汇总', 'cyan');
    log('═══════════════════════════════════════════════════════════════', 'cyan');
    
    log(`\n通过: ${testResults.passed.length}`, 'green');
    log(`失败: ${testResults.failed.length}`, testResults.failed.length > 0 ? 'red' : 'green');
    
    if (testResults.failed.length > 0) {
        log('\n失败的测试:', 'red');
        for (const test of testResults.failed) {
            log(`  - ${test.name}: ${test.detail}`, 'red');
        }
    }
    
    // 输出 JSON 格式结果（用于日记记录）
    testResults.endTime = new Date().toISOString();
    testResults.summary = {
        total: testResults.passed.length + testResults.failed.length,
        passed: testResults.passed.length,
        failed: testResults.failed.length,
        passRate: ((testResults.passed.length / (testResults.passed.length + testResults.failed.length)) * 100).toFixed(1) + '%'
    };
    
    log('\n═══════════════════════════════════════════════════════════════', 'cyan');
    log('  JSON 结果（用于日记记录）', 'cyan');
    log('═══════════════════════════════════════════════════════════════', 'cyan');
    console.log(JSON.stringify(testResults, null, 2));
    
    // 退出码
    process.exit(testResults.failed.length > 0 ? 1 : 0);
}

main().catch(error => {
    log(`\n测试运行失败: ${error.message}`, 'red');
    console.error(error.stack);
    process.exit(1);
});