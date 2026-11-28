import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import type {
  SchedulerObserver,
  TransitionSubject,
  WaitSplit,
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
 * Card 15A: the scheduler reports its transitions to an optional observer, for timing. The
 * observer only watches: it is told, never asked, and one that throws changes nothing.
 */

const W = 'file:///w';
const A = 'file:///w/A.java';
const B = 'file:///w/B.java';
const QUIET = 3000;
const COOLDOWN = 30_000;

const OK: DetectorResult = {
  ok: true,
  output: { detectorId: 'scripted', detectorVersion: '1', findings: [] },
};

/** Settles each call only when the test says so. */
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

type Event =
  | readonly ['changed', string]
  | readonly ['due', string, WaitSplit]
  | readonly ['cacheHit', string, WaitSplit, number]
  | readonly ['slotWait', string]
  | readonly ['started', string, number]
  | readonly ['settled', string, number, boolean];

function recorder(): { events: Event[]; observer: SchedulerObserver } {
  const events: Event[] = [];
  const name = (s: TransitionSubject): string =>
    `${s.fileUri.slice(-6)} v${s.version} ${s.detector}`;
  return {
    events,
    observer: {
      changed: (s) => events.push(['changed', name(s)]),
      due: (s, wait) => events.push(['due', name(s), wait]),
      cacheHit: (s, wait, findings) =>
        events.push(['cacheHit', name(s), wait, findings]),
      slotWait: (s) => events.push(['slotWait', name(s)]),
      started: (s, n) => events.push(['started', name(s), n]),
      settled: (s, n, result) =>
        events.push(['settled', name(s), n, result.ok]),
    },
  };
}

function setup(
  options: {
    quietMs?: number;
    cooldownMs?: number;
    maxConcurrent?: number;
    observer?: SchedulerObserver;
  } = {},
) {
  const clock = createFakeTimers();
  const detector = new ScriptedDetector();
  const cache = new ResultCache({
    store: createMemoryCacheStore(),
    now: () => clock.now(),
  });
  const lines: string[] = [];
  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector,
    cache,
    hash: sha256Hex,
    log: (line) => lines.push(line),
    clock,
    quietMs: options.quietMs ?? QUIET,
    cooldownMs: options.cooldownMs ?? COOLDOWN,
    maxConcurrent: options.maxConcurrent ?? 0,
    ...(options.observer !== undefined && { observer: options.observer }),
  });
  return { clock, detector, cache, lines, scheduler };
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
    content: `class X { ${text} }`,
    trigger: 'edit',
    observedAt: clock.now(),
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('the scheduler notifies an optional observer (card 15A)', () => {
  test('one edit: changed, due after the quiet period, started, settled', async () => {
    const { events, observer } = recorder();
    const { clock, detector, scheduler } = setup({ observer });

    scheduler.submit(snap(clock, A, 'a', 1));
    clock.advance(QUIET);
    detector.calls[0].resolve(OK);
    await settle();

    expect(events).toEqual([
      ['changed', 'A.java v1 scripted@1'],
      [
        'due',
        'A.java v1 scripted@1',
        { quietMs: QUIET, cooldownMs: 0, inFlightMs: 0 },
      ],
      ['started', 'A.java v1 scripted@1', 1],
      ['settled', 'A.java v1 scripted@1', 1, true],
    ]);
  });

  test('splits a wait into the quiet period and the cooldown that followed it', async () => {
    const { events, observer } = recorder();
    const { clock, detector, scheduler } = setup({ observer });
    scheduler.submit(snap(clock, A, 'a', 1));
    clock.advance(QUIET); // t=3 s: starts
    detector.calls[0].resolve(OK); // settles at t=3 s: cooldown until 33 s
    await settle();

    clock.advance(1000); // t=4 s
    scheduler.submit(snap(clock, A, 'b', 2)); // quiet until 7 s, cooldown until 33 s
    clock.advance(29_000); // t=33 s
    await settle();

    expect(events.find((e) => e[0] === 'due' && e[1].includes('v2'))).toEqual([
      'due',
      'A.java v2 scripted@1',
      { quietMs: QUIET, cooldownMs: 26_000, inFlightMs: 0 },
    ]);
  });

  test('counts the time behind the file’s own running request as in flight', async () => {
    const { events, observer } = recorder();
    const { clock, detector, scheduler } = setup({
      observer,
      quietMs: 0,
      cooldownMs: 0,
    });
    scheduler.submit(snap(clock, A, 'a', 1)); // starts at once
    scheduler.submit(snap(clock, A, 'b', 2)); // waits behind it
    clock.advance(5000);
    detector.calls[0].resolve(OK);
    await settle();

    expect(events.find((e) => e[0] === 'due' && e[1].includes('v2'))).toEqual([
      'due',
      'A.java v2 scripted@1',
      { quietMs: 0, cooldownMs: 0, inFlightMs: 5000 },
    ]);
    expect(events.filter((e) => e[0] === 'changed').map((e) => e[1])).toEqual([
      'A.java v1 scripted@1',
      'A.java v2 scripted@1',
    ]);
  });

  test('a cache hit is reported with its wait and finding count, and nothing starts', async () => {
    const { events, observer } = recorder();
    const { clock, cache, detector, scheduler } = setup({ observer });
    const s = snap(clock, A, 'cached', 1);
    await cache.store(
      {
        workspaceId: W,
        fileUri: A,
        contentHash: sha256Hex(s.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      OK,
    );

    scheduler.submit(s);
    clock.advance(QUIET);
    await settle();

    // Due work is looked up before any call; the hit answers it.
    expect(events).toEqual([
      ['changed', 'A.java v1 scripted@1'],
      [
        'due',
        'A.java v1 scripted@1',
        { quietMs: QUIET, cooldownMs: 0, inFlightMs: 0 },
      ],
      [
        'cacheHit',
        'A.java v1 scripted@1',
        { quietMs: QUIET, cooldownMs: 0, inFlightMs: 0 },
        0,
      ],
    ]);
    expect(detector.calls).toHaveLength(0);
  });

  test('due work that waits for a free slot reports the wait, then starts', async () => {
    const { events, observer } = recorder();
    const { clock, detector, scheduler } = setup({
      observer,
      quietMs: 0,
      cooldownMs: 0,
      maxConcurrent: 1,
    });
    scheduler.submit(snap(clock, A, 'a', 1));
    scheduler.submit(snap(clock, B, 'b', 1));
    expect(events.map((e) => e[0])).toEqual([
      'changed',
      'due',
      'started',
      'changed',
      'due',
      'slotWait',
    ]);

    detector.calls[0].resolve(OK);
    await settle();

    expect(events.slice(6).map((e) => [e[0], e[1]])).toEqual([
      ['settled', 'A.java v1 scripted@1'],
      ['started', 'B.java v1 scripted@1'],
    ]);
  });

  test('an observer that throws on every call changes nothing', async () => {
    const throwing: SchedulerObserver = {
      changed: () => {
        throw new Error('observer bug');
      },
      due: () => {
        throw new Error('observer bug');
      },
      cacheHit: () => {
        throw new Error('observer bug');
      },
      slotWait: () => {
        throw new Error('observer bug');
      },
      started: () => {
        throw new Error('observer bug');
      },
      settled: () => {
        throw new Error('observer bug');
      },
    };
    const plain = setup();
    const watched = setup({ observer: throwing });

    for (const run of [plain, watched]) {
      run.scheduler.submit(snap(run.clock, A, 'a', 1));
      run.clock.advance(QUIET);
      run.detector.calls[0].resolve(OK);
      await settle();
    }

    expect(watched.lines).toEqual(plain.lines);
    expect(watched.scheduler.stats()).toEqual(plain.scheduler.stats());
    expect(watched.lines.join('\n')).not.toContain('observer bug');
  });
});
