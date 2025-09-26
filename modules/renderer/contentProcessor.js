// modules/renderer/contentProcessor.js

let mainRefs = {};

/**
 * Initializes the content processor with necessary references.
 * @param {object} refs - References to main modules and utilities.
 */
function initializeContentProcessor(refs) {
    mainRefs = refs;
}

/**
 * Ensures that triple backticks for code blocks are followed by a newline.
 * @param {string} text The input string.
 * @returns {string} The processed string with newlines after ``` if they were missing.
 */
function ensureNewlineAfterCodeBlock(text) {
    if (typeof text !== 'string') return text;
    // Replace ``` (possibly with leading spaces) not followed by \n or \r\n with the same ``` (and spaces) followed by \n
    return text.replace(/^(\s*```)(?![\r\n])/gm, '$1\n');
}

/**
 * Ensures that a tilde (~) is followed by a space.
 * @param {string} text The input string.
 * @returns {string} The processed string with spaces after tildes where they were missing.
 */
function ensureSpaceAfterTilde(text) {
    if (typeof text !== 'string') return text;
    // Replace ~ not followed by a space with ~ followed by a space
    return text.replace(/~(?![\s~])/g, '~ ');
}

/**
 * Removes leading whitespace from lines starting with ``` (code block markers).
 * @param {string} text The input string.
 * @returns {string} The processed string.
 */
function removeIndentationFromCodeBlockMarkers(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/^(\s*)(```.*)/gm, '$2');
}

/**
 * Removes speaker tags like "[Sender's speech]: " from the beginning of a string.
 * @param {string} text The input string.
 * @returns {string} The processed string without the leading speaker tag.
 */
function removeSpeakerTags(text) {
    if (typeof text !== 'string') return text;
    const speakerTagRegex = /^\[(?:(?!\]:\s).)*的发言\]:\s*/;
    let newText = text;
    // Loop to remove all occurrences of the speaker tag at the beginning of the string
    while (speakerTagRegex.test(newText)) {
        newText = newText.replace(speakerTagRegex, '');
    }
    return newText;
}

/**
* Ensures there is a separator between an <img> tag and a subsequent code block fence (```).
* This prevents the markdown parser from failing to recognize the code block.
* It inserts a double newline and an HTML comment. The comment acts as a "hard" separator
* for the markdown parser, forcing it to reset its state after the raw HTML img tag.
* @param {string} text The input string.
* @returns {string} The processed string.
*/
function ensureSeparatorBetweenImgAndCode(text) {
    if (typeof text !== 'string') return text;
    // Looks for an <img> tag, optional whitespace, and then a ```.
    // Inserts a double newline and an HTML comment.
    return text.replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2');
}


/**
 * Parses VCP tool_name from content.
 * @param {string} toolContent - The raw string content of the tool request.
 * @returns {string|null} The extracted tool name or null.
 */
function extractVcpToolName(toolContent) {
    const match = toolContent.match(/tool_name:\s*「始」([^「」]+)「末」/);
    return match ? match[1] : null;
}

/**
 * Prettifies a single <pre> code block for DailyNote or VCP ToolUse.
 * @param {HTMLElement} preElement - The <pre> element to prettify.
 * @param {'dailynote' | 'vcptool'} type - The type of block.
 * @param {string} relevantContent - The relevant text content for the block.
 */
function prettifySinglePreElement(preElement, type, relevantContent) {
    if (!preElement || preElement.dataset.vcpPrettified === "true" || preElement.dataset.maidDiaryPrettified === "true") {
        return;
    }

    let targetContentElement = preElement.querySelector('code') || preElement;

    const copyButton = targetContentElement.querySelector('.code-copy, .fa-copy');
    if (copyButton) {
        copyButton.remove(); // Remove existing copy button
    }

    if (type === 'vcptool') {
        preElement.classList.add('vcp-tool-use-bubble');
        const toolName = extractVcpToolName(relevantContent);

        let newInnerHtml = `<span class="vcp-tool-label">ToolUse:</span>`;
        if (toolName) {
            newInnerHtml += `<span class="vcp-tool-name-highlight">${toolName}</span>`;
        } else {
            newInnerHtml += `<span class="vcp-tool-name-highlight">UnknownTool</span>`;
        }

        targetContentElement.innerHTML = newInnerHtml;
        preElement.dataset.vcpPrettified = "true";

    } else if (type === 'dailynote') {
        preElement.classList.add('maid-diary-bubble');
        let actualNoteContent = relevantContent.trim();

        let finalHtml = "";
        const lines = actualNoteContent.split('\n');
        const firstLineTrimmed = lines[0] ? lines[0].trim() : "";

        if (firstLineTrimmed.startsWith('Maid:')) {
            finalHtml = `<span class="maid-label">${lines.shift().trim()}</span>`;
            finalHtml += lines.join('\n');
        } else if (firstLineTrimmed.startsWith('Maid')) {
            finalHtml = `<span class="maid-label">${lines.shift().trim()}</span>`;
            finalHtml += lines.join('\n');
        } else {
            finalHtml = actualNoteContent;
        }

        targetContentElement.innerHTML = finalHtml.replace(/\n/g, '<br>');
        preElement.dataset.maidDiaryPrettified = "true";
    }
}

/**
 * Highlights @tag patterns within the text nodes of a given HTML element.
 * @param {HTMLElement} messageElement - The HTML element containing the message content.
 */
function highlightTagsInMessage(messageElement) {
    if (!messageElement) return;

    const tagRegex = /@([\u4e00-\u9fa5A-Za-z0-9_]+)/g;
    const walker = document.createTreeWalker(
        messageElement,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    let node;
    const nodesToProcess = [];

    while (node = walker.nextNode()) {
        if (node.parentElement.tagName === 'STYLE' ||
            node.parentElement.tagName === 'SCRIPT' ||
            node.parentElement.classList.contains('highlighted-tag')) {
            continue;
        }

        const text = node.nodeValue;
        let match;
        const matches = [];
        tagRegex.lastIndex = 0;
        while ((match = tagRegex.exec(text)) !== null) {
            matches.push({
                index: match.index,
                tagText: match[0],
                tagName: match[1]
            });
        }

        if (matches.length > 0) {
            nodesToProcess.push({ node, matches });
        }
    }

    for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node, matches } = nodesToProcess[i];
        let currentNode = node;

        for (let j = matches.length - 1; j >= 0; j--) {
            const matchInfo = matches[j];
            const textAfterMatch = currentNode.splitText(matchInfo.index + matchInfo.tagText.length);

            const span = document.createElement('span');
            span.className = 'highlighted-tag';
            span.textContent = matchInfo.tagText;

            currentNode.parentNode.insertBefore(span, textAfterMatch);
            currentNode.nodeValue = currentNode.nodeValue.substring(0, matchInfo.index);
        }
    }
}

/**
 * Highlights text within double quotes in a given HTML element.
 * @param {HTMLElement} messageElement - The HTML element containing the message content.
 */
function highlightQuotesInMessage(messageElement) {
    if (!messageElement) return;

    const quoteRegex = /(?:"([^"]*)"|“([^”]*)”)/g; // Matches English "..." and Chinese “...”
    const walker = document.createTreeWalker(
        messageElement,
        NodeFilter.SHOW_TEXT,
        (node) => {
            // 过滤：已在高亮/KaTeX/代码等环境，或父节点包含内联样式（AI 富文本）
            let parent = node.parentElement;
            while (parent && parent !== messageElement && parent !== document.body) {
                if (
                    (parent.classList && (parent.classList.contains('highlighted-quote') ||
                                          parent.classList.contains('highlighted-tag') ||
                                          parent.classList.contains('katex'))) ||
                    parent.tagName === 'STYLE' ||
                    parent.tagName === 'SCRIPT' ||
                    parent.tagName === 'PRE' ||
                    parent.tagName === 'CODE' ||
                    (parent.hasAttribute && parent.hasAttribute('style'))
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                parent = parent.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
        false
    );

    let node;
    const nodesToProcess = [];

    try {
        while ((node = walker.nextNode())) {
            const parentEl = node.parentElement;
            // 跳过：父元素内含有子元素（复杂富文本），避免跨标签切割
            if (!parentEl || parentEl.children.length > 0) continue;

            const text = node.nodeValue || '';
            let match;
            const matches = [];
            quoteRegex.lastIndex = 0;
            while ((match = quoteRegex.exec(text)) !== null) {
                const contentGroup1 = match[1];
                const contentGroup2 = match[2];
                if ((contentGroup1 && contentGroup1.length > 0) || (contentGroup2 && contentGroup2.length > 0)) {
                    matches.push({
                        index: match.index,
                        fullMatch: match[0],
                    });
                }
            }

            if (matches.length > 0) {
                nodesToProcess.push({ node, matches });
            }
        }
    } catch (error) {
        if (error.message.includes("The provided callback is no longer runnable")) {
            console.warn("highlightQuotesInMessage: TreeWalker failed, likely due to concurrent DOM modification. Processing collected nodes and stopping traversal.");
        } else {
            console.error("highlightQuotesInMessage: Error during TreeWalker traversal.", error);
        }
    }

    // 逆序处理，避免索引失效
    for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node, matches } = nodesToProcess[i];
        let currentNode = node;

        for (let j = matches.length - 1; j >= 0; j--) {
            const matchInfo = matches[j];

            // 在匹配末尾切分
            const textAfterNode = currentNode.splitText(matchInfo.index + matchInfo.fullMatch.length);

            // 包裹为可断行的高亮片段
            const span = document.createElement('span');
            span.className = 'highlighted-quote';
            span.textContent = matchInfo.fullMatch;

            // 插入 span 与一个零宽空格，提供断行机会
            currentNode.parentNode.insertBefore(span, textAfterNode);
            const zwsp = document.createTextNode('\u200B');
            currentNode.parentNode.insertBefore(zwsp, textAfterNode);

            // 截断原节点
            currentNode.nodeValue = currentNode.nodeValue.substring(0, matchInfo.index);
        }
    }
}

/**
 * Processes all relevant <pre> blocks within a message's contentDiv AFTER marked.parse().
 * @param {HTMLElement} contentDiv - The div containing the parsed Markdown.
 */
function processAllPreBlocksInContentDiv(contentDiv) {
    if (!contentDiv) return;

    const allPreElements = contentDiv.querySelectorAll('pre');
    allPreElements.forEach(preElement => {
        if (preElement.dataset.vcpPrettified === "true" || preElement.dataset.maidDiaryPrettified === "true") {
            return; // Already processed
        }

        const codeElement = preElement.querySelector('code');
        const blockText = codeElement ? (codeElement.textContent || "") : (preElement.textContent || "");

        // Check for VCP Tool Request
        if (blockText.includes('<<<[TOOL_REQUEST]>>>') && blockText.includes('<<<[END_TOOL_REQUEST]>>>')) {
            const vcpContentMatch = blockText.match(/<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/);
            const actualVcpText = vcpContentMatch ? vcpContentMatch[1].trim() : "";
            prettifySinglePreElement(preElement, 'vcptool', actualVcpText);
        }
        // Check for DailyNote
        else if (blockText.includes('<<<DailyNoteStart>>>') && blockText.includes('<<<DailyNoteEnd>>>')) {
            const dailyNoteContentMatch = blockText.match(/<<<DailyNoteStart>>>([\s\S]*?)<<<DailyNoteEnd>>>/);
            const actualDailyNoteText = dailyNoteContentMatch ? dailyNoteContentMatch[1].trim() : "";
            prettifySinglePreElement(preElement, 'dailynote', actualDailyNoteText);
        }
    });
}

/**
 * Processes interactive buttons in AI messages
 * @param {HTMLElement} contentDiv The message content element.
 */
function processInteractiveButtons(contentDiv) {
    if (!contentDiv) return;

    // Find all button elements
    const buttons = contentDiv.querySelectorAll('button');

    buttons.forEach(button => {
        // Skip if already processed
        if (button.dataset.vcpInteractive === 'true') return;

        // Mark as processed
        button.dataset.vcpInteractive = 'true';

        // Set up button styling
        setupButtonStyle(button);

        // Add click event listener
        button.addEventListener('click', handleAIButtonClick);

        console.log('[ContentProcessor] Processed interactive button:', button.textContent.trim());
    });
}

/**
 * Sets up functional properties for interactive buttons (no styling)
 * @param {HTMLElement} button The button element
 */
function setupButtonStyle(button) {
    // Ensure button looks clickable
    button.style.cursor = 'pointer';

    // Prevent any form submission or default behavior
    button.type = 'button';
    button.setAttribute('type', 'button');

    // Note: Visual styling is left to AI-defined CSS classes and styles
}

/**
 * Handles click events on AI-generated buttons
 * @param {Event} event The click event
 */
function handleAIButtonClick(event) {
    const button = event.target;

    // Completely prevent any default behavior
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Check if button is disabled
    if (button.disabled) {
        return false;
    }

    // Get text to send (priority: data-send attribute > button text)
    const sendText = button.dataset.send || button.textContent.trim();

    // Validate text
    if (!sendText || sendText.length === 0) {
        console.warn('[ContentProcessor] Button has no text to send');
        return false;
    }

    // Format the text to be sent
    let finalSendText = `[[点击按钮:${sendText}]]`;

    // Truncate if the final text is too long
    if (finalSendText.length > 500) {
        console.warn('[ContentProcessor] Button text too long, truncating');
        const maxTextLength = 500 - '[[点击按钮:]]'.length; // Account for '[[点击按钮:' and ']]'
        const truncatedText = sendText.substring(0, maxTextLength);
        finalSendText = `[[点击按钮:${truncatedText}]]`;
    }

    // Disable button to prevent double-click
    disableButton(button);

    // Send the message asynchronously to avoid blocking
    setTimeout(() => {
        sendButtonMessage(finalSendText, button);
    }, 10);

    return false;
}

/**
 * Disables a button and provides visual feedback
 * @param {HTMLElement} button The button to disable
 */
function disableButton(button) {
    button.disabled = true;
    button.style.opacity = '0.6';
    button.style.cursor = 'not-allowed';

    // Add checkmark to indicate it was clicked
    const originalText = button.textContent;
    button.textContent = originalText + ' ✓';

    // Store original text for potential restoration
    button.dataset.originalText = originalText;
}

/**
 * Restores a button to its original state
 * @param {HTMLElement} button The button to restore
 */
function restoreButton(button) {
    button.disabled = false;
    button.style.opacity = '1';
    button.style.cursor = 'pointer';

    // Restore original text if available
    if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
    }
}

/**
 * Sends a message triggered by button click
 * @param {string} text The text to send
 * @param {HTMLElement} button The button that triggered the send
 */
function sendButtonMessage(text, button) {
    try {
        // Check if chatManager is available
        if (window.chatManager && typeof window.chatManager.handleSendMessage === 'function') {
            // Use the main chat manager for regular chat
            sendMessageViaMainChat(text);
        } else if (window.sendMessage && typeof window.sendMessage === 'function') {
            // Use direct sendMessage function (for voice chat, assistant modules)
            window.sendMessage(text);
        } else {
            throw new Error('No message sending function available');
        }

        console.log('[ContentProcessor] Button message sent:', text);

    } catch (error) {
        console.error('[ContentProcessor] Failed to send button message:', error);

        // Restore button on error
        restoreButton(button);

        // Show error notification
        showErrorNotification('发送失败，请重试');
    }
}

/**
 * Sends message via main chat interface
 * @param {string} text The text to send
 */
function sendMessageViaMainChat(text) {
    // Get the message input element
    const messageInput = document.getElementById('messageInput');
    if (!messageInput) {
        throw new Error('Message input not found');
    }

    // Set the text in input and trigger send
    messageInput.value = text;
    window.chatManager.handleSendMessage();

    // Note: handleSendMessage will clear the input automatically
}

/**
 * Shows an error notification to the user
 * @param {string} message The error message
 */
function showErrorNotification(message) {
    // Try to use existing notification system
    if (window.uiHelper && typeof window.uiHelper.showToastNotification === 'function') {
        window.uiHelper.showToastNotification(message, 'error');
        return;
    }

    // Fallback: create a simple notification
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff4444;
        color: white;
        padding: 12px 20px;
        border-radius: 4px;
        z-index: 10000;
        font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;

    document.body.appendChild(notification);

    // Auto remove after 3 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            document.body.removeChild(notification);
        }
    }, 3000);
}

/**
 * Applies all post-render processing to the message content.
 * @param {HTMLElement} contentDiv The message content element.
 */
function processRenderedContent(contentDiv) {
    if (!contentDiv) return;

    // KaTeX rendering
    if (window.renderMathInElement) {
        window.renderMathInElement(contentDiv, {
            delimiters: [
                {left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false},
                {left: "\\(", right: "\\)", display: false}, {left: "\\[", right: "\\]", display: true}
            ],
            throwOnError: false
        });
    }

    // Special block formatting (VCP/Diary)
    processAllPreBlocksInContentDiv(contentDiv);

    // Process interactive buttons (NEW)
    processInteractiveButtons(contentDiv);

    // Highlighting must run after KaTeX and other DOM manipulations
    highlightTagsInMessage(contentDiv);
    highlightQuotesInMessage(contentDiv);

    // Apply syntax highlighting to code blocks
    if (window.hljs) {
        contentDiv.querySelectorAll('pre code').forEach((block) => {
            // Only highlight if the block hasn't been specially prettified (e.g., DailyNote or VCP ToolUse)
            if (!block.parentElement.dataset.vcpPrettified && !block.parentElement.dataset.maidDiaryPrettified) {
                window.hljs.highlightElement(block);
            }
        });
    }
}


export {
    initializeContentProcessor,
    ensureNewlineAfterCodeBlock,
    ensureSpaceAfterTilde,
    removeIndentationFromCodeBlockMarkers,
    removeSpeakerTags,
    ensureSeparatorBetweenImgAndCode,
    processAllPreBlocksInContentDiv,
    highlightTagsInMessage,
    highlightQuotesInMessage,
    processRenderedContent,
    processInteractiveButtons,
    handleAIButtonClick,
    sendButtonMessage

};