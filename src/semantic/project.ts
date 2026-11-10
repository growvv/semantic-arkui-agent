import { Page } from '../model/page';
import { Component } from '../model/component';
import {
    AgentAction,
    LiveFacts,
    SemanticNode,
    SemanticSnapshot,
    SemanticView,
    SemanticViewNode,
} from './types';

export interface SemanticActionRequest {
    action: AgentAction;
    ref: string;
    text?: string;
    direction?: 'forward' | 'backward';
}

export type SemanticActionValidation =
    | { ok: true }
    | { ok: false; errorCode: string; message: string };

export function projectSemanticSnapshot(snapshot: SemanticSnapshot, livePage?: Page): SemanticView {
    const liveById = new Map<string, Component[]>();
    if (livePage) {
        for (const component of livePage.getComponents()) {
            if (!component.id) continue;
            const matches = liveById.get(component.id) ?? [];
            matches.push(component);
            liveById.set(component.id, matches);
        }
    }

    const nodes: SemanticViewNode[] = snapshot.nodes.map((node) => {
        const matches = liveById.get(node.id) ?? [];
        const component = matches.length === 1 ? matches[0] : undefined;
        return {
            ...node,
            live: component ? liveFacts(component) : undefined,
            liveCount: matches.length,
        };
    });
    return {
        revision: snapshot.revision,
        nodes,
        byRef: new Map(nodes.map((node) => [node.ref, node])),
    };
}

export function validateSemanticAction(node: SemanticViewNode, action: SemanticActionRequest): SemanticActionValidation {
    if (action.action === 'finish' || action.action === 'press' || action.action === 'launch') {
        return { ok: true };
    }
    if (node.liveCount === 0) {
        return failure('TARGET_NOT_FOUND', `No live node has id ${node.id}.`);
    }
    if (node.liveCount > 1) {
        return failure('AMBIGUOUS_TARGET', `The live tree has ${node.liveCount} nodes with id ${node.id}.`);
    }
    const live = node.live;
    if (!live) {
        return failure('TARGET_NOT_FOUND', `The live node for ${node.id} is unavailable.`);
    }
    if (live.visible === false) {
        return failure('NOT_VISIBLE', `The live node ${node.id} is not visible.`);
    }
    if (live.enabled === false) {
        return failure('NOT_INTERACTABLE', `The live node ${node.id} is disabled.`);
    }

    const declared = node.actions?.find((item) => declaredInputFor(action.action) === item.input);
    if (!declared) {
        return failure('ACTION_UNSUPPORTED', `The semantic declaration for ${node.id} does not allow ${action.action}.`);
    }

    if (action.action === 'tap' && live.clickable !== true) {
        return failure('TARGET_NOT_CLICKABLE', `The live node ${node.id} is not clickable.`);
    }
    if (action.action === 'long_press' && live.longClickable !== true) {
        return failure('TARGET_NOT_LONG_CLICKABLE', `The live node ${node.id} does not support long press.`);
    }
    if (action.action === 'input' && live.inputable !== true && live.type !== '__Common__') {
        return failure('TARGET_NOT_INPUTABLE', `The live node ${node.id} is not a text input.`);
    }
    if (action.action === 'scroll') {
        if (live.scrollable !== true) {
            return failure('TARGET_NOT_SCROLLABLE', `The live node ${node.id} is not scrollable.`);
        }
        if (action.direction && declared.directions && !declared.directions.includes(action.direction)) {
            return failure('DIRECTION_UNSUPPORTED', `The semantic declaration for ${node.id} does not allow ${action.direction} scrolling.`);
        }
    }
    return { ok: true };
}

export function findSemanticNode(view: SemanticView, ref: string): SemanticViewNode | undefined {
    return view.byRef.get(ref);
}

export function liveComponentForNode(page: Page | undefined, node: SemanticNode): Component | undefined {
    if (!page) return undefined;
    const matches = page.getComponents().filter((component) => component.id === node.id);
    return matches.length === 1 ? matches[0] : undefined;
}

function liveFacts(component: Component): LiveFacts {
    return {
        type: component.type,
        text: component.inputable ? undefined : component.text,
        enabled: component.enabled,
        clickable: component.clickable,
        checked: component.checked,
        selected: component.selected,
        scrollable: component.scrollable,
        longClickable: component.longClickable,
        inputable: component.inputable,
        visible: component.visible,
        bounds: component.bounds,
    };
}

function declaredInputFor(action: AgentAction): string {
    switch (action) {
        case 'tap':
            return 'tap';
        case 'long_press':
            return 'long_press';
        case 'scroll':
            return 'scroll';
        case 'input':
            return 'set_text';
        default:
            return '';
    }
}

function failure(errorCode: string, message: string): SemanticActionValidation {
    return { ok: false, errorCode, message };
}
