document.addEventListener('DOMContentLoaded', async () => {
    // --- Start: Emoticon URL Fixer ---
    let emoticonLibrary = [];
    let isEmoticonFixerInitialized = false;

    // A simple string similarity function (Jaro-Winkler might be better, but this is simple)
    function getSimilarity(s1, s2) {
        let longer = s1;
        let shorter = s2;
        if (s1.length < s2.length) {
            longer = s2;
            shorter = s1;
        }
        const longerLength = longer.length;
        if (longerLength === 0) {
            return 1.0;
        }
        return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
    }

    function editDistance(s1, s2) {
        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else {
                    if (j > 0) {
                        let newValue = costs[j - 1];
                        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                        }
                        costs[j - 1] = lastValue;
                        lastValue = newValue;
                    }
                }
            }
            if (i > 0) {
                costs[s2.length] = lastValue;
            }
        }
        return costs[s2.length];
    }
    
    function extractEmoticonInfo(url) {
        let filename = null;
        let packageName = null;

        if (!url) return { filename, packageName };

        try {
            const decodedPath = decodeURIComponent(new URL(url).pathname);
            const parts = decodedPath.split('/').filter(Boolean);
            if (parts.length > 0) {
                filename = parts[parts.length - 1];
            }
            if (parts.length > 1) {
                packageName = parts[parts.length - 2];
            }
        } catch (e) {
            try {
                const decodedUrl = decodeURIComponent(url);
                const parts = decodedUrl.split('/').filter(Boolean);
                if (parts.length > 0) {
                    filename = parts[parts.length - 1];
                }
                if (parts.length > 1) {
                    packageName = parts[parts.length - 2];
                }
            } catch (e2) {
                const parts = url.split('/').filter(Boolean);
                if (parts.length > 0) {
                    filename = parts[parts.length - 1];
                }
                if (parts.length > 1) {
                    packageName = parts[parts.length - 2];
                }
            }
        }
        
        return { filename, packageName };
    }

    async function initializeEmoticonFixer() {
        if (isEmoticonFixerInitialized || !window.electronAPI) return;
        try {
            console.log('[TextViewer-EmoticonFixer] Initializing and fetching library...');
            const library = await window.electronAPI.getEmoticonLibrary();
            if (library && library.length > 0) {
                emoticonLibrary = library;
                isEmoticonFixerInitialized = true;
                console.log(`[TextViewer-EmoticonFixer] Library loaded with ${emoticonLibrary.length} items.`);
            } else {
                console.warn('[TextViewer-EmoticonFixer] Fetched library is empty.');
            }
        } catch (error) {
            console.error('[TextViewer-EmoticonFixer] Failed to initialize:', error);
        }
    }

    function fixEmoticonUrl(originalSrc) {
        if (!isEmoticonFixerInitialized || emoticonLibrary.length === 0) {
            return originalSrc;
        }
        try {
            const decodedOriginalSrc = decodeURIComponent(originalSrc);
            if (emoticonLibrary.some(item => decodeURIComponent(item.url) === decodedOriginalSrc)) {
                return originalSrc;
            }
        } catch (e) {
            // Malformed URL, proceed to fuzzy matching
        }
        try {
            if (!decodeURIComponent(originalSrc).includes('表情包')) {
                return originalSrc;
            }
        } catch (e) {
            return originalSrc;
        }

        const searchInfo = extractEmoticonInfo(originalSrc);
        if (!searchInfo.filename) {
            return originalSrc;
        }

        let bestMatch = null;
        let highestScore = -1;

        for (const item of emoticonLibrary) {
            const itemPackageInfo = extractEmoticonInfo(item.url);
            let packageScore = 0.5;
            if (searchInfo.packageName && itemPackageInfo.packageName) {
                packageScore = getSimilarity(searchInfo.packageName, itemPackageInfo.packageName);
            } else if (!searchInfo.packageName && !itemPackageInfo.packageName) {
                packageScore = 1.0;
            } else {
                packageScore = 0.0;
            }
            const filenameScore = getSimilarity(searchInfo.filename, item.filename);
            const score = (0.7 * packageScore) + (0.3 * filenameScore);
            if (score > highestScore) {
                highestScore = score;
                bestMatch = item;
            }
        }

        if (bestMatch && highestScore > 0.6) {
            console.log(`[TextViewer-EmoticonFixer] Fixed URL. Original: "${originalSrc}", Best Match: "${bestMatch.url}" (Score: ${highestScore.toFixed(2)})`);
            return bestMatch.url;
        }
        return originalSrc;
    }

    async function fixEmoticonImagesInContainer(container) {
        if (!isEmoticonFixerInitialized) {
            return;
        }
        const images = container.querySelectorAll('img');
        images.forEach(img => {
            const originalSrc = img.getAttribute('src');
            if (originalSrc) {
                const fixedSrc = fixEmoticonUrl(originalSrc);
                if (originalSrc !== fixedSrc) {
                    img.src = fixedSrc;
                }
            }
        });
    }
    // --- End: Emoticon URL Fixer ---

    initializeEmoticonFixer(); // Initialize when the script loads

    let originalRawContent = ''; // To store the raw, un-rendered content

    // --- Start: Ported Pre-processing functions from messageRenderer ---

    function deIndentHtml(text) {
        const lines = text.split('\n');
        let inFence = false;
        return lines.map(line => {
            if (line.trim().startsWith('```')) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && line.trim().startsWith('<')) {
                return line.trimStart();
            }
            return line;
        }).join('\n');
    }

    function escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"')
            .replace(/'/g, '&#039;');
    }

    function transformSpecialBlocksForViewer(text) {
        const toolRegex = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
        const noteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
        const toolResultRegex = /\[\[VCP调用结果信息汇总:(.*?)\]\]/gs;

        let processed = text;

        // Process VCP Tool Results - Viewer Mode (Full Details)
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

            let html = `<div class="vcp-tool-result-bubble">`;
            html += `<div class="vcp-tool-result-header">`;
            html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
            html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
            html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
            html += `</div>`;

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
            html += `</div>`;

            if (otherContent.length > 0) {
                html += `<div class="vcp-tool-result-footer"><pre>${escapeHtml(otherContent.join('\n'))}</pre></div>`;
            }

            html += `</div>`;

            return html;
        });

        // Process Tool Requests - Viewer Mode (Full Details)
        processed = processed.replace(toolRegex, (match, content) => {
            const toolNameRegex = /<tool_name>([\s\S]*?)<\/tool_name>|tool_name:\s*([^\n\r]*)/;
            const toolNameMatch = content.match(toolNameRegex);
            let toolName = (toolNameMatch && (toolNameMatch[1] || toolNameMatch[2])) ? (toolNameMatch[1] || toolNameMatch[2]).trim() : 'Tool Call';
            toolName = toolName.replace(/「始」|「末」|,/g, '').trim();

            let finalContent = escapeHtml(content.trim());
            if (toolName) {
                 finalContent = finalContent.replace(
                    escapeHtml(toolName),
                    `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>`
                );
            }
            
            return `<div class="vcp-tool-use-bubble">` +
                   `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                   finalContent +
                   `</div>`;
        });

        // Process Daily Notes - Viewer Mode (Styled)
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
    
    function ensureHtmlFenced(text) {
        const doctypeTag = '<!DOCTYPE html>';
        const lowerText = text.toLowerCase();
        
        // Quick exit if no doctype is present.
        if (!lowerText.includes(doctypeTag.toLowerCase())) {
            return text;
        }
        
        // If it's already in a proper code block, do nothing.
        // This regex now checks for any language specifier (or none) after the fences.
        if (/```\w*\n<!DOCTYPE html>/i.test(text)) {
            return text;
        }

        let result = '';
        let lastIndex = 0;
        while (true) {
            const startIndex = lowerText.indexOf(doctypeTag.toLowerCase(), lastIndex);

            const textSegment = text.substring(lastIndex, startIndex === -1 ? text.length : startIndex);
            result += textSegment;

            if (startIndex === -1) {
                break;
            }

            const endIndex = lowerText.indexOf('</html>', startIndex + doctypeTag.length);
            if (endIndex === -1) {
                result += text.substring(startIndex);
                break;
            }

            const block = text.substring(startIndex, endIndex + '</html>'.length);
            
            const fencesInResult = (result.match(/```/g) || []).length;

            if (fencesInResult % 2 === 0) {
                result += `\n\`\`\`html\n${block}\n\`\`\`\n`;
            } else {
                result += block;
            }

            lastIndex = endIndex + '</html>'.length;
        }
        return result;
    }

    function preprocessFullContent(text) {
        const codeBlockMap = new Map();
        let placeholderId = 0;

        // Step 1: Find and protect all fenced code blocks.
        let processed = text.replace(/```\w*([\s\S]*?)```/g, (match) => {
            const placeholder = `__VCP_CODE_BLOCK_PLACEHOLDER_${placeholderId}__`;
            codeBlockMap.set(placeholder, match);
            placeholderId++;
            return placeholder;
        });

        // Step 2: Run existing pre-processing on the modified text.
        processed = deIndentHtml(processed);
        processed = transformSpecialBlocksForViewer(processed);
        processed = ensureHtmlFenced(processed);
        
        // Basic content processors from contentProcessor.js
        processed = processed.replace(/^(\s*```)(?![\r\n])/gm, '$1\n'); // ensureNewlineAfterCodeBlock
        processed = processed.replace(/~(?![\s~])/g, '~ '); // ensureSpaceAfterTilde
        processed = processed.replace(/^(\s*)(```.*)/gm, '$2'); // removeIndentationFromCodeBlockMarkers
        processed = processed.replace(/(<img[^>]+>)\s*(```)/g, '$1\n\n<!-- VCP-Renderer-Separator -->\n\n$2'); // ensureSeparatorBetweenImgAndCode

        // Step 3: Restore the protected code blocks.
        if (codeBlockMap.size > 0) {
            for (const [placeholder, block] of codeBlockMap.entries()) {
                processed = processed.replace(placeholder, block);
            }
        }

        return processed;
    }

    // --- End: Ported functions ---

    /**
     * Finds and executes script tags within a given HTML element.
     * This is necessary because scripts inserted via innerHTML are not automatically executed.
     * @param {HTMLElement} containerElement - The element to search for scripts within.
     */
    function processAnimationsInContent(containerElement) {
        if (!containerElement || !window.anime) return;

        const scripts = Array.from(containerElement.querySelectorAll('script'));
        scripts.forEach(oldScript => {
            if (oldScript.type && oldScript.type !== 'text/javascript' && oldScript.type !== 'application/javascript') {
                return;
            }
            // Avoid re-running the main text-viewer script or external libraries already loaded
            if (oldScript.src.includes('text-viewer.js') || oldScript.src.includes('cdn.jsdelivr.net')) {
                return;
            }

            const newScript = document.createElement('script');
            Array.from(oldScript.attributes).forEach(attr => {
                newScript.setAttribute(attr.name, attr.value);
            });
            newScript.textContent = oldScript.textContent;
            
            if (oldScript.parentNode) {
                oldScript.parentNode.replaceChild(newScript, oldScript);
            }
        });
    }


    // --- Theme Management ---
    function applyTheme(theme) {
        const currentTheme = theme || 'dark';
        document.body.classList.toggle('light-theme', currentTheme === 'light');
        const highlightThemeStyle = document.getElementById('highlight-theme-style');
        if (highlightThemeStyle) {
            highlightThemeStyle.href = currentTheme === 'light'
                ? "../vendor/atom-one-light.min.css"
                : "../vendor/atom-one-dark.min.css";
        }
    }

    const params = new URLSearchParams(window.location.search);
    const initialTheme = params.get('theme') || 'dark';
    applyTheme(initialTheme);
    console.log(`[TextViewer] Initial theme set from URL: ${initialTheme}`);

    if (window.electronAPI) {
        window.electronAPI.onThemeUpdated(applyTheme);
    } else {
        console.log('[TextViewer] electronAPI not found. Theme updates will not be received.');
    }

    mermaid.initialize({ startOnLoad: false }); // 初始化 Mermaid，但不自动渲染

    if (window.marked) {
        marked.setOptions({
            gfm: true,
            tables: true,
            breaks: false,
            pedantic: false,
            sanitize: false,
            smartLists: true,
            smartypants: false
        });
    }

    // --- Dual-Mode Python Execution ---
    let pyodide = null;
    let isPyodideLoading = false;

    async function initializePyodide(statusElement) {
        if (pyodide) return pyodide;
        if (isPyodideLoading) {
            statusElement.textContent = 'Pyodide is already loading, please wait...';
            return null;
        }
        isPyodideLoading = true;
        try {
            statusElement.textContent = 'Loading Pyodide script...';
            if (!window.loadPyodide) {
                const script = document.createElement('script');
                script.src = '../vendor/pyodide.js';
                document.head.appendChild(script);
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                });
            }
            statusElement.textContent = 'Initializing Pyodide core... (this may take a moment)';
            pyodide = await window.loadPyodide({
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/"
            });
            console.log("Pyodide initialized successfully.");
            return pyodide;
        } catch (error) {
            console.error("Pyodide initialization failed:", error);
            statusElement.textContent = `Pyodide initialization failed: ${error}`;
            return null;
        } finally {
            isPyodideLoading = false;
        }
    }


    // --- Start: Python Executors as requested ---

    function displayPythonResult(outputContainer, result) {
        const trimmedResult = result.trim();
        // A simple check for HTML content. It looks for a string that starts with a tag.
        const isHtml = /^<[a-z][\s\S]*>/i.test(trimmedResult);
        if (isHtml) {
            outputContainer.innerHTML = trimmedResult;
        } else {
            outputContainer.textContent = trimmedResult || 'Execution finished with no output.';
        }
    }

    async function py_safe_executor(code, outputContainer) {
        outputContainer.textContent = 'Preparing Python sandbox environment...';
        const pyodideInstance = await initializePyodide(outputContainer);
        if (!pyodideInstance) return;

        try {
            // First, handle packages specified in comments
            const packageRegex = /^#\s*requires:\s*([a-zA-Z0-9_,\s-]+)/gm;
            const packages = new Set();
            let match;
            while ((match = packageRegex.exec(code)) !== null) {
                match[1].split(',').forEach(p => {
                    const pkg = p.trim();
                    if (pkg) packages.add(pkg);
                });
            }

            if (packages.size > 0) {
                const packageList = Array.from(packages);
                outputContainer.textContent = `Loading required packages: ${packageList.join(', ')}...`;
                await pyodideInstance.loadPackage(packageList);
                outputContainer.textContent = 'Packages loaded. Executing code...';
            } else {
                outputContainer.textContent = 'Executing code in sandbox...';
            }

            let stdout = '';
            let stderr = '';
            pyodideInstance.setStdout({ batched: (s) => { stdout += s + '\n'; } });
            pyodideInstance.setStderr({ batched: (s) => { stderr += s + '\n'; } });
            
            await pyodideInstance.runPythonAsync(code);

            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += `\n--- ERRORS ---\n${stderr}`;
            
            displayPythonResult(outputContainer, result);

        } catch (error) {
            const errorMessage = error.toString();
            const packageMatch = errorMessage.match(/await pyodide\.loadPackage\("([^"]+)"\)/) || errorMessage.match(/await micropip\.install\("([^"]+)"\)/);

            if (packageMatch && packageMatch[1]) {
                const missingPackage = packageMatch[1];
                try {
                    outputContainer.textContent = `Detected missing package: ${missingPackage}. Attempting to install...`;
                    await pyodideInstance.loadPackage(missingPackage);
                    outputContainer.textContent = `Package ${missingPackage} installed. Retrying execution...`;
                    
                    let stdout = '';
                    let stderr = '';
                    pyodideInstance.setStdout({ batched: (s) => { stdout += s + '\n'; } });
                    pyodideInstance.setStderr({ batched: (s) => { stderr += s + '\n'; } });
                    
                    await pyodideInstance.runPythonAsync(code);

                    let result = '';
                    if (stdout) result += stdout;
                    if (stderr) result += `\n--- ERRORS ---\n${stderr}`;
                    
                    displayPythonResult(outputContainer, result);

                } catch (retryError) {
                    console.error(`Sandbox Python execution error on retry for ${missingPackage}:`, retryError);
                    outputContainer.textContent = `Sandbox Execution Error:\nFailed to install or run after installing '${missingPackage}'.\n${retryError.toString()}`;
                }
            } else {
                console.error("Sandbox Python execution error:", error);
                outputContainer.textContent = `Sandbox Execution Error:\n${error.toString()}`;
            }
        }
    }

    async function py_penetration_executor(code, outputContainer) {
        console.log('[text-viewer] Entering py_penetration_executor.');
        outputContainer.textContent = 'Executing with local Python...';
        if (window.electronAPI && window.electronAPI.executePythonCode) {
            try {
                console.log('[text-viewer] Calling electronAPI.executePythonCode...');
                const { stdout, stderr } = await window.electronAPI.executePythonCode(code);
                console.log('[text-viewer] electronAPI.executePythonCode returned.');
                console.log('[text-viewer] Python stdout (from renderer):', stdout);
                console.log('[text-viewer] Python stderr (from renderer):', stderr);

                let result = '';
                // Strip ANSI escape codes before displaying
                const cleanedStdout = stripAnsi(stdout);
                const cleanedStderr = stripAnsi(stderr);

                if (cleanedStdout) result += `--- Output ---\n${cleanedStdout}`;
                if (cleanedStderr) result += `\n--- Errors ---\n${cleanedStderr}`;
                outputContainer.textContent = result.trim() || 'Execution finished with no output.';
            } catch (error) {
                console.error("[text-viewer] Local Python execution error (in renderer):", error);
                outputContainer.textContent = `Local Execution Error:\n${error.toString()}`;
            }
        } else {
            outputContainer.textContent = 'Error: electronAPI.executePythonCode is not available.';
            console.error('[text-viewer] electronAPI.executePythonCode is not available.');
        }
        console.log('[text-viewer] Exiting py_penetration_executor.');
    }

    // --- End: Python Executors as requested ---
    async function runPythonCode(code, outputContainer) {
        outputContainer.style.display = 'block';
        const isSandboxMode = document.getElementById('sandbox-toggle').checked;

        if (isSandboxMode) {
            await py_safe_executor(code, outputContainer);
        } else {
            await py_penetration_executor(code, outputContainer);
        }
    }
    // --- End Dual-Mode Python Execution ---

    // Function to strip ANSI escape codes
    function stripAnsi(str) {
        // eslint-disable-next-line no-control-regex
        return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, '');
    }

    function removeBoldMarkersAroundQuotes(text) {
        if (typeof text !== 'string') return text;
        // Replace **" with " and **“ with “
        let processedText = text.replace(/\*\*(["“])/g, '$1');
        // Replace "** with " and ”** with ”
        processedText = processedText.replace(/(["”])\*\*/g, '$1');
        return processedText;
    }

    function renderQuotedText(text, currentTheme) {
        const className = currentTheme === 'light' ? 'custom-quote-light' : 'custom-quote-dark';
        // This regex uses alternation. It first tries to match a whole code block.
        // If it matches, the code block is returned unmodified.
        // Otherwise, it tries to match a quoted string and wraps it.
        // This is much more robust than splitting the string.
        return text.replace(/(```[\s\S]*?```)|("([^"]*?)"|“([^”]*?)”)/g, (match, codeBlock, fullQuote) => {
            // If a code block is matched (group 1), return it as is.
            if (codeBlock) {
                return codeBlock;
            }
            // If a quote is matched (group 2), wrap it in a span.
            if (fullQuote) {
                return `<span class="${className}">${fullQuote}</span>`;
            }
            // Fallback, should not happen with this regex structure
            return match;
        });
    }

    function decodeHtmlEntities(text) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = text;
        return textarea.value;
    }

    const textContent = params.get('text');
    const windowTitle = params.get('title') || '文本阅读模式';
    const encoding = params.get('encoding');
    const decodedTitle = decodeURIComponent(windowTitle);

    document.title = decodedTitle;
    document.getElementById('viewer-title-text').textContent = decodedTitle;
    const contentDiv = document.getElementById('textContent');
    const editAllButton = document.getElementById('editAllButton'); // Get the new button
    const shareToNotesButton = document.getElementById('shareToNotesButton');

    // Global edit button logic
    if (editAllButton && contentDiv) {
        // Store references to the button's icon and text elements
        let currentEditAllButtonIcon = editAllButton.querySelector('svg');
        const editAllButtonText = editAllButton.querySelector('span');

        const globalEditIconSVGString = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        const globalDoneIconSVGString = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;

        editAllButton.addEventListener('click', () => {
            const existingTextarea = document.querySelector('.global-edit-textarea');
            currentEditAllButtonIcon = editAllButton.querySelector('svg');

            if (existingTextarea) { // === Exiting edit mode ===
                originalRawContent = existingTextarea.value; // Get updated raw content

                // Re-render content using the full pipeline
                const processedContent = preprocessFullContent(originalRawContent);
                const renderedHtml = window.marked.parse(processedContent);
                contentDiv.innerHTML = renderedHtml;
                enhanceRenderedContent(contentDiv); // This already includes syntax highlighting etc.

                // UI cleanup
                existingTextarea.remove();
                contentDiv.style.display = '';
                if (currentEditAllButtonIcon) currentEditAllButtonIcon.outerHTML = globalEditIconSVGString;
                if (editAllButtonText) editAllButtonText.textContent = '编辑全文';
                editAllButton.setAttribute('title', '编辑全文');

            } else { // === Entering edit mode ===
                contentDiv.style.display = 'none'; // Hide rendered content

                const textarea = document.createElement('textarea');
                textarea.className = 'global-edit-textarea';
                textarea.value = originalRawContent; // Put raw content in textarea

                // Basic styling for the textarea
                textarea.style.width = '100%';
                textarea.style.minHeight = '70vh';
                textarea.style.boxSizing = 'border-box';
                textarea.style.backgroundColor = 'var(--viewer-code-bg)';
                textarea.style.color = 'var(--viewer-primary-text)';
                textarea.style.border = '1px solid var(--viewer-code-bg-hover)';
                textarea.style.borderRadius = '8px';
                textarea.style.padding = '15px';
                textarea.style.fontFamily = 'var(--font-family-monospace, monospace)';
                textarea.style.lineHeight = '1.5';

                // Insert textarea and focus
                contentDiv.parentNode.insertBefore(textarea, contentDiv.nextSibling);
                textarea.focus();

                // Add keyboard shortcuts for exiting edit mode
                textarea.addEventListener('keydown', (e) => {
                    // Ctrl+Enter to save changes
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        editAllButton.click(); // Trigger the save-and-exit logic
                    }
                    // Escape to cancel changes
                    else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation(); // Prevent the global Escape handler from closing the window
                        // Manually revert the UI to its pre-edit state without saving
                        const currentIcon = editAllButton.querySelector('svg');
                        textarea.remove();
                        contentDiv.style.display = '';
                        if (currentIcon) currentIcon.outerHTML = globalEditIconSVGString;
                        if (editAllButtonText) editAllButtonText.textContent = '编辑全文';
                        editAllButton.setAttribute('title', '编辑全文');
                    }
                });

                // Update button state
                if (currentEditAllButtonIcon) currentEditAllButtonIcon.outerHTML = globalDoneIconSVGString;
                if (editAllButtonText) editAllButtonText.textContent = '完成编辑';
                editAllButton.setAttribute('title', '完成编辑');
            }
        });
    }

    if (shareToNotesButton && contentDiv) {
        shareToNotesButton.addEventListener('click', () => {
            const noteTitle = document.title || '来自阅读模式的分享'; // 使用页面标题或默认标题
            
            // 尝试通过 electronAPI 打开新窗口或通知主进程处理
            if (window.electronAPI && window.electronAPI.openNotesWithContent) {
                console.log('[text-viewer] Attempting to share via electronAPI.openNotesWithContent');
                window.electronAPI.openNotesWithContent({
                    title: noteTitle,
                    content: originalRawContent, // Use the raw source content
                }).catch(err => {
                    console.error('[text-viewer] Error calling electronAPI.openNotesWithContent:', err);
                    // 如果API调用失败，可以在这里给用户一些提示
                    alert('分享到笔记失败，请检查控制台获取更多信息。');
                });
            } else {
                console.error('[text-viewer] electronAPI.openNotesWithContent is not available.');
                alert('分享功能不可用，无法连接到主进程。');
            }
        });
    }

    async function enhanceRenderedContent(container) {
        // First, fix any broken emoticon URLs
        await fixEmoticonImagesInContainer(container);

        // Style status bubbles based on content
        container.querySelectorAll('.vcp-tool-result-status').forEach(statusEl => {
            const statusText = statusEl.textContent.toUpperCase();
            if (statusText.includes('SUCCESS')) {
                statusEl.classList.add('status-success');
            } else if (statusText.includes('FAILURE') || statusText.includes('ERROR')) {
                statusEl.classList.add('status-failure');
            }
        });

        const codeBlocksToProcess = [];
        const mermaidBlocksToRender = [];
        const drawioBlocksToRender = [];

        // First pass: Separate Mermaid and Draw.io blocks from regular code blocks
        container.querySelectorAll('pre code').forEach((codeBlock) => {
            const firstLine = (codeBlock.textContent.trim().split('\n')[0] || '').trim().toLowerCase();
            const isMermaidByClass = codeBlock.classList.contains('language-mermaid');
            const isMermaidByContent = firstLine === 'mermaid';
            const isDrawioByClass = codeBlock.classList.contains('language-drawio');
            const isDrawioByContent = codeBlock.textContent.trim().startsWith('<mxfile');

            if (isMermaidByClass || isMermaidByContent) {
                mermaidBlocksToRender.push({ codeBlock, isMermaidByContent });
            } else if (isDrawioByClass || isDrawioByContent) {
                drawioBlocksToRender.push(codeBlock);
            }
            else {
                codeBlocksToProcess.push(codeBlock);
            }
        });

        // --- RENDER MERMAID ---
        if (window.mermaid && mermaidBlocksToRender.length > 0) {
            const mermaidElements = [];
            mermaidBlocksToRender.forEach(({ codeBlock, isMermaidByContent }) => {
                const preElement = codeBlock.parentElement;
                const mermaidContainer = document.createElement('div');
                mermaidContainer.className = 'mermaid';

                let mermaidText = codeBlock.textContent;
                if (isMermaidByContent) {
                    const newlineIndex = mermaidText.indexOf('\n');
                    mermaidText = newlineIndex !== -1 ? mermaidText.substring(newlineIndex + 1) : '';
                }
                
                mermaidContainer.textContent = mermaidText.trim();
                
                preElement.parentNode.replaceChild(mermaidContainer, preElement);
                mermaidElements.push(mermaidContainer);
            });

            try {
                mermaid.run({ nodes: mermaidElements });
            } catch(e) {
                console.error("Mermaid rendering error:", e);
                mermaidElements.forEach(block => {
                    block.innerHTML = `Mermaid Error: ${e.message}`;
                });
            }
        }

        // --- RENDER DRAW.IO ---
        if (window.GraphViewer && drawioBlocksToRender.length > 0) {
            drawioBlocksToRender.forEach(codeBlock => {
                const preElement = codeBlock.parentElement;
                const drawioContainer = document.createElement('div');
                // The viewer script looks for the 'mxgraph' class.
                drawioContainer.className = 'mxgraph';
                
                let xmlContent = codeBlock.textContent.trim();
                // Remove HTML comments from the XML content to prevent parsing issues.
                xmlContent = xmlContent.replace(/<!--[\s\S]*?-->/g, '');
                
                // The configuration is passed via a data-mxgraph attribute.
                const config = {
                    "highlight": "#0000ff",
                    "target": "blank",
                    "nav": true,
                    "resize": true,
                    "toolbar": "zoom layers lightbox",
                    "edit": "_blank",
                    "xml": xmlContent
                };
                drawioContainer.setAttribute('data-mxgraph', JSON.stringify(config));
                
                preElement.parentNode.replaceChild(drawioContainer, preElement);
            });
            
            // After creating the elements, we need to tell the viewer to render them.
            // This is a more robust method than relying on automatic rendering.
            try {
                window.GraphViewer.processElements();
            } catch (e) {
                console.error("Draw.io rendering error (processElements):", e);
            }
        }

        // --- PROCESS REGULAR CODE BLOCKS ---
        codeBlocksToProcess.forEach((block) => {
            const preElement = block.parentElement;
            if (!preElement || preElement.querySelector('.copy-button')) return; // Already enhanced or parent gone

            // Step 1: Clean language identifier
            let lines = block.textContent.split('\n');
            if (lines.length > 0) {
                const firstLine = lines[0].trim().toLowerCase();
                if (firstLine === 'python' || firstLine === 'html') {
                    lines.shift();
                    block.textContent = lines.join('\n');
                }
            }

            // Step 2: Apply syntax highlighting
            if (window.hljs) {
                hljs.highlightElement(block);
            }

            // Step 3: Add interactive buttons
            preElement.style.position = 'relative';
            const codeContent = decodeHtmlEntities(block.textContent);
            
            const isHtmlByClass = Array.from(block.classList).some(cls => /^language-html$/i.test(cls));
            const trimmedContent = codeContent.trim().toLowerCase();
            const isHtmlByContent = trimmedContent.startsWith('<!doctype html>') || trimmedContent.startsWith('<html>');
            const isHtml = isHtmlByClass || isHtmlByContent;

            const isPython = Array.from(block.classList).some(cls => /^language-python$/i.test(cls));

            // New check for three.js
            const isThreeJsByClass = Array.from(block.classList).some(cls => /^language-(javascript|js|threejs)$/i.test(cls));
            const isThreeJsByContent = codeContent.includes('THREE.');
            // To avoid conflict with regular HTML that might contain JS.
            // A dedicated threejs block should not be a full html document.
            const isThreeJs = (isThreeJsByClass && isThreeJsByContent) && !isHtml;

            if (isHtml) {
                const playButton = document.createElement('button');
                const playIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
                const codeIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
                playButton.innerHTML = playIconSVG;
                playButton.className = 'play-button';
                playButton.setAttribute('title', '预览HTML');
                preElement.appendChild(playButton);

                playButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const existingPreview = preElement.nextElementSibling;
                    if (existingPreview && existingPreview.classList.contains('html-preview-container')) {
                        existingPreview.remove();
                        preElement.style.display = 'block';
                        return;
                    }
                    preElement.style.display = 'none';
                    const previewContainer = document.createElement('div');
                    previewContainer.className = 'html-preview-container';
                    const iframe = document.createElement('iframe');
                    iframe.sandbox = 'allow-scripts allow-same-origin';
                    const exitButton = document.createElement('button');
                    exitButton.innerHTML = codeIconSVG + ' 返回代码';
                    exitButton.className = 'exit-preview-button';
                    exitButton.title = '返回代码视图';
                    exitButton.addEventListener('click', () => {
                        previewContainer.remove();
                        preElement.style.display = 'block';
                    });
                    previewContainer.appendChild(iframe);
                    previewContainer.appendChild(exitButton);
                    preElement.parentNode.insertBefore(previewContainer, preElement.nextSibling);
                    const iframeDoc = iframe.contentWindow.document;
                    iframeDoc.open();
                    let finalHtml = codeContent;
                    const trimmedCode = codeContent.trim().toLowerCase();
                    if (!trimmedCode.startsWith('<!doctype') && !trimmedCode.startsWith('<html>')) {
                        const bodyStyles = document.body.classList.contains('light-theme')
                            ? 'color: #2c3e50; background-color: #ffffff;'
                            : 'color: #abb2bf; background-color: #282c34;';
                        finalHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HTML Preview</title><script src="../vendor/anime.min.js"><\/script><style>body { font-family: sans-serif; padding: 15px; margin: 0; ${bodyStyles} }</style></head><body>${codeContent}</body></html>`;
                    } else {
                        // If it's a full document, inject anime.js before the closing </head> tag
                        finalHtml = finalHtml.replace('</head>', '<script src="../vendor/anime.min.js"><\/script></head>');
                    }
                    iframeDoc.write(finalHtml);
                    iframeDoc.close();
                });
            } else if (isPython) {
                const pyPlayButton = document.createElement('button');
                const playIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
                pyPlayButton.innerHTML = playIconSVG;
                pyPlayButton.className = 'play-button';
                pyPlayButton.setAttribute('title', 'Run Python Code');
                preElement.appendChild(pyPlayButton);
                const outputContainer = document.createElement('div');
                outputContainer.className = 'python-output-container';
                preElement.parentNode.insertBefore(outputContainer, preElement.nextSibling);
                pyPlayButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (outputContainer.style.display === 'block') {
                        outputContainer.style.display = 'none';
                    } else {
                        const codeToRun = decodeHtmlEntities(block.innerText);
                        runPythonCode(codeToRun, outputContainer);
                    }
                });
            } else if (isThreeJs) {
                const playButton = document.createElement('button');
                const playIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
                const codeIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
                playButton.innerHTML = playIconSVG;
                playButton.className = 'play-button';
                playButton.setAttribute('title', '预览 3D 动画');
                preElement.appendChild(playButton);

                playButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const existingPreview = preElement.nextElementSibling;
                    if (existingPreview && existingPreview.classList.contains('html-preview-container')) {
                        existingPreview.remove();
                        preElement.style.display = 'block';
                        return;
                    }
                    preElement.style.display = 'none';
                    const previewContainer = document.createElement('div');
                    previewContainer.className = 'html-preview-container';
                    const iframe = document.createElement('iframe');
                    iframe.sandbox = 'allow-scripts allow-same-origin';
                    const exitButton = document.createElement('button');
                    exitButton.innerHTML = codeIconSVG + ' 返回代码';
                    exitButton.className = 'exit-preview-button';
                    exitButton.title = '返回代码视图';
                    exitButton.addEventListener('click', () => {
                        previewContainer.remove();
                        preElement.style.display = 'block';
                    });
                    previewContainer.appendChild(iframe);
                    previewContainer.appendChild(exitButton);
                    preElement.parentNode.insertBefore(previewContainer, preElement.nextSibling);
                    const iframeDoc = iframe.contentWindow.document;
                    iframeDoc.open();
                    const threeJsHtml = `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>Three.js Preview</title>
                            <style>
                                body { margin: 0; overflow: hidden; background-color: #000; }
                                canvas { display: block; }
                            </style>
                        </head>
                        <body>
                            <script src="../vendor/three.min.js"><\/script>
                            <script>
                                // Defer execution until three.js is loaded
                                window.addEventListener('load', () => {
                                    try {
${codeContent}
                                    } catch (e) {
                                        document.body.innerHTML = '<div style="color: #ff5555; font-family: sans-serif; padding: 20px;"><h3>An error occurred while running the script:</h3><pre>' + e.stack + '</pre></div>';
                                    }
                                });
                            <\/script>
                        </body>
                        </html>
                    `;
                    iframeDoc.write(threeJsHtml);
                    iframeDoc.close();
                });
            }

            const editButton = document.createElement('button');
            const editIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
            const doneIconSVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
            editButton.innerHTML = editIconSVG;
            editButton.className = 'edit-button';
            editButton.setAttribute('title', '编辑');
            editButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isEditing = block.isContentEditable;
                block.contentEditable = !isEditing;
                if (!isEditing) {
                    block.focus();
                    editButton.innerHTML = doneIconSVG;
                    editButton.setAttribute('title', '完成编辑');
                } else {
                    editButton.innerHTML = editIconSVG;
                    editButton.setAttribute('title', '编辑');
                    if (window.hljs) {
                        hljs.highlightElement(block);
                    }
                }
            });
            preElement.appendChild(editButton);

            const copyButton = document.createElement('button');
            copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
            copyButton.className = 'copy-button';
            copyButton.setAttribute('title', '复制');
            copyButton.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(block.innerText).catch(err => console.error('无法复制到剪贴板:', err));
            });
            preElement.appendChild(copyButton);
        });

        // --- PROCESS SHADOW DOM ---
        container.querySelectorAll('div > style').forEach(styleTag => {
            const wrapperDiv = styleTag.parentElement;
            if (wrapperDiv.shadowRoot || wrapperDiv.closest('pre, .html-preview-container')) {
                return;
            }
            if (wrapperDiv.parentElement !== container) {
                return;
            }
            try {
                const shadow = wrapperDiv.attachShadow({ mode: 'open' });
                shadow.innerHTML = wrapperDiv.innerHTML;
                wrapperDiv.innerHTML = '';
            } catch (e) {
                console.error('Error creating shadow DOM for rich content:', e);
            }
        });

        // --- RENDER LATEX ---
        if (window.renderMathInElement) {
            try {
                renderMathInElement(container, {
                    delimiters: [
                        {left: "$$", right: "$$", display: true},
                        {left: "$", right: "$", display: false},
                        {left: "\\(", right: "\\)", display: false},
                        {left: "\\[", right: "\\]", display: true}
                    ],
                    throwOnError: false
                });
            } catch (e) {
                console.error("KaTeX rendering error:", e);
            }
        }
        
        // --- Call animation processor after all other enhancements ---
        processAnimationsInContent(container);
    }

    if (textContent) {
        try {
            let decodedText;
            if (encoding === 'base64') {
                try {
                    // This is a more robust way to decode base64 with UTF-8 characters.
                    const binaryString = atob(textContent);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    decodedText = new TextDecoder('utf-8').decode(bytes);
                } catch (e) {
                    console.error("Base64 decoding failed:", e);
                    // Fallback to the old method for simpler cases, just in case.
                    decodedText = decodeURIComponent(escape(window.atob(textContent)));
                }
            } else {
                decodedText = decodeURIComponent(textContent);
            }
            originalRawContent = decodedText; // Store the raw source content

            // Render with the full pre-processing pipeline
            const processedContent = preprocessFullContent(originalRawContent);
            const renderedHtml = window.marked.parse(processedContent);
            contentDiv.innerHTML = renderedHtml;

            // After rendering, enhance the content with interactivity
            enhanceRenderedContent(contentDiv);

        } catch (error) {
            console.error("Error rendering content:", error);
            contentDiv.innerHTML = `
                <h3 style="color: #e06c75;">内容渲染失败</h3>
                <p>在处理文本时发生错误，这可能是由于文本包含了格式不正确的编码字符。</p>
                <p><strong>错误详情:</strong></p>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${error.toString()}</pre>
                <p><strong>原始文本内容:</strong></p>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${textContent}</pre>
            `;
        }
    } else {
        contentDiv.textContent = '没有提供文本内容。';
    }

    // Custom Context Menu Logic
    const contextMenu = document.getElementById('customContextMenu');
    const contextMenuCopyButton = document.getElementById('contextMenuCopy');
    const contextMenuCutButton = document.getElementById('contextMenuCut');
    const contextMenuDeleteButton = document.getElementById('contextMenuDelete');
    const contextMenuEditAllButton = document.getElementById('contextMenuEditAll');
    const contextMenuCopyAllButton = document.getElementById('contextMenuCopyAll');
    const contextMenuShareScreenshotButton = document.getElementById('contextMenuShareScreenshot');
    const contextMenuShareNoteButton = document.getElementById('contextMenuShareNote');
    const mainContentDiv = document.getElementById('textContent'); // Renamed for clarity from previous contentDiv
 
     if (contextMenu && contextMenuCopyButton && contextMenuCutButton && contextMenuDeleteButton && contextMenuEditAllButton && contextMenuCopyAllButton && contextMenuShareScreenshotButton && contextMenuShareNoteButton && mainContentDiv) {
        document.addEventListener('contextmenu', (event) => {
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();

            event.preventDefault(); // Always prevent default to show custom menu

            contextMenu.style.top = `${event.pageY}px`;
            contextMenu.style.left = `${event.pageX}px`;
            contextMenu.style.display = 'block';

            if (selectedText) {
                // Show standard copy, cut, delete if text is selected
                contextMenuCopyButton.style.display = 'block';
                contextMenuCutButton.style.display = 'block';
                contextMenuDeleteButton.style.display = 'block';
                contextMenuEditAllButton.style.display = 'none';
                contextMenuCopyAllButton.style.display = 'none';
                contextMenuShareScreenshotButton.style.display = 'none';
                contextMenuShareNoteButton.style.display = 'none';
            } else {
                // Show "Edit All" and "Copy All" if no text is selected
                contextMenuCopyButton.style.display = 'none';
                contextMenuCutButton.style.display = 'none';
                contextMenuDeleteButton.style.display = 'none';
                contextMenuEditAllButton.style.display = 'block';
                contextMenuCopyAllButton.style.display = 'block';
                contextMenuShareScreenshotButton.style.display = 'block';
                contextMenuShareNoteButton.style.display = 'block';
            }

            // Determine if Cut and Delete should be shown (based on editability)
            let isAnyEditableContext = mainContentDiv.isContentEditable; // Check global edit mode
            const targetElement = event.target;
            const closestCodeBlock = targetElement.closest('code.hljs');

            if (!isAnyEditableContext && closestCodeBlock && closestCodeBlock.isContentEditable) {
                isAnyEditableContext = true;
            }

            // If text is selected, adjust cut/delete visibility based on editability
            if (selectedText) {
                contextMenuCutButton.style.display = isAnyEditableContext ? 'block' : 'none';
                contextMenuDeleteButton.style.display = isAnyEditableContext ? 'block' : 'none';
            }
        });

        document.addEventListener('click', (event) => {
            if (contextMenu.style.display === 'block' && !contextMenu.contains(event.target)) {
                contextMenu.style.display = 'none';
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                contextMenu.style.display = 'none';
            }
        });

        contextMenuCopyButton.addEventListener('click', () => {
            const selectedText = window.getSelection().toString();
            if (selectedText) {
                navigator.clipboard.writeText(selectedText).then(() => {
                    console.log('文本已复制到剪贴板');
                }).catch(err => {
                    console.error('无法复制文本: ', err);
                });
            }
            contextMenu.style.display = 'none';
        });

        contextMenuCutButton.addEventListener('click', () => {
            const selection = window.getSelection();
            const selectedText = selection.toString();
            
            let canPerformEdit = mainContentDiv.isContentEditable;
            const activeCodeBlock = document.activeElement && document.activeElement.closest('code.hljs') && document.activeElement.isContentEditable;
            if(!canPerformEdit && activeCodeBlock){
                canPerformEdit = true;
            }

            if (selectedText && canPerformEdit) {
                navigator.clipboard.writeText(selectedText).then(() => {
                    document.execCommand('delete', false, null);
                    console.log('文本已剪切到剪贴板');
                }).catch(err => {
                    console.error('无法剪切文本: ', err);
                });
            }
            contextMenu.style.display = 'none';
        });

        contextMenuDeleteButton.addEventListener('click', () => {
            const selection = window.getSelection();
            let canPerformEdit = mainContentDiv.isContentEditable;
            const activeCodeBlock = document.activeElement && document.activeElement.closest('code.hljs') && document.activeElement.isContentEditable;
             if(!canPerformEdit && activeCodeBlock){
                canPerformEdit = true;
            }

            if (selection.toString() && canPerformEdit) {
                document.execCommand('delete', false, null);
                console.log('选中文本已删除');
            }
            contextMenu.style.display = 'none';
        });
        contextMenuEditAllButton.addEventListener('click', () => {
            editAllButton.click(); // Trigger the global edit button's click event
            contextMenu.style.display = 'none';
        });

        contextMenuCopyAllButton.addEventListener('click', () => {
            const fullText = mainContentDiv.innerText;
            navigator.clipboard.writeText(fullText).then(() => {
                console.log('全文已复制到剪贴板');
            }).catch(err => {
                console.error('无法复制全文: ', err);
            });
            contextMenu.style.display = 'none';
        });
 
         contextMenuShareScreenshotButton.addEventListener('click', () => {
            contextMenu.style.display = 'none';
            if (window.html2canvas && mainContentDiv) {
                html2canvas(mainContentDiv, {
                    useCORS: true, // Allow loading cross-origin images
                    // Use the body's actual background color. This is crucial for correct rendering.
                    backgroundColor: window.getComputedStyle(document.body).backgroundColor,
                    onclone: (clonedDoc) => {
                        // Re-apply the theme class to the cloned document's body so styles are correct
                        if (document.body.classList.contains('light-theme')) {
                            clonedDoc.body.classList.add('light-theme');
                        }
                        // Also explicitly set the background color on the cloned body, as it can help html2canvas
                        // with layout calculations. A transparent background can cause rendering glitches.
                        clonedDoc.body.style.backgroundColor = window.getComputedStyle(document.body).backgroundColor;

                        // --- FIX for flexbox rendering issue ---
                        // html2canvas can struggle with text nodes that are direct children of flex containers.
                        // We wrap them in a <span> to make them element nodes, which are handled more robustly.
                        clonedDoc.querySelectorAll('*').forEach(el => {
                            const style = window.getComputedStyle(el);
                            if (style.display === 'flex') {
                                Array.from(el.childNodes).forEach(child => {
                                    // Node.TEXT_NODE === 3
                                    if (child.nodeType === 3 && child.textContent.trim().length > 0) {
                                        const span = clonedDoc.createElement('span');
                                        span.textContent = child.textContent;
                                        el.replaceChild(span, child);
                                    }
                                });
                            }
                        });
                    }
                }).then(canvas => {
                    const imageDataUrl = canvas.toDataURL('image/png');
                    if (window.electronAPI && window.electronAPI.openImageViewer) {
                        window.electronAPI.openImageViewer({
                            src: imageDataUrl,
                            title: `截图分享 - ${document.title}`
                        });
                    } else {
                        console.error('electronAPI.openImageViewer is not available.');
                        alert('截图功能不可用。');
                    }
                }).catch(err => {
                    console.error('Error generating screenshot:', err);
                    alert('生成截图失败。');
                });
            }
        });
 
         contextMenuShareNoteButton.addEventListener('click', () => {
            shareToNotesButton.click(); // Trigger the global share button's click event
            contextMenu.style.display = 'none';
        });
    }
    
    // Add keyboard listener for Escape key to close the window
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            window.close();
        }
    });

    // --- Custom Title Bar Listeners ---
    const minimizeBtn = document.getElementById('minimize-viewer-btn');
    const maximizeBtn = document.getElementById('maximize-viewer-btn');
    const closeBtn = document.getElementById('close-viewer-btn');

    if (minimizeBtn && maximizeBtn && closeBtn) {
        minimizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        });

        maximizeBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        });

        closeBtn.addEventListener('click', () => {
            window.close();
        });
    }
});
