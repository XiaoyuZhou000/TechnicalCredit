import * as fs from 'fs';
import * as path from 'path';

import { enumerateConstructs } from '@/context/enumerateConstructs';
import {
  MAX_LIVE_BUDGET,
  runLiveSample,
  type LiveFixture,
  type LiveSampleConfig,
  type UsageClient,
} from '@/measurement/liveSample';
import { SYSTEM_PROMPT } from '@/prompts/systemPrompt';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { initParser } from '@/test/context/parserSetup';
import {
  answer,
  candidate,
  createFakeClaude,
  type Script,
} from '@/test/detection/fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 15A US3: the budgeted live sample harness, proven offline with a fake client before any
 * billed run. It stops on its budget, a rate limit, an unexpected request count or repeated
 * failures, and records metadata only.
 */

beforeAll(() => {
  initParser();
});

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const NAMES = ['OneA.java', 'OneB.java', 'Two.java', 'Three.java'];

function fixtures(): LiveFixture[] {
  return NAMES.map((name) => ({
    name,
    content: fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'),
  }));
}

const ENVIRONMENT = {
  os: 'test-os',
  node: 'v0',
  model: 'test-model',
  date: '2026-11-28',
};

function config(
  overrides: Partial<LiveSampleConfig> & { script?: Script } = {},
): { config: LiveSampleConfig; calls: () => number } {
  const claude = createFakeClaude(overrides.script ?? {});
  const client: UsageClient = (system, user, signal, onUsage) => {
    onUsage({ inputTokens: 100, outputTokens: 20 });
    return claude.client(system, user, signal);
  };
  let tick = 0;
  return {
    calls: () => claude.calls.length,
    config: {
      fixtures: fixtures(),
      budget: { analyses: 4, requests: 56 },
      client,
      clock: createFakeTimers(),
      monotonic: () => (tick += 5),
      environment: ENVIRONMENT,
      runId: 'test',
      ...overrides,
    },
  };
}

describe('the live sample fixtures', () => {
  test('enumerate to 1, 1, 2 and 3 top-level types with no syntax errors', async () => {
    const counts = [];
    for (const fixture of fixtures()) {
      const result = await enumerateConstructs(
        fixture.content,
        fixture.name,
        'java',
      );
      if (!result.ok) {
        throw new Error('parser unavailable');
      }
      expect(result.hasSyntaxErrors).toBe(false);
      counts.push(result.constructs.length);
    }
    expect(counts).toEqual([1, 1, 2, 3]);
  });
});

describe('runLiveSample with a fake client (US3)', () => {
  test('runs the 4 fixtures within the budget: 56 requests, every run a real call', async () => {
    const { config: c, calls } = config({
      script: { abstraction: answer(candidate('abstraction')) },
    });

    const result = await runLiveSample(c);

    expect(result.stoppedBy).toBeUndefined();
    expect(result.used).toEqual({ analyses: 4, requests: 56 });
    expect(calls()).toBe(56);
    expect(result.environment).toEqual(ENVIRONMENT);
    expect(result.budget).toEqual({ analyses: 4, requests: 56 });
    expect(
      result.runs.map((r) => [
        r.fixture,
        r.constructs,
        r.expectedRequests,
        r.requests,
        r.outcome,
        r.findings,
      ]),
    ).toEqual([
      ['OneA.java', 1, 8, 8, 'done', 1],
      ['OneB.java', 1, 8, 8, 'done', 1],
      ['Two.java', 2, 16, 16, 'done', 2],
      ['Three.java', 3, 24, 24, 'done', 3],
    ]);
    const first = result.runs[0];
    expect(first.chars).toBe(fixtures()[0].content.length);
    expect(first.inputTokens).toBe(800);
    expect(first.outputTokens).toBe(160);
    expect(first.costUsd).toBeNull();
    expect(first.detectorMs).toBeGreaterThan(0);
    // No quiet period or cooldown; the slot time is one 5 ms tick of the test's clock.
    expect([first.quietMs, first.cooldownMs, first.slotMs]).toEqual([0, 0, 5]);
    expect(new Set(result.runs.map((r) => r.sha8)).size).toBe(4);
  });

  test('computes cost only from prices the runner supplies', async () => {
    const { config: c } = config({
      budget: { analyses: 1, requests: 8 },
      prices: { inputPerMTok: 3, outputPerMTok: 15 },
    });

    const result = await runLiveSample(c);

    // 800 input and 160 output tokens: (800 × 3 + 160 × 15) / 1e6.
    expect(result.runs[0].costUsd).toBeCloseTo(0.0048, 10);
  });

  test('stops before a run that could pass the request budget (US3-1)', async () => {
    const { config: c, calls } = config({
      budget: { analyses: 4, requests: 20 },
    });

    const result = await runLiveSample(c);

    expect(result.stoppedBy).toBe('budget');
    expect(result.runs.map((r) => r.fixture)).toEqual([
      'OneA.java',
      'OneB.java',
    ]);
    expect(calls()).toBe(16);
    expect(result.used.requests).toBeLessThanOrEqual(20);
  });

  test('stops at the analysis budget', async () => {
    const { config: c } = config({ budget: { analyses: 2, requests: 56 } });

    const result = await runLiveSample(c);

    expect(result.runs).toHaveLength(2);
    expect(result.stoppedBy).toBe('budget');
  });

  test('never sends a request past the budget, even if a run needs more than expected', async () => {
    // Misdeclared at 1 request per type, so the check before the run lets it through.
    const { config: c, calls } = config({
      budget: { analyses: 4, requests: 5 },
      requestsPerConstruct: 1,
    });

    const result = await runLiveSample(c);

    expect(calls()).toBe(5);
    expect(result.used.requests).toBe(5);
    expect(result.runs[0].outcome).toBe('failed');
    expect(result.stoppedBy).toBe('budget');
  });

  test('stops on a rate limit, with no retry (US3-2)', async () => {
    const limited = Object.assign(new Error('rate limited'), { status: 429 });
    const { config: c, calls } = config({
      script: { abstraction: { kind: 'reject', error: limited } },
    });

    const result = await runLiveSample(c);

    expect(result.stoppedBy).toBe('rate-limit');
    expect(result.runs).toHaveLength(1);
    expect(calls()).toBeLessThanOrEqual(8);
  });

  test('stops when a run makes an unexpected number of requests (US3-3)', async () => {
    const { config: c } = config({ requestsPerConstruct: 7 });

    const result = await runLiveSample(c);

    expect(result.stoppedBy).toBe('unexpected-count');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ expectedRequests: 7, requests: 8 });
  });

  test('stops after 2 failed runs in a row', async () => {
    const { config: c } = config({
      script: { abstraction: { kind: 'reject', error: new Error('server') } },
    });

    const result = await runLiveSample(c);

    expect(result.stoppedBy).toBe('repeated-failures');
    expect(result.runs.map((r) => r.outcome)).toEqual(['failed', 'failed']);
  });

  test('refuses a budget above the declared maximum before any call', async () => {
    const { config: c, calls } = config({
      budget: { analyses: 4, requests: MAX_LIVE_BUDGET.requests + 1 },
    });

    await expect(runLiveSample(c)).rejects.toThrow(/budget/);
    expect(calls()).toBe(0);
  });

  test('refuses a fixture with syntax errors before any call', async () => {
    const { config: c, calls } = config({
      fixtures: [{ name: 'Broken.java', content: 'clas Broken {' }],
    });

    await expect(runLiveSample(c)).rejects.toThrow(/Broken\.java/);
    expect(calls()).toBe(0);
  });

  test('records no source, prompt or key', async () => {
    const { config: c } = config({
      script: { abstraction: answer(candidate('abstraction')) },
    });

    const text = JSON.stringify(await runLiveSample(c));

    expect(text).not.toContain('InvoiceTotals');
    expect(text).not.toContain('BigDecimal');
    expect(text).not.toContain(SYSTEM_PROMPT.slice(0, 40));
    expect(text).not.toContain('ANTHROPIC_API_KEY');
  });
});
