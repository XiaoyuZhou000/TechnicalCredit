import type { TCResult } from '@/comment/tcResult';
import { ADR_SYSTEM_PROMPT } from '@/prompts/adrPrompt';
import {
  createHeuristicPrompt,
  HEURISTIC_CATEGORIES,
  type HeuristicCategory,
} from '@/prompts/heuristics';
import { SYSTEM_PROMPT } from '@/prompts/systemPrompt';

/** What one scripted call does. Values are cloned per call, so callers may mutate answers. */
export type Behaviour =
  | { readonly kind: 'resolve'; readonly value: unknown }
  | { readonly kind: 'reject'; readonly error: unknown }
  | { readonly kind: 'throw'; readonly error: unknown }
  /** Settles only when released; with `ignoreSignal`, an abort doesn't settle it either. */
  | {
      readonly kind: 'hold';
      readonly value: unknown;
      readonly ignoreSignal?: boolean;
    };

/** Keyed by heuristic category, or `adr:<category>` for that candidate's ADR-matching call. */
export type Script = Readonly<Record<string, Behaviour>>;

export interface RecordedCall {
  readonly kind: 'heuristic' | 'adr';
  readonly category: string;
  readonly system: string;
  readonly user: string;
  readonly signal: AbortSignal;
}

export type FakeClient = (
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
) => Promise<unknown>;

export interface FakeClaude {
  readonly client: FakeClient;
  readonly calls: RecordedCall[];
  /** Settles held calls in start order, or in reverse start order. */
  releaseAll(order?: 'start' | 'reverse'): void;
  /** Number of held calls not yet settled. */
  held(): number;
}

export function heuristicSystemPrompt(category: HeuristicCategory): string {
  return `${SYSTEM_PROMPT}\n\n${createHeuristicPrompt(category)}`;
}

const HEURISTIC_BY_PROMPT = new Map<string, HeuristicCategory>(
  HEURISTIC_CATEGORIES.map((c) => [heuristicSystemPrompt(c), c]),
);

/** The finding a valid `candidate(category)` answer becomes. */
export function candidateResult(category: HeuristicCategory): TCResult {
  return {
    is_tc_candidate: true,
    category,
    benefit: `${category} benefit`,
    conditions: `${category} conditions`,
    signals: [`${category}-signal`],
    not_tc_reason: null,
  };
}

export function candidate(
  category: HeuristicCategory,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...candidateResult(category), ...overrides };
}

export function notCandidate(): Record<string, unknown> {
  return {
    is_tc_candidate: false,
    category: 'abstraction',
    benefit: '',
    conditions: '',
    signals: [],
    not_tc_reason: 'no evidence in this construct',
  };
}

export const answer = (value: unknown): Behaviour => ({
  kind: 'resolve',
  value,
});
export const hold = (value: unknown, ignoreSignal = false): Behaviour => ({
  kind: 'hold',
  value,
  ignoreSignal,
});

function classify(
  system: string,
  user: string,
): { kind: 'heuristic' | 'adr'; category: string } {
  const heuristic = HEURISTIC_BY_PROMPT.get(system);
  if (heuristic !== undefined) {
    return { kind: 'heuristic', category: heuristic };
  }
  if (system === ADR_SYSTEM_PROMPT) {
    const category = /^category: (.+)$/m.exec(user)?.[1] ?? '?';
    return { kind: 'adr', category };
  }
  throw new Error('fake claude: unexpected system prompt');
}

interface Held {
  readonly settle: () => void;
}

/**
 * A scripted stand-in for `callClaude`. Unscripted heuristic calls answer "not a candidate";
 * unscripted ADR calls answer `{ adr: null }`.
 */
export function createFakeClaude(script: Script = {}): FakeClaude {
  const calls: RecordedCall[] = [];
  let pending: Held[] = [];

  const client: FakeClient = (system, user, signal) => {
    const { kind, category } = classify(system, user);
    calls.push({ kind, category, system, user, signal });
    const key = kind === 'adr' ? `adr:${category}` : category;
    const behaviour =
      script[key] ?? answer(kind === 'adr' ? { adr: null } : notCandidate());

    switch (behaviour.kind) {
      case 'resolve':
        return Promise.resolve(structuredClone(behaviour.value));
      case 'reject':
        return Promise.reject(behaviour.error);
      case 'throw':
        throw behaviour.error;
      case 'hold':
        return new Promise((resolve, reject) => {
          const entry: Held = {
            settle: () => resolve(structuredClone(behaviour.value)),
          };
          pending.push(entry);
          if (!behaviour.ignoreSignal) {
            signal.addEventListener(
              'abort',
              () => {
                pending = pending.filter((p) => p !== entry);
                reject(signal.reason);
              },
              { once: true },
            );
          }
        });
    }
  };

  return {
    client,
    calls,
    releaseAll(order = 'start') {
      const batch = order === 'reverse' ? [...pending].reverse() : pending;
      pending = [];
      for (const entry of batch) {
        entry.settle();
      }
    },
    held: () => pending.length,
  };
}
