import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import {
  formatTiming,
  RequestTimeline,
  type SchedulerObserver,
} from '@/background/scheduler/timeline';
import {
  createFakeTimers,
  type FakeTimers,
} from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 15A US1: one timing record and line per background request or cache hit. Detector time
 * is kept apart from the quiet, cooldown, in-flight and slot waits, and the timeline never
 * changes a decision.
 */

const W = 'file:///w';
const A = 'file:///w/A.java';
const B = 'file:///w/B.java';
const SECRET = 'SECRET_BODY_15A';

function ok(findings: number): DetectorResult {
  return {
    ok: true,
    output: {
      detectorId: 'scripted',
      detectorVersion: '1',
      findings: Array.from({ length: findings }, (_, line) => ({
        line,
        result: {
          is_tc_candidate: true,
          category: 'modularity',
          benefit: 'b',
          conditions: 'c',
          signals: [],
          not_tc_reason: null,
        },
      })),
    },
  };
}

class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  readonly calls: {
    readonly input: DetectorInput;
    resolve(r: DetectorResult): void;
  }[] = [];

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return new Promise((resolve) => {
      this.calls.push({ input, resolve });
      signal.addEventListener(
        'abort',
        () => resolve(failureFromAbort(signal)),
        {
          once: true,
        },
      );
    });
  }
}

function setup(
  options: {
    quietMs?: number;
    cooldownMs?: number;
    maxConcurrent?: number;
    observer?: 'timeline' | 'none' | 'throwing';
    limit?: number;
  } = {},
) {
  const clock = createFakeTimers();
  const detector = new ScriptedDetector();
  const cache = new ResultCache({
    store: createMemoryCacheStore(),
    now: () => clock.now(),
  });
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  const timeline = new RequestTimeline({
    now: () => clock.now(),
    log,
    ...(options.limit !== undefined && { limit: options.limit }),
  });
  const throwing: SchedulerObserver = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('observer bug');
      },
    },
  );
  const mode = options.observer ?? 'timeline';
  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector,
    cache,
    hash: sha256Hex,
    log,
    clock,
    quietMs: options.quietMs ?? 3000,
    cooldownMs: options.cooldownMs ?? 0,
    maxConcurrent: options.maxConcurrent ?? 0,
    ...(mode === 'timeline' && { observer: timeline }),
    ...(mode === 'throwing' && { observer: throwing }),
  });
  return { clock, detector, cache, lines, scheduler, timeline };
}

function snap(
  clock: FakeTimers,
  uri: string,
  text: string,
  version: number,
): FileSnapshot {
  return {
    workspaceId: W,
    fileUri: uri,
    languageId: 'java',
    version,
    content: `class X { ${SECRET} ${text} }`,
    trigger: 'edit',
    observedAt: clock.now(),
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const timingLines = (lines: readonly string[]): string[] =>
  lines.filter((l) => l.startsWith('timing '));

describe('RequestTimeline (card 15A US1)', () => {
  test('an edit, a 3 s quiet period and a 2 s call give one record and one line (US1-1)', async () => {
    const { clock, detector, lines, scheduler, timeline } = setup();
    const s = snap(clock, A, 'a', 4);
    scheduler.submit(s);
    clock.advance(3000);
    clock.advance(2000);
    detector.calls[0].resolve(ok(2));
    await settle();

    expect(timeline.records()).toEqual([
      {
        kind: 'request',
        n: 1,
        fileUri: A,
        sha8: sha256Hex(s.content).slice(0, 8),
        version: 4,
        detector: 'scripted@1',
        quietMs: 3000,
        cooldownMs: 0,
        inFlightMs: 0,
        lateMs: 0,
        slotMs: 0,
        detectorMs: 2000,
        outcome: 'done',
        findings: 2,
        delivery: 'n/a',
      },
    ]);
    expect(timingLines(lines)).toEqual([
      `timing #1 v4 scripted@1 wait quiet=3000 cooldown=0 inflight=0 late=0 slot=0 detector=2000 outcome=done findings=2 delivery=n/a ${A}`,
    ]);
  });

  test('splits a wait into quiet, cooldown and slot time (US1-2)', async () => {
    const { clock, detector, scheduler, timeline } = setup({
      quietMs: 1000,
      cooldownMs: 5000,
      maxConcurrent: 1,
    });
    scheduler.submit(snap(clock, A, 'a1', 1)); // t=0
    clock.advance(1000); // A starts
    detector.calls[0].resolve(ok(0)); // A settles at 1 s: cooldown until 6 s
    await settle();
    clock.advance(1000); // t=2 s
    scheduler.submit(snap(clock, A, 'a2', 2)); // quiet until 3 s, cooldown until 6 s
    clock.advance(2000); // t=4 s
    scheduler.submit(snap(clock, B, 'b', 1)); // quiet until 5 s
    clock.advance(1000); // t=5 s: B starts and holds the only slot
    clock.advance(1000); // t=6 s: A is due, but waits for the slot
    clock.advance(2000); // t=8 s
    detector.calls[1].resolve(ok(0)); // B settles: A starts
    await settle();
    clock.advance(1000); // t=9 s
    detector.calls[2].resolve(ok(1));
    await settle();

    const a2 = timeline.records().find((r) => r.version === 2);
    expect(a2).toMatchObject({
      fileUri: A,
      quietMs: 1000,
      cooldownMs: 3000,
      inFlightMs: 0,
      lateMs: 0,
      slotMs: 2000,
      detectorMs: 1000,
      outcome: 'done',
    });
  });

  test('a cache hit is recorded as a hit with no detector time, and is not a request (US1-3)', async () => {
    const { clock, cache, lines, scheduler, timeline } = setup();
    const s = snap(clock, A, 'cached', 1);
    await cache.store(
      {
        workspaceId: W,
        fileUri: A,
        contentHash: sha256Hex(s.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(3),
    );
    scheduler.submit(s);
    clock.advance(3000);
    await settle();

    expect(timeline.records()).toEqual([
      expect.objectContaining({
        kind: 'hit',
        detectorMs: 0,
        slotMs: 0,
        quietMs: 3000,
        outcome: 'hit',
        findings: 3,
      }),
    ]);
    expect(timeline.records()[0].n).toBeUndefined();
    expect(scheduler.stats().started).toBe(0);
    expect(timingLines(lines)).toEqual([
      `timing hit v1 scripted@1 wait quiet=3000 cooldown=0 inflight=0 late=0 slot=0 detector=0 outcome=hit findings=3 delivery=n/a ${A}`,
    ]);
  });

  test.each([
    [
      'failed',
      { ok: false, failure: { kind: 'failed', message: 'boom' } },
      'outcome=failed',
    ],
    ['timeout', { ok: false, failure: { kind: 'timeout' } }, 'outcome=timeout'],
    [
      'cancelled',
      { ok: false, failure: { kind: 'cancelled' } },
      'outcome=cancelled',
    ],
    [
      'skipped',
      { ok: false, failure: { kind: 'skipped', reason: 'syntax-errors' } },
      'outcome=skipped:syntax-errors',
    ],
  ] as const)(
    'records a %s outcome with its kind (US1-4)',
    async (kind, result, logged) => {
      const { clock, detector, lines, scheduler, timeline } = setup();
      scheduler.submit(snap(clock, A, 'a', 1));
      clock.advance(3000);
      clock.advance(500);
      detector.calls[0].resolve(result);
      await settle();

      expect(timeline.records()[0]).toMatchObject({
        outcome: kind,
        detectorMs: 500,
      });
      expect(timeline.records()[0].findings).toBeUndefined();
      expect(timingLines(lines)[0]).toContain(` ${logged} `);
    },
  );

  test('keeps only the most recent records', async () => {
    const { clock, detector, scheduler, timeline } = setup({
      quietMs: 0,
      limit: 3,
    });
    for (let v = 1; v <= 5; v++) {
      scheduler.submit(snap(clock, A, `v${v}`, v));
      detector.calls[v - 1].resolve(ok(0));
      await settle();
    }

    expect(timeline.records().map((r) => r.version)).toEqual([3, 4, 5]);
  });

  test('never logs or records file text', async () => {
    const { clock, detector, lines, scheduler, timeline } = setup();
    scheduler.submit(snap(clock, A, 'a', 1));
    clock.advance(3000);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(lines.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(timeline.records())).not.toContain(SECRET);
  });

  test('formats a skipped reason and rounds durations to whole milliseconds', () => {
    expect(
      formatTiming({
        kind: 'request',
        n: 7,
        fileUri: A,
        sha8: 'abcdef12',
        version: 3,
        detector: 'technicalcredit@claude:fp-1',
        quietMs: 3000,
        cooldownMs: 0,
        inFlightMs: 0,
        lateMs: 0,
        slotMs: 0.4,
        detectorMs: 12_345.6,
        outcome: 'skipped',
        skipReason: 'live-disabled',
        delivery: 'n/a',
      }),
    ).toBe(
      `timing #7 v3 technicalcredit@claude:fp-1 wait quiet=3000 cooldown=0 inflight=0 late=0 slot=0 detector=12346 outcome=skipped:live-disabled delivery=n/a ${A}`,
    );
  });
});

describe('the timeline only observes (FR-004, SC-002)', () => {
  /** A script with edits, a hit, a cooldown, a slot wait and a failure. */
  async function run(observer: 'timeline' | 'none' | 'throwing') {
    const r = setup({
      quietMs: 1000,
      cooldownMs: 4000,
      maxConcurrent: 1,
      observer,
    });
    const { clock, detector, scheduler } = r;
    scheduler.submit(snap(clock, A, 'a1', 1));
    scheduler.submit(snap(clock, B, 'b1', 1));
    clock.advance(1000);
    detector.calls[0].resolve(ok(1));
    await settle();
    detector.calls[1].resolve({
      ok: false,
      failure: { kind: 'failed', message: 'boom' },
    });
    await settle();
    clock.advance(500);
    scheduler.submit(snap(clock, A, 'a2', 2));
    clock.advance(800);
    scheduler.submit(snap(clock, A, 'a1', 3)); // back to cached content
    clock.advance(6000);
    await settle();
    scheduler.submit(snap(clock, B, 'b2', 2));
    clock.advance(6000);
    detector.calls[2].resolve(ok(0));
    await settle();
    return r;
  }

  test('decisions, counts and calls are identical with a timeline, with none, and with a throwing observer', async () => {
    const plain = await run('none');
    const timed = await run('timeline');
    const throwing = await run('throwing');

    for (const other of [timed, throwing]) {
      expect(other.lines.filter((l) => !l.startsWith('timing '))).toEqual(
        plain.lines,
      );
      expect(other.scheduler.stats()).toEqual(plain.scheduler.stats());
      expect(other.cache.stats()).toEqual(plain.cache.stats());
      expect(other.detector.calls.map((c) => c.input)).toEqual(
        plain.detector.calls.map((c) => c.input),
      );
    }
    expect(timingLines(timed.lines).length).toBeGreaterThan(0);
    expect(timingLines(throwing.lines)).toEqual([]);
  });
});
