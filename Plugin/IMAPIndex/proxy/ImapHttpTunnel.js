const net = require('net');
const tls = require('tls');
const { URL } = require('url');

function createImapTunnelSocket({ proxyUrl, targetHost, targetPort, timeout, rejectUnauthorized }) {
    return new Promise((resolve, reject) => {
        process.stderr.write(`[Proxy] Attempting to establish tunnel to ${targetHost}:${targetPort} via ${proxyUrl}\n`);

        const proxy = new URL(proxyUrl);
        const isProxyTls = proxy.protocol === 'https:' || proxy.protocol === 'wss:';

        const connectOptions = {
            host: proxy.hostname,
            port: proxy.port,
            timeout: timeout,
        };

        if (isProxyTls) {
            connectOptions.servername = proxy.hostname;
            connectOptions.rejectUnauthorized = rejectUnauthorized;
        }

        const socket = isProxyTls ? tls.connect(connectOptions) : net.connect(connectOptions);

        socket.setTimeout(timeout);

        const onError = (err) => {
            socket.destroy();
            reject(new Error(`[Proxy] ${err.message}`));
        };

        socket.once('error', onError);
        socket.once('timeout', () => onError(new Error('Proxy connection timed out')));

        socket.on('connect', () => {
            socket.removeListener('error', onError); // Remove generic error handler

            const headers = {
                'Host': `${targetHost}:${targetPort}`,
                'Connection': 'keep-alive',
            };

            if (proxy.username || proxy.password) {
                const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
                headers['Proxy-Authorization'] = `Basic ${auth}`;
            }

            const request = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
                Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') +
                '\r\n\r\n';

            socket.write(request);

            let responseBuffer = '';
            const onData = (data) => {
                responseBuffer += data.toString();
                if (responseBuffer.includes('\r\n\r\n')) {
                    const [header] = responseBuffer.split('\r\n');
                    const match = header.match(/^HTTP\/1\.[01] (\d{3})/);
                    if (match && match[1] === '200') {
                        process.stderr.write(`[Proxy] CONNECT request successful. Tunnel established.\n`);
                        socket.removeListener('data', onData);
                        socket.removeListener('error', onConnectError);
                        socket.removeListener('timeout', onConnectTimeout);
                        // Clear timeout for subsequent TLS/IMAP I/O; upper layers will manage timeouts.
                        socket.setTimeout(0);
                        resolve(socket);
                    } else {
                        socket.destroy();
                        reject(new Error(`[Proxy] Tunnel establishment failed with status: ${match ? match[1] : 'Unknown'}. Response: ${header}`));
                    }
                }
            };
            
            const onConnectError = (err) => reject(new Error(`[Proxy] Error after connect: ${err.message}`));
            const onConnectTimeout = () => reject(new Error('[Proxy] Timeout after connect'));

            socket.on('data', onData);
            socket.once('error', onConnectError);
            socket.once('timeout', onConnectTimeout);
        });
    });
}

module.exports = { createImapTunnelSocket };