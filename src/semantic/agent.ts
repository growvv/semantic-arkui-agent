import fs from 'fs';
import path from 'path';
import { HarmonyObservation } from '../device/harmony/session';
import { HarmonySelector } from '../device/harmony/selectors';
import {
    AgentDecision,
    AgentPrompt,
    AgentRunResult,
    SemanticError,
    SemanticNode,
    SemanticSnapshot,
    SemanticView,
} from './types';
import { findSemanticNode, projectSemanticSnapshot, validateSemanticAction } from './project';

export interface SemanticAgentBridge {
    snapshot(): Promise<SemanticSnapshot>;
    prepare(ref: string): Promise<SemanticNode>;
}

export interface SemanticAgentDevice {
    observe(options?: { screenshot?: boolean; bundleName?: string }): Promise<HarmonyObservation>;
    tap(options: { selector?: HarmonySelector; index?: number; x?: number; y?: number; observationId?: string }): Promise<unknown>;
    swipe(options: { from: { x: number; y: number }; to: { x: number; y: number }; observationId?: string; speed?: number }): Promise<unknown>;
    typeText(text: string): Promise<unknown>;
    pressKey(key: string): Promise<unknown>;
    launchApp(bundle: string): Promise<unknown>;
}

export interface SemanticLlm {
    decide(input: AgentPrompt): Promise<{ decision: AgentDecision; promptTokens: number; completionTokens: number }>;
}

export interface SemanticAgentDependencies {
    bridge: SemanticAgentBridge;
    device: SemanticAgentDevice;
    llm: SemanticLlm;
    now?: () => number;
    maxSteps?: number;
    bundleName?: string;
}

interface TrajectoryRecord {
    step: number;
    snapshotRevision: number;
    observationId: string;
    action: AgentDecision;
    result: string;
    promptTokens: number;
    completionTokens: number;
    elapsedMs: number;
}

export class SemanticAgent {
    private readonly maxSteps: number;
    private readonly now: () => number;

    constructor(private readonly deps: SemanticAgentDependencies) {
        this.maxSteps = deps.maxSteps ?? 12;
        this.now = deps.now ?? (() => Date.now());
    }

    async run(task: string, options: { outDir?: string } = {}): Promise<AgentRunResult> {
        const started = this.now();
        const history: string[] = [];
        const trajectory: TrajectoryRecord[] = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let steps = 0;
        let lastKey = '';
        let repeats = 0;

        for (let step = 1; step <= this.maxSteps; step++) {
            steps = step;
            const snapshot = await this.deps.bridge.snapshot();
            if (snapshot.error) {
                this.writeTrajectory(options.outDir, trajectory);
                return this.result(false, steps, `BRIDGE_${snapshot.error}`, promptTokens, completionTokens, started);
            }
            const observation = await this.deps.device.observe(
                this.deps.bundleName === undefined ? {} : { bundleName: this.deps.bundleName },
            );
            if (observation.locked) {
                this.writeTrajectory(options.outDir, trajectory);
                return this.result(false, steps, 'DEVICE_LOCKED', promptTokens, completionTokens, started);
            }
            const view = projectSemanticSnapshot(snapshot, observation.tree);
            if (view.nodes.length === 0) {
                this.writeTrajectory(options.outDir, trajectory);
                return this.result(false, steps, 'EMPTY_SNAPSHOT', promptTokens, completionTokens, started);
            }

            const llmResult = await this.deps.llm.decide({ task, view, history });
            promptTokens += llmResult.promptTokens;
            completionTokens += llmResult.completionTokens;
            const decision = llmResult.decision;
            const record: TrajectoryRecord = {
                step,
                snapshotRevision: snapshot.revision,
                observationId: observation.observationId,
                action: decision,
                result: 'pending',
                promptTokens: llmResult.promptTokens,
                completionTokens: llmResult.completionTokens,
                elapsedMs: this.now() - started,
            };

            if (decision.action === 'finish') {
                record.result = decision.summary ?? 'finished';
                trajectory.push(record);
                this.writeTrajectory(options.outDir, trajectory);
                return this.result(true, steps, record.result, promptTokens, completionTokens, started);
            }

            const actionKey = `${snapshot.revision}:${JSON.stringify(decision)}`;
            if (actionKey === lastKey) {
                repeats += 1;
            } else {
                repeats = 1;
                lastKey = actionKey;
            }
            if (repeats >= 3) {
                record.result = 'REPEATED_ACTION';
                trajectory.push(record);
                this.writeTrajectory(options.outDir, trajectory);
                return this.result(false, steps, 'REPEATED_ACTION', promptTokens, completionTokens, started);
            }

            try {
                record.result = await this.execute(decision, view, observation);
                history.push(`${decision.action} ${decision.ref ?? ''}: ${record.result}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                record.result = `ERROR ${message}`;
                history.push(`${decision.action} ${decision.ref ?? ''}: ERROR ${message}`);
            }
            if (history.length > 12) {
                history.splice(0, history.length - 12);
            }
            trajectory.push(record);
        }

        this.writeTrajectory(options.outDir, trajectory);
        return this.result(false, steps, 'MAX_STEPS', promptTokens, completionTokens, started);
    }

    private async execute(
        decision: AgentDecision,
        view: SemanticView,
        observation: HarmonyObservation,
    ): Promise<string> {
        if (decision.action === 'press') {
            const key = decision.key ?? 'BACK';
            await this.deps.device.pressKey(key);
            return `pressed ${key}`;
        }
        if (decision.action === 'launch') {
            if (!decision.bundle) {
                throw new SemanticError('INVALID_ACTION', 'launch requires a bundle name.');
            }
            await this.deps.device.launchApp(decision.bundle);
            return `launched ${decision.bundle}`;
        }
        if (!decision.ref) {
            throw new SemanticError('INVALID_ACTION', `${decision.action} requires a ref.`);
        }
        const node = findSemanticNode(view, decision.ref);
        if (!node) {
            throw new SemanticError('TARGET_NOT_IN_VIEW', `The ref ${decision.ref} is not in the current view.`);
        }
        const validation = validateSemanticAction(node, {
            action: decision.action,
            ref: node.ref,
            text: decision.text,
            direction: decision.direction,
        });
        if (!validation.ok) {
            throw new SemanticError(validation.errorCode, validation.message);
        }
        await this.deps.bridge.prepare(node.ref);

        switch (decision.action) {
            case 'tap':
                await this.deps.device.tap({ selector: { id: node.id } });
                return `tapped ${node.id}`;
            case 'input':
                await this.deps.device.tap({ selector: { id: node.id } });
                await this.deps.device.observe(
                    this.deps.bundleName === undefined ? {} : { bundleName: this.deps.bundleName },
                );
                await this.deps.device.typeText(decision.text ?? '');
                try {
                    await this.deps.device.observe(
                        this.deps.bundleName === undefined ? {} : { bundleName: this.deps.bundleName },
                    );
                    await this.deps.device.pressKey('BACK');
                } catch {
                    // The text was entered; a failed keyboard dismissal is retried by the next observation.
                }
                return `entered ${JSON.stringify(decision.text ?? '')} into ${node.id}`;
            case 'scroll':
                await this.scroll(node, decision, observation);
                return `scrolled ${node.id} ${decision.direction ?? 'forward'}`;
            case 'long_press':
                throw new SemanticError('ACTION_UNSUPPORTED', 'long_press is not enabled in the first implementation.');
            default:
                throw new SemanticError('INVALID_ACTION', `Unsupported action ${decision.action}.`);
        }
    }

    private async scroll(node: SemanticNode, decision: AgentDecision, observation: HarmonyObservation): Promise<void> {
        const bounds = node.bounds ?? undefined;
        const liveBounds = (node as { live?: { bounds?: { x: number; y: number }[] } }).live?.bounds;
        const points = liveBounds ?? (bounds ? [
            { x: bounds[0], y: bounds[1] },
            { x: bounds[2], y: bounds[3] },
        ] : undefined);
        if (!points || points.length < 2) {
            throw new SemanticError('TARGET_BOUNDS_UNAVAILABLE', `The ref ${node.ref} has no bounds for scrolling.`);
        }
        const left = Math.min(points[0].x, points[1].x);
        const right = Math.max(points[0].x, points[1].x);
        const top = Math.min(points[0].y, points[1].y);
        const bottom = Math.max(points[0].y, points[1].y);
        const centerX = Math.round((left + right) / 2);
        const forward = (decision.direction ?? 'forward') === 'forward';
        const fromY = Math.round(forward ? top + (bottom - top) * 0.75 : top + (bottom - top) * 0.25);
        const toY = Math.round(forward ? top + (bottom - top) * 0.25 : top + (bottom - top) * 0.75);
        await this.deps.device.swipe({
            from: { x: centerX, y: fromY },
            to: { x: centerX, y: toY },
            observationId: observation.observationId,
        });
    }

    private writeTrajectory(outDir: string | undefined, trajectory: TrajectoryRecord[]): void {
        if (!outDir) {
            return;
        }
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
            path.join(outDir, 'trajectory.jsonl'),
            trajectory.map((record) => JSON.stringify(record)).join('\n') + (trajectory.length > 0 ? '\n' : ''),
            'utf8',
        );
    }

    private result(
        success: boolean,
        steps: number,
        reason: string,
        promptTokens: number,
        completionTokens: number,
        started: number,
    ): AgentRunResult {
        return {
            success,
            steps,
            reason,
            promptTokens,
            completionTokens,
            elapsedMs: this.now() - started,
        };
    }
}
