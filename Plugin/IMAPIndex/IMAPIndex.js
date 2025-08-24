require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const TurndownService = require('turndown');
const net = require('net');
const tls = require('tls');
const { createImapTunnelSocket } = require('./proxy/ImapHttpTunnel');
const { runPostScripts } = require('./post_run');

// --- Constants ---
const APP_ROOT = path.resolve(__dirname);
const STORAGE_PATH = path.resolve(APP_ROOT, process.env.STORAGE_PATH || 'mail_store');
// --- End Constants ---

const imapConfig = {
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT, 10),
    tls: process.env.IMAP_TLS === 'true',
    proxy: {
        enabled: process.env.IMAP_PROXY_ENABLED === 'true',
        url: process.env.IMAP_PROXY_URL,
        timeout: parseInt(process.env.IMAP_PROXY_TIMEOUT_MS, 10) || 10000,
        rejectUnauthorized: process.env.IMAP_PROXY_TLS_REJECT_UNAUTHORIZED !== 'false',
    }
};

const uidIndexPath = path.join(STORAGE_PATH, 'uid.index');

async function rebuildUidIndex() {
    const storagePath = STORAGE_PATH;
    
    try {
        await fsp.mkdir(storagePath, { recursive: true });
        
        try {
            await fsp.unlink(uidIndexPath);
            process.stderr.write('Deleted existing uid.index.\n');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            process.stderr.write('uid.index not found, creating a new one.\n');
        }

        const uids = new Set();
        
        async function findMailFiles(dirPath) {
            try {
                const entries = await fsp.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    if (entry.isDirectory()) {
                        await findMailFiles(fullPath);
                    } else if (entry.isFile() && (entry.name.endsWith('.eml') || entry.name.endsWith('.md'))) {
                        const match = entry.name.match(/^(\d+)_/);
                        if (match && match[1]) {
                            uids.add(match[1]);
                        }
                    }
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    process.stderr.write(`Directory not found: ${dirPath}, skipping scan.\n`);
                    return;
                }
                throw error;
            }
        }

        await findMailFiles(storagePath);

        const uidArray = Array.from(uids);
        await fsp.writeFile(uidIndexPath, uidArray.join('\n') + '\n');
        
        process.stderr.write(`Rebuilt uid.index with ${uidArray.length} entries.\n`);

    } catch (error) {
        process.stderr.write(`FATAL: Error rebuilding UID index: ${error.message}\n`);
        throw error;
    }
}

function getDownloadedUids() {
    if (!fs.existsSync(uidIndexPath)) {
        return new Set();
    }
    const content = fs.readFileSync(uidIndexPath, 'utf-8');
    return new Set(content.split('\n').filter(uid => uid));
}

function addDownloadedUid(uid) {
    fs.appendFileSync(uidIndexPath, `${uid}\n`);
}

async function deleteLocalFilesByUids(uidsToDelete) {
    if (uidsToDelete.size === 0) {
        process.stderr.write('No local emails to delete.\n');
        return;
    }
    process.stderr.write(`Starting deletion of ${uidsToDelete.size} emails...\n`);
    const storagePath = STORAGE_PATH;

    async function findAndDelete(dirPath) {
        try {
            const entries = await fsp.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    await findAndDelete(fullPath);
                } else if (entry.isFile()) {
                    const match = entry.name.match(/^(\d+)_/);
                    if (match && match[1] && uidsToDelete.has(match[1])) {
                        try {
                            await fsp.unlink(fullPath);
                            process.stderr.write(`Deleted ${entry.name}\n`);
                        } catch (delError) {
                            process.stderr.write(`Failed to delete ${entry.name}: ${delError.message}\n`);
                        }
                    }
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                process.stderr.write(`Error scanning directory for deletion ${dirPath}: ${error.message}\n`);
            }
        }
    }
    await findAndDelete(storagePath);
}


async function convertFile(filePath) {
  try {
    const emlContent = await fsp.readFile(filePath);
    const mail = await simpleParser(emlContent);

    const from = mail.from?.value[0]?.address || 'unknown';
    const subject = mail.subject || '';
    const date = mail.date || new Date();

    const turndownService = new TurndownService();
    const markdownBody = turndownService.turndown(mail.html || mail.textAsHtml || '');

    const frontMatter = `---
From: ${from}
Subject: ${subject}
Date: ${date.toISOString()}
---

`;
    const mdContent = frontMatter + markdownBody;
    const mdFilePath = filePath.replace(/\.eml$/, '.md');

    await fsp.writeFile(mdFilePath, mdContent);
    await fsp.unlink(filePath);
    process.stderr.write(`Converted ${path.basename(filePath)} to ${path.basename(mdFilePath)}\n`);
  } catch (error) {
    process.stderr.write(`Failed to process ${filePath}: ${error.message}\n`);
  }
}

async function findAndConvert(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await findAndConvert(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.eml')) {
            await convertFile(fullPath);
        }
    }
  } catch (error) {
      if (error.code !== 'ENOENT') {
          throw error;
      }
      // Ignore ENOENT, as the directory might not exist on first run
  }
}

async function preflightCheck() {
    const { host, port, user, proxy } = imapConfig;
    process.stderr.write(`--- Preflight Check ---\n`);
    process.stderr.write(`User: ${user}\n`);
    process.stderr.write(`Host: ${host}\n`);
    process.stderr.write(`Port: ${port}\n`);
    process.stderr.write(`TLS: ${imapConfig.tls}\n`);
    process.stderr.write(`Proxy Enabled: ${proxy.enabled}\n`);
    if (proxy.enabled) {
        process.stderr.write(`Proxy URL: ${proxy.url}\n`);
    }

    if (!host || !port || !user) {
        throw new Error('IMAP host, port, or user is not configured. Check your .env file.');
    }

    if (proxy.enabled) {
        if (!proxy.url) {
            throw new Error('IMAP proxy is enabled, but IMAP_PROXY_URL is not set.');
        }
        try {
            process.stderr.write(`Preflight: Testing proxy connection to ${host}:${port}...\n`);
            const tunnelSocket = await createImapTunnelSocket({
                proxyUrl: proxy.url,
                targetHost: host,
                targetPort: port,
                timeout: proxy.timeout,
                rejectUnauthorized: proxy.rejectUnauthorized
            });
            tunnelSocket.destroy();
            process.stderr.write('Proxy tunnel preflight check successful.\n');
        } catch (error) {
            throw new Error(`Proxy preflight check failed: ${error.message}`);
        }
    } else {
        return new Promise((resolve, reject) => {
            if (host === '127.0.0.1' || host === 'localhost') {
                process.stderr.write(`Warning: Connecting to localhost. Inside a container, this usually means the container itself.\n`);
            }
            const socket = new net.Socket();
            socket.setTimeout(5000);
            socket.on('connect', () => {
                process.stderr.write('Direct TCP connection to IMAP server successful.\n');
                socket.end();
                resolve();
            });
            socket.on('error', (err) => reject(new Error(`Preflight check failed: Could not connect to ${host}:${port}. Reason: ${err.code}`)));
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error(`Preflight check failed: Connection to ${host}:${port} timed out.`));
            });
            socket.connect(port, host);
        });
    }
}

async function fetchAndSave() {
    let imap;
    try {
        let finalImapConfig = { ...imapConfig };

        if (imapConfig.proxy.enabled) {
            const tunnelSocket = await createImapTunnelSocket({
                proxyUrl: imapConfig.proxy.url,
                targetHost: imapConfig.host,
                targetPort: imapConfig.port,
                timeout: imapConfig.proxy.timeout,
                rejectUnauthorized: imapConfig.proxy.rejectUnauthorized
            });

            // Perform TLS handshake ourselves over the tunnel and pass the secure socket to node-imap.
            // This guarantees all traffic (including TLS) goes through the proxy tunnel.
            const tlsSocket = tls.connect({
                socket: tunnelSocket,
                servername: imapConfig.host,
                rejectUnauthorized: imapConfig.proxy.rejectUnauthorized
            });

            await new Promise((resolveTls, rejectTls) => {
                const onErr = (e) => rejectTls(new Error(`TLS handshake failed: ${e.message}`));
                const onTimeout = () => rejectTls(new Error(`TLS handshake timed out after ${imapConfig.proxy.timeout}ms`));
                tlsSocket.once('secureConnect', resolveTls);
                tlsSocket.once('error', onErr);
                tlsSocket.setTimeout(imapConfig.proxy.timeout, onTimeout);
            });
            tlsSocket.setTimeout(0);

            // Hand off a ready TLS socket; disable node-imap's own tls.
            finalImapConfig.tls = false;
            finalImapConfig.socket = tlsSocket;
        }

        imap = new Imap(finalImapConfig);

    } catch (error) {
        throw new Error(`Failed to create IMAP connection: ${error.message}`);
    }

    return new Promise((resolve, reject) => {
        const openInbox = (cb) => imap.openBox('INBOX', true, cb);

        imap.once('ready', () => {
            process.stderr.write('IMAP connection ready. Opening INBOX...\n');
            openInbox((err, box) => {
                if (err) return reject(new Error(`Error opening inbox: ${err.message}`));
                
                const whitelist = (process.env.WHITELIST || '').split(',');
                if (!whitelist[0]) {
                    process.stderr.write('Whitelist is empty, skipping fetch.\n');
                    imap.end();
                    return;
                }

                const timeLimitDays = parseInt(process.env.TIME_LIMIT_DAYS, 10) || 30;
                const sinceDate = new Date();
                sinceDate.setDate(sinceDate.getDate() - timeLimitDays);

                process.stderr.write(`Search SINCE date: ${sinceDate.toUTCString()}\n`);
                const searchCriteria = [['SINCE', sinceDate]];
                const trimmedWhitelist = whitelist.map(email => email.trim());

                const searchPromises = trimmedWhitelist.map(sender => 
                    new Promise((res, rej) => {
                        imap.search([ ...searchCriteria, ['FROM', sender] ], (e, uids) => e ? rej(e) : res(uids));
                    })
                );

                Promise.all(searchPromises).then(async (resultsBySender) => {
                    resultsBySender.forEach((uids, idx) => {
                        process.stderr.write(`Sender ${trimmedWhitelist[idx]} -> ${uids.length} matches\n`);
                    });
                    const remoteUids = new Set(resultsBySender.flat().map(String));
                    process.stderr.write(`Found ${remoteUids.size} total emails on server matching criteria.\n`);

                    const localUids = getDownloadedUids();
                    process.stderr.write(`Found ${localUids.size} emails in local store.\n`);

                    const uidsToDelete = new Set([...localUids].filter(uid => !remoteUids.has(uid)));
                    const uidsToFetch = new Set([...remoteUids].filter(uid => !localUids.has(uid)));

                    await deleteLocalFilesByUids(uidsToDelete);

                    const uidsToFetchArray = Array.from(uidsToFetch);

                    if (uidsToFetchArray.length === 0) {
                        process.stderr.write('No new mail to download.\n');
                        imap.end();
                        return;
                    }

                    process.stderr.write(`Found ${uidsToFetchArray.length} new emails to download.\n`);

                    const f = imap.fetch(uidsToFetchArray, { bodies: '', struct: true });
                    f.on('message', (msg, seqno) => {
                        let messageData = {};
                        msg.on('attributes', (attrs) => messageData.uid = attrs.uid);
                        
                        let buffer = '';
                        msg.on('body', (stream) => {
                            stream.on('data', (chunk) => buffer += chunk.toString('utf8'));
                            stream.once('end', () => messageData.body = buffer);
                        });

                        msg.once('end', () => {
                            if (messageData.uid && messageData.body) {
                                saveEmail(messageData);
                            }
                        });
                    });
                    f.once('error', (fetchErr) => reject(new Error(`Fetch error: ${fetchErr.message}`)));
                    f.once('end', () => {
                        process.stderr.write('Done fetching all messages!\n');
                        imap.end();
                    });
                }).catch(searchErr => reject(new Error(`Error during parallel search: ${searchErr.message}`)));
            });
        });

        function saveEmail({ uid, body }) {
            const storagePath = STORAGE_PATH;
            const header = Imap.parseHeader(body);
            let sender = 'unknown';
            if (header.from && header.from.length > 0) {
                const fromHeader = header.from[0];
                const match = fromHeader.match(/<([^>]+)>/);
                sender = match ? match[1] : fromHeader;
            }
            
            const senderDir = path.join(storagePath, sender.replace(/[^a-zA-Z0-9.-]/g, '_'));
            if (!fs.existsSync(senderDir)) fs.mkdirSync(senderDir, { recursive: true });
    
            const filename = path.join(senderDir, `${uid}_${Date.now()}.eml`);
            fs.writeFileSync(filename, body);
            addDownloadedUid(uid);
            process.stderr.write(`Saved to ${path.basename(filename)}\n`);
        }

        imap.once('error', (imapErr) => reject(new Error(`IMAP error: ${imapErr.message}`)));
        imap.once('end', () => {
            process.stderr.write('IMAP connection ended.\n');
            resolve();
        });

        imap.connect();
    });
}

async function findMdFiles(dirPath) {
    let mdFiles = [];
    try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                mdFiles = mdFiles.concat(await findMdFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'vcp_index.md') {
                mdFiles.push(fullPath);
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return mdFiles;
}

async function getIndex() {
    const storagePath = STORAGE_PATH;
    const allMdFiles = await findMdFiles(storagePath);

    if (allMdFiles.length === 0) {
        return "No mail found in the local store.";
    }

    allMdFiles.sort();

    let combinedContent = "--- START OF LOCAL MAIL INDEX ---\n\n";
    for (const filePath of allMdFiles) {
        try {
            const content = await fsp.readFile(filePath, 'utf-8');
            const fileName = path.basename(filePath);
            combinedContent += `--- MAIL: ${fileName} ---\n`;
            combinedContent += content;
            combinedContent += `\n\n--- END OF MAIL: ${fileName} ---\n\n`;
        } catch (error) {
            process.stderr.write(`Could not read file ${filePath}: ${error.message}\n`);
        }
    }
    combinedContent += "--- END OF LOCAL MAIL INDEX ---";
    return combinedContent;
}

async function main() {
    try {
        process.stderr.write('--- Starting IMAPIndex Plugin Execution ---\n');
        
        await preflightCheck();

        process.stderr.write('Step 1: Rebuilding UID index from local file store...\n');
        await rebuildUidIndex();

        process.stderr.write('Step 2: Syncing emails with IMAP server...\n');
        await fetchAndSave();
        
        const storagePath = STORAGE_PATH;
        process.stderr.write('Step 3: Converting EML files to Markdown...\n');
        await findAndConvert(storagePath);

        process.stderr.write('Step 4: Generating combined index...\n');
        const indexContent = await getIndex();
        
        process.stderr.write('Step 5: Outputting index and writing to cache...\n');
        process.stdout.write(indexContent);
        
        const cacheFilePath = path.join(storagePath, 'vcp_index.md');
        await fsp.writeFile(cacheFilePath, indexContent);

        process.stderr.write('--- IMAPIndex Plugin Execution Finished Successfully ---\n');

        // Run any post-execution scripts if defined
        await runPostScripts();

    } catch (error) {
        const errorMessage = `Failed during IMAPIndex execution: ${error.message}`;
        process.stderr.write(errorMessage + '\n');
        process.stdout.write(errorMessage);
        process.exit(1);
    }
}

main();