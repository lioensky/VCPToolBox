// Plugin/ChromeBridge/ChromeScripts/test_alert.js
// 这是一个简单的测试脚本，用于验证持久化脚本执行功能
alert("VCPChrome 浏览器控制引擎：持久化脚本执行成功！");
return {
    success: true,
    title: document.title,
    url: document.URL,
    message: "来自持久化脚本的问候！"
};