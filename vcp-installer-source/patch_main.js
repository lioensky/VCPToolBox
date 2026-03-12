const fs = require('fs');
const file = 'E:\\VCP\\vcp-installer\\src\\main.rs';
let content = fs.readFileSync(file, 'utf8');
const originalCRLF = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 先清理之前错误插入的代码（在run_app末尾的）
const badBlock = `
    // 安装完成后启动 Web 配置向导
    if result.is_ok() {
        let install_dir = std::env::current_dir().unwrap_or_default();
        if install_dir.join("VCPToolBox").exists() {
            println!();
            println!("  [VCP] 安装完成，正在启动配置向导...");
            if let Err(e) = web_config::start_web_config(&install_dir) {
                eprintln!("  [VCP] 配置向导出错: {:#}", e);
            }
        }
    }

    Ok(())
}`;

if (content.includes(badBlock.trim())) {
    // 把错误的块替换回原来的 Ok(()) }
    content = content.replace(badBlock.trim(), 'Ok(())\n}');
    console.log('Cleanup: removed misplaced block from run_app');
}

// 现在找 main() 函数里的插入点
// main() 的特征：在 "if let Err(err) = &result {" 之后
const marker = 'if let Err(err) = &result {\n        eprintln!("Error: {err:?}");\n    }\n\n    Ok(())\n}';
const replacement = `if let Err(err) = &result {
        eprintln!("Error: {err:?}");
    }

    // 安装完成后启动 Web 配置向导
    if result.is_ok() {
        let install_dir = std::env::current_dir().unwrap_or_default();
        if install_dir.join("VCPToolBox").exists() {
            println!();
            println!("  [VCP] 安装完成，正在启动配置向导...");
            if let Err(e) = web_config::start_web_config(&install_dir) {
                eprintln!("  [VCP] 配置向导出错: {:#}", e);
            }
        }
    }

    Ok(())
}`;

if (content.includes(marker)) {
    content = content.replace(marker, replacement);
    console.log('Patch: web_config call inserted into main()');
} else {
    console.log('WARN: marker not found, dumping nearby context...');
    // 找 eprintln!("Error 附近的内容
    const idx = content.indexOf('eprintln!("Error: {err:?}");');
    if (idx !== -1) {
        console.log('Context around eprintln:', content.substring(idx - 50, idx + 150));
    }
}

if (originalCRLF) {
    content = content.replace(/\n/g, '\r\n');
}
fs.writeFileSync(file, content, 'utf8');
console.log('Done!');