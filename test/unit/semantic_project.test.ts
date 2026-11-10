import { describe, expect, it } from 'vitest';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { findSemanticNode, projectSemanticSnapshot, validateSemanticAction } from '../../src/semantic/project';
import { SemanticNode, SemanticSnapshot } from '../../src/semantic/types';

function component(id: string, type: string, overrides: Partial<Component> = {}): Component {
    const result = new Component();
    result.id = id;
    result.type = type;
    result.visible = true;
    result.enabled = true;
    result.clickable = true;
    result.scrollable = false;
    result.bounds = [{ x: 0, y: 0 }, { x: 100, y: 50 }];
    Object.assign(result, overrides);
    return result;
}

function page(components: Component[]): Page {
    return { getComponents: () => components } as unknown as Page;
}

function snapshot(nodes: SemanticNode[]): SemanticSnapshot {
    return { schemaVersion: 1, revision: 1, viewport: { width: 200, height: 200 }, nodes };
}

const tapNode: SemanticNode = {
    ref: 'sem.a',
    id: 'sem.a',
    type: 'Button',
    role: 'action',
    meaning: 'tap me',
    actions: [{ name: 'tap', input: 'tap', label: 'tap' }],
};

describe('semantic projection', () => {
    it('joins live facts by id and validates a declared tap', () => {
        const view = projectSemanticSnapshot(snapshot([tapNode]), page([component('sem.a', 'Button')]));
        const node = findSemanticNode(view, 'sem.a');
        expect(node).toMatchObject({ liveCount: 1, live: { type: 'Button', clickable: true, enabled: true } });
        expect(validateSemanticAction(node!, { action: 'tap', ref: 'sem.a' })).toEqual({ ok: true });
    });

    it('reports a missing target and a duplicate target without guessing', () => {
        const missing = projectSemanticSnapshot(snapshot([tapNode]), page([]));
        expect(validateSemanticAction(missing.byRef.get('sem.a')!, { action: 'tap', ref: 'sem.a' }))
            .toMatchObject({ ok: false, errorCode: 'TARGET_NOT_FOUND' });

        const duplicate = projectSemanticSnapshot(
            snapshot([tapNode]),
            page([component('sem.a', 'Button'), component('sem.a', 'Button')]),
        );
        expect(validateSemanticAction(duplicate.byRef.get('sem.a')!, { action: 'tap', ref: 'sem.a' }))
            .toMatchObject({ ok: false, errorCode: 'AMBIGUOUS_TARGET' });
    });

    it('rejects an undeclared action and a non-clickable live node', () => {
        const noActions = projectSemanticSnapshot(
            snapshot([{ ...tapNode, actions: [] }]),
            page([component('sem.a', 'Button')]),
        );
        expect(validateSemanticAction(noActions.byRef.get('sem.a')!, { action: 'tap', ref: 'sem.a' }))
            .toMatchObject({ ok: false, errorCode: 'ACTION_UNSUPPORTED' });

        const disabled = projectSemanticSnapshot(
            snapshot([tapNode]),
            page([component('sem.a', 'Button', { clickable: false })]),
        );
        expect(validateSemanticAction(disabled.byRef.get('sem.a')!, { action: 'tap', ref: 'sem.a' }))
            .toMatchObject({ ok: false, errorCode: 'TARGET_NOT_CLICKABLE' });
    });

    it('accepts set_text only for a live input and scroll only for a live scroll container', () => {
        const inputNode: SemanticNode = {
            ref: 'sem.input',
            id: 'sem.input',
            type: 'TextInput',
            role: 'input',
            meaning: 'search',
            actions: [{ name: 'set_text', input: 'set_text', label: 'enter text' }],
        };
        const inputView = projectSemanticSnapshot(snapshot([inputNode]), page([component('sem.input', 'TextInput')]));
        expect(validateSemanticAction(inputView.byRef.get('sem.input')!, { action: 'input', ref: 'sem.input', text: 'x' }))
            .toEqual({ ok: true });

        const wrongInput = projectSemanticSnapshot(snapshot([inputNode]), page([component('sem.input', 'Button')]));
        expect(validateSemanticAction(wrongInput.byRef.get('sem.input')!, { action: 'input', ref: 'sem.input', text: 'x' }))
            .toMatchObject({ ok: false, errorCode: 'TARGET_NOT_INPUTABLE' });

        const scrollNode: SemanticNode = {
            ref: 'sem.list',
            id: 'sem.list',
            type: 'List',
            role: 'list',
            meaning: 'tasks',
            actions: [{ name: 'scroll', input: 'scroll', label: 'scroll', directions: ['forward', 'backward'] }],
        };
        const notScrollable = projectSemanticSnapshot(snapshot([scrollNode]), page([component('sem.list', 'List', { scrollable: false })]));
        expect(validateSemanticAction(notScrollable.byRef.get('sem.list')!, { action: 'scroll', ref: 'sem.list', direction: 'forward' }))
            .toMatchObject({ ok: false, errorCode: 'TARGET_NOT_SCROLLABLE' });
    });
});
