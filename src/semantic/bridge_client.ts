import net from 'net';
import { hostUnusedPort } from '../utils/net_utils';
import { SemanticError, SemanticNode, SemanticSnapshot } from './types';

export interface PortForwarder {
    fport(localNode: string, remoteNode: string): void;
    fportRm(localNode: string, remoteNode: string): void;
}

interface BridgeClientOptions {
    devicePort?: number;
    timeoutMs?: number;
    connectPort?: number;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class SemanticBridgeClient {
    private readonly devicePort: number;
    private readonly timeoutMs: number;
    private readonly connectPort?: number;
    private socket?: net.Socket;
    private buffer = '';
    private nextId = 1;
    private localPort?: number;
    private forwarded = false;
    private closed = false;
    private readonly pending = new Map<number, PendingRequest>();

    constructor(private readonly forwarder: PortForwarder, options: BridgeClientOptions = {}) {
        this.devicePort = options.devicePort ?? 18765;
        this.timeoutMs = options.timeoutMs ?? 8000;
        this.connectPort = options.connectPort;
    }

    async connect(): Promise<void> {
        if (this.closed) {
            throw new SemanticError('BRIDGE_CLOSED', 'The semantic bridge client is closed.');
        }
        if (this.socket && !this.socket.destroyed) {
            return;
        }

        this.localPort = this.connectPort ?? await hostUnusedPort();
        if (this.connectPort === undefined) {
            this.forwarder.fport(`tcp:${this.localPort}`, `tcp:${this.devicePort}`);
            this.forwarded = true;
        }

        const deadline = Date.now() + this.timeoutMs;
        let lastError: unknown;
        while (Date.now() < deadline) {
            try {
                await this.openSocket(this.localPort);
                return;
            } catch (error) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
        }
        this.releaseForward();
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new SemanticError('BRIDGE_CONNECT_FAILED', `Could not connect to the semantic bridge: ${detail}`, lastError);
    }

    async snapshot(): Promise<SemanticSnapshot> {
        const result = await this.request('snapshot');
        if (!isSnapshot(result)) {
            throw new SemanticError('BRIDGE_PROTOCOL_ERROR', 'The semantic bridge returned an invalid snapshot.');
        }
        if (result.error) {
            throw new SemanticError(result.error, `The semantic bridge reported ${result.error}.`);
        }
        return result;
    }

    async prepare(ref: string): Promise<SemanticNode> {
        const result = await this.request('prepare', { ref });
        if (!isSemanticNode(result)) {
            throw new SemanticError('BRIDGE_PROTOCOL_ERROR', `The semantic bridge did not return node ${ref}.`);
        }
        return result;
    }

    /**
     * Drop the current socket and forward, then open a fresh one.
     * Used after an app restart, which invalidates the forwarded port.
     */
    async reconnect(): Promise<void> {
        this.failPending(new SemanticError('BRIDGE_CLOSED', 'The semantic bridge client reconnected.'));
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.destroy();
        }
        this.releaseForward();
        this.buffer = '';
        await this.connect();
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.failPending(new SemanticError('BRIDGE_CLOSED', 'The semantic bridge client was closed.'));
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.destroy();
        }
        this.releaseForward();
    }

    private async openSocket(port: number): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                socket.destroy();
                reject(new SemanticError('BRIDGE_CONNECT_FAILED', `Timed out connecting to 127.0.0.1:${port}.`));
            }, Math.min(this.timeoutMs, 1500));

            socket.once('connect', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.socket = socket;
                this.attach(socket);
                resolve();
            });
            socket.once('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                reject(new SemanticError('BRIDGE_CONNECT_FAILED', error.message, error));
            });
            socket.once('close', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new SemanticError('BRIDGE_CONNECT_FAILED', 'The bridge socket closed before connecting.'));
            });
        });
    }

    private attach(socket: net.Socket): void {
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => {
            // Only the current socket may clear state; a replaced socket's late
            // event must not invalidate the live connection.
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.failPending(new SemanticError('BRIDGE_CLOSED', error.message, error));
        });
        socket.on('close', () => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.failPending(new SemanticError('BRIDGE_CLOSED', 'The semantic bridge socket closed.'));
        });
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            let response: unknown;
            try {
                response = JSON.parse(line);
            } catch {
                this.failPending(new SemanticError('BRIDGE_PROTOCOL_ERROR', 'The semantic bridge returned malformed JSON.'));
                return;
            }
            const record = response as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
            if (typeof record.id !== 'number') {
                const error = typeof record.error === 'string' ? record.error : 'BRIDGE_PROTOCOL_ERROR';
                this.failPending(new SemanticError(error, `The semantic bridge rejected a request: ${error}.`));
                return;
            }
            const pending = this.pending.get(record.id);
            if (!pending) continue;
            this.pending.delete(record.id);
            clearTimeout(pending.timer);
            if (record.ok === true) {
                pending.resolve(record.result);
            } else {
                const code = typeof record.error === 'string' ? record.error : 'BRIDGE_ERROR';
                pending.reject(new SemanticError(code, `The semantic bridge returned ${code}.`));
            }
        }
    }

    private request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            return Promise.reject(new SemanticError('BRIDGE_NOT_CONNECTED', 'Connect the semantic bridge before sending requests.'));
        }
        const id = this.nextId++;
        const message = JSON.stringify({ id, op, ...params }) + '\n';
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new SemanticError('BRIDGE_TIMEOUT', `Timed out waiting for semantic bridge response ${id}.`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            socket.write(message, (error) => {
                if (error) {
                    const pending = this.pending.get(id);
                    if (pending) {
                        this.pending.delete(id);
                        clearTimeout(pending.timer);
                        pending.reject(new SemanticError('BRIDGE_WRITE_FAILED', error.message, error));
                    }
                }
            });
        });
    }

    private failPending(error: SemanticError): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private releaseForward(): void {
        if (!this.forwarded || this.localPort === undefined) {
            return;
        }
        this.forwarded = false;
        try {
            this.forwarder.fportRm(`tcp:${this.localPort}`, `tcp:${this.devicePort}`);
        } catch {
            // The forward may already be gone after an app restart.
        }
    }
}

function isSnapshot(value: unknown): value is SemanticSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<SemanticSnapshot>;
    return snapshot.schemaVersion === 1 && typeof snapshot.revision === 'number' && Array.isArray(snapshot.nodes);
}

function isSemanticNode(value: unknown): value is SemanticNode {
    if (!value || typeof value !== 'object') return false;
    const node = value as Partial<SemanticNode>;
    return typeof node.id === 'string' && typeof node.ref === 'string' && typeof node.meaning === 'string';
}
