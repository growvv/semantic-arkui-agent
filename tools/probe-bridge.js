'use strict';

const net = require('net');

const port = Number(process.env.BRIDGE_PORT || 18765);
const host = process.env.BRIDGE_HOST || '127.0.0.1';
const deadline = Date.now() + Number(process.env.BRIDGE_TIMEOUT_MS || 8000);

function snapshotOnce() {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let buffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('bridge response timeout'));
        }, 3000);

        socket.on('connect', () => {
            socket.write(JSON.stringify({ id: 1, op: 'snapshot' }) + '\n');
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    if (response.id !== 1) continue;
                    clearTimeout(timer);
                    socket.end();
                    if (!response.ok) {
                        reject(new Error(response.error || 'snapshot failed'));
                        return;
                    }
                    resolve(response.result);
                } catch (error) {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(error);
                }
            }
        });
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function main() {
    let lastError;
    while (Date.now() < deadline) {
        try {
            const snapshot = await snapshotOnce();
            console.log(JSON.stringify(snapshot, null, 2));
            const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
            const probe = nodes.find((node) => node.id === 'sem.probe');
            if (!probe) {
                console.error('PROBE_FAILED: sem.probe missing');
                process.exitCode = 1;
                return;
            }
            console.log('PROBE_OK');
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
    console.error('PROBE_FAILED:', lastError ? lastError.message : 'unknown error');
    process.exitCode = 1;
}

main();
