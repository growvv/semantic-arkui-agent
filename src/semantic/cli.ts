import fs from 'fs';
import path from 'path';
import { HarmonyDevice } from '../device/harmony/session';
import { Hdc } from '../device/hdc';
import { SemanticBridgeClient } from './bridge_client';
import { SemanticAgent } from './agent';
import { LlmClient } from './llm';
import { SemanticError } from './types';

interface ParsedArgs {
    command: string;
    options: Map<string, string>;
    positionals: string[];
}

const USAGE = `Usage:
  haptest semantic tree --serial <serial> [--bundle <bundle>] [--out <file>] [--port <port>]
  haptest semantic run  --serial <serial> --task <text> [--bundle <bundle>] [--out <dir>] [--port <port>] [--max-steps <n>]

The target app must contain the debug-only SemanticBridge and must be debug-signed.`;

export async function runSemanticCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(args);
    } catch (error) {
        return finish({ ok: false, error: messageOf(error) }, `haptest semantic: ${messageOf(error)}\n\n${USAGE}`, 2);
    }

    if (parsed.options.has('help') || parsed.command === 'help' || parsed.command === '') {
        return { stdout: USAGE + '\n', stderr: '', exitCode: 0 };
    }
    if (parsed.command !== 'tree' && parsed.command !== 'run') {
        return finish({ ok: false, error: `Unknown semantic command: ${parsed.command}` }, USAGE, 2);
    }
    if (parsed.command === 'run' && !parsed.options.get('task')) {
        return finish({ ok: false, error: '--task is required for semantic run.' }, USAGE, 2);
    }

    const serial = parsed.options.get('serial');
    const bundle = parsed.options.get('bundle');
    const port = numberOption(parsed.options.get('port'), 18765, 'port');
    const maxSteps = numberOption(parsed.options.get('max-steps'), 12, 'max-steps');
    const out = parsed.options.get('out');
    let device: HarmonyDevice | undefined;
    let bridge: SemanticBridgeClient | undefined;

    try {
        device = await HarmonyDevice.connect(serial ? { serial } : {});
        const initial = await device.observe();
        if (initial.locked) {
            throw new SemanticError('DEVICE_LOCKED', 'The device is locked; unlock it before running the semantic agent.');
        }
        if (bundle) {
            await device.launchApp(bundle);
            await waitForBundle(device, bundle);
        }

        const forwarder = new Hdc(serial);
        bridge = new SemanticBridgeClient(forwarder, { devicePort: port });
        await bridge.connect();

        if (parsed.command === 'tree') {
            const snapshot = await bridge.snapshot();
            if (out) {
                fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
                fs.writeFileSync(path.resolve(out), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
            }
            return finish({ ok: true, snapshot }, '', 0);
        }

        const task = parsed.options.get('task')!;
        const agent = new SemanticAgent({
            bridge,
            device,
            llm: new LlmClient(),
            maxSteps,
            bundleName: bundle,
        });
        const result = await agent.run(task, { outDir: out ? path.resolve(out) : undefined });
        return finish({ ok: true, result }, '', result.success ? 0 : 1);
    } catch (error) {
        const code = error instanceof SemanticError ? error.code : 'SEMANTIC_FAILED';
        return finish({ ok: false, errorCode: code, error: messageOf(error) }, messageOf(error), 1);
    } finally {
        if (bridge) {
            await bridge.close().catch(() => {});
        }
        if (device) {
            await device.close().catch(() => {});
        }
    }
}

async function waitForBundle(device: HarmonyDevice, bundle: string): Promise<void> {
    for (let attempt = 0; attempt < 15; attempt++) {
        const observation = await device.observe({ bundleName: bundle });
        if (observation.locked) {
            throw new SemanticError('DEVICE_LOCKED', 'The device is locked; unlock it before running the semantic agent.');
        }
        if (observation.bundleName === bundle) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new SemanticError('APP_NOT_FOREGROUND', `App ${bundle} did not reach the foreground.`);
}

function parseArgs(args: string[]): ParsedArgs {
    const options = new Map<string, string>();
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            options.set('help', 'true');
            continue;
        }
        if (arg.startsWith('--')) {
            const equal = arg.indexOf('=');
            if (equal > 2) {
                options.set(arg.slice(2, equal), arg.slice(equal + 1));
                continue;
            }
            const key = arg.slice(2);
            const value = args[index + 1];
            if (value === undefined || value.startsWith('--')) {
                options.set(key, 'true');
                continue;
            }
            options.set(key, value);
            index += 1;
            continue;
        }
        positionals.push(arg);
    }
    return {
        command: positionals.shift() ?? '',
        options,
        positionals,
    };
}

function numberOption(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new SemanticError('INVALID_ARGUMENT', `--${name} must be a positive integer.`);
    }
    return parsed;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function finish(payload: unknown, stderr: string, exitCode: number): { stdout: string; stderr: string; exitCode: number } {
    return {
        stdout: JSON.stringify(payload, null, 2) + '\n',
        stderr,
        exitCode,
    };
}
