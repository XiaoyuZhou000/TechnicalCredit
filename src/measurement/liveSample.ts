import {
  ResultCache,
  sha256Hex,
  type CacheStore,
} from '@/background/cache/resultCache';
import type { DetectorResult } from '@/background/detector/detector';
import { RealDetector } from '@/background/detector/realDetector';
import type { Clock } from '@/background/scheduler/clock';
import { Scheduler } from '@/background/scheduler/scheduler';
import { RequestTimeline } from '@/background/scheduler/timeline';
import { enumerateConstructs } from '@/context/enumerateConstructs';
import type { ClaudeClient } from '@/detection/detectTechnicalCredit';

/**
 * Card 15A: the most a live sample may ever spend, whatever the runner asks for. The budget
 * is declared before the run and enforced here, in the client wrapper.
 */
export const MAX_LIVE_BUDGET = { analyses: 4, requests: 56 } as const;

/** One heuristic request per category, and no ADR matching: no ADRs are passed. */
export const REQUESTS_PER_CONSTRUCT = 8;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** `callClaude`'s shape, with its optional usage callback required. */
export type UsageClient = (
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
  onUsage: (usage: TokenUsage) => void,
) => Promise<unknown>;

export interface LiveFixture {
  readonly name: string;
  /** Kept in memory only; never written to a record. */
  readonly content: string;
}

export interface LiveBudget {
  readonly analyses: number;
  readonly requests: number;
}

export interface LiveEnvironment {
  readonly os: string;
  readonly node: string;
  readonly model: string;
  readonly date: string;
}

export interface LiveSampleConfig {
  readonly fixtures: readonly LiveFixture[];
  readonly budget: LiveBudget;
  readonly client: UsageClient;
  /** The scheduler's clock and the detector's file time limit (real timers in a live run). */
  readonly clock: Clock;
  /** Monotonic milliseconds for the timeline. */
  readonly monotonic: () => number;
  readonly environment: LiveEnvironment;
  /** Makes every run's content distinct, so no run is a cache hit. */
  readonly runId: string;
  /** USD per million tokens; without them, cost is unavailable. */
  readonly prices?: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
  };
  /** Requests a construct is expected to make; anything else stops the sample. */
  readonly requestsPerConstruct?: number;
  readonly log?: (line: string) => void;
}

export type LiveOutcome =
  | 'done'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped';

export type StopReason =
  | 'budget'
  | 'rate-limit'
  | 'unexpected-count'
  | 'repeated-failures';

/** One measured analysis: metadata, counts and durations, never text. */
export interface LiveRunRecord {
  readonly runId: string;
  readonly fixture: string;
  readonly chars: number;
  readonly sha8: string;
  readonly constructs: number;
  readonly expectedRequests: number;
  readonly requests: number;
  readonly outcome: LiveOutcome;
  readonly findings: number | null;
  readonly detectorMs: number;
  readonly slotMs: number;
  readonly quietMs: number;
  readonly cooldownMs: number;
  /** `null` when no usage was reported. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** `null` unless prices were supplied. */
  readonly costUsd: number | null;
}

export interface LiveSampleResult {
  readonly environment: LiveEnvironment;
  readonly budget: LiveBudget;
  readonly used: { readonly analyses: number; readonly requests: number };
  readonly runs: readonly LiveRunRecord[];
  readonly stoppedBy?: StopReason;
}

class BudgetError extends Error {
  constructor() {
    super('live sample budget exhausted: request refused');
  }
}

class RateLimitedError extends Error {
  constructor() {
    super('live sample stopped after a rate limit: request refused');
  }
}

function isRateLimit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 429
  );
}

function memoryStore(): CacheStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    update: (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  };
}

function outcomeOf(result: DetectorResult): LiveOutcome {
  return result.ok ? 'done' : result.failure.kind;
}

function checkBudget(budget: LiveBudget): void {
  const valid = (n: number, max: number): boolean =>
    Number.isInteger(n) && n >= 1 && n <= max;
  if (
    !valid(budget.analyses, MAX_LIVE_BUDGET.analyses) ||
    !valid(budget.requests, MAX_LIVE_BUDGET.requests)
  ) {
    throw new Error(
      `live sample budget must be 1–${MAX_LIVE_BUDGET.analyses} analyses and 1–${MAX_LIVE_BUDGET.requests} requests`,
    );
  }
}

/**
 * Card 15A US3: a small, budgeted live latency sample through the real scheduler and the real
 * background detector (no ADRs, no cooldown, no quiet period, one call at a time).
 *
 * Stops before a run that could pass the budget, and refuses any request past it in the client
 * wrapper itself. Also stops on a rate limit (never retried), on a successful run whose request
 * count differs from the expected one, and after 2 failed runs in a row. Never touches the
 * extension or its live-call gate, and records metadata only.
 */
export async function runLiveSample(
  config: LiveSampleConfig,
): Promise<LiveSampleResult> {
  checkBudget(config.budget);
  const perConstruct = config.requestsPerConstruct ?? REQUESTS_PER_CONSTRUCT;
  const log = config.log ?? (() => {});

  // Every fixture is checked first, so a bad one costs nothing.
  const prepared: { fixture: LiveFixture; constructs: number }[] = [];
  for (const fixture of config.fixtures) {
    const enumeration = await enumerateConstructs(
      fixture.content,
      fixture.name,
      'java',
    );
    if (!enumeration.ok) {
      throw new Error('the Java parser is unavailable; run npm run compile');
    }
    if (enumeration.hasSyntaxErrors || enumeration.constructs.length === 0) {
      throw new Error(
        `fixture ${fixture.name} must parse cleanly with ≥1 type`,
      );
    }
    prepared.push({ fixture, constructs: enumeration.constructs.length });
  }

  let sent = 0;
  let refused = 0;
  let rateLimited = false;
  let runRequests = 0;
  let runInput = 0;
  let runOutput = 0;
  let runUsageSeen = false;

  const client: ClaudeClient = (systemPrompt, userMessage, signal) => {
    if (rateLimited) {
      refused++;
      return Promise.reject(new RateLimitedError());
    }
    if (sent >= config.budget.requests) {
      refused++;
      return Promise.reject(new BudgetError());
    }
    sent++;
    runRequests++;
    return config
      .client(systemPrompt, userMessage, signal, (usage) => {
        runUsageSeen = true;
        runInput += usage.inputTokens;
        runOutput += usage.outputTokens;
      })
      .catch((error: unknown) => {
        if (isRateLimit(error)) {
          rateLimited = true;
        }
        throw error;
      });
  };

  const timeline = new RequestTimeline({ now: config.monotonic, log });
  let settledRun: ((result: DetectorResult) => void) | undefined;
  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector: new RealDetector({
      client,
      adrsFor: () => [],
      clock: config.clock,
    }),
    cache: new ResultCache({
      store: memoryStore(),
      now: () => config.clock.now(),
    }),
    hash: sha256Hex,
    log,
    clock: config.clock,
    quietMs: 0,
    cooldownMs: 0,
    maxConcurrent: 1,
    observer: timeline,
    onSettled: (event) => settledRun?.(event.result),
  });

  const runs: LiveRunRecord[] = [];
  let failuresInRow = 0;
  let stoppedBy: StopReason | undefined;
  try {
    for (const [index, { fixture, constructs }] of prepared.entries()) {
      const expectedRequests = constructs * perConstruct;
      if (
        runs.length + 1 > config.budget.analyses ||
        sent + expectedRequests > config.budget.requests
      ) {
        stoppedBy = 'budget';
        break;
      }
      const runId = `${config.runId}-${index + 1}`;
      const content = `${fixture.content}\n// card 15A live sample run ${runId}\n`;
      runRequests = 0;
      runInput = 0;
      runOutput = 0;
      runUsageSeen = false;

      const settled = new Promise<DetectorResult>((resolve) => {
        settledRun = resolve;
      });
      const started = scheduler.stats().started;
      scheduler.submit({
        workspaceId: 'file:///measurement',
        fileUri: `file:///measurement/${fixture.name}`,
        languageId: 'java',
        version: index + 1,
        content,
        trigger: 'open',
        observedAt: config.clock.now(),
      });
      if (scheduler.stats().started !== started + 1) {
        throw new Error(`run ${runId} did not start a detector call`);
      }
      const result = await settled;
      settledRun = undefined;

      const timing = timeline.records().at(-1);
      const outcome = outcomeOf(result);
      const cost =
        config.prices === undefined || !runUsageSeen
          ? null
          : (runInput * config.prices.inputPerMTok +
              runOutput * config.prices.outputPerMTok) /
            1_000_000;
      runs.push({
        runId,
        fixture: fixture.name,
        chars: fixture.content.length,
        sha8: sha256Hex(content).slice(0, 8),
        constructs,
        expectedRequests,
        requests: runRequests,
        outcome,
        findings: result.ok ? result.output.findings.length : null,
        detectorMs: timing?.detectorMs ?? 0,
        slotMs: timing?.slotMs ?? 0,
        quietMs: timing?.quietMs ?? 0,
        cooldownMs: timing?.cooldownMs ?? 0,
        inputTokens: runUsageSeen ? runInput : null,
        outputTokens: runUsageSeen ? runOutput : null,
        costUsd: cost,
      });
      log(
        `live run ${runId} ${fixture.name} ${outcome} requests=${runRequests}/${expectedRequests} detector=${Math.round(timing?.detectorMs ?? 0)}ms`,
      );

      if (rateLimited) {
        stoppedBy = 'rate-limit';
        break;
      }
      if (refused > 0) {
        stoppedBy = 'budget';
        break;
      }
      if (outcome === 'done' && runRequests !== expectedRequests) {
        stoppedBy = 'unexpected-count';
        break;
      }
      failuresInRow = outcome === 'done' ? 0 : failuresInRow + 1;
      if (failuresInRow >= 2) {
        stoppedBy = 'repeated-failures';
        break;
      }
    }
  } finally {
    scheduler.dispose();
  }

  return {
    environment: config.environment,
    budget: config.budget,
    used: { analyses: runs.length, requests: sent },
    runs,
    ...(stoppedBy !== undefined && { stoppedBy }),
  };
}
