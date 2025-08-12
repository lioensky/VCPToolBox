const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE_PATH = path.join(__dirname, 'frps_info_cache.txt');
const DEBUG_MODE = process.env.DebugMode === 'true' || process.env.FRPSINFOPROVIDER_DEBUGMODE === 'true';

const FRPS_BASE_URL = process.env.FRPSBaseUrl || process.env.FRPSINFOPROVIDER_FRPSBaseUrl;
const FRPS_ADMIN_USER = process.env.FRPSAdminUser || process.env.FRPSINFOPROVIDER_FRPSAdminUser;
const FRPS_ADMIN_PASSWORD = process.env.FRPSAdminPassword || process.env.FRPSINFOPROVIDER_FRPSAdminPassword;

const PROXY_TYPES = ['tcp', 'udp', 'http', 'https', 'tcpmux', 'stcp', 'sudp'];

function logDebug(message) {
    if (DEBUG_MODE) {
        console.error(`[FRPSInfoProvider][Debug] ${new Date().toISOString()}: ${message}`);
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function fetchProxyInfo(proxyType) {
    if (!FRPS_BASE_URL || !FRPS_ADMIN_USER || !FRPS_ADMIN_PASSWORD) {
        throw new Error('FRPS server URL, admin user, or admin password is not configured.');
    }
    const apiUrl = `${FRPS_BASE_URL}/api/proxy/${proxyType.toLowerCase()}`;
    logDebug(`Fetching ${proxyType} info from ${apiUrl}`);

    try {
        const response = await axios.get(apiUrl, {
            auth: {
                username: FRPS_ADMIN_USER,
                password: FRPS_ADMIN_PASSWORD
            },
            timeout: 5000 // 5 seconds timeout
        });
        logDebug(`Successfully fetched ${proxyType} data. Status: ${response.status}`);
        return response.data; // Expecting an array of proxies
    } catch (error) {
        let errorMessage = `Error fetching ${proxyType} data: `;
        if (error.response) {
            errorMessage += `Status ${error.response.status} - ${error.response.statusText}. Data: ${JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            errorMessage += 'No response received from server.';
        } else {
            errorMessage += error.message;
        }
        logDebug(errorMessage);
        throw new Error(errorMessage);
    }
}

function formatProxyData(proxyType, proxies) {
    let output = `--- ${proxyType.toUpperCase()} ---\n`;
    if (!proxies || proxies.length === 0) {
        output += `No active proxies of type ${proxyType.toUpperCase()}\n`;
        return output;
    }

    proxies.forEach(proxy => {
        output += `  Name: ${proxy.name || 'N/A'}\n`;
        output += `  Status: ${proxy.status || 'N/A'}\n`;
        output += `  Type: ${proxy.type || proxyType}\n`; // Use proxy.type if available, else fallback to requested type
        
        if (proxy.conf) {
            output += `  Local IP: ${proxy.conf.local_ip || 'N/A'}\n`;
            output += `  Local Port: ${proxy.conf.local_port || 'N/A'}\n`;
            if (proxy.conf.remote_port) {
                 output += `  Remote Port: ${proxy.conf.remote_port}\n`;
            }
        } else { // Fallback for flatter structures if 'conf' is not present
             if (proxy.local_addr) {
                output += `  Local Addr: ${proxy.local_addr}\n`;
             } else {
                output += `  Local IP: ${proxy.local_ip || 'N/A'}\n`;
                output += `  Local Port: ${proxy.local_port || 'N/A'}\n`;
             }
             if (proxy.remote_port) {
                output += `  Remote Port: ${proxy.remote_port}\n`;
            }
        }

        if (proxy.domain) { // Common for http/https
            output += `  Domain: ${proxy.domain}\n`;
        }
        if (proxy.subdomain) { // Common for http/https
            output += `  Subdomain: ${proxy.subdomain}\n`;
        }

        output += `  Today Traffic In: ${proxy.today_traffic_in !== undefined ? formatBytes(proxy.today_traffic_in) : 'N/A'}\n`;
        output += `  Today Traffic Out: ${proxy.today_traffic_out !== undefined ? formatBytes(proxy.today_traffic_out) : 'N/A'}\n`;
        
        if (proxy.client_version) {
            output += `  Client Version: ${proxy.client_version}\n`;
        }
        output += '  --------------------\n';
    });
    return output + '\n';
}

async function fetchAndProcessFRPSInfo() {
    logDebug('Starting to fetch and process FRPS info...');
    let combinedOutput = "FRPS Proxy Information:\n\n";
    
    const results = await Promise.allSettled(PROXY_TYPES.map(type => fetchProxyInfo(type)));

    results.forEach((result, index) => {
        const proxyType = PROXY_TYPES[index];
        if (result.status === 'fulfilled') {
            try {
                let proxiesArray = result.value;
                if (result.value && result.value.proxies && Array.isArray(result.value.proxies)) {
                    proxiesArray = result.value.proxies;
                } else if (!Array.isArray(result.value)) {
                    logDebug(`Unexpected data structure for ${proxyType}: ${JSON.stringify(result.value)}. Expected array or {proxies: []}.`);
                    proxiesArray = []; 
                }
                combinedOutput += formatProxyData(proxyType, proxiesArray);
            } catch (e) {
                logDebug(`Error formatting data for ${proxyType}: ${e.message}`);
                combinedOutput += `--- ${proxyType.toUpperCase()} ---\nError formatting data: ${e.message}\n\n`;
            }
        } else {
            logDebug(`Failed to fetch data for ${proxyType}: ${result.reason.message}`);
            combinedOutput += `--- ${proxyType.toUpperCase()} ---\nFailed to fetch data: ${result.reason.message}\n\n`;
        }
    });
    
    try {
        fs.writeFileSync(CACHE_FILE_PATH, combinedOutput);
        logDebug(`Successfully wrote FRPS info to cache file: ${CACHE_FILE_PATH}`);
    } catch (error) {
        logDebug(`Failed to write FRPS info to cache file ${CACHE_FILE_PATH}: ${error.message}`);
    }

    process.stdout.write(combinedOutput);
}

async function main() {
    if (!FRPS_BASE_URL || !FRPS_ADMIN_USER || !FRPS_ADMIN_PASSWORD) {
        const errorMessage = "Error: FRPS_BASE_URL, FRPS_ADMIN_USER, or FRPS_ADMIN_PASSWORD environment variables are not set.";
        console.error(errorMessage);
        try {
            const cachedData = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
            process.stdout.write(cachedData);
            logDebug("FRPS config missing, served from cache.");
        } catch (cacheError) {
            logDebug(`FRPS config missing and cache unavailable: ${cacheError.message}`);
            process.stdout.write(errorMessage + " Cache is also unavailable.");
        }
        return;
    }

    try {
        await fetchAndProcessFRPSInfo();
    } catch (error) {
        logDebug(`Critical error in fetchAndProcessFRPSInfo: ${error.message}`);
        try {
            const cachedData = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
            process.stdout.write(cachedData);
            logDebug("Critical error during FRPS fetch, served from cache.");
        } catch (cacheError) {
            logDebug(`Critical error and cache unavailable: ${cacheError.message}`);
            process.stdout.write(`Failed to fetch FRPS info: ${error.message}. Cache is also unavailable.`);
        }
    }
}

main(); 