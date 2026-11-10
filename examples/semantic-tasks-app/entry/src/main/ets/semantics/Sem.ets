export interface SemanticAction {
  name: string;
  input: string;
  label: string;
  directions?: string[];
}

export interface SemanticState {
  count?: number;
  enabled?: boolean;
  completed?: boolean;
  favorite?: boolean;
  priority?: string;
  selected?: boolean;
  value?: string | number;
  extra?: string;
}

export interface SemanticSpec {
  schema: number;
  id: string;
  role: string;
  meaning: string;
  entityKind?: string;
  entityKey?: string;
  state?: SemanticState;
  actions?: SemanticAction[];
  constraints?: string;
  risk?: string;
}

export class Sem {
  static node(spec: SemanticSpec): SemanticSpec {
    return spec;
  }

  static safe<T>(factory: () => T, fallback: T): T {
    try {
      return factory();
    } catch (error) {
      return fallback;
    }
  }

  static fallback(id: string): SemanticSpec {
    return {
      schema: 1,
      id: id,
      role: 'unknown',
      meaning: 'unavailable'
    };
  }
}
