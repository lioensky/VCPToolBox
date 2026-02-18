// test_dream.js - 手动触发一次梦境（测试用）
// 用法: node Plugin/AgentDream/test_dream.js [AgentName]
// 例如: node Plugin/AgentDream/test_dream.js Nova
// 需要 VCP 服务器已运行

const agentName = process.argv[2] || 'Nova';
console.log(`\n🌙 手动触发梦境测试: ${agentName}\n`);

// 模拟 PluginManager 的初始化流程
const path = require('path');
const dotenv = require('dotenv');

// 加载主配置
const mainEnvPath = path.join(__dirname, '..', '..', 'config.env');
const fs = require('fs');
if (fs.existsSync(mainEnvPath)) {
    dotenv.config({ path: mainEnvPath });
}

const AgentDream = require('./AgentDream.js');

// 初始化插件
const config = {
    PORT: process.env.PORT || 5555,
    Key: process.env.Key || '',
    DebugMode: 'true'
};

AgentDream.initialize(config, {
    vcpLogFunctions: {
        pushVcpInfo: (data) => {
            console.log(`\n📡 [VCPInfo Broadcast] type: ${data.type}`);
            console.log(JSON.stringify(data, null, 2).substring(0, 500));
            if (JSON.stringify(data).length > 500) console.log('...(truncated for console)');
            console.log('');
        }
    }
});

// 触发梦境
(async () => {
    try {
        console.log(`\n⏳ 开始入梦流程...\n`);
        const result = await AgentDream.triggerDream(agentName);

        if (result.status === 'success') {
            console.log(`\n✅ 梦境完成!`);
            console.log(`  Dream ID: ${result.dreamId}`);
            console.log(`  Seeds: ${result.seedDiaries?.length || 0} 篇`);
            console.log(`  Associations: ${result.associations?.length || 0} 篇`);
            console.log(`  Log file: ${result.dreamLogFile || 'N/A'}`);
            console.log(`\n--- 梦叙事 (前800字) ---`);
            console.log(result.narrative?.substring(0, 800) || '(empty)');
            console.log(`\n--- 完整叙事长度: ${result.narrative?.length || 0} 字 ---`);
        } else {
            console.error(`\n❌ 入梦失败: ${result.error}`);
        }
    } catch (e) {
        console.error(`\n💥 异常: ${e.message}`);
        console.error(e.stack);
    }
    process.exit(0);
})();
