import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { HarmonyObservation } from '../../src/device/harmony/session';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { SemanticAgent, SemanticAgentDevice } from '../../src/semantic/agent';
import { SemanticNode, SemanticSnapshot } from '../../src/semantic/types';

const node: SemanticNode = {
    ref: 'sem.a',
    id: 'sem.a',
    type: 'Button',
    role: 'action',
    meaning: 'do the task',
    actions: [{ name: 'tap', input: 'tap', label: 'tap' }],
};

const snapshot: SemanticSnapshot = {
    schemaVersion: 1,
    revision: 1,
    viewport: { width: 200, height: 200 },
    nodes: [node],
};

function livePage(): Page {
    const component = new Component();
    component.id = 'sem.a';
    component.type = 'Button';
    component.text = 'do the task';
    component.visible = true;
    component.enabled = true;
    component.clickable = true;
    component.bounds = [{ x: 10, y: 10 }, { x: 110, y: 60 }];
    return { getComponents: () => [component] } as unknown as Page;
}

function observation(): HarmonyObservation {
    return {
        observationId: 'obs-1',
        observedAt: new Date('2026-11-11T00:00:00.000Z').toISOString(),
        serial: 'device',
        width: 200,
        height: 200,
        coordinateSpace: 'physical-pixels',
        bundleName: 'com.example.app',
        locked: false,
        tree: livePage(),
    };
}

describe('SemanticAgent', () => {
    it('taps a declared live target and stops on finish, recording a trajectory', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-agent-'));
        const tap = vi.fn(async () => ({}));
        const device = {
            observe: vi.fn(async () => observation()),
            tap,
            swipe: vi.fn(async () => ({})),
            typeText: vi.fn(async () => ({})),
            pressKey: vi.fn(async () => ({})),
            launchApp: vi.fn(async () => ({})),
        } as unknown as SemanticAgentDevice;
        const bridge = {
            snapshot: vi.fn(async () => snapshot),
            prepare: vi.fn(async () => node),
        };
        let call = 0;
        const llm = {
            decide: vi.fn(async () => {
                call += 1;
                return call === 1
                    ? { decision: { action: 'tap' as const, ref: 'sem.a' }, promptTokens: 10, completionTokens: 2 }
                    : { decision: { action: 'finish' as const, summary: 'done' }, promptTokens: 8, completionTokens: 1 };
            }),
        };
        const agent = new SemanticAgent({ bridge, device, llm, maxSteps: 4 });

        try {
            const result = await agent.run('do the task', { outDir });
            expect(result).toMatchObject({ success: true, steps: 2, promptTokens: 18, completionTokens: 3 });
            expect(tap).toHaveBeenCalledOnce();
            expect(tap).toHaveBeenCalledWith({ selector: { id: 'sem.a' } });
            const lines = fs.readFileSync(path.join(outDir, 'trajectory.jsonl'), 'utf8').trim().split('\n');
            expect(lines).toHaveLength(2);
            expect(JSON.parse(lines[0])).toMatchObject({ action: { action: 'tap', ref: 'sem.a' }, result: 'tapped sem.a' });
            expect(JSON.parse(lines[1])).toMatchObject({ action: { action: 'finish' }, result: 'done' });
        } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
    });

    it('waits for the semantic snapshot to settle before the next decision', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-agent-settle-'));
        const settled: SemanticSnapshot = {
            ...snapshot,
            revision: 2,
            nodes: [{ ...node, state: { selected: true } }],
        };
        // The bridge answers with the pre-action content twice: ArkUI has not re-rendered yet.
        const revisions = [1, 1, 1, 2];
        let reads = 0;
        const bridge = {
            snapshot: vi.fn(async () => {
                const revision = revisions[Math.min(reads, revisions.length - 1)];
                reads += 1;
                return revision === 2 ? settled : snapshot;
            }),
            prepare: vi.fn(async () => node),
        };
        const device = {
            observe: vi.fn(async () => observation()),
            tap: vi.fn(async () => ({})),
            swipe: vi.fn(async () => ({})),
            typeText: vi.fn(async () => ({})),
            pressKey: vi.fn(async () => ({})),
            launchApp: vi.fn(async () => ({})),
        } as unknown as SemanticAgentDevice;
        const seenRevisions: number[] = [];
        const llm = {
            decide: vi.fn(async (input: { view: { revision: number } }) => {
                seenRevisions.push(input.view.revision);
                return seenRevisions.length === 1
                    ? { decision: { action: 'tap' as const, ref: 'sem.a' }, promptTokens: 10, completionTokens: 2 }
                    : { decision: { action: 'finish' as const, summary: 'done' }, promptTokens: 8, completionTokens: 1 };
            }),
        };
        const agent = new SemanticAgent({
            bridge,
            device,
            llm,
            maxSteps: 4,
            sleep: async () => {},
            settleAttempts: 4,
        });

        try {
            const result = await agent.run('do the task', { outDir });
            expect(result).toMatchObject({ success: true, steps: 2 });
            // The second decision must see the post-action state, not the stale pre-action snapshot.
            expect(seenRevisions).toEqual([1, 2]);
            const lines = fs.readFileSync(path.join(outDir, 'trajectory.jsonl'), 'utf8').trim().split('\n');
            expect(JSON.parse(lines[1])).toMatchObject({ snapshotRevision: 2 });
        } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
    });
});

describe('SemanticAgent text entry', () => {
    function inputDeps(focused: boolean) {
        const order: string[] = [];
        const device = {
            observe: vi.fn(async () => { order.push('observe'); return observation(); }),
            tap: vi.fn(async () => { order.push('tap'); return {}; }),
            swipe: vi.fn(async () => ({})),
            typeText: vi.fn(async () => { order.push('typeText'); return {}; }),
            pressKey: vi.fn(async () => { order.push('pressKey'); return {}; }),
            launchApp: vi.fn(async () => ({})),
        } as unknown as SemanticAgentDevice;
        const inputNode: SemanticNode = {
            ...node,
            role: 'input',
            actions: [{ name: 'set_text', input: 'set_text', label: 'type' }],
            live: { type: 'TextInput', inputable: true, enabled: true, visible: true, focused },
        };
        const viewSnapshot: SemanticSnapshot = { ...snapshot, nodes: [inputNode] };
        const bridge = { snapshot: vi.fn(async () => viewSnapshot), prepare: vi.fn(async () => inputNode) };
        let call = 0;
        const llm = {
            decide: vi.fn(async () => {
                call += 1;
                return call === 1
                    ? { decision: { action: 'input' as const, ref: 'sem.a', text: '米饭' }, promptTokens: 1, completionTokens: 1 }
                    : { decision: { action: 'finish' as const, summary: 'done' }, promptTokens: 1, completionTokens: 1 };
            }),
        };
        return { order, device, bridge, llm };
    }

    it('focuses an unfocused field before typing and dismisses the keyboard afterwards', async () => {
        const deps = inputDeps(false);
        const page = livePage();
        const component = page.getComponents()[0];
        component.type = 'TextInput';
        component.focused = false;
        const device = deps.device as unknown as { observe: ReturnType<typeof vi.fn> };
        device.observe = vi.fn(async () => { deps.order.push('observe'); return { ...observation(), tree: page }; });
        const agent = new SemanticAgent({ bridge: deps.bridge, device: deps.device, llm: deps.llm, maxSteps: 3 });
        await agent.run('add a dish');
        // Typing before focus would land in whichever field held it, and the
        // keyboard left up would push later targets out of the live tree.
        expect(deps.order).toEqual(['observe', 'tap', 'observe', 'typeText', 'observe', 'pressKey', 'observe']);
    });

    it('types straight into a field that already holds focus', async () => {
        const deps = inputDeps(true);
        const page = livePage();
        page.getComponents()[0].type = 'TextInput';
        page.getComponents()[0].focused = true;
        const device = deps.device as unknown as { observe: ReturnType<typeof vi.fn> };
        device.observe = vi.fn(async () => { deps.order.push('observe'); return { ...observation(), tree: page }; });
        const agent = new SemanticAgent({ bridge: deps.bridge, device: deps.device, llm: deps.llm, maxSteps: 3 });
        await agent.run('add a dish');
        expect(deps.order).toEqual(['observe', 'typeText', 'observe']);
    });
});

describe('SemanticAgent budgets', () => {
    function deps(overrides: Record<string, unknown> = {}) {
        const device = {
            observe: vi.fn(async () => observation()),
            tap: vi.fn(async () => ({})),
            swipe: vi.fn(async () => ({})),
            typeText: vi.fn(async () => ({})),
            pressKey: vi.fn(async () => ({})),
            launchApp: vi.fn(async () => ({})),
        } as unknown as SemanticAgentDevice;
        const bridge = { snapshot: vi.fn(async () => snapshot), prepare: vi.fn(async () => node) };
        // A model that never finishes and never repeats itself, so the repeat
        // guard cannot mask the budget under test. Each step advances the
        // snapshot revision and picks a different key.
        let revision = 1;
        bridge.snapshot = vi.fn(async () => ({ ...snapshot, revision: revision++ }));
        let call = 0;
        const llm = {
            decide: vi.fn(async () => ({
                decision: { action: 'press' as const, key: 'BACK', summary: `step ${call++}` },
                promptTokens: 1,
                completionTokens: 1,
            })),
        };
        return { bridge, device, llm, ...overrides };
    }

    it('stops at the step cap and reports MAX_STEPS', async () => {
        const agent = new SemanticAgent({ ...deps(), maxSteps: 3, sleep: async () => {} });
        const result = await agent.run('never finishes');
        expect(result).toMatchObject({ success: false, reason: 'MAX_STEPS', steps: 3 });
    });

    it('defaults to a 20-step cap', async () => {
        const agent = new SemanticAgent({ ...deps(), sleep: async () => {} });
        const result = await agent.run('never finishes');
        expect(result).toMatchObject({ success: false, reason: 'MAX_STEPS', steps: 20 });
    });

    it('stops on the wall-clock budget so one task cannot hold the device', async () => {
        let clock = 0;
        const agent = new SemanticAgent({
            ...deps(),
            maxSteps: 20,
            maxDurationMs: 1000,
            sleep: async () => {},
            now: () => {
                clock += 600;
                return clock;
            },
        });
        const result = await agent.run('never finishes');
        expect(result.success).toBe(false);
        expect(result.reason).toBe('TASK_TIMEOUT');
        expect(result.steps).toBeLessThan(20);
    });
});
