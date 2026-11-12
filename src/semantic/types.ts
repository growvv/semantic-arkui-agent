export type SemanticInput = 'tap' | 'long_press' | 'scroll' | 'set_text';

export interface SemanticAction {
    name: string;
    input: SemanticInput;
    label: string;
    directions?: string[];
}

export type SemanticState = Record<string, string | number | boolean>;

export interface SemanticNode {
    ref: string;
    id: string;
    type: string;
    role: string;
    meaning: string;
    entityKind?: string;
    entityKey?: string;
    state?: SemanticState;
    actions?: SemanticAction[];
    risk?: string;
    passthrough?: boolean;
    parentRef?: string;
    visible?: boolean;
    bounds?: [number, number, number, number];
}

export interface SemanticSnapshot {
    schemaVersion: number;
    revision: number;
    bundleName?: string;
    pagePath?: string;
    viewport: { width: number; height: number };
    nodes: SemanticNode[];
    error?: string;
}

export interface LiveFacts {
    type?: string;
    text?: string;
    enabled?: boolean;
    clickable?: boolean;
    checked?: boolean;
    selected?: boolean;
    scrollable?: boolean;
    longClickable?: boolean;
    inputable?: boolean;
    /** The device currently routes typed text here. */
    focused?: boolean;
    visible?: boolean;
    bounds?: { x: number; y: number }[];
}

export interface SemanticViewNode extends SemanticNode {
    live?: LiveFacts;
    liveCount: number;
}

export interface SemanticView {
    revision: number;
    nodes: SemanticViewNode[];
    byRef: Map<string, SemanticViewNode>;
}

export type AgentAction = 'tap' | 'long_press' | 'scroll' | 'input' | 'press' | 'launch' | 'finish';

export interface AgentDecision {
    action: AgentAction;
    ref?: string;
    text?: string;
    direction?: 'forward' | 'backward';
    key?: string;
    bundle?: string;
    summary?: string;
}

export interface AgentPrompt {
    task: string;
    view: SemanticView;
    history: string[];
}

export interface AgentRunResult {
    success: boolean;
    steps: number;
    reason: string;
    promptTokens: number;
    completionTokens: number;
    elapsedMs: number;
}

export class SemanticError extends Error {
    constructor(readonly code: string, message: string, readonly cause?: unknown) {
        super(message);
        this.name = 'SemanticError';
    }
}
