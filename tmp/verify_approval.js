const fs = require('fs');
const path = require('path');
const ToolApprovalManager = require('../modules/toolApprovalManager');

async function test() {
    const configPath = path.join(__dirname, '..', 'toolApprovalConfig.json');
    console.log('--- Test 1: Initial Load ---');
    const manager = new ToolApprovalManager(configPath);
    
    console.log('Should approve TestTool1 (default):', manager.shouldApprove('TestTool1')); // false because enabled is false
    console.log('Timeout MS (default 5m):', manager.getTimeoutMs());

    console.log('\n--- Test 2: Enable Approval ---');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(originalConfig);
    config.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Wait for watcher to trigger
    await new Promise(r => setTimeout(r, 1000));
    console.log('Should approve TestTool1 (enabled):', manager.shouldApprove('TestTool1')); // true
    console.log('Should approve UnknownTool:', manager.shouldApprove('UnknownTool')); // false

    console.log('\n--- Test 3: Approve All ---');
    config.approveAll = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    await new Promise(r => setTimeout(r, 1000));
    console.log('Should approve UnknownTool (approveAll):', manager.shouldApprove('UnknownTool')); // true

    console.log('\n--- Test 4: Restore Original Config ---');
    fs.writeFileSync(configPath, originalConfig);
    await new Promise(r => setTimeout(r, 1000));
    console.log('Should approve TestTool1 (restored):', manager.shouldApprove('TestTool1')); // false

    manager.shutdown();
    console.log('\nVerification completed.');
}

test().catch(console.error);
