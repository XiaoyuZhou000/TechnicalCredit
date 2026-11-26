import type { DetectorFailure } from '@/background/detector/detector';
import type { TCResult } from '@/comment/tcResult';
import type { TcContext } from '@/context/buildContext';
import type { AdrSummary } from '@/context/findAdrs';
import {
  parseAdrAnswer,
  parseHeuristicAnswer,
  type AnswerCheck,
} from '@/detection/validateAnswer';
import { ADR_SYSTEM_PROMPT, createAdrUserPrompt } from '@/prompts/adrPrompt';
import {
  createHeuristicPrompt,
  HEURISTIC_CATEGORIES,
} from '@/prompts/heuristics';
import { SYSTEM_PROMPT } from '@/prompts/systemPrompt';
import { createUserPrompt } from '@/prompts/userPrompts';

/**
 * Sends one prompt and resolves with the parsed JSON answer. Injected, so the core never loads
 * the SDK: the extension binds `callClaude`, and tests bind a fake.
 */
export type ClaudeClient = (
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
) => Promise<unknown>;

export interface DetectionRequest {
  readonly context: TcContext;
  /** Found by the caller; may be empty, which skips ADR matching. */
  readonly adrs: readonly AdrSummary[];
}

/** Never a rejection: failures use card 10's vocabulary, so a `Detector` can return them as is. */
export type DetectionOutcome =
  | { readonly ok: true; readonly findings: readonly TCResult[] }
  | { readonly ok: false; readonly failure: DetectorFailure };

/** A failed call or unusable answer, named by its step. */
class StepFailure extends Error {
  constructor(step: string, reason: string) {
    super(`${step}: ${reason}`);
  }
}

function reasonOf(error: unknown): string {
  // V8's JSON.parse messages quote the answer, which can echo the analysed source.
  if (error instanceof SyntaxError) {
    return 'the answer is not valid JSON';
  }
  return error instanceof Error ? error.message : String(error);
}

async function ask<T>(
  step: string,
  call: () => Promise<unknown>,
  parse: (answer: unknown) => AnswerCheck<T>,
): Promise<T> {
  let answer: unknown;
  try {
    // The executor turns a client that throws synchronously into a rejected call.
    answer = await new Promise<unknown>((resolve) => resolve(call()));
  } catch (e) {
    throw new StepFailure(step, reasonOf(e));
  }
  const check = parse(answer);
  if (!check.ok) {
    throw new StepFailure(step, check.problem);
  }
  return check.value;
}

/**
 * Card 13: Technical Credit detection for one construct, shared by the manual command and the
 * future background detector. Makes exactly the calls the manual command made before card 13:
 * one per heuristic category, then one ADR-matching call per candidate when ADRs exist. Any
 * failed call fails the whole run. Findings follow `HEURISTIC_CATEGORIES` order.
 */
export async function detectTechnicalCredit(
  request: DetectionRequest,
  client: ClaudeClient,
  signal: AbortSignal,
): Promise<DetectionOutcome> {
  try {
    const userPrompt = createUserPrompt(request.context);
    const answers = await Promise.all(
      HEURISTIC_CATEGORIES.map((category) =>
        ask(
          `heuristic "${category}"`,
          () =>
            client(
              `${SYSTEM_PROMPT}\n\n${createHeuristicPrompt(category)}`,
              userPrompt,
              signal,
            ),
          parseHeuristicAnswer,
        ),
      ),
    );
    const candidates = answers.filter((a): a is TCResult => a !== null);
    if (candidates.length === 0 || request.adrs.length === 0) {
      return { ok: true, findings: candidates };
    }

    const adrs = [...request.adrs];
    const findings = await Promise.all(
      candidates.map(async (finding) => ({
        ...finding,
        adr: await ask(
          `ADR matching for "${finding.category}"`,
          () =>
            client(
              ADR_SYSTEM_PROMPT,
              createAdrUserPrompt(finding, adrs),
              signal,
            ),
          parseAdrAnswer,
        ),
      })),
    );
    return { ok: true, findings };
  } catch (e) {
    const message =
      e instanceof StepFailure ? e.message : `detection: ${reasonOf(e)}`;
    return { ok: false, failure: { kind: 'failed', message } };
  }
}
