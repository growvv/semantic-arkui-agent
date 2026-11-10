import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { SemanticBridgeClient } from '../../src/semantic/bridge_client';
import { SemanticNode, SemanticSnapshot } from '../../src/semantic/types';

const node: SemanticNode = {
    ref: 'sem.a',
    id: 'sem.a',
    type: 'Button',
    role: 'action',
    meaning: 'a button',
    actions: [{ name: 'tap', input: 'tap', label: 'tap' }],
};

const snapshot: SemanticSnapshot = {
    schemaVersion: 1,
    revision: 3,
    viewport: { width: 100, height: 200 },
    nodes: [node],
};

const servers: net.Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

async function startBridge(handler: (request: Record<string, unknown>, socket: net.Socket) => void): Promise<number> {
    const server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                handler(JSON.parse(line) as Record<string, unknown>, socket);
            }
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;
    return address.port;
}

function reply(socket: net.Socket, response: unknown): void {
    socket.write(JSON.stringify(response) + '\n');
}

describe('SemanticBridgeClient', () => {
    it('parses a snapshot and prepares a node over JSON lines', async () => {
        const port = await startBridge((request, socket) => {
            if (request.op === 'snapshot') {
                reply(socket, { id: request.id, ok: true, result: snapshot });
            } else if (request.op === 'prepare' && request.ref === 'sem.a') {
                reply(socket, { id: request.id, ok: true, result: node });
            } else {
                reply(socket, { id: request.id, ok: false, error: 'STALE_REFERENCE' });
            }
        });
        const client = new SemanticBridgeClient({ fport: () => {}, fportRm: () => {} }, { connectPort: port, timeoutMs: 2000 });
        await client.connect();
        await expect(client.snapshot()).resolves.toMatchObject({ revision: 3, nodes: [expect.objectContaining({ id: 'sem.a' })] });
        await expect(client.prepare('sem.a')).resolves.toMatchObject({ id: 'sem.a' });
        await expect(client.prepare('missing')).rejects.toMatchObject({ code: 'STALE_REFERENCE' });
        await client.close();
    });

    it('times out when the bridge accepts a connection but never responds', async () => {
        const port = await startBridge(() => {});
        const client = new SemanticBridgeClient({ fport: () => {}, fportRm: () => {} }, { connectPort: port, timeoutMs: 400 });
        await client.connect();
        await expect(client.snapshot()).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' });
        await client.close();
    });
});
