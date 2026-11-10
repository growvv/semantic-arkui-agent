import OpenAI from 'openai';
import { AgentDecision, AgentPrompt, SemanticError } from './types';

const SYSTEM_PROMPT = `You operate a HarmonyOS application through a semantic UI tree.
You never see screenshots. Each step, choose exactly one action from the tree.

Allowed responses (JSON only):
{"action":"tap","ref":"<ref>"}
{"action":"long_press","ref":"<ref>"}
{"action":"scroll","ref":"<ref>","direction":"forward"|"backward"}
{"action":"input","ref":"<ref>","text":"<text>"}
{"action":"press","key":"BACK"|"HOME"|"ENTER"}
{"action":"launch","bundle":"<bundle>"}
{"action":"finish","summary":"<what was done or why stopped>"}

Rules:
- Use only refs present in the current view.
- Prefer a node whose meaning, entity, state, and actions match the task.
- Do not invent refs, coordinates, or hidden screens.
- If the target is missing, ambiguous, or the task is already complete, finish with a short summary.
- If the view revision did not change after your last action, do not repeat the same action; finish or choose a different target.
- Finish as soon as the task is complete; do not keep tapping a control whose state does not change.
- For a slider or another control that changes value on tap, one tap is usually enough; inspect the new value and finish when the requested change is achieved.
- If your last action changed the view and the target condition is now satisfied, finish immediately.
- One action per response, no prose outside the JSON object.`;

const ALLOWED_ACTIONS = new Set(['tap', 'long_press', 'scroll', 'input', 'press', 'launch', 'finish']);

export interface LlmDecisionResult {
    decision: AgentDecision;
    promptTokens: number;
    completionTokens: number;
}

export class LlmClient {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(options: { baseURL?: string; model?: string; apiKey?: string } = {}) {
        this.client = new OpenAI({
            baseURL: options.baseURL ?? process.env.MAGPIE_BASE_URL ?? 'http://127.0.0.1:3425/v1',
            apiKey: options.apiKey ?? process.env.MAGPIE_API_KEY ?? 'magpie',
            timeout: 120000,
        });
        this.model = options.model ?? process.env.SEMANTIC_MODEL ?? 'auto/gpt-6-luna';
    }

    async decide(input: AgentPrompt): Promise<LlmDecisionResult> {
        const promptView = {
            revision: input.view.revision,
            nodes: input.view.nodes.map((node) => ({
                ref: node.ref,
                role: node.role,
                meaning: node.meaning,
                visible: node.visible,
                entityKind: node.entityKind,
                entityKey: node.entityKey,
                state: node.state,
                actions: node.actions,
                live: node.live ? {
                    type: node.live.type,
                    text: node.live.text,
                    enabled: node.live.enabled,
                    clickable: node.live.clickable,
                    checked: node.live.checked,
                    selected: node.live.selected,
                    scrollable: node.live.scrollable,
                    inputable: node.live.inputable,
                    visible: node.live.visible,
                } : null,
            })),
        };

        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: [
                        `Task: ${input.task}`,
                        `History:\n${input.history.length > 0 ? input.history.join('\n') : '(none)'}`,
                        `Current view:\n${JSON.stringify(promptView)}`,
                    ].join('\n\n'),
                },
            ],
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new SemanticError('INVALID_MODEL_DECISION', 'The model returned an empty decision.');
        }
        return {
            decision: parseDecision(content),
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
        };
    }
}

function parseDecision(content: string): AgentDecision {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start < 0 || end <= start) {
            throw new SemanticError('INVALID_MODEL_DECISION', `The model did not return JSON: ${content.slice(0, 200)}`);
        }
        try {
            parsed = JSON.parse(content.slice(start, end + 1));
        } catch (error) {
            throw new SemanticError('INVALID_MODEL_DECISION', 'The model returned malformed JSON.', error);
        }
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new SemanticError('INVALID_MODEL_DECISION', 'The model decision is not an object.');
    }
    const record = parsed as Record<string, unknown>;
    const action = record.action;
    if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
        throw new SemanticError('INVALID_MODEL_DECISION', `The model returned an unknown action: ${String(action)}`);
    }
    return {
        action: action as AgentDecision['action'],
        ref: stringValue(record.ref),
        text: stringValue(record.text),
        direction: record.direction === 'forward' || record.direction === 'backward' ? record.direction : undefined,
        key: stringValue(record.key),
        bundle: stringValue(record.bundle),
        summary: stringValue(record.summary),
    };
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
