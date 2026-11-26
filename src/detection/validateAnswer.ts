import type { TCCategory, TCResult } from '@/comment/tcResult';

/**
 * Card 13: checks a model answer before it becomes a finding. The candidate rules match the
 * result cache's read rules (`background/cache/resultCache.ts`), so every finding the shared
 * detection service returns can be cached and read back.
 */
export type AnswerCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

// `satisfies` makes the compiler reject this list if a category is added or removed.
const CATEGORIES = {
  abstraction: true,
  modularity: true,
  'api-stability': true,
  automation: true,
  'compliance-readiness': true,
  configurability: true,
  observability: true,
  reusability: true,
} satisfies Record<TCCategory, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is TCCategory {
  return typeof value === 'string' && Object.hasOwn(CATEGORIES, value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

const NOT_AN_OBJECT = 'the answer is not a JSON object';

function problem(text: string): { ok: false; problem: string } {
  return { ok: false, problem: text };
}

/**
 * A heuristic answer: `value` is the finding for a candidate, or `null` for "not a candidate".
 * A non-candidate is never a finding, so only its flag is checked. Problems name the field,
 * never its value.
 */
export function parseHeuristicAnswer(
  answer: unknown,
): AnswerCheck<TCResult | null> {
  if (!isRecord(answer)) {
    return problem(NOT_AN_OBJECT);
  }
  // Before card 13 a missing flag read as "not a candidate"; one such answer must not fail the run.
  const isCandidate = answer.is_tc_candidate ?? false;
  if (typeof isCandidate !== 'boolean') {
    return problem('the answer has no boolean is_tc_candidate');
  }
  if (!isCandidate) {
    return { ok: true, value: null };
  }
  const { category, benefit, conditions, signals } = answer;
  // The system prompt asks for null on candidates; a missing value means the same.
  const notTcReason = answer.not_tc_reason ?? null;
  if (!isCategory(category)) {
    return problem('the answer has no valid category');
  }
  if (typeof benefit !== 'string') {
    return problem('the answer has no string benefit');
  }
  if (typeof conditions !== 'string') {
    return problem('the answer has no string conditions');
  }
  if (!isStringArray(signals)) {
    return problem('the answer has no string array signals');
  }
  if (notTcReason !== null && typeof notTcReason !== 'string') {
    return problem('the answer has an invalid not_tc_reason');
  }
  return {
    ok: true,
    value: {
      is_tc_candidate: true,
      category,
      benefit,
      conditions,
      signals: [...signals],
      not_tc_reason: notTcReason,
    },
  };
}

/** An ADR-matching answer: the matched ADR id, or `null` when no ADR documents the pattern. */
export function parseAdrAnswer(answer: unknown): AnswerCheck<string | null> {
  // A bare null says "no match" as plainly as { "adr": null }.
  if (answer === null) {
    return { ok: true, value: null };
  }
  if (!isRecord(answer)) {
    return problem(NOT_AN_OBJECT);
  }
  // Before card 13 a missing adr read as "no match"; one such answer must not fail the run.
  const adr = answer.adr ?? null;
  if (adr !== null && typeof adr !== 'string') {
    return problem('the answer has no valid adr');
  }
  return { ok: true, value: adr };
}
