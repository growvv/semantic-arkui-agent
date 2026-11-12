import fs from 'fs';
import path from 'path';
import { Hdc } from '../device/hdc';
import { unlockDevice } from './device_unlock';
import { HarmonyDevice } from '../device/harmony/session';
import { SemanticBridgeClient } from './bridge_client';
import { SemanticAgent } from './agent';
import { LlmClient } from './llm';
import { SemanticNode, SemanticSnapshot } from './types';

/**
 * Multi-app semantic benchmark.
 *
 * Reuses the HapTest building blocks rather than shelling out to hdc:
 * `Hdc` installs and launches, `HarmonyDevice` observes and acts,
 * `SemanticBridgeClient` reads the app's semantic tree.
 *
 * Two budgets apply to every task:
 * - `--max-steps` (default 20): exceeding it is a failure, reported as
 *   EXCEEDED_MAX_STEPS.
 * - `--max-duration-ms` (default 1800000): a wall-clock guard so one slow model
 *   call cannot hold the single test device. Hitting it is TASK_TIMEOUT.
 */

interface TaskCheck {
    id: string;
    field?: string;
    op?: '==' | '>=' | '>' | 'contains';
    value: string | number | boolean;
}

interface BenchTask {
    id: string;
    goal: string;
    check: TaskCheck;
}

interface BenchApp {
    key: string;
    source: string;
    baseline: string;
    license: string;
    tasks: BenchTask[];
}

interface BenchConfig {
    apps: BenchApp[];
}

interface TaskResult {
    app: string;
    task: string;
    goal: string;
    verified: boolean;
    steps: number;
    elapsedSeconds: number;
    promptTokens: number;
    completionTokens: number;
    agentFinished: boolean;
    reason: string;
    attempts?: number;
    beforeCheck: string;
    afterCheck: string;
    preconditionOk: boolean;
}

export interface BenchmarkOptions {
    serial: string;
    appsRoot: string;
    tasksPath: string;
    outDir: string;
    apps?: string[];
    maxSteps?: number;
    maxDurationMs?: number;
    bundle?: string;
    log?: (line: string) => void;
}

export interface BenchmarkSummary {
    total: number;
    verified: number;
    agentFinished: number;
    steps: number;
    promptTokens: number;
    completionTokens: number;
    elapsedSeconds: number;
    results: TaskResult[];
}

function readNode(snapshot: SemanticSnapshot | undefined, id: string): SemanticNode | undefined {
    return snapshot?.nodes.find((node) => node.id === id);
}

/** Judge a task from the app's own semantic snapshot; never from the agent's summary. */
export function evaluateCheck(snapshot: SemanticSnapshot | undefined, check: TaskCheck): [boolean, string] {
    const node = readNode(snapshot, check.id);
    if (!node) return [false, `node ${check.id} missing`];
    const field = check.field ?? 'value';
    const actual = field === 'visible'
        ? node.visible
        : (node.state as Record<string, unknown> | undefined)?.[field];
    if (actual === undefined) return [false, `${field} missing`];
    const expected = check.value;
    let ok = false;
    switch (check.op) {
        case '>=':
            ok = Number(actual) >= Number(expected);
            break;
        case '>':
            ok = Number(actual) > Number(expected);
            break;
        case 'contains':
            ok = typeof actual === 'string' && actual.includes(String(expected));
            break;
        default:
            ok = actual === expected;
    }
    return [ok, `${field}=${JSON.stringify(actual)}`];
}

interface Bounds { x: number; y: number }

/** Find the centre of the first node whose text matches one of `labels`. */
function findLabelBounds(node: unknown, labels: string[]): Bounds | undefined {
    if (!node || typeof node !== 'object') return undefined;
    const record = node as { attributes?: Record<string, string>; children?: unknown[] };
    const text = record.attributes?.text;
    const bounds = record.attributes?.bounds;
    if (text && labels.includes(text) && bounds) {
        const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
        if (match) {
            return {
                x: Math.round((Number(match[1]) + Number(match[3])) / 2),
                y: Math.round((Number(match[2]) + Number(match[4])) / 2),
            };
        }
    }
    for (const child of record.children ?? []) {
        const found = findLabelBounds(child, labels);
        if (found) return found;
    }
    return undefined;
}

export class SemanticBenchmark {
    private readonly bundle: string;
    private readonly maxSteps: number;
    private readonly maxDurationMs: number;
    private readonly log: (line: string) => void;

    constructor(private readonly options: BenchmarkOptions) {
        this.bundle = options.bundle ?? 'org.anapp.research.prototype';
        this.maxSteps = options.maxSteps ?? 20;
        this.maxDurationMs = options.maxDurationMs ?? 1800000;
        this.log = options.log ?? ((line) => process.stdout.write(line + '\n'));
    }

    private hapPath(app: string): string {
        return path.join(this.options.appsRoot, app, 'entry/build/default/outputs/default/entry-default-signed.hap');
    }

    /** Snapshot with reconnect; throws only after every attempt failed. */
    private async retryingSnapshot(client: SemanticBridgeClient): Promise<SemanticSnapshot> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                return await client.snapshot();
            } catch (error) {
                lastError = error;
                try {
                    await client.reconnect();
                } catch (reconnectError) {
                    lastError = reconnectError;
                }
                await new Promise((resolve) => setTimeout(resolve, 800));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async retryingPrepare(client: SemanticBridgeClient, ref: string): Promise<SemanticNode> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await client.prepare(ref);
            } catch (error) {
                lastError = error;
                try {
                    await client.reconnect();
                } catch (reconnectError) {
                    lastError = reconnectError;
                }
                await new Promise((resolve) => setTimeout(resolve, 800));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async readSnapshot(client: SemanticBridgeClient, attempts = 5): Promise<SemanticSnapshot | undefined> {
        let last: SemanticSnapshot | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                last = await client.snapshot();
                if (last.nodes.length > 0) return last;
            } catch (error) {
                // The bridge may still be binding its port, or a restarted app may
                // have dropped the forwarded connection. Reconnect and retry.
                try {
                    await client.reconnect();
                } catch {
                    // The app may still be starting; the next attempt waits and retries.
                }
            }
            if (attempt < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
        return last;
    }

    private async withDevice<T>(fn: (device: HarmonyDevice, hdc: Hdc) => Promise<T>): Promise<T> {
        const hdc = new Hdc(this.options.serial);
        const device = await HarmonyDevice.connect({ serial: this.options.serial });
        try {
            return await fn(device, hdc);
        } finally {
            await device.close().catch(() => {});
        }
    }

    async run(): Promise<BenchmarkSummary> {
        const config = JSON.parse(fs.readFileSync(this.options.tasksPath, 'utf8')) as BenchConfig;
        const wanted = new Set(this.options.apps ?? []);
        const apps = config.apps.filter((app) => wanted.size === 0 || wanted.has(app.key));
        const started = Date.now();
        const results: TaskResult[] = [];

        for (const app of apps) {
            this.log(`=== ${app.key} (${app.source}) ===`);
            const hap = this.hapPath(app.key);
            if (!fs.existsSync(hap)) {
                for (const task of app.tasks) {
                    results.push(this.failed(app.key, task, 'HAP_NOT_FOUND'));
                    this.log(`FAIL ${app.key}/${task.id} HAP not found`);
                }
                continue;
            }

            for (const task of app.tasks) {
                const runDir = path.join(this.options.outDir, app.key, task.id);
                fs.mkdirSync(runDir, { recursive: true });
                let record: TaskResult | undefined;
                // The first task after a cold install can lose the forwarded bridge
                // port before the app finishes binding it. One clean retry costs a
                // reinstall but keeps the batch moving; the attempt count is recorded.
                for (let attempt = 1; attempt <= 2 && !record; attempt++) {
                    try {
                        const result = await this.runTask(app, task, hap, runDir);
                        result.attempts = attempt;
                        record = result;
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        this.log(`  [attempt ${attempt} failed] ${reason}`);
                        if (attempt === 2) {
                            record = this.failed(app.key, task, reason);
                            record.attempts = attempt;
                        }
                    }
                }
                const finished = record ?? this.failed(app.key, task, 'UNKNOWN');
                results.push(finished);
                this.log(`${finished.verified ? 'PASS' : 'FAIL'} ${app.key}/${task.id} | steps=${finished.steps} | ${finished.elapsedSeconds}s | attempts=${finished.attempts} | ${finished.reason}`);
            }
        }

        const summary: BenchmarkSummary = {
            total: results.length,
            verified: results.filter((result) => result.verified).length,
            agentFinished: results.filter((result) => result.agentFinished).length,
            steps: results.reduce((sum, result) => sum + result.steps, 0),
            promptTokens: results.reduce((sum, result) => sum + result.promptTokens, 0),
            completionTokens: results.reduce((sum, result) => sum + result.completionTokens, 0),
            elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
            results,
        };
        fs.mkdirSync(this.options.outDir, { recursive: true });
        fs.writeFileSync(path.join(this.options.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
        return summary;
    }

    private failed(app: string, task: BenchTask, reason: string): TaskResult {
        return {
            app, task: task.id, goal: task.goal, verified: false, steps: 0,
            elapsedSeconds: 0, promptTokens: 0, completionTokens: 0,
            agentFinished: false, reason, beforeCheck: '', afterCheck: '', preconditionOk: false,
        };
    }

    /**
     * Dismiss the consent / permission dialogs that some apps show on first launch.
     * They sit above the app, so the semantic bridge's page is present but not
     * interactable until they are accepted.
     */
    private async dismissLaunchDialogs(hdc: Hdc): Promise<void> {
        const acceptLabels = ['同意', '同意并继续', '允许', '接受', '我知道了', '确定'];
        for (let round = 0; round < 3; round++) {
            let output = '';
            try {
                output = await hdc.excuteShellCommand('uitest', 'dumpLayout');
            } catch {
                return;
            }
            const match = /DumpLayout saved to:(\S+)/.exec(output);
            const remote = match?.[1];
            if (!remote) return;
            const local = path.join(this.options.outDir, '.layout.json');
            fs.mkdirSync(this.options.outDir, { recursive: true });
            hdc.recvFile(remote, local);
            let layout: unknown;
            try {
                layout = JSON.parse(fs.readFileSync(local, 'utf8'));
            } catch {
                return;
            }
            const hit = findLabelBounds(layout, acceptLabels);
            if (!hit) return;
            await hdc.excuteShellCommand('uitest', 'uiInput', 'click', String(hit.x), String(hit.y));
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }

    /** Wake the screen and swipe past the lock screen if it is showing. */
    /**
     * Wake the screen. A passcode-locked device cannot be unlocked from here and
     * must not be guessed at, so the run stops with a clear instruction instead.
     */
    private async ensureUnlocked(hdc: Hdc): Promise<void> {
        await unlockDevice(hdc);
    }

    /** Install, clear data and launch before any device session or port forward exists. */
    private prepareApp(hap: string): void {
        const hdc = new Hdc(this.options.serial);
        // Uninstall before installing: `install -r` silently fails on a version
        // downgrade or a different signing identity, leaving the previous app in
        // place, which would make the run measure the wrong app entirely.
        hdc.forceStop(this.bundle);
        hdc.excuteSync('uninstall', this.bundle);
        hdc.excuteSync('shell', 'bm', 'uninstall', '-n', this.bundle);
        const install = hdc.excuteSync('install', hap);
        const output = `${install.stdout ?? ''}${install.stderr ?? ''}`;
        if (!/successfully/i.test(output)) {
            throw new Error(`INSTALL_FAILED: ${output.trim().slice(0, 200)}`);
        }
        hdc.excuteSync('shell', 'bm', 'clean', '-n', this.bundle, '-d');
    }

    private async openBridge(client: SemanticBridgeClient, hdc: Hdc): Promise<void> {
        // A cold-started app binds its bridge port after the UI is ready; give it
        // several tries, restarting the app once if the port never appears.
        let lastError: unknown;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                await client.reconnect();
                const snapshot = await client.snapshot();
                if (snapshot.nodes.length > 0) return;
            } catch (error) {
                lastError = error;
            }
            if (attempt === 2) {
                hdc.startAblity(this.bundle, 'EntryAbility');
            }
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'bridge returned no nodes');
        throw new Error(`BRIDGE_UNAVAILABLE: ${detail}`);
    }

    private async runTask(app: BenchApp, task: BenchTask, hap: string, runDir: string): Promise<TaskResult> {
        const started = Date.now();
        // The app must be running before the device session forwards the bridge port;
        // restarting it afterwards would tear the forward down mid-run.
        this.prepareApp(hap);
        return this.withDevice(async (device, hdc) => {
            // The screen may have locked between tasks; wake and dismiss the lock
            // screen before the device session will accept any action.
            this.log('  [stage] observe/unlock');
            await this.ensureUnlocked(hdc);
            // Observe before launching: `launchApp` requires an existing observation,
            // which is why `semantic run` observes first.
            const first = await device.observe({ bundleName: this.bundle });
            if (first.locked) {
                await this.ensureUnlocked(hdc);
                await device.observe({ bundleName: this.bundle });
            }
            // Launch through the device session, then let HapTest wait for the
            // foreground page. This is the same path `semantic run` uses.
            this.log('  [stage] launch');
            await device.launchApp(this.bundle);
            await new Promise((resolve) => setTimeout(resolve, 2500));
            this.log('  [stage] dismiss dialogs');
            await this.dismissLaunchDialogs(hdc);
            // Launching can leave the screen dimmed on a cold device; wake once more
            // so the agent's first observe is not rejected as a locked screen.
            await hdc.excuteShellCommand('power-shell', 'wakeup');
            await new Promise((resolve) => setTimeout(resolve, 800));
            const client = new SemanticBridgeClient(hdc, { devicePort: 18765, timeoutMs: 20000 });
            try {
                this.log('  [stage] open bridge');
                await this.openBridge(client, hdc);
                this.log('  [stage] before snapshot');
                const before = await this.readSnapshot(client);
                fs.writeFileSync(path.join(runDir, 'before.json'), JSON.stringify(before, null, 2) + '\n', 'utf8');
                const [beforeOk, beforeDetail] = evaluateCheck(before, task.check);

                const resilientBridge = {
                    snapshot: async () => this.retryingSnapshot(client),
                    prepare: async (ref: string) => this.retryingPrepare(client, ref),
                    reconnect: async () => client.reconnect(),
                };
                const agent = new SemanticAgent({
                    bridge: resilientBridge,
                    device,
                    llm: new LlmClient(),
                    maxSteps: this.maxSteps,
                    maxDurationMs: this.maxDurationMs,
                    bundleName: this.bundle,
                });
                let result;
                try {
                    this.log('  [stage] agent run');
                    result = await agent.run(task.goal, { outDir: runDir });
                } catch (error) {
                    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
                    this.log(`  [agent error] ${message}`);
                    throw error;
                }

                const after = await this.readSnapshot(client);
                fs.writeFileSync(path.join(runDir, 'after.json'), JSON.stringify(after, null, 2) + '\n', 'utf8');
                const [afterOk, afterDetail] = evaluateCheck(after, task.check);

                const overBudget = result.steps > this.maxSteps;
                // A run that hit the wall clock is a failure even if the state
                // happens to be right: the agent did not finish the task itself.
                const timedOut = result.reason === 'TASK_TIMEOUT';
                // A pass only means something if the target was not already true.
                const preconditionOk = !beforeOk;
                const verified = afterOk && preconditionOk && !overBudget && !timedOut;
                let reason = result.reason;
                if (overBudget) reason = `EXCEEDED_MAX_STEPS(${result.steps})`;
                else if (timedOut) reason = `TASK_TIMEOUT(${result.steps} steps, state=${afterDetail})`;
                else if (beforeOk) reason = `PRECONDITION_ALREADY_MET (${beforeDetail})`;

                const record: TaskResult = {
                    app: app.key, task: task.id, goal: task.goal, verified,
                    steps: result.steps,
                    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
                    promptTokens: result.promptTokens,
                    completionTokens: result.completionTokens,
                    agentFinished: result.success,
                    reason, beforeCheck: beforeDetail, afterCheck: afterDetail, preconditionOk,
                };
                fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
                return record;
            } finally {
                await client.close().catch(() => {});
            }
        });
    }
}
