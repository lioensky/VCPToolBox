// modules/messageRenderer.js

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls



import { avatarColorCache, getDominantAvatarColor } from './renderer/colorUtils.js';
import { initializeImageHandler, setContentAndProcessImages, clearImageState, clearAllImageStates } from './renderer/imageHandler.js';
import { processAnimationsInContent } from './renderer/animation.js';
import { createMessageSkeleton } from './renderer/domBuilder.js';
import * as streamManager from './renderer/streamManager.js';
import * as emoticonUrlFixer from './renderer/emoticonUrlFixer.js';


import * as contentProcessor from './renderer/contentProcessor.js';
import * as contextMenu from './renderer/messageContextMenu.js';


// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
   try {
       const existingStyleElement = document.getElementById('vcp-enhanced-ui-styles');
       if (existingStyleElement) {
           // Style element already exists, no need to recreate
           return;
       }

       // Create link element to load external CSS
       const linkElement = document.createElement('link');
       linkElement.id = 'vcp-enhanced-ui-styles';
       linkElement.rel = 'stylesheet';
       linkElement.type = 'text/css';
       linkElement.href = 'styles/messageRenderer.css';
       document.head.appendChild(linkElement);

       // console.log('VCPSub Enhanced UI: External styles loaded.'); // Reduced logging
   } catch (error) {
       console.error('VCPSub Enhanced UI: Failed to load external styles:', error);
   }
}




// --- Core Logic ---

/**
 * A helper function to escape HTML special characters.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#039;');
}

/**
 * 应用单个正则规则到文本
 * @param {string} text - 输入文本
 * @param {Object} rule - 正则规则对象
 * @returns {string} 处理后的文本
 */
function applyRegexRule(text, rule) {
    if (!rule || !rule.findPattern || typeof text !== 'string') {
        return text;
    }

    try {
        // 使用 uiHelperFunctions.regexFromString 来解析正则表达式
        let regex = null;
        if (window.uiHelperFunctions && window.uiHelperFunctions.regexFromString) {
            regex = window.uiHelperFunctions.regexFromString(rule.findPattern);
        } else {
            // 后备方案：手动解析
            const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
            if (regexMatch) {
                regex = new RegExp(regexMatch[1], regexMatch[2]);
            } else {
                regex = new RegExp(rule.findPattern, 'g');
            }
        }
        
        if (!regex) {
            console.error('无法解析正则表达式:', rule.findPattern);
            return text;
        }
        
        // 应用替换（如果没有替换内容，则默认替换为空字符串）
        return text.replace(regex, rule.replaceWith || '');
    } catch (error) {
        console.error('应用正则规则时出错:', rule.findPattern, error);
        return text;
    }
}

/**
 * 应用所有匹配的正则规则到文本（前端版本）
 * @param {string} text - 输入文本
 * @param {Array} rules - 正则规则数组
 * @param {string} role - 消息角色 ('user' 或 'assistant')
 * @param {number} depth - 消息深度（0 = 最新消息）
 * @returns {string} 处理后的文本
 */
function applyFrontendRegexRules(text, rules, role, depth) {
    if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
        return text;
    }

    let processedText = text;
    
    rules.forEach(rule => {
        // 检查是否应该应用此规则
        
        // 1. 检查是否应用于前端
        if (!rule.applyToFrontend) return;
        
        // 2. 检查角色
        const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
        if (!shouldApplyToRole) return;
        
        // 3. 检查深度（-1 表示无限制）
        const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
        const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
        
        if (!minDepthOk || !maxDepthOk) return;
        
        // 应用规则
        processedText = applyRegexRule(processedText, rule);
    });
    
    return processedText;
}

/**
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @returns {string} The processed text with special blocks as HTML.
 */
function transformSpecialBlocks(text) {
    const toolRegex = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
    const noteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
    const toolResultRegex = /\[\[VCP调用结果信息汇总:(.*?)\]\]/gs;

    let processed = text;

    // Process VCP Tool Results
    processed = processed.replace(toolResultRegex, (match, rawContent) => {
        const content = rawContent.trim();
        const lines = content.split('\n').filter(line => line.trim() !== '');

        let toolName = 'Unknown Tool';
        let status = 'Unknown Status';
        const details = [];
        let otherContent = [];

        lines.forEach(line => {
            const kvMatch = line.match(/-\s*([^:]+):\s*(.*)/);
            if (kvMatch) {
                const key = kvMatch[1].trim();
                const value = kvMatch[2].trim();
                if (key === '工具名称') {
                    toolName = value;
                } else if (key === '执行状态') {
                    status = value;
                } else {
                    details.push({ key, value });
                }
            } else {
                otherContent.push(line);
            }
        });

        // Add 'collapsible' class for the new functionality, default to collapsed
        let html = `<div class="vcp-tool-result-bubble collapsible">`;
        html += `<div class="vcp-tool-result-header">`;
        html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
        html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
        html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`; // Toggle icon
        html += `</div>`;

        // Wrap details and footer in a new collapsible container
        html += `<div class="vcp-tool-result-collapsible-content">`;

        html += `<div class="vcp-tool-result-details">`;
        details.forEach(({ key, value }) => {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            let processedValue = escapeHtml(value);
            
            if ((key === '可访问URL' || key === '返回内容') && value.match(/\.(jpeg|jpg|png|gif)$/i)) {
                 processedValue = `<a href="${value}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${value}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
            } else {
                processedValue = processedValue.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
            }
            
            if (key === '返回内容') {
                processedValue = processedValue.replace(/###(.*?)###/g, '<strong>$1</strong>');
            }

            html += `<div class="vcp-tool-result-item">`;
            html += `<span class="vcp-tool-result-item-key">${escapeHtml(key)}:</span> `;
            html += `<span class="vcp-tool-result-item-value">${processedValue}</span>`;
            html += `</div>`;
        });
        html += `</div>`; // End of vcp-tool-result-details

        if (otherContent.length > 0) {
            html += `<div class="vcp-tool-result-footer"><pre>${escapeHtml(otherContent.join('\n'))}</pre></div>`;
        }

        html += `</div>`; // End of vcp-tool-result-collapsible-content
        html += `</div>`; // End of vcp-tool-result-bubble

        return html;
    });

    // Process Tool Requests
    processed = processed.replace(toolRegex, (match, content) => {
        // Regex to find tool name in either XML format (<tool_name>...</tool_name>) or key-value format (tool_name: ...)
        const toolNameRegex = /<tool_name>([\s\S]*?)<\/tool_name>|tool_name:\s*([^\n\r]*)/;
        const toolNameMatch = content.match(toolNameRegex);

        // The tool name will be in capture group 1 or 2. Default to a fallback.
        let toolName = 'Processing...';
        if (toolNameMatch) {
            // Use the first non-empty capture group
            let extractedName = (toolNameMatch[1] || toolNameMatch[2] || '').trim();
            
            // Clean the extracted name: remove special markers and trailing commas
            if (extractedName) {
                extractedName = extractedName.replace(/「始」|「末」/g, '').replace(/,$/, '').trim();
            }

            if (extractedName) {
                toolName = extractedName;
            }
        }

        const escapedFullContent = escapeHtml(content);
        // Construct the new HTML with a hidden details part
        return `<div class="vcp-tool-use-bubble">` +
               `<div class="vcp-tool-summary">` +
               `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
               `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
               `</div>` +
               `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
               `</div>`;
    });

    // Process Daily Notes
    processed = processed.replace(noteRegex, (match, rawContent) => {
        const content = rawContent.trim();
        const maidRegex = /Maid:\s*([^\n\r]*)/;
        const dateRegex = /Date:\s*([^\n\r]*)/;
        const contentRegex = /Content:\s*([\s\S]*)/;

        const maidMatch = content.match(maidRegex);
        const dateMatch = content.match(dateRegex);
        const contentMatch = content.match(contentRegex);

        const maid = maidMatch ? maidMatch[1].trim() : '';
        const date = dateMatch ? dateMatch[1].trim() : '';
        // The rest of the text after "Content:", or the full text if "Content:" is not found
        const diaryContent = contentMatch ? contentMatch[1].trim() : content;

        let html = `<div class="maid-diary-bubble">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">Maid's Diary</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;
        
        if (maid) {
            html += `<div class="diary-maid-info">`;
            html += `<span class="diary-maid-label">Maid:</span> `;
            html += `<span class="diary-maid-name">${escapeHtml(maid)}</span>`;
            html += `</div>`;
        }

        html += `<div class="diary-content">${escapeHtml(diaryContent)}</div>`;
        html += `</div>`;

        return html;
    });

    return processed;
}

/**
 * Transforms user's "clicked button" indicators into styled bubbles.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function transformUserButtonClick(text) {
    const buttonClickRegex = /\[\[点击按钮:(.*?)\]\]/gs;
    return text.replace(buttonClickRegex, (match, content) => {
        const escapedContent = escapeHtml(content.trim());
        return `<span class="user-clicked-button-bubble">${escapedContent}</span>`;
    });
}

function transformVCPChatCanvas(text) {
    const canvasPlaceholderRegex = /\{\{VCPChatCanvas\}\}/g;
    return text.replace(canvasPlaceholderRegex, () => {
        // Use a div for better block-level layout and margin behavior
        return `<div class="vcp-chat-canvas-placeholder">Canvas协同中<span class="thinking-indicator-dots">...</span></div>`;
    });
}


/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * An HTML document is identified by the `<!DOCTYPE html>` declaration.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function ensureHtmlFenced(text) {
    const doctypeTag = '<!DOCTYPE html>';
    const htmlCloseTag = '</html>';
    const lowerText = text.toLowerCase();

    // If it's already in a proper html code block, do nothing. This is the fix.
    // This regex now checks for any language specifier (or none) after the fences.
    if (/```\w*\n<!DOCTYPE html>/i.test(text)) {
        return text;
    }

    // Quick exit if no doctype is present.
    if (!lowerText.includes(doctypeTag.toLowerCase())) {
        return text;
    }

    let result = '';
    let lastIndex = 0;
    while (true) {
        const startIndex = text.toLowerCase().indexOf(doctypeTag.toLowerCase(), lastIndex);

        // Append the segment of text before the current HTML block.
        const textSegment = text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);
        result += textSegment;

        if (startIndex === -1) {
            break; // Exit loop if no more doctype markers are found.
        }

        // Find the corresponding </html> tag.
        const endIndex = text.toLowerCase().indexOf(htmlCloseTag.toLowerCase(), startIndex + doctypeTag.length);
        if (endIndex === -1) {
            // Malformed HTML (no closing tag), append the rest of the string and stop.
            result += text.substring(startIndex);
            break;
        }

        const block = text.substring(startIndex, endIndex + htmlCloseTag.length);
        
        // Check if we are currently inside an open code block by counting fences in the processed result.
        const fencesInResult = (result.match(/```/g) || []).length;

        if (fencesInResult % 2 === 0) {
            // Even number of fences means we are outside a code block.
            // Wrap the HTML block in new fences.
            result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
        } else {
            // Odd number of fences means we are inside a code block.
            // Append the HTML block as is.
            result += block;
        }

        // Move past the current HTML block.
        lastIndex = endIndex + htmlCloseTag.length;
    }

    return result;
}


/**
 * Removes leading whitespace from lines that appear to be HTML tags,
 * as long as they are not inside a fenced code block. This prevents
 * the markdown parser from misinterpreting indented HTML as an indented code block.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
function deIndentHtml(text) {
    const lines = text.split('\n');
    let inFence = false;
    return lines.map(line => {
        if (line.trim().startsWith('```')) {
            inFence = !inFence;
        }
        // If we are not in a fenced block, and a line is indented and looks like an HTML tag,
        // remove the leading whitespace. This is the key fix.
        // The regex now specifically targets indented `<p>` and `<div>` tags,
        // which are common block-level elements that can be misinterpreted as code blocks.
        // It is case-insensitive and handles tags spanning multiple lines.
        if (!inFence && /^\s+<(!|[a-zA-Z])/.test(line)) {
            return line.trimStart();
        }
        return line;
    }).join('\n');
}


/**
 * 根据对话轮次计算消息的深度。
 * @param {string} messageId - 目标消息的ID。
 * @param {Array<Message>} history - 完整的聊天记录数组。
 * @returns {number} - 计算出的深度（0代表最新一轮）。
 */
function calculateDepthByTurns(messageId, history) {
    const turns = [];
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') {
            const turn = { assistant: history[i], user: null };
            if (i > 0 && history[i - 1].role === 'user') {
                turn.user = history[i - 1];
                i--; // 跳过用户消息
            }
            turns.unshift(turn);
        } else if (history[i].role === 'user') {
            turns.unshift({ assistant: null, user: history[i] });
        }
    }
    
    const turnIndex = turns.findIndex(t => (t.assistant && t.assistant.id === messageId) || (t.user && t.user.id === messageId));
    
    // 如果找不到，默认为最新消息（深度0），这对于新消息渲染是安全的回退
    return turnIndex !== -1 ? (turns.length - 1 - turnIndex) : 0;
}


/**
 * A helper function to preprocess the full message content string before parsing.
 * @param {string} text The raw text content.
 * @returns {string} The processed text.
 */
function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    // --- 应用正则规则（前端）---
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const agentConfig = currentSelectedItem?.config;

    if (agentConfig?.stripRegexes && Array.isArray(agentConfig.stripRegexes)) {
        // 应用前端正则规则，包含深度控制
        text = applyFrontendRegexRules(text, agentConfig.stripRegexes, messageRole, depth);
    }
    // --- 正则规则应用结束 ---

    const codeBlockMap = new Map();
    let placeholderId = 0;

    // Step 1: Find and protect all fenced code blocks.
    // The regex looks for ``` followed by an optional language identifier, then anything until the next ```
    let processed = text.replace(/```\w*([\s\S]*?)```/g, (match) => {
        const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
        codeBlockMap.set(placeholder, match);
        placeholderId++;
        return placeholder;
    });

    // The order of the remaining operations is critical.
    // Step 2. Fix indented HTML that markdown might misinterpret as code blocks.
    processed = deIndentHtml(processed);

    // Step 3. Directly transform special blocks (Tool/Diary) into styled HTML divs.
    processed = transformSpecialBlocks(processed);

    // Step 4. Ensure raw HTML documents are fenced to be displayed as code.
    processed = ensureHtmlFenced(processed);

    // Step 5. Run other standard content processors.
    processed = contentProcessor.ensureNewlineAfterCodeBlock(processed);
    processed = contentProcessor.ensureSpaceAfterTilde(processed);
    processed = contentProcessor.removeIndentationFromCodeBlockMarkers(processed);
    processed = contentProcessor.removeSpeakerTags(processed);
    processed = contentProcessor.ensureSeparatorBetweenImgAndCode(processed);

    // Step 6: Restore the protected code blocks.
    if (codeBlockMap.size > 0) {
        for (const [placeholder, block] of codeBlockMap.entries()) {
            processed = processed.replace(placeholder, block);
        }
    }

    return processed;
}

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {string} [id] 
 * @property {boolean} [isThinking]
 * @property {Array<{type: string, src: string, name: string}>} [attachments]
 * @property {string} [finishReason] 
 * @property {boolean} [isGroupMessage] // New: Indicates if it's a group message
 * @property {string} [agentId] // New: ID of the speaking agent in a group
 * @property {string} [name] // New: Name of the speaking agent in a group (can override default role name)
 * @property {string} [avatarUrl] // New: Specific avatar for this message (e.g. group member)
 * @property {string} [avatarColor] // New: Specific avatar color for this message
 */


/**
 * @typedef {Object} CurrentSelectedItem
 * @property {string|null} id - Can be agentId or groupId
 * @property {'agent'|'group'|null} type 
 * @property {string|null} name
 * @property {string|null} avatarUrl
 * @property {object|null} config - Full config of the selected item
 */


let mainRendererReferences = {
    currentChatHistoryRef: { get: () => [], set: () => {} }, // Ref to array
    currentSelectedItemRef: { get: () => ({ id: null, type: null, name: null, avatarUrl: null, config: null }), set: () => {} }, // Ref to object
    currentTopicIdRef: { get: () => null, set: () => {} }, // Ref to string/null
    globalSettingsRef: { get: () => ({ userName: '用户', userAvatarUrl: 'assets/default_user_avatar.png', userAvatarCalculatedColor: null }), set: () => {} }, // Ref to object

    chatMessagesDiv: null,
    electronAPI: null,
    markedInstance: null,
    uiHelper: {
        scrollToBottom: () => {},
        openModal: () => {},
        autoResizeTextarea: () => {},
        // ... other uiHelper functions ...
    },
    summarizeTopicFromMessages: async () => "",
    handleCreateBranch: () => {},
    // activeStreamingMessageId: null, // ID of the message currently being streamed - REMOVED
};


function removeMessageById(messageId, saveHistory = false) {
    const item = mainRendererReferences.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (item) item.remove();
    
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const index = currentChatHistoryArray.findIndex(m => m.id === messageId);
    
    if (index > -1) {
        currentChatHistoryArray.splice(index, 1);
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);
        
        if (saveHistory) {
            const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
            const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();
            if (currentSelectedItemVal.id && currentTopicIdVal) {
                if (currentSelectedItemVal.type === 'agent') {
                    mainRendererReferences.electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                } else if (currentSelectedItemVal.type === 'group' && mainRendererReferences.electronAPI.saveGroupChatHistory) {
                    mainRendererReferences.electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                }
            }
        }
    }
    clearImageState(messageId); // Clean up image state for the deleted message
}

function clearChat() {
    if (mainRendererReferences.chatMessagesDiv) mainRendererReferences.chatMessagesDiv.innerHTML = '';
    mainRendererReferences.currentChatHistoryRef.set([]); // Clear the history array via its ref
    clearAllImageStates(); // Clear all image loading states
}


function initializeMessageRenderer(refs) {
   Object.assign(mainRendererReferences, refs);

   initializeImageHandler({
       electronAPI: mainRendererReferences.electronAPI,
       uiHelper: mainRendererReferences.uiHelper,
       chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
   });

   // Initialize the emoticon fixer
   emoticonUrlFixer.initialize(mainRendererReferences.electronAPI);

   // Add event listener for collapsible tool results
   mainRendererReferences.chatMessagesDiv.addEventListener('click', (event) => {
       const header = event.target.closest('.vcp-tool-result-header');
       if (header) {
           const bubble = header.closest('.vcp-tool-result-bubble.collapsible');
           if (bubble) {
               bubble.classList.toggle('expanded');
           }
       }
   });

   // Create a new marked instance wrapper specifically for the stream manager.
   // This ensures that any text passed to `marked.parse()` during streaming
   // is first processed by `deIndentHtml`. This robustly fixes the issue of
   // indented HTML being rendered as code blocks during live streaming,
   // without needing to modify the stream manager itself.
   const originalMarkedParse = mainRendererReferences.markedInstance.parse.bind(mainRendererReferences.markedInstance);
   const streamingMarkedInstance = {
       ...mainRendererReferences.markedInstance,
       parse: (text) => {
           const globalSettings = mainRendererReferences.globalSettingsRef.get();
           // Pass settings to the preprocessor so it can adjust its behavior.
           const processedText = preprocessFullContent(text, globalSettings);
           return originalMarkedParse(processedText);
       }
   };

   contentProcessor.initializeContentProcessor(mainRendererReferences);

   contextMenu.initializeContextMenu(mainRendererReferences, {
       // Pass functions that the context menu needs to call back into the main renderer
       removeMessageById: removeMessageById,
       finalizeStreamedMessage: finalizeStreamedMessage,
       renderMessage: renderMessage,
       startStreamingMessage: startStreamingMessage,
       setContentAndProcessImages: setContentAndProcessImages,
       processRenderedContent: contentProcessor.processRenderedContent,
       preprocessFullContent: preprocessFullContent,
       renderAttachments: renderAttachments,
       interruptHandler: mainRendererReferences.interruptHandler, // Pass the interrupt handler
   });

   streamManager.initStreamManager({
       // Core Refs
       globalSettingsRef: mainRendererReferences.globalSettingsRef,
       currentChatHistoryRef: mainRendererReferences.currentChatHistoryRef,
       currentSelectedItemRef: mainRendererReferences.currentSelectedItemRef,
       currentTopicIdRef: mainRendererReferences.currentTopicIdRef,
       
       // DOM & API Refs
       chatMessagesDiv: mainRendererReferences.chatMessagesDiv,
       markedInstance: streamingMarkedInstance, // Use the wrapped instance
       electronAPI: mainRendererReferences.electronAPI,
       uiHelper: mainRendererReferences.uiHelper,

       // Rendering & Utility Functions
       renderMessage: renderMessage,
       showContextMenu: contextMenu.showContextMenu,
       setContentAndProcessImages: setContentAndProcessImages,
       processRenderedContent: contentProcessor.processRenderedContent,
       preprocessFullContent: preprocessFullContent,
       // Pass individual processors needed by streamManager
       removeSpeakerTags: contentProcessor.removeSpeakerTags,
       ensureNewlineAfterCodeBlock: contentProcessor.ensureNewlineAfterCodeBlock,
       ensureSpaceAfterTilde: contentProcessor.ensureSpaceAfterTilde,
       removeIndentationFromCodeBlockMarkers: contentProcessor.removeIndentationFromCodeBlockMarkers,
       ensureSeparatorBetweenImgAndCode: contentProcessor.ensureSeparatorBetweenImgAndCode,

       // Pass the main processor function
       processRenderedContent: contentProcessor.processRenderedContent,
       processAnimationsInContent: processAnimationsInContent, // Pass the animation processor

       // Debouncing and Timers
       enhancedRenderDebounceTimers: enhancedRenderDebounceTimers,
       ENHANCED_RENDER_DEBOUNCE_DELAY: ENHANCED_RENDER_DEBOUNCE_DELAY,
       DIARY_RENDER_DEBOUNCE_DELAY: DIARY_RENDER_DEBOUNCE_DELAY,
   });


   injectEnhancedStyles();
   console.log("[MessageRenderer] Initialized. Current selected item type on init:", mainRendererReferences.currentSelectedItemRef.get()?.type);
}


function setCurrentSelectedItem(item) {
    // This function is mainly for renderer.js to update the shared state.
    // messageRenderer will read from currentSelectedItemRef.get() when rendering.
    // console.log("[MessageRenderer] setCurrentSelectedItem called with:", item);
}

function setCurrentTopicId(topicId) {
    // console.log("[MessageRenderer] setCurrentTopicId called with:", topicId);
}

// These are for specific avatar of the current *context* (agent or user), not for individual group member messages
function setCurrentItemAvatar(avatarUrl) { // Renamed from setCurrentAgentAvatar
    // This updates the avatar for the main selected agent/group, not individual group members in a message.
    // The currentSelectedItemRef should hold the correct avatar for the overall context.
}

function setUserAvatar(avatarUrl) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const oldUrl = globalSettings.userAvatarUrl;
    if (oldUrl && oldUrl !== (avatarUrl || 'assets/default_user_avatar.png')) {
        avatarColorCache.delete(oldUrl.split('?')[0]);
    }
    mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarUrl: avatarUrl || 'assets/default_user_avatar.png' });
}

function setCurrentItemAvatarColor(color) { // Renamed from setCurrentAgentAvatarColor
    // For the main selected agent/group
}

function setUserAvatarColor(color) { // For the user's global avatar
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarCalculatedColor: color });
}


async function renderAttachments(message, contentDiv) {
    const { electronAPI } = mainRendererReferences;
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.classList.add('message-attachments');
        message.attachments.forEach(att => {
            let attachmentElement;
            if (att.type.startsWith('image/')) {
                attachmentElement = document.createElement('img');
                attachmentElement.src = att.src; // This src should be usable (e.g., file:// or data:)
                attachmentElement.alt = `附件图片: ${att.name}`;
                attachmentElement.title = `点击在新窗口预览: ${att.name}`;
                attachmentElement.classList.add('message-attachment-image-thumbnail');
                attachmentElement.onclick = (e) => {
                    e.stopPropagation();
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    electronAPI.openImageViewer({ src: att.src, title: att.name, theme: currentTheme });
                };
                 attachmentElement.addEventListener('contextmenu', (e) => { // Use attachmentElement here
                    e.preventDefault(); e.stopPropagation();
                    electronAPI.showImageContextMenu(att.src);
                });
            } else if (att.type.startsWith('audio/')) {
                attachmentElement = document.createElement('audio');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
            } else if (att.type.startsWith('video/')) {
                attachmentElement = document.createElement('video');
                attachmentElement.src = att.src;
                attachmentElement.controls = true;
                attachmentElement.style.maxWidth = '300px';
            } else { // Generic file
                attachmentElement = document.createElement('a');
                attachmentElement.href = att.src;
                attachmentElement.textContent = `📄 ${att.name}`;
                attachmentElement.title = `点击打开文件: ${att.name}`;
                attachmentElement.onclick = (e) => {
                    e.preventDefault();
                    if (electronAPI.sendOpenExternalLink && att.src.startsWith('file://')) {
                         electronAPI.sendOpenExternalLink(att.src);
                    } else {
                        console.warn("Cannot open local file attachment, API missing or path not a file URI:", att.src);
                    }
                };
            }
            if (attachmentElement) attachmentsContainer.appendChild(attachmentElement);
        });
        contentDiv.appendChild(attachmentsContainer);
    }
}

async function renderMessage(message, isInitialLoad = false) {
    console.log('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message))); // Log incoming message
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = mainRendererReferences;
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentChatHistory = mainRendererReferences.currentChatHistoryRef.get();

    // Prevent re-rendering if the message already exists in the DOM, unless it's a thinking message being replaced.
    const existingMessageDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (existingMessageDom && !existingMessageDom.classList.contains('thinking')) {
        // console.log(`[MessageRenderer] Message ${message.id} already in DOM. Skipping render.`);
        // return existingMessageDom;
    }

    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(message, globalSettings, currentSelectedItem);

    // Attach context menu to all assistant and user messages, regardless of state.
    // The context menu itself will decide which options to show.
    if (message.role === 'assistant' || message.role === 'user') {
        messageItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            contextMenu.showContextMenu(e, messageItem, message);
        });
    }

    // Add logic for stopping TTS by clicking the avatar
    // Add logic for stopping TTS by clicking the avatar
    // Simplified logic: always add the click listener to assistant avatars.
    // Clicking it will stop any ongoing TTS playback.
    if (avatarImg && message.role === 'assistant') {
        avatarImg.addEventListener('click', () => {
            console.log(`[MessageRenderer] Avatar clicked for message ${message.id}. Stopping TTS.`);
            mainRendererReferences.electronAPI.sovitsStop();
        });
    }

    // Determine avatar color and URL to use
    let avatarColorToUse;
    let avatarUrlToUse; // This was the missing variable
    if (message.role === 'user') {
        avatarColorToUse = globalSettings.userAvatarCalculatedColor;
        avatarUrlToUse = globalSettings.userAvatarUrl;
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarColorToUse = message.avatarColor;
            avatarUrlToUse = message.avatarUrl;
        } else if (currentSelectedItem) {
            avatarColorToUse = currentSelectedItem.config?.avatarCalculatedColor;
            avatarUrlToUse = currentSelectedItem.avatarUrl;
        }
    }

    chatMessagesDiv.appendChild(messageItem);

    if (message.isThinking) {
        contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
        messageItem.classList.add('thinking');
    } else {
        let textToRender = "";
        if (typeof message.content === 'string') {
            textToRender = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            // This case handles objects like { text: "..." }, common for group messages before history saving
            textToRender = message.content.text;
        } else if (message.content === null || message.content === undefined) {
            textToRender = ""; // Handle null or undefined content gracefully
             console.warn('[MessageRenderer] message.content is null or undefined for message ID:', message.id);
        } else {
            // Fallback for other unexpected object structures, log and use a placeholder
            console.warn('[MessageRenderer] Unexpected message.content type. Message ID:', message.id, 'Content:', JSON.stringify(message.content));
            textToRender = "[消息内容格式异常]";
        }
        
        // Apply special formatting for user button clicks
        if (message.role === 'user') {
            textToRender = transformUserButtonClick(textToRender);
            textToRender = transformVCPChatCanvas(textToRender);
        }
        
        // --- 按“对话轮次”计算深度 ---
        // 如果是新消息，它此时还不在 history 数组里，先临时加进去计算
        const historyForDepthCalc = currentChatHistory.some(m => m.id === message.id)
            ? [...currentChatHistory]
            : [...currentChatHistory, message];
        const depth = calculateDepthByTurns(message.id, historyForDepthCalc);
        // --- 深度计算结束 ---

        const processedContent = preprocessFullContent(textToRender, globalSettings, message.role, depth);
        let rawHtml = markedInstance.parse(processedContent);
        
        // Create a temporary div to apply emoticon fixes before setting innerHTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = rawHtml;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
            const originalSrc = img.getAttribute('src');
            if (originalSrc) {
                const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
                if (originalSrc !== fixedSrc) {
                    img.src = fixedSrc;
                }
            }
        });
        
        setContentAndProcessImages(contentDiv, tempDiv.innerHTML, message.id);
        contentProcessor.processRenderedContent(contentDiv);
        
        // After content is rendered, check if we need to run animations
        if (globalSettings.enableAgentBubbleTheme) {
            processAnimationsInContent(contentDiv);
        }
    }
    
    // Avatar Color Application (after messageItem is in DOM)
    if ((message.role === 'user' || message.role === 'assistant') && avatarImg && senderNameDiv) {
        const applyColorToElements = (colorStr) => {
            if (colorStr && messageItem.isConnected) { // Check if still in DOM
                senderNameDiv.style.color = colorStr;
                avatarImg.style.borderColor = colorStr;
            }
        };

        if (avatarColorToUse) { // If a specific color was passed (e.g. for group member or persisted user/agent color)
            applyColorToElements(avatarColorToUse);
        } else if (avatarUrlToUse && !avatarUrlToUse.includes('default_')) { // No persisted color, try to extract
            const dominantColor = await getDominantAvatarColor(avatarUrlToUse);
            applyColorToElements(dominantColor);
            if (dominantColor && messageItem.isConnected) { // If extracted and still in DOM, try to persist
                let typeToSave, idToSaveFor;
                if (message.role === 'user') {
                    typeToSave = 'user'; idToSaveFor = 'user_global';
                } else if (message.isGroupMessage && message.agentId) {
                    typeToSave = 'agent'; idToSaveFor = message.agentId; // Save for the specific group member
                } else if (currentSelectedItem && currentSelectedItem.type === 'agent') {
                    typeToSave = 'agent'; idToSaveFor = currentSelectedItem.id; // Current agent
                }

                if (typeToSave && idToSaveFor) {
                    electronAPI.saveAvatarColor({ type: typeToSave, id: idToSaveFor, color: dominantColor })
                        .then(result => {
                            if (result.success) {
                                if (typeToSave === 'user') {
                                     mainRendererReferences.globalSettingsRef.set({...globalSettings, userAvatarCalculatedColor: dominantColor });
                                } else if (typeToSave === 'agent' && idToSaveFor === currentSelectedItem.id && currentSelectedItem.config) {
                                    // Update currentSelectedItem.config if it's the active agent
                                    currentSelectedItem.config.avatarCalculatedColor = dominantColor;
                                }
                                // For group messages, the individual agent's config isn't directly held in currentSelectedItem.config
                                // The color is applied directly to the message. If persistence is needed for each group member,
                                // it should happen when their main config is loaded/saved.
                            }
                        });
                }
            }
        } else { // Default avatar or no URL, reset to theme defaults
            senderNameDiv.style.color = message.role === 'user' ? 'var(--secondary-text)' : 'var(--highlight-text)';
            avatarImg.style.borderColor = 'transparent';
        }
    }


    // Render attachments using the new helper function
    renderAttachments(message, contentDiv);
    
   if (!message.isThinking) {
       contentProcessor.processRenderedContent(contentDiv);
   }
   
   // The responsibility of updating the history array is now moved to the caller (e.g., chatManager.handleSendMessage)
   // to ensure a single source of truth and prevent race conditions.
   /*
   if (!isInitialLoad && !message.isThinking) {
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        currentChatHistoryArray.push(message);
        mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray); // Update the ref

        if (currentSelectedItem.id && mainRendererReferences.currentTopicIdRef.get()) {
             if (currentSelectedItem.type === 'agent') {
                electronAPI.saveChatHistory(currentSelectedItem.id, mainRendererReferences.currentTopicIdRef.get(), currentChatHistoryArray);
             } else if (currentSelectedItem.type === 'group') {
                // Group history is usually saved by groupchat.js in main process after AI response
             }
        }
    }
    */
    if (isInitialLoad && message.isThinking) {
        // This case should ideally not happen if thinking messages aren't persisted.
        // If it does, remove the transient thinking message.
        const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
        const thinkingMsgIndex = currentChatHistoryArray.findIndex(m => m.id === message.id && m.isThinking);
        if (thinkingMsgIndex > -1) {
            currentChatHistoryArray.splice(thinkingMsgIndex, 1);
            mainRendererReferences.currentChatHistoryRef.set(currentChatHistoryArray);
        }
        messageItem.remove();
        return null;
    }

   // Highlighting is now part of processRenderedContent
   
   mainRendererReferences.uiHelper.scrollToBottom();
   return messageItem;
}

function startStreamingMessage(message, messageItem = null) {
    return streamManager.startStreamingMessage(message, messageItem);
}


function appendStreamChunk(messageId, chunkData, context) {
    streamManager.appendStreamChunk(messageId, chunkData, context);
}

async function finalizeStreamedMessage(messageId, finishReason, context) {
    // 责任完全在 streamManager 内部，它应该使用自己拼接好的文本。
    // 我们现在只传递必要的元数据。
    await streamManager.finalizeStreamedMessage(messageId, finishReason, context);
}



/**
 * Renders a full, non-streamed message, replacing a 'thinking' placeholder.
 * @param {string} messageId - The ID of the message to update.
 * @param {string} fullContent - The full HTML or text content of the message.
 * @param {string} agentName - The name of the agent sending the message.
 * @param {string} agentId - The ID of the agent sending the message.
 */
async function renderFullMessage(messageId, fullContent, agentName, agentId) {
    console.log(`[MessageRenderer renderFullMessage] Rendering full message for ID: ${messageId}`);
    const { chatMessagesDiv, electronAPI, uiHelper, markedInstance } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    // --- Update History First ---
    const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === messageId);
    if (messageIndex > -1) {
        const message = currentChatHistoryArray[messageIndex];
        message.content = fullContent;
        message.isThinking = false;
        message.finishReason = 'completed_non_streamed';
        message.name = agentName || message.name;
        message.agentId = agentId || message.agentId;
        mainRendererReferences.currentChatHistoryRef.set([...currentChatHistoryArray]);

        // Save history
        if (currentSelectedItem && currentSelectedItem.id && currentTopicIdVal && currentSelectedItem.type === 'group') {
            if (electronAPI.saveGroupChatHistory) {
                try {
                    await electronAPI.saveGroupChatHistory(currentSelectedItem.id, currentTopicIdVal, currentChatHistoryArray.filter(m => !m.isThinking));
                } catch (error) {
                    console.error(`[MR renderFullMessage] FAILED to save GROUP history for ${currentSelectedItem.id}, topic ${currentTopicIdVal}:`, error);
                }
            }
        }
    } else {
        console.warn(`[renderFullMessage] Message ID ${messageId} not found in history. UI will be updated, but history may be inconsistent.`);
        // Even if not in history, we might still want to render it if the DOM element exists (e.g., from a 'thinking' state)
    }

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        console.log(`[renderFullMessage] No DOM element for ${messageId}. History updated, UI skipped.`);
        return; // No UI to update, but history is now consistent.
    }

    messageItem.classList.remove('thinking', 'streaming');

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) {
        console.error(`[renderFullMessage] Could not find .md-content div for message ID ${messageId}.`);
        return;
    }

    // Update timestamp display if it was missing
    const nameTimeBlock = messageItem.querySelector('.name-time-block');
    if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
        const timestampDiv = document.createElement('div');
        timestampDiv.classList.add('message-timestamp');
        const messageFromHistory = currentChatHistoryArray.find(m => m.id === messageId);
        timestampDiv.textContent = new Date(messageFromHistory?.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        nameTimeBlock.appendChild(timestampDiv);
    }

    // --- Update DOM ---
    const globalSettings = mainRendererReferences.globalSettingsRef.get();
    const processedFinalText = preprocessFullContent(fullContent, globalSettings, 'assistant');
    let rawHtml = markedInstance.parse(processedFinalText);

    // Create a temporary div to apply emoticon fixes before setting innerHTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    const images = tempDiv.querySelectorAll('img');
    images.forEach(img => {
        const originalSrc = img.getAttribute('src');
        if (originalSrc) {
            const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
            if (originalSrc !== fixedSrc) {
                img.src = fixedSrc;
            }
        }
    });

    setContentAndProcessImages(contentDiv, tempDiv.innerHTML, messageId);

    // Apply post-processing
    contentProcessor.processRenderedContent(contentDiv);

    // After content is rendered, check if we need to run animations
    if (globalSettings.enableAgentBubbleTheme) {
        processAnimationsInContent(contentDiv);
    }

    mainRendererReferences.uiHelper.scrollToBottom();
}

function updateMessageContent(messageId, newContent) {
    const { chatMessagesDiv, markedInstance, globalSettingsRef } = mainRendererReferences;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const globalSettings = globalSettingsRef.get();
    let textToRender = (typeof newContent === 'string') ? newContent : (newContent?.text || "[内容格式异常]");
    
    // --- 深度计算 (用于历史消息渲染) ---
    const currentChatHistoryForUpdate = mainRendererReferences.currentChatHistoryRef.get();
    const messageInHistory = currentChatHistoryForUpdate.find(m => m.id === messageId);
    
    // --- 按“对话轮次”计算深度 ---
    const depthForUpdate = calculateDepthByTurns(messageId, currentChatHistoryForUpdate);
    // --- 深度计算结束 ---
    const processedContent = preprocessFullContent(textToRender, globalSettings, messageInHistory?.role || 'assistant', depthForUpdate);
    let rawHtml = markedInstance.parse(processedContent);

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = rawHtml;
    const images = tempDiv.querySelectorAll('img');
    images.forEach(img => {
        const originalSrc = img.getAttribute('src');
        if (originalSrc) {
            const fixedSrc = emoticonUrlFixer.fixEmoticonUrl(originalSrc);
            if (originalSrc !== fixedSrc) {
                img.src = fixedSrc;
            }
        }
    });

    setContentAndProcessImages(contentDiv, tempDiv.innerHTML, messageId);
    contentProcessor.processRenderedContent(contentDiv);

    // Re-render attachments if they exist in the new content object
    if (messageInHistory) {
        // First, remove any existing attachments container
        const existingAttachments = contentDiv.querySelector('.message-attachments');
        if (existingAttachments) existingAttachments.remove();
        // Then, render new ones if they exist
        renderAttachments({ ...messageInHistory, content: newContent }, contentDiv);
    }
}

// Expose methods to renderer.js
window.messageRenderer = {
    initializeMessageRenderer,
    setCurrentSelectedItem, // Keep for renderer.js to call
    setCurrentTopicId,      // Keep for renderer.js to call
    setCurrentItemAvatar,   // Renamed for clarity
    setUserAvatar,
    setCurrentItemAvatarColor, // Renamed
    setUserAvatarColor,
    renderMessage,
    startStreamingMessage,
    appendStreamChunk,
    finalizeStreamedMessage,
    renderFullMessage,
    clearChat,
    removeMessageById,
    updateMessageContent, // Expose the new function
    isMessageInitialized: (messageId) => {
        // Check if message exists in DOM or is being tracked by streamManager
        const messageInDom = mainRendererReferences.chatMessagesDiv?.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (messageInDom) return true;
        
        // Also check if streamManager is tracking this message
        if (streamManager && typeof streamManager.isMessageInitialized === 'function') {
            return streamManager.isMessageInitialized(messageId);
        }
        
        return false;
    },
    summarizeTopicFromMessages: async (history, agentName) => { // Example: Keep this if it's generic enough
        // This function was passed in, so it's likely defined in renderer.js or another module.
        // If it's meant to be internal to messageRenderer, its logic would go here.
        // For now, assume it's an external utility.
        if (mainRendererReferences.summarizeTopicFromMessages) {
            return mainRendererReferences.summarizeTopicFromMessages(history, agentName);
        }
        return null;
    },
    setContextMenuDependencies: (deps) => {
        if (contextMenu && typeof contextMenu.setContextMenuDependencies === 'function') {
            contextMenu.setContextMenuDependencies(deps);
        } else {
            console.error("contextMenu or setContextMenuDependencies not available.");
        }
    }
};
