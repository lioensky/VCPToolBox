const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { setHost, setApiKey, newPanelClient, PanelError } = require('./utils');

// const PANEL_INFO_SEPARATOR = '\n---PANEL_INFO_SEPARATOR---\n'; // No longer needed
// const CACHE_FILE = path.join(__dirname, '1panel_info_provider_cache.txt'); // Replaced by individual cache files

const DASHBOARD_CACHE_FILE = path.join(__dirname, '1panel_dashboard_cache.json');
const SYSTEM_INFO_CACHE_FILE = path.join(__dirname, '1panel_system_info_cache.json');

// 从环境变量读取配置
const panelBaseUrl = process.env.PanelBaseUrl;
const panelApiKey = process.env.PanelApiKey;
const debugMode = (process.env.DebugMode || "false").toLowerCase() === "true";
const enabled = (process.env.Enabled || "true").toLowerCase() === "true"; // 新增：读取 Enabled 配置

function FORCE_LOG(...args) {
    console.error(...args); // 强制日志输出到 stderr
}

async function fetchDashboardInfo() {
    if (debugMode) FORCE_LOG('[1PanelInfoProvider] Fetching Dashboard Info...');
    const client = newPanelClient('GET', '/dashboard/base/all/all');
    try {
        const response = await client.request(); // This is axiosResponse.data
        if (debugMode) FORCE_LOG('[1PanelInfoProvider] Raw Dashboard Info API Response (type):', typeof response);
        // Expect response to be like { code: 0, message: 'success', data: { ...payload... } }
        if (response && typeof response.data === 'object') {
            return response; // Return the full {code, message, data: payload} object
        } else {
            FORCE_LOG('[1PanelInfoProvider] Dashboard Info API did not return expected structure (missing or invalid .data field in response):', response);
            return { error: 'Invalid API response structure for dashboard info', details: response };
        }
    } catch (error) {
        if (debugMode) {
            FORCE_LOG('[1PanelInfoProvider] Error fetching dashboard info:', error.toString());
            if (error instanceof PanelError) {
                FORCE_LOG(`  PanelError Details: Code - ${error.code}, Details - ${error.details}`);
            }
        }
        return { error: error.toString(), details: error }; // Return error object
    }
}

async function fetchSystemInfo() {
    if (debugMode) FORCE_LOG('[1PanelInfoProvider] Fetching System Info...');
    const client = newPanelClient('GET', '/dashboard/base/os');
    try {
        const response = await client.request(); // This is axiosResponse.data
        if (debugMode) FORCE_LOG('[1PanelInfoProvider] Raw System Info API Response (type):', typeof response);
        if (response && typeof response.data === 'object') {
            return response;
        } else {
            if (debugMode) { // Log only in debug mode
                FORCE_LOG('[1PanelInfoProvider] System Info API did not return expected structure (missing or invalid .data field in response):', response);
            }
            return { error: 'Invalid API response structure for system info', details: response };
        }
    } catch (error) {
        if (debugMode) {
            FORCE_LOG('[1PanelInfoProvider] Error fetching system info:', error.toString());
            if (error instanceof PanelError) {
                FORCE_LOG(`  PanelError Details: Code - ${error.code}, Details - ${error.details}`);
            }
        }
        return { error: error.toString(), details: error }; // Return error object
    }
}
 
async function main() {
    if (!enabled) {
        if (debugMode) FORCE_LOG('[1PanelInfoProvider] Plugin is disabled by configuration.');
        process.stdout.write(JSON.stringify({
            "1PanelDashboard": "[1PanelInfoProvider: Disabled]",
            "1PanelOsInfo": "[1PanelInfoProvider: Disabled]"
        }));
        process.exit(0);
        return;
    }

    if (!panelBaseUrl || !panelApiKey) {
        const errorMsg = '[1PanelInfoProvider] Error: PanelBaseUrl or PanelApiKey is not configured.';
        FORCE_LOG(errorMsg);
        const errorOutput = JSON.stringify({
            "1PanelDashboard": errorMsg,
            "1PanelOsInfo": errorMsg,
            error: errorMsg
        });
        process.stdout.write(errorOutput);
        process.exit(1);
        return;
    }

    setHost(panelBaseUrl);
    setApiKey(panelApiKey);
    if (debugMode) FORCE_LOG(`[1PanelInfoProvider] Initialized with Base URL: ${panelBaseUrl}`);

    const results = await Promise.allSettled([
        fetchDashboardInfo(),
        fetchSystemInfo()
    ]);

    let apiDashboardResponse = results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason.toString(), details: results[0].reason };
    let apiSystemInfoResponse = results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason.toString(), details: results[1].reason };

    let finalDashboardPayload = null;
    let dashboardErrorForOutput = null;

    if (apiDashboardResponse && !apiDashboardResponse.error && apiDashboardResponse.data) {
        finalDashboardPayload = apiDashboardResponse.data;
        if (debugMode) FORCE_LOG('[1PanelInfoProvider] Successfully fetched Dashboard data from API.');
        try {
            await fs.writeFile(DASHBOARD_CACHE_FILE, JSON.stringify(finalDashboardPayload), 'utf-8');
            if (debugMode) FORCE_LOG(`[1PanelInfoProvider] Wrote Dashboard data to cache: ${DASHBOARD_CACHE_FILE}`);
        } catch (cacheWriteError) {
            if (debugMode) {
                FORCE_LOG(`[1PanelInfoProvider] Error writing Dashboard data to cache: ${cacheWriteError.toString()}`);
            }
        }
    } else {
        const apiErrorMsg = apiDashboardResponse && apiDashboardResponse.error ? apiDashboardResponse.error : 'Unknown API error for dashboard';
        dashboardErrorForOutput = `API Error: ${apiErrorMsg.substring(0,100)}`; // Used for debug output or if cache fails
        if (debugMode) {
            FORCE_LOG(`[1PanelInfoProvider] Dashboard API error or invalid data: "${apiErrorMsg}". Attempting to read from cache: ${DASHBOARD_CACHE_FILE}`);
        }
        try {
            const cachedData = await fs.readFile(DASHBOARD_CACHE_FILE, 'utf-8');
            finalDashboardPayload = JSON.parse(cachedData);
            if (debugMode) {
                FORCE_LOG('[1PanelInfoProvider] Successfully read Dashboard data from cache.');
            }
            dashboardErrorForOutput = null; // Clear error if cache is good
        } catch (cacheReadError) {
            dashboardErrorForOutput = `API/Cache Error for Dashboard: ${apiErrorMsg.substring(0,50)} / ${cacheReadError.message.substring(0,50)}`;
            if (debugMode) {
                FORCE_LOG(`[1PanelInfoProvider] Error reading Dashboard data from cache: ${cacheReadError.toString()}. Original API error: ${apiErrorMsg}`);
            }
        }
    }

    let finalSystemPayload = null;
    let systemInfoErrorForOutput = null;

    if (apiSystemInfoResponse && !apiSystemInfoResponse.error && apiSystemInfoResponse.data) {
        finalSystemPayload = apiSystemInfoResponse.data;
        if (debugMode) FORCE_LOG('[1PanelInfoProvider] Successfully fetched System Info data from API.');
        try {
            await fs.writeFile(SYSTEM_INFO_CACHE_FILE, JSON.stringify(finalSystemPayload), 'utf-8');
            if (debugMode) FORCE_LOG(`[1PanelInfoProvider] Wrote System Info data to cache: ${SYSTEM_INFO_CACHE_FILE}`);
        } catch (cacheWriteError) {
            if (debugMode) {
                FORCE_LOG(`[1PanelInfoProvider] Error writing System Info data to cache: ${cacheWriteError.toString()}`);
            }
        }
    } else {
        const apiErrorMsg = apiSystemInfoResponse && apiSystemInfoResponse.error ? apiSystemInfoResponse.error : 'Unknown API error for system info';
        systemInfoErrorForOutput = `API Error: ${apiErrorMsg.substring(0,100)}`; // Used for debug output or if cache fails
        if (debugMode) {
            FORCE_LOG(`[1PanelInfoProvider] System Info API error or invalid data: "${apiErrorMsg}". Attempting to read from cache: ${SYSTEM_INFO_CACHE_FILE}`);
        }
        try {
            const cachedData = await fs.readFile(SYSTEM_INFO_CACHE_FILE, 'utf-8');
            finalSystemPayload = JSON.parse(cachedData);
            if (debugMode) {
                FORCE_LOG('[1PanelInfoProvider] Successfully read System Info data from cache.');
            }
            systemInfoErrorForOutput = null; // Clear error if cache is good
        } catch (cacheReadError) {
            systemInfoErrorForOutput = `API/Cache Error for System Info: ${apiErrorMsg.substring(0,50)} / ${cacheReadError.message.substring(0,50)}`;
            if (debugMode) {
                FORCE_LOG(`[1PanelInfoProvider] Error reading System Info data from cache: ${cacheReadError.toString()}. Original API error: ${apiErrorMsg}`);
            }
        }
    }

    const outputData = {};
    let overallExitCode = 0; // Default to 0 (success)

    let dashboardDataAvailable = false;
    if (finalDashboardPayload) {
        outputData["1PanelDashboard"] = finalDashboardPayload;
        dashboardDataAvailable = true;
    } else {
        if (debugMode) {
            outputData["1PanelDashboard"] = dashboardErrorForOutput || '[Debug Error: Dashboard data unavailable]';
        } else {
            outputData["1PanelDashboard"] = "[1Panel Dashboard: Data unavailable]";
        }
    }

    let systemDataAvailable = false;
    if (finalSystemPayload) {
        outputData["1PanelOsInfo"] = finalSystemPayload;
        systemDataAvailable = true;
    } else {
        if (debugMode) {
            outputData["1PanelOsInfo"] = systemInfoErrorForOutput || '[Debug Error: System info data unavailable]';
        } else {
            outputData["1PanelOsInfo"] = "[1Panel OS Info: Data unavailable]";
        }
    }
    
    if (debugMode) {
        if (!dashboardDataAvailable || !systemDataAvailable) {
            overallExitCode = 1;
        }
        // No need for 'else overallExitCode = 0;' as it's initialized to 0
    } 
    // If not debugMode, overallExitCode remains 0 regardless of data availability
    
    if (overallExitCode === 1 && debugMode) {
        outputData.debug_dashboard_api_response = apiDashboardResponse; // Include raw API responses for debugging if things failed
        outputData.debug_systeminfo_api_response = apiSystemInfoResponse;
        FORCE_LOG("[1PanelInfoProvider] One or more parts failed. Final output object:", JSON.stringify(outputData, null, 2));
    } else if (debugMode) {
        FORCE_LOG("[1PanelInfoProvider] Both parts successful. Final output object:", JSON.stringify(outputData, null, 2));
    }

    process.stdout.write(JSON.stringify(outputData));
    process.exit(overallExitCode);
}

main().catch(e => {
    const errorMsg = `[1PanelInfoProvider] Uncaught error in main: ${e.toString()}`;
    FORCE_LOG(errorMsg);
    try {
        const errorOutput = JSON.stringify({ 
            "1PanelDashboard": `[Main Uncaught Error: ${e.message.substring(0,100)}]`,
            "1PanelOsInfo": `[Main Uncaught Error: ${e.message.substring(0,100)}]`,
            error: errorMsg 
        });
        process.stdout.write(errorOutput);
    } catch(eStdout) { /* ignore */ }
    process.exit(1);
}); 