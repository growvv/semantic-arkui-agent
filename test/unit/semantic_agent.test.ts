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
