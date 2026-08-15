// [SynchroVision] AI Intent Observer
// Version: 1.2 (Security Enhanced)
// 作用: 监听主流 AI 聊天平台 (ChatGPT, Grok, Gemini, Claude, DeepSeek) 的输入框，
// 将用户的 Prompt 视为“搜索意图”发送给 VCP。
// 安全特性: 仅在白名单域名下激活，且不记录密码框。

console.log('[SynchroVision-Eye] AI Intent Observer Loaded');

const ALLOWED_DOMAINS = [
    'chatgpt.com',
    'chat.openai.com',
    'grok.com',
    'x.ai',
    'x.com',
    'gemini.google.com',
    'bard.google.com',
    'claude.ai',
    'chat.deepseek.com',
    'aistudio.google.com'
];

// Security Check: Only run on allowed domains
const currentHost = window.location.hostname;
const isAllowed = ALLOWED_DOMAINS.some(domain => currentHost.endsWith(domain));

if (!isAllowed) {
    console.log('[SynchroVision-Eye] Domain not in allowlist. Observer disabled for privacy.');
} else {
    console.log(`[SynchroVision-Eye] Domain authorized: ${currentHost}. Observer active.`);

    let lastPrompt = '';
    let lastTime = 0;

    // 通用监听器：监听所有文本域的回车事件
    document.addEventListener('keydown', (e) => {
        // 检查是否是 Enter 键，且没有按住 Shift (Shift+Enter 通常是换行)
        if (e.key === 'Enter' && !e.shiftKey) {
            const target = e.target;

            // Security Check: Ignore password fields
            if (target.type === 'password') return;

            // 检查焦点是否在输入框内
            if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text') || target.getAttribute('contenteditable') === 'true') {

                // 获取输入内容
                let prompt = target.value || target.innerText;

                // 简单清洗
                if (prompt) {
                    prompt = prompt.trim();
                }

                // 过滤短内容和重复内容
                const now = Date.now();
                if (prompt && prompt.length > 5 && (prompt !== lastPrompt || (now - lastTime > 5000))) {

                    console.log('[SynchroVision-Eye] AI Prompt Captured (Sanitized):', prompt.substring(0, 15) + '...');

                    // 发送给 Background Script
                    try {
                        chrome.runtime.sendMessage({
                            type: 'report_intent',
                            data: {
                                keyword: '[AI Prompt] ' + prompt, // 加个前缀区分
                                url: window.location.href,
                                source: currentHost,
                                title: document.title,
                                intent_type: 'ai_prompt'
                            }
                        });
                    } catch (err) {
                        console.error('[SynchroVision-Eye] Failed to send prompt:', err);
                    }

                    lastPrompt = prompt;
                    lastTime = now;
                }
            }
        }
    }, true); // 使用捕获阶段
}
