import * as fs from 'fs';
import * as path from 'path';

import {
  ResultCache,
  sha256Hex,
  type CacheIdentity,
  type CacheStore,
} from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type {
  FileSnapshot,
  SnapshotSink,
  TriggerKind,
} from '@/background/events/fileEvents';
import { MockDetector } from '@/background/detector/mockDetector';
import {
  Scheduler,
  type SettledRequest,
} from '@/background/scheduler/scheduler';
import {
  createFakeTimers,
  type FakeTimers,
} from '@/test/background/fakeTimers';
import {
  createMemoryCacheStore,
  rejectingUpdateStore,
} from '@/test/background/memoryCacheStore';

/** Offline tests for card 08's scheduler: no `vscode`, no live client. */

const T0 = '1970-01-01T00:00:00.000Z';
const W = 'file:///w';
const A_URI = 'file:///w/A.java';
const SECRET = 'SECRET_BODY_08';

function snapshot(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
  return {
    workspaceId: W,
    fileUri: A_URI,
    languageId: 'java',
    version: 1,
    content: `class A { ${SECRET} }`,
    trigger: 'edit',
    observedAt: 0,
    ...overrides,
  };
}

/** A snapshot of `A_URI` whose content is `class A { <text> }`. */
function rev(text: string, version: number): FileSnapshot {
  return snapshot({ version, content: `class A { ${SECRET} ${text} }` });
}

const sha8 = (s: FileSnapshot): string => sha256Hex(s.content).slice(0, 8);

interface Call {
  readonly input: DetectorInput;
  readonly signal: AbortSignal;
  resolve(result: DetectorResult): void;
}

/** The controlled async mock: resolves only when the test says so, or once aborted. */
class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  readonly calls: Call[] = [];

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return new Promise((resolve) => {
      this.calls.push({ input, signal, resolve });
      signal.addEventListener(
        'abort',
        () => resolve(failureFromAbort(signal)),
        { once: true },
      );
    });
  }

  get outstanding(): number {
    return this.calls.length;
  }
}

class RejectingDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  callCount = 0;

  analyse(): Promise<DetectorResult> {
    this.callCount++;
    return Promise.reject(new Error('boom'));
  }
}

class ThrowingDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  callCount = 0;

  analyse(): Promise<DetectorResult> {
    this.callCount++;
    throw new Error('sync boom');
  }
}

/** A `ScriptedDetector` whose version can change between submits, as a detector update would. */
class VersionedDetector implements Detector {
  readonly id = 'scripted';
  version = '1';
  private readonly inner = new ScriptedDetector();

  get calls(): Call[] {
    return this.inner.calls;
  }

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return this.inner.analyse(input, signal);
  }
}

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
          signals: ['finding-signal'],
          not_tc_reason: null,
        },
      })),
    },
  };
}

function fail(kind: 'failed' | 'cancelled' | 'timeout'): DetectorResult {
  return kind === 'failed'
    ? { ok: false, failure: { kind, message: 'nope' } }
    : { ok: false, failure: { kind } };
}

/** Lets every pending promise chain run, however many turns it takes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface SetupOptions {
  readonly detector?: Detector;
  readonly store?: CacheStore;
  readonly onSettled?: (event: SettledRequest) => void;
  readonly clock?: FakeTimers;
  /** Defaults to 0, so card 08 and 05 tests keep their immediate starts (card 06 FR-010). */
  readonly quietMs?: number;
  /** Defaults to 0, so earlier cards' tests keep their timing (card 07 FR-011). */
  readonly cooldownMs?: number;
}

function setup(options: SetupOptions = {}) {
  const detector = options.detector ?? new ScriptedDetector();
  const store = options.store ?? createMemoryCacheStore();
  const clock = options.clock ?? createFakeTimers();
  const order: string[] = [];
  const lines: string[] = [];
  const events: SettledRequest[] = [];
  const inner: SnapshotSink = {
    submit: (s) => order.push(`inner submit ${s.fileUri}`),
    closed: (n) => order.push(`inner closed ${n.fileUri}`),
  };
  const cache = new ResultCache({ store, now: () => 0 });
  const scheduler = new Scheduler({
    inner,
    detector,
    cache,
    hash: sha256Hex,
    log: (line) => {
      lines.push(line);
      order.push(line);
    },
    clock,
    quietMs: options.quietMs ?? 0,
    cooldownMs: options.cooldownMs ?? 0,
    onSettled:
      options.onSettled ??
      ((event) => {
        events.push(event);
      }),
  });
  return { scheduler, detector, store, cache, lines, order, events, clock };
}

function scripted() {
  const detector = new ScriptedDetector();
  return { ...setup({ detector }), detector };
}

const TRIGGERS: readonly TriggerKind[] = [
  'open',
  'activate',
  'save',
  'startup',
  'edit',
];

/** Submits `count` reports of `base`'s content, cycling through every trigger, each 1 ms later. */
function repeatBurst(
  sink: SnapshotSink,
  base: FileSnapshot,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    sink.submit({
      ...base,
      trigger: TRIGGERS[i % TRIGGERS.length],
      observedAt: base.observedAt + i + 1,
    });
  }
}

describe('scheduler basics', () => {
  it('forwards to the inner sink first and starts with empty state', () => {
    const { scheduler, order } = scripted();

    expect(scheduler.fileState(W, A_URI)).toBeUndefined();
    expect(scheduler.stats()).toEqual({
      started: 0,
      followUps: 0,
      duplicates: 0,
      pendingHeld: 0,
      pendingReplaced: 0,
      pendingCleared: 0,
      pendingDropped: 0,
    });
    expect(Object.isFrozen(scheduler.stats())).toBe(true);

    scheduler.submit(snapshot());

    expect(order[0]).toBe(`inner submit ${A_URI}`);
  });
});

describe('one active request per file (US1)', () => {
  it('starts exactly one call on a miss, inside submit (US1-1)', () => {
    const { scheduler, detector, lines } = scripted();
    const s = snapshot();

    scheduler.submit(s);

    expect(detector.outstanding).toBe(1);
    expect(detector.calls[0].input).toEqual({
      workspaceId: W,
      fileUri: A_URI,
      languageId: 'java',
      version: 1,
      contentHash: sha256Hex(s.content),
      content: s.content,
    });
    expect(lines).toEqual([
      `${T0} cache miss (absent) v1 sha ${sha8(s)} scripted@1 ${A_URI}`,
      `${T0} scripted start #1 v1 ${A_URI}`,
    ]);
    expect(scheduler.fileState(W, A_URI)?.active?.contentHash).toBe(
      sha256Hex(s.content),
    );
  });

  it('makes no call on a cache hit (US1-2)', async () => {
    const { scheduler, detector, cache, lines } = scripted();
    const s = snapshot();
    await cache.store(
      {
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(s.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(2),
    );

    scheduler.submit(s);

    expect(detector.outstanding).toBe(0);
    expect(lines).toEqual([
      `${T0} cache hit 2 findings v1 sha ${sha8(s)} scripted@1 ${A_URI}`,
    ]);
    expect(scheduler.stats().started).toBe(0);
  });

  it('never starts or aborts while a request is active (US1-3)', async () => {
    const { scheduler, detector } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.submit(rev('b', 2));
    scheduler.submit(rev('c', 3));
    await settle();

    expect(detector.outstanding).toBe(1);
    expect(detector.calls[0].signal.aborted).toBe(false);
    expect(scheduler.fileState(W, A_URI)?.active?.contentHash).toBe(
      sha256Hex(a.content),
    );
  });

  it('runs different files, and the same path in two workspaces, independently (US1-4, US1-5)', () => {
    const { scheduler, detector } = scripted();

    scheduler.submit(snapshot());
    scheduler.submit(snapshot({ fileUri: 'file:///w/B.java' }));
    scheduler.submit(snapshot({ fileUri: 'file:///w/C.java' }));
    scheduler.submit(snapshot({ workspaceId: 'file:///other' }));

    expect(detector.outstanding).toBe(4);
    expect(detector.calls.map((c) => c.input.fileUri)).toEqual([
      A_URI,
      'file:///w/B.java',
      'file:///w/C.java',
      A_URI,
    ]);
  });

  it('stores a success and then releases the slot', async () => {
    const { scheduler, detector, cache, lines } = scripted();
    const s = snapshot();
    scheduler.submit(s);

    detector.calls[0].resolve(ok(2));
    await settle();

    expect(lines.slice(2, 4)).toEqual([
      `${T0} scripted done 2 findings #1 v1 ${A_URI}`,
      `${T0} cache stored 2 findings v1 sha ${sha8(s)} scripted@1 ${A_URI}`,
    ]);
    expect(cache.stats().stored).toBe(1);
    const state = scheduler.fileState(W, A_URI);
    expect(state?.active).toBeUndefined();
    expect(state?.lastSettledAt).toBe(0);
  });

  it.each([
    ['failed', fail('failed'), 'scripted failed: nope #1'],
    ['cancelled', fail('cancelled'), 'scripted cancelled #1'],
    ['timeout', fail('timeout'), 'scripted timeout #1'],
  ])(
    'never stores a %s result and still releases the slot (SC-006)',
    async (_kind, result, line) => {
      const { scheduler, detector, cache, lines } = scripted();
      scheduler.submit(rev('a', 1));

      detector.calls[0].resolve(result);
      await settle();

      expect(lines).toContain(`${T0} ${line} v1 ${A_URI}`);
      expect(cache.stats().stored).toBe(0);
      expect(scheduler.fileState(W, A_URI)?.active).toBeUndefined();

      scheduler.submit(rev('b', 2));
      expect(detector.outstanding).toBe(2);
    },
  );

  it.each([
    ['rejects', () => new RejectingDetector(), 'boom'],
    ['throws synchronously', () => new ThrowingDetector(), 'sync boom'],
  ])(
    'treats a detector that %s as a failure and releases the slot (SC-006)',
    async (_how, make, message) => {
      const detector = make();
      const { scheduler, cache, lines } = setup({ detector });

      expect(() => scheduler.submit(rev('a', 1))).not.toThrow();
      await settle();

      expect(lines).toContain(
        `${T0} scripted failed: ${message} #1 v1 ${A_URI}`,
      );
      expect(cache.stats().stored).toBe(0);
      expect(scheduler.fileState(W, A_URI)?.active).toBeUndefined();

      scheduler.submit(rev('b', 2));
      expect(detector.callCount).toBe(2);
    },
  );
});

/** A store whose writes finish only when the test calls `release`. */
function gatedStore() {
  const inner = createMemoryCacheStore();
  const gates: (() => void)[] = [];
  const store: CacheStore = {
    get: (key) => inner.get(key),
    update: (key, value) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          void inner.update(key, value).then(resolve);
        });
      }),
  };
  return {
    store,
    release(): void {
      gates.splice(0).forEach((open) => open());
    },
  };
}

describe('latest pending snapshot (US2)', () => {
  it('keeps only the newest different content, and runs it once after A is stored (US2-1, US2-4, US2-6)', async () => {
    const { scheduler, detector, lines } = scripted();
    const [a, b, c] = [rev('a', 1), rev('b', 2), rev('c', 3)];

    scheduler.submit(a);
    scheduler.submit(b);
    scheduler.submit(c);

    expect(lines.slice(2)).toEqual([
      `${T0} pending v2 sha ${sha8(b)} scripted@1 ${A_URI}`,
      `${T0} pending replaced v3 sha ${sha8(c)} scripted@1 ${A_URI}`,
    ]);
    expect(scheduler.fileState(W, A_URI)?.pending).toEqual({
      version: 3,
      contentHash: sha256Hex(c.content),
    });

    detector.calls[0].resolve(ok(1));
    await settle();

    const stored = lines.indexOf(
      `${T0} cache stored 1 findings v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    const missC = lines.indexOf(
      `${T0} cache miss (content changed) v3 sha ${sha8(c)} scripted@1 ${A_URI}`,
    );
    expect(stored).toBeGreaterThan(-1);
    expect(missC).toBeGreaterThan(stored);
    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(c.content));
    expect(scheduler.fileState(W, A_URI)?.pending).toBeUndefined();
    expect(scheduler.stats()).toMatchObject({
      started: 2,
      followUps: 1,
      pendingHeld: 1,
      pendingReplaced: 1,
    });
  });

  it('makes no call for pending content that is already cached (US2-5)', async () => {
    const { scheduler, detector, cache, lines } = scripted();
    const [a, c] = [rev('a', 1), rev('c', 2)];
    await cache.store(
      {
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(c.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(3),
    );
    // C misses on submit only because A arrived first; A's failure stores nothing, so C's entry
    // is still the file's latest one when C is rechecked.
    scheduler.submit(a);
    scheduler.submit(c);
    detector.calls[0].resolve(fail('cancelled'));
    await settle();

    expect(lines.at(-1)).toBe(
      `${T0} cache hit 3 findings v2 sha ${sha8(c)} scripted@1 ${A_URI}`,
    );
    expect(detector.outstanding).toBe(1);
    expect(scheduler.stats().followUps).toBe(0);
  });

  it('rechecks pending content after a successful store replaced its entry', async () => {
    const { scheduler, detector, cache, lines } = scripted();
    const [a, c] = [rev('a', 1), rev('c', 2)];
    await cache.store(
      {
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(c.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(3),
    );

    scheduler.submit(a);
    scheduler.submit(c);
    detector.calls[0].resolve(ok(1));
    await settle();

    // Card 04 keeps one entry per file and version, so A's store replaced C's.
    expect(lines.at(-1)).toBe(`${T0} scripted start #2 v2 ${A_URI}`);
    expect(detector.outstanding).toBe(2);
  });

  it('ignores repeated events for the running content (US2-2, SC-003)', async () => {
    const { scheduler, detector, lines } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    for (const trigger of [
      'open',
      'activate',
      'save',
      'edit',
      'startup',
    ] as const) {
      scheduler.submit({ ...a, trigger });
      scheduler.submit({ ...a, trigger, version: 2 });
    }

    expect(
      lines.filter((l) => l.includes('duplicate of running')),
    ).toHaveLength(10);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(1);
    expect(scheduler.stats().duplicates).toBe(10);
  });

  it('ignores a repeat of the pending content', () => {
    const { scheduler, lines } = scripted();
    const b = rev('b', 2);

    scheduler.submit(rev('a', 1));
    scheduler.submit(b);
    scheduler.submit({ ...b, trigger: 'save' });

    expect(lines.at(-1)).toBe(
      `${T0} duplicate of pending v2 sha ${sha8(b)} scripted@1 ${A_URI}`,
    );
  });

  it('clears pending when the file changes back to the running content (US2-3, SC-004)', async () => {
    const { scheduler, detector, lines } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.submit(rev('b', 2));
    scheduler.submit({ ...a, version: 3 });

    expect(lines.at(-1)).toBe(
      `${T0} pending cleared v3 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(scheduler.fileState(W, A_URI)?.pending).toBeUndefined();

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(1);
    expect(scheduler.stats().pendingCleared).toBe(1);
  });

  it('holds a snapshot that arrives while the result is being stored', async () => {
    const gated = gatedStore();
    const detector = new ScriptedDetector();
    const { scheduler, lines } = setup({ detector, store: gated.store });
    const b = rev('b', 2);

    scheduler.submit(rev('a', 1));
    detector.calls[0].resolve(ok(1));
    await settle();
    scheduler.submit(b);

    expect(lines.at(-1)).toBe(
      `${T0} pending v2 sha ${sha8(b)} scripted@1 ${A_URI}`,
    );
    expect(detector.outstanding).toBe(1);

    gated.release();
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.version).toBe(2);
  });

  it('runs the pending snapshot after a failure, but never retries the failure (US2-7, US2-8)', async () => {
    const { scheduler, detector, cache } = scripted();

    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('c', 2));
    detector.calls[0].resolve(fail('failed'));
    await settle();

    expect(cache.stats().stored).toBe(0);
    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.version).toBe(2);

    detector.calls[1].resolve(fail('failed'));
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(scheduler.fileState(W, A_URI)?.active).toBeUndefined();
  });

  it('releases the slot and runs pending work when the store fails', async () => {
    const detector = new ScriptedDetector();
    const { scheduler, lines } = setup({
      detector,
      store: rejectingUpdateStore('disk full'),
    });
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.submit(rev('c', 2));
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(lines).toContain(
      `${T0} cache store failed: disk full v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(detector.outstanding).toBe(2);
  });
});

describe('scheduler with the mock detector', () => {
  const POSITIVE = fs.readFileSync(
    path.join(__dirname, '../creational/prototype/Positive.java'),
    'utf8',
  );
  const URI = 'file:///w/Positive.java';
  const P8 = sha256Hex(POSITIVE).slice(0, 8);

  function positive(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
    return snapshot({
      fileUri: URI,
      version: 1,
      content: POSITIVE,
      ...overrides,
    });
  }

  it('logs a miss, runs the mock, stores, skips an unchanged report, then hits on reopen (SC-001)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const { scheduler, order } = setup({ detector: mock });

    scheduler.submit(positive());
    timers.advance(2000);
    await settle();
    scheduler.submit(positive({ version: 2, trigger: 'activate' }));
    scheduler.closed({ workspaceId: W, fileUri: URI, observedAt: 0 });
    scheduler.submit(positive({ version: 3, trigger: 'open' }));

    expect(order).toEqual([
      `inner submit ${URI}`,
      `${T0} cache miss (absent) v1 sha ${P8} mock@mock-1 ${URI}`,
      `${T0} mock start #1 v1 ${URI}`,
      `${T0} mock done 6 findings #1 v1 ${URI}`,
      `${T0} cache stored 6 findings v1 sha ${P8} mock@mock-1 ${URI}`,
      `${T0} result current #1 v1 ${URI}`,
      `inner submit ${URI}`,
      `${T0} unchanged v2 sha ${P8} mock@mock-1 ${URI}`,
      `inner closed ${URI}`,
      `inner submit ${URI}`,
      `${T0} cache hit 6 findings v3 sha ${P8} mock@mock-1 ${URI}`,
    ]);
    expect(mock.callCount).toBe(1);
  });

  it('makes one call when open and activate arrive together (SC-011)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const { scheduler, lines } = setup({ detector: mock });

    scheduler.submit(positive({ trigger: 'open' }));
    scheduler.submit(positive({ trigger: 'activate' }));
    timers.advance(2000);
    await settle();

    expect(mock.callCount).toBe(1);
    expect(mock.calls()[0].outcome).toEqual({ status: 'ok', findingCount: 6 });
    expect(lines).toContain(
      `${T0} duplicate of running v1 sha ${P8} mock@mock-1 ${URI}`,
    );
  });

  it('runs the latest edit once after the running call, never cancelling it', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const { scheduler } = setup({ detector: mock });

    scheduler.submit(positive());
    for (let v = 2; v <= 6; v++) {
      scheduler.submit(positive({ version: v, content: `${POSITIVE}//${v}` }));
    }
    timers.advance(2000);
    await settle();
    timers.advance(2000);
    await settle();

    expect(mock.calls().map((c) => [c.version, c.outcome.status])).toEqual([
      [1, 'ok'],
      [6, 'ok'],
    ]);
  });

  it('never stores a failed call, so a reopen misses again (SC-005)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({
      timers,
      version: 'mock-fail',
      behaviour: { kind: 'fail', message: 'nope' },
    });
    const store = createMemoryCacheStore();
    const { scheduler, lines } = setup({ detector: mock, store });

    scheduler.submit(positive());
    timers.advance(2000);
    await settle();
    // An unchanged report never retries a failure (card 05); a reopen is a first report.
    scheduler.closed({ workspaceId: W, fileUri: URI, observedAt: 0 });
    scheduler.submit(positive({ version: 2, trigger: 'open' }));

    expect(lines).toContain(`${T0} mock failed: nope #1 v1 ${URI}`);
    expect(lines.filter((l) => l.includes('cache stored'))).toEqual([]);
    expect(mock.callCount).toBe(2);
    expect(store.keys()).toEqual([]);
  });

  it('hits after a restart without calling the new detector (card 04 SC-002)', async () => {
    const store = createMemoryCacheStore();
    const timers = createFakeTimers();
    const first = setup({ detector: new MockDetector({ timers }), store });
    first.scheduler.submit(positive());
    timers.advance(2000);
    await settle();
    first.scheduler.dispose();

    const mock = new MockDetector({ timers });
    const second = setup({ detector: mock, store });
    second.scheduler.submit(positive({ trigger: 'startup' }));

    expect(second.lines).toEqual([
      `${T0} cache hit 6 findings v1 sha ${P8} mock@mock-1 ${URI}`,
    ]);
    expect(mock.callCount).toBe(0);
  });

  it('runs a new detector version once instead of reusing the old one (card 04 SC-004)', async () => {
    const store = createMemoryCacheStore();
    const timers = createFakeTimers();
    const first = setup({ detector: new MockDetector({ timers }), store });
    first.scheduler.submit(positive());
    timers.advance(2000);
    await settle();
    first.scheduler.dispose();

    const mock = new MockDetector({ version: 'mock-2', timers });
    const second = setup({ detector: mock, store });
    second.scheduler.submit(positive());
    timers.advance(2000);
    await settle();

    expect(second.lines).toEqual([
      `${T0} cache miss (absent) v1 sha ${P8} mock@mock-2 ${URI}`,
      `${T0} mock start #1 v1 ${URI}`,
      `${T0} mock done 6 findings #1 v1 ${URI}`,
      `${T0} cache stored 6 findings v1 sha ${P8} mock@mock-2 ${URI}`,
      `${T0} result current #1 v1 ${URI}`,
    ]);
    expect(mock.callCount).toBe(1);
  });
});

describe('current or stale results (US3)', () => {
  it('stores a result that settles after the file changed, but marks it stale (US3-1, SC-007)', async () => {
    const { scheduler, detector, lines, events, cache } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.submit(rev('c', 2));
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(lines).toContain(`${T0} result stale #1 v1 ${A_URI}`);
    expect(events[0]).toMatchObject({
      n: 1,
      version: 1,
      contentHash: sha256Hex(a.content),
      detectorId: 'scripted',
      detectorVersion: '1',
      stored: true,
      eligible: false,
    });
    expect(cache.stats().stored).toBe(1);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('marks a result current when nothing newer arrived (US3-2)', async () => {
    const { scheduler, detector, lines, events } = scripted();

    scheduler.submit(rev('a', 1));
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(lines.at(-1)).toBe(`${T0} result current #1 v1 ${A_URI}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stored: true, eligible: true });
  });

  it('marks it current again when the file changes back before it settles (US3-4)', async () => {
    const { scheduler, detector, events } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.submit(rev('c', 2));
    scheduler.submit({ ...a, version: 3 });
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(events[0].eligible).toBe(true);
    expect(detector.outstanding).toBe(1);
  });

  it('never stores or marks a failure as eligible (US3-3)', async () => {
    const { scheduler, detector, lines, events } = scripted();

    scheduler.submit(rev('a', 1));
    detector.calls[0].resolve(fail('timeout'));
    await settle();

    expect(events[0]).toMatchObject({ stored: false, eligible: false });
    expect(lines.some((l) => l.includes(' result '))).toBe(false);
  });

  it('keeps going when the settle listener throws', async () => {
    const detector = new ScriptedDetector();
    const { scheduler, lines } = setup({
      detector,
      onSettled: () => {
        throw new Error('listener broke');
      },
    });

    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('c', 2));
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(lines).toContain(`${T0} settle listener error: listener broke`);
    expect(detector.outstanding).toBe(2);
  });
});

describe('close and dispose (US4)', () => {
  const closeA = { workspaceId: W, fileUri: A_URI, observedAt: 0 };

  it('drops pending work on close and lets the active request finish (US4-1, US4-2, SC-008)', async () => {
    const { scheduler, detector, lines, events, cache, order } = scripted();
    const c = rev('c', 2);

    scheduler.submit(rev('a', 1));
    scheduler.submit(c);
    scheduler.closed(closeA);

    expect(order.slice(-2)).toEqual([
      `inner closed ${A_URI}`,
      `${T0} pending dropped (closed) v2 sha ${sha8(c)} scripted@1 ${A_URI}`,
    ]);
    expect(detector.calls[0].signal.aborted).toBe(false);

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(cache.stats().stored).toBe(1);
    expect(lines).toContain(`${T0} result stale #1 v1 ${A_URI}`);
    expect(events[0]).toMatchObject({ stored: true, eligible: false });
    expect(detector.outstanding).toBe(1);
    expect(scheduler.fileState(W, A_URI)).toBeUndefined();
    expect(scheduler.stats().pendingDropped).toBe(1);
  });

  it('holds new content from a reopen until the closed request settles (US4-3)', async () => {
    const { scheduler, detector } = scripted();
    const d = rev('d', 5);

    scheduler.submit(rev('a', 1));
    scheduler.closed(closeA);
    scheduler.submit({ ...d, trigger: 'open' });

    expect(detector.outstanding).toBe(1);
    expect(scheduler.fileState(W, A_URI)?.pending?.version).toBe(5);

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(d.content));
  });

  it('marks the result current when the file is reopened with the same content', async () => {
    const { scheduler, detector, lines, events } = scripted();
    const a = rev('a', 1);

    scheduler.submit(a);
    scheduler.closed(closeA);
    scheduler.submit({ ...a, trigger: 'open' });

    expect(lines.at(-1)).toContain('duplicate of running v1');

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(events[0].eligible).toBe(true);
    expect(scheduler.fileState(W, A_URI)?.open).toBe(true);
  });

  it('forgets an idle file on close, and ignores unknown files', async () => {
    const { scheduler, detector, order } = scripted();
    scheduler.submit(rev('a', 1));
    detector.calls[0].resolve(ok(1));
    await settle();

    scheduler.closed(closeA);
    expect(scheduler.fileState(W, A_URI)).toBeUndefined();

    const before = order.length;
    expect(() =>
      scheduler.closed({ ...closeA, fileUri: 'file:///w/Unknown.java' }),
    ).not.toThrow();
    expect(order.slice(before)).toEqual([
      'inner closed file:///w/Unknown.java',
    ]);
  });

  it('aborts everything on dispose and starts nothing afterwards (US4-4, US4-5, SC-008)', async () => {
    const { scheduler, detector, order, cache, events } = scripted();
    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('b', 2));
    scheduler.submit(snapshot({ fileUri: 'file:///w/B.java' }));
    scheduler.submit(
      snapshot({ fileUri: 'file:///w/B.java', version: 2, content: 'x' }),
    );
    const before = order.length;

    scheduler.dispose();

    expect(detector.calls.map((c) => c.signal.aborted)).toEqual([true, true]);
    scheduler.submit(rev('c', 3));
    scheduler.closed(closeA);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(order).toHaveLength(before);
    expect(cache.stats().stored).toBe(0);
    expect(events).toEqual([]);
    expect(scheduler.fileState(W, A_URI)).toBeUndefined();
  });

  it('stores and logs nothing when disposed during the store', async () => {
    const gated = gatedStore();
    const detector = new ScriptedDetector();
    const { scheduler, lines, events } = setup({
      detector,
      store: gated.store,
    });
    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('c', 2));
    detector.calls[0].resolve(ok(1));
    await settle();
    const before = lines.length;

    scheduler.dispose();
    gated.release();
    await settle();

    expect(lines).toHaveLength(before);
    expect(events).toEqual([]);
    expect(detector.outstanding).toBe(1);
  });
});

describe('inspection (US5)', () => {
  const B_URI = 'file:///w/B.java';
  const closeOf = (fileUri: string) => ({
    workspaceId: W,
    fileUri,
    observedAt: 0,
  });

  /** Every kind of decision line, across two files. */
  async function everyDecision() {
    const run = scripted();
    const { scheduler, detector } = run;
    const a = rev('a', 1);
    scheduler.submit(a); // miss, start #1
    scheduler.submit({ ...a, trigger: 'activate' }); // duplicate of running
    scheduler.submit(rev('b', 2)); // pending
    scheduler.submit(rev('b', 3)); // duplicate of pending
    scheduler.submit(rev('c', 4)); // pending replaced
    scheduler.submit({ ...a, version: 5 }); // pending cleared
    scheduler.submit(rev('d', 6)); // pending
    detector.calls[0].resolve(ok(1)); // stored, stale; follow-up for d (#2)
    await settle();
    scheduler.submit(snapshot({ fileUri: B_URI })); // miss, start #3
    scheduler.submit(snapshot({ fileUri: B_URI, version: 2, content: 'x' })); // pending
    scheduler.closed(closeOf(B_URI)); // pending dropped
    detector.calls[2].resolve(fail('failed')); // B failed
    detector.calls[1].resolve(ok(2)); // d stored, current
    await settle();
    scheduler.submit(rev('d', 7)); // unchanged
    scheduler.closed(closeOf(A_URI)); // idle, so A is forgotten
    scheduler.submit(rev('d', 8)); // reopen: cache hit
    return run;
  }

  it('counts every decision exactly (US5-3)', async () => {
    const { scheduler, detector } = await everyDecision();

    expect(scheduler.stats()).toEqual({
      started: 3,
      followUps: 1,
      duplicates: 3,
      pendingHeld: 3,
      pendingReplaced: 1,
      pendingCleared: 1,
      pendingDropped: 1,
    });
    expect(Object.isFrozen(scheduler.stats())).toBe(true);
    expect(detector.outstanding).toBe(3);
    expect(scheduler.fileState(W, B_URI)).toBeUndefined();
    expect(scheduler.fileState(W, A_URI)).toEqual({
      latestHash: sha256Hex(rev('d', 8).content),
      lastChangeAt: 0,
      open: true,
    });
  });

  it('writes every line in an agreed format (US5-1, US5-2)', async () => {
    const { lines } = await everyDecision();
    const time = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
    const uri = String.raw`file:///w/[AB]\.java`;
    const sfx = String.raw`v\d+ sha [0-9a-f]{8} scripted@1 ${uri}`;
    const req = String.raw`#\d+ v\d+ ${uri}`;
    const formats = [
      String.raw`cache hit \d+ findings ${sfx}`,
      String.raw`cache miss \((absent|unreadable|content changed|error: .+)\) ${sfx}`,
      String.raw`scripted start ${req}`,
      String.raw`scripted (done \d+ findings|failed: .+|cancelled|timeout) ${req}`,
      String.raw`cache stored \d+ findings ${sfx}`,
      String.raw`result (current|stale) ${req}`,
      String.raw`pending ${sfx}`,
      String.raw`pending replaced ${sfx}`,
      String.raw`duplicate of (running|pending) ${sfx}`,
      String.raw`unchanged ${sfx}`,
      String.raw`pending cleared ${sfx}`,
      String.raw`pending dropped \(closed\) ${sfx}`,
    ].map((f) => new RegExp(`^${time} ${f}$`));

    expect(lines.filter((l) => !formats.some((f) => f.test(l)))).toEqual([]);
    expect(
      formats.filter((f) => !lines.some((l) => f.test(l))).map(String),
    ).toEqual([]);
  });

  it('never logs file text or findings (SC-010)', async () => {
    const { lines } = await everyDecision();
    const all = lines.join('\n');

    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('finding-signal');
  });

  it('keeps its invariants through a long seeded sequence (SC-001)', async () => {
    const { scheduler, detector } = scripted();
    const uris = [A_URI, B_URI, 'file:///w/C.java'];
    const resolved = new Set<number>();
    let seed = 8;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let version = 0;

    for (let step = 0; step < 200; step++) {
      const fileUri = uris[random(uris.length)];
      const action = random(10);
      if (action < 6) {
        const s = snapshot({
          fileUri,
          version: ++version,
          content: `v${random(3)}`,
        });
        scheduler.submit(s);
        // A save straight after is always a repeat: only the counter may change (card 05).
        const state = scheduler.fileState(W, fileUri);
        const calls = detector.calls.length;
        const duplicates = scheduler.stats().duplicates;
        scheduler.submit({ ...s, trigger: 'save', observedAt: 1 });
        expect(scheduler.fileState(W, fileUri)).toEqual(state);
        expect(detector.calls).toHaveLength(calls);
        expect(scheduler.stats().duplicates).toBe(duplicates + 1);
      } else if (action < 9) {
        const index = detector.calls.findIndex(
          (c, i) => c.input.fileUri === fileUri && !resolved.has(i),
        );
        if (index >= 0) {
          resolved.add(index);
          detector.calls[index].resolve(
            random(4) === 0 ? fail('failed') : ok(1),
          );
        }
      } else {
        scheduler.closed(closeOf(fileUri));
      }
      if (random(2) === 0) {
        await settle();
      }

      for (const uri of uris) {
        const unresolved = detector.calls.filter(
          (c, i) => c.input.fileUri === uri && !resolved.has(i),
        );
        expect(unresolved.length).toBeLessThanOrEqual(1);
        const state = scheduler.fileState(W, uri);
        if (state?.pending !== undefined) {
          expect(state.active).toBeDefined();
          expect(state.pending.contentHash).not.toBe(state.active?.contentHash);
        }
      }
    }
    expect(scheduler.stats().started).toBeGreaterThan(10);
  });
});

describe('event coalescing (card 05)', () => {
  const unchanged = (s: FileSnapshot): string =>
    `${T0} unchanged v${s.version} sha ${sha8(s)} scripted@1 ${s.fileUri}`;

  it('makes no lookup or call for 50 unchanged reports on an idle file (SC-001, US1-1)', async () => {
    const { scheduler, detector, lines } = scripted();
    const a = rev('a', 1);
    scheduler.submit(a);
    detector.calls[0].resolve(ok(1));
    await settle();
    const before = lines.length;

    repeatBurst(scheduler, a, 50);

    expect(lines.slice(before)).toEqual(Array(50).fill(unchanged(a)));
    expect(detector.outstanding).toBe(1);
    expect(scheduler.stats().duplicates).toBe(50);
    expect(scheduler.fileState(W, A_URI)).toMatchObject({
      latestHash: sha256Hex(a.content),
      lastChangeAt: 0,
    });
    expect(scheduler.fileState(W, A_URI)?.pending).toBeUndefined();
  });

  it('looks up a cached file once, not on every unchanged report (SC-001)', async () => {
    const { scheduler, detector, cache, lines } = scripted();
    const a = rev('a', 1);
    await cache.store(
      {
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(a.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(2),
    );

    scheduler.submit({ ...a, trigger: 'startup' });
    repeatBurst(scheduler, a, 5);

    expect(lines.filter((l) => l.includes(' cache '))).toHaveLength(1);
    expect(detector.outstanding).toBe(0);
  });

  it.each([
    ['failed analysis', undefined, fail('failed')],
    ['failed store', rejectingUpdateStore('disk full'), ok(1)],
  ])(
    'never retries after a %s on unchanged saves or activates (SC-003, US1-2)',
    async (_what, store, result) => {
      const detector = new ScriptedDetector();
      const { scheduler } = setup({ detector, store });
      const a = rev('a', 1);
      scheduler.submit(a);
      detector.calls[0].resolve(result);
      await settle();

      for (const trigger of ['save', 'activate', 'save'] as const) {
        scheduler.submit({ ...a, trigger });
      }

      expect(detector.outstanding).toBe(1);
    },
  );

  it('ignores a burst of the running content and never aborts it (US1-4)', () => {
    const { scheduler, detector, lines } = scripted();
    const a = rev('a', 1);
    scheduler.submit(a);
    const before = lines.length;

    repeatBurst(scheduler, a, 10);

    expect(lines.slice(before)).toEqual(
      Array(10).fill(
        `${T0} duplicate of running v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
      ),
    );
    expect(detector.outstanding).toBe(1);
    expect(detector.calls[0].signal.aborted).toBe(false);
    expect(scheduler.fileState(W, A_URI)?.pending).toBeUndefined();
  });

  it('leaves pending work and its change time alone on unchanged saves (SC-004, US1-3)', () => {
    const { scheduler } = scripted();
    scheduler.submit(rev('a', 1));
    const c = { ...rev('c', 2), observedAt: 100 };
    scheduler.submit(c);
    const pending = scheduler.fileState(W, A_URI)?.pending;

    scheduler.submit({ ...c, trigger: 'save', observedAt: 200 });
    scheduler.submit({ ...c, trigger: 'save', observedAt: 300 });

    const state = scheduler.fileState(W, A_URI);
    expect(state?.pending).toEqual(pending);
    expect(state?.lastChangeAt).toBe(100);
  });

  it('treats unchanged content as new work once the detector version changes (research R9)', async () => {
    const detector = new VersionedDetector();
    const { scheduler, lines } = setup({ detector });
    const a = rev('a', 1);
    scheduler.submit(a);
    detector.calls[0].resolve(ok(1));
    await settle();

    detector.version = '2';
    scheduler.submit({ ...a, trigger: 'activate' });
    scheduler.submit({ ...a, trigger: 'save' });

    expect(lines).toContain(
      `${T0} cache miss (absent) v1 sha ${sha8(a)} scripted@2 ${A_URI}`,
    );
    expect(detector.calls).toHaveLength(2);
  });
});

describe('event coalescing: newest unstarted content (card 05 US2)', () => {
  const B_URI = 'file:///w/B.java';

  it('keeps one pending snapshot, the newest, and runs only it after A (SC-002, US2-1)', async () => {
    const { scheduler, detector } = scripted();
    const c = rev('c', 3);

    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('b', 2));
    scheduler.submit(c);

    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.fileState(W, A_URI)?.pending?.contentHash).toBe(
      sha256Hex(c.content),
    );

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(c.content));
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('makes no second call when the newest pending content is already cached (SC-002)', async () => {
    const { scheduler, detector, cache } = scripted();
    const c = rev('c', 3);
    await cache.store(
      {
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(c.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      },
      ok(1),
    );

    scheduler.submit(rev('a', 1));
    scheduler.submit(rev('b', 2));
    scheduler.submit(c);
    // A fails, so nothing is stored: storing A would replace C's entry (one entry per file, the
    // open stale-result cache eviction decision).
    detector.calls[0].resolve(fail('failed'));
    await settle();

    expect(detector.outstanding).toBe(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('keeps pending on a repeat of it, and clears it on a change back to the running content (US2-2, US2-3)', () => {
    const { scheduler, detector } = scripted();
    const a = rev('a', 1);
    const c = { ...rev('c', 2), observedAt: 10 };
    scheduler.submit(a);
    scheduler.submit(c);
    const before = scheduler.fileState(W, A_URI);

    scheduler.submit({ ...c, version: 3, trigger: 'activate', observedAt: 20 });

    expect(scheduler.fileState(W, A_URI)).toEqual(before);

    scheduler.submit({ ...a, version: 4, observedAt: 30 });

    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.fileState(W, A_URI)).toMatchObject({ lastChangeAt: 30 });
    expect(scheduler.fileState(W, A_URI)?.pending).toBeUndefined();
    expect(detector.outstanding).toBe(1);
  });

  it('coalesces each file on its own (US2-4)', () => {
    const { scheduler, detector } = scripted();
    const a = rev('a', 1);
    const b = snapshot({ fileUri: B_URI, content: 'class B { b }' });

    scheduler.submit(a);
    scheduler.submit(b);
    for (let v = 2; v <= 4; v++) {
      scheduler.submit(rev(`a${v}`, v));
      scheduler.submit({ ...b, version: v, content: `class B { b${v} }` });
    }
    repeatBurst(scheduler, rev('a4', 4), 3); // repeats of A's pending content

    expect(detector.outstanding).toBe(2);
    expect(scheduler.pendingCount()).toBe(2);
    expect(scheduler.fileState(W, B_URI)?.pending?.version).toBe(4);

    // B's repeats never suppress a first report of another file.
    repeatBurst(scheduler, { ...b, version: 4, content: 'class B { b4 }' }, 3);
    scheduler.submit(snapshot({ fileUri: 'file:///w/C.java' }));

    expect(detector.outstanding).toBe(3);
  });
});

describe('event coalescing: close and reopen (card 05 US3)', () => {
  const closeA = { workspaceId: W, fileUri: A_URI, observedAt: 0 };

  it('drops pending work on close so it never runs (SC-005, US3-1)', async () => {
    const { scheduler, detector, lines } = scripted();
    const c = rev('c', 2);
    scheduler.submit(rev('a', 1));
    scheduler.submit(c);

    scheduler.closed(closeA);

    expect(lines.at(-1)).toBe(
      `${T0} pending dropped (closed) v2 sha ${sha8(c)} scripted@1 ${A_URI}`,
    );
    expect(scheduler.pendingCount()).toBe(0);

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(1);
  });

  it('lets a request running at close finish, stores it, and marks it stale (US3-2)', async () => {
    const { scheduler, detector, cache, events } = scripted();
    scheduler.submit(rev('a', 1));

    scheduler.closed(closeA);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.calls[0].signal.aborted).toBe(false);
    expect(cache.stats().stored).toBe(1);
    expect(events[0]).toMatchObject({ stored: true, eligible: false });
  });

  it('treats a reopen of an idle file as a first report, not a repeat (US3-3)', async () => {
    const { scheduler, detector, lines } = scripted();
    const a = rev('a', 1);
    scheduler.submit(a);
    detector.calls[0].resolve(ok(1));
    await settle();

    scheduler.closed(closeA);
    const before = lines.length;
    scheduler.submit({ ...a, trigger: 'open' });

    expect(lines.slice(before)).toEqual([
      `${T0} cache hit 1 findings v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    ]);
    expect(detector.outstanding).toBe(1);
  });

  it('retries a failed analysis on reopen, the trigger a repeat never is (US3-3, research R4)', async () => {
    const { scheduler, detector } = scripted();
    const a = rev('a', 1);
    scheduler.submit(a);
    detector.calls[0].resolve(fail('failed'));
    await settle();
    scheduler.submit({ ...a, trigger: 'save' });

    expect(detector.outstanding).toBe(1);

    scheduler.closed(closeA);
    scheduler.submit({ ...a, trigger: 'open' });

    expect(detector.outstanding).toBe(2);
  });
});

describe('event coalescing: inspection (card 05 US4)', () => {
  it('reports coalescing state and counts every decision exactly (US4-1, US4-2)', async () => {
    const { scheduler, detector } = scripted();
    const at = (s: FileSnapshot, observedAt: number): FileSnapshot => ({
      ...s,
      observedAt,
    });
    const [a, b, c] = [rev('a', 1), rev('b', 2), rev('c', 3)];

    scheduler.submit(at(a, 10)); // start #1
    scheduler.submit(at({ ...a, trigger: 'activate' }, 11)); // repeat (running)
    scheduler.submit(at(b, 20)); // held
    scheduler.submit(at(c, 30)); // replaced
    scheduler.submit(at({ ...c, trigger: 'save' }, 31)); // repeat (pending)

    expect(scheduler.fileState(W, A_URI)).toEqual({
      active: {
        n: 1,
        version: 1,
        contentHash: sha256Hex(a.content),
        detectorVersion: '1',
      },
      pending: { version: 3, contentHash: sha256Hex(c.content) },
      latestHash: sha256Hex(c.content),
      lastChangeAt: 30,
      eligibleAt: 30, // no quiet period in this suite (card 06)
      open: true,
    });

    scheduler.submit(at({ ...a, version: 4 }, 40)); // cleared
    detector.calls[0].resolve(ok(1));
    await settle();
    scheduler.submit(at({ ...a, version: 4, trigger: 'save' }, 41)); // repeat (idle)
    scheduler.submit(at(b, 50)); // start #2
    scheduler.submit(at(c, 60)); // held
    scheduler.closed({ workspaceId: W, fileUri: A_URI, observedAt: 70 }); // dropped

    expect(scheduler.stats()).toEqual({
      started: 2,
      followUps: 0,
      duplicates: 3,
      pendingHeld: 2,
      pendingReplaced: 1,
      pendingCleared: 1,
      pendingDropped: 1,
    });
    expect(scheduler.fileState(W, A_URI)).toMatchObject({
      latestHash: sha256Hex(c.content),
      lastChangeAt: 60,
      open: false,
    });
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe('debounce (card 06)', () => {
  const QUIET = 3000;
  const B_URI = 'file:///w/B.java';

  /** A scripted scheduler with the 3 s quiet period and one fake clock for every timestamp. */
  function debounced(store?: CacheStore) {
    const clock = createFakeTimers();
    const detector = new ScriptedDetector();
    // Pure debounce: card 07's cooldown is tested in its own block.
    const run = setup({
      detector,
      store,
      clock,
      quietMs: QUIET,
      cooldownMs: 0,
    });
    const at = (s: FileSnapshot): FileSnapshot => ({
      ...s,
      observedAt: clock.now(),
    });
    return { ...run, detector, clock, at };
  }

  function identity(s: FileSnapshot): CacheIdentity {
    return {
      workspaceId: s.workspaceId,
      fileUri: s.fileUri,
      contentHash: sha256Hex(s.content),
      detectorId: 'scripted',
      detectorVersion: '1',
    };
  }

  it('starts nothing while edits arrive every second, then one call 3 s after the last (SC-001, US1-1, US1-2, US1-3)', () => {
    const { scheduler, detector, clock, at } = debounced();
    let last = rev('e1', 1);
    scheduler.submit(at(last));
    for (let v = 2; v <= 10; v++) {
      clock.advance(1000);
      last = rev(`e${v}`, v);
      scheduler.submit(at(last));
    }

    expect(detector.outstanding).toBe(0);
    clock.advance(QUIET - 1);
    expect(detector.outstanding).toBe(0);
    clock.advance(1);

    expect(detector.outstanding).toBe(1);
    expect(detector.calls[0].input.contentHash).toBe(sha256Hex(last.content));
  });

  it('makes a first report wait too, then checks the cache (US1-4, SC-005)', async () => {
    const { scheduler, detector, clock, at, cache, lines } = debounced();
    const cached = rev('cached', 1);
    await cache.store(identity(cached), ok(1));

    scheduler.submit(at({ ...cached, trigger: 'open' }));
    scheduler.submit(at(snapshot({ fileUri: B_URI, trigger: 'startup' })));
    clock.advance(QUIET - 1);

    expect(lines.filter((l) => l.includes(' cache '))).toEqual([]);
    expect(detector.outstanding).toBe(0);

    clock.advance(1);

    expect(lines).toContain(
      `1970-01-01T00:00:03.000Z cache hit 1 findings v1 sha ${sha8(cached)} scripted@1 ${A_URI}`,
    );
    expect(detector.calls.map((c) => c.input.fileUri)).toEqual([B_URI]);
  });

  it('holds one wake-up per waiting file and none once dispatched or cached (SC-003)', async () => {
    const { scheduler, detector, clock, at, cache } = debounced();
    const b = snapshot({ fileUri: B_URI, content: 'class B {}' });
    await cache.store(identity(b), ok(1));

    scheduler.submit(at(rev('a1', 1)));
    clock.advance(500);
    scheduler.submit(at(rev('a2', 2)));
    scheduler.submit(at(b));

    expect(clock.pendingCount).toBe(2);
    expect(scheduler.pendingCount()).toBe(2);

    clock.advance(QUIET);

    expect(clock.pendingCount).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
    expect(detector.outstanding).toBe(1);
  });

  it('exposes when waiting work becomes eligible, and drops it once dispatched (FileStateView.eligibleAt)', () => {
    const { scheduler, clock, at } = debounced();

    scheduler.submit(at(rev('a1', 1)));
    expect(scheduler.fileState(W, A_URI)?.eligibleAt).toBe(QUIET);

    clock.advance(1000);
    scheduler.submit(at(rev('a2', 2)));
    expect(scheduler.fileState(W, A_URI)?.eligibleAt).toBe(1000 + QUIET);

    clock.advance(QUIET);
    expect(scheduler.fileState(W, A_URI)?.eligibleAt).toBeUndefined();
    expect(scheduler.fileState(W, A_URI)?.active).toBeDefined();
  });

  it('keeps the deadline through unchanged saves, Auto Saves, opens and activates (SC-002, US2-1)', () => {
    const { scheduler, detector, clock, at } = debounced();
    const a = rev('a', 1);
    scheduler.submit(at(a));
    for (const step of [1000, 1500]) {
      clock.advance(step); // T + 1000, then T + 2500
      for (const trigger of TRIGGERS) {
        scheduler.submit(at({ ...a, trigger }));
      }
    }

    expect(scheduler.fileState(W, A_URI)?.eligibleAt).toBe(QUIET);
    clock.advance(QUIET - 2500 - 1);
    expect(detector.outstanding).toBe(0);
    clock.advance(1);
    expect(detector.outstanding).toBe(1);
  });

  it('logs a repeat of waiting work as a duplicate and changes nothing (US2-2)', () => {
    const { scheduler, clock, at, lines } = debounced();
    const a = rev('a', 1);
    scheduler.submit(at(a));
    clock.advance(1000);
    const state = scheduler.fileState(W, A_URI);
    const timers = clock.pendingCount;

    scheduler.submit(at({ ...a, trigger: 'save' }));

    expect(lines.at(-1)).toBe(
      `1970-01-01T00:00:01.000Z duplicate of pending v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(scheduler.fileState(W, A_URI)).toEqual(state);
    expect(clock.pendingCount).toBe(timers);
  });

  it('starts nothing at a deadline passed while A runs, then C as soon as A settles (SC-004, US3-1, US3-2)', async () => {
    const { scheduler, detector, clock, at } = debounced();
    const c = rev('c', 2);
    scheduler.submit(at(rev('a', 1)));
    clock.advance(QUIET); // A starts
    scheduler.submit(at(c));

    expect(clock.pendingCount).toBe(1);
    clock.advance(QUIET + 500);
    expect(detector.outstanding).toBe(1);
    expect(clock.pendingCount).toBe(0);

    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(c.content));
    expect(detector.calls[0].signal.aborted).toBe(false);
  });

  it('lets C wait out its quiet period when A settles first (US3-3)', async () => {
    const { scheduler, detector, clock, at } = debounced();
    scheduler.submit(at(rev('a', 1)));
    clock.advance(QUIET); // A starts
    scheduler.submit(at(rev('c', 2))); // T
    clock.advance(1000);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.outstanding).toBe(1);
    expect(clock.pendingCount).toBe(1);
    clock.advance(QUIET - 1000 - 1); // T + 2999
    expect(detector.outstanding).toBe(1);
    clock.advance(1); // T + 3000
    expect(detector.outstanding).toBe(2);
  });

  it('moves the deadline again on a change after A settled (US3-3)', async () => {
    const { scheduler, detector, clock, at } = debounced();
    scheduler.submit(at(rev('a', 1)));
    clock.advance(QUIET); // A starts
    scheduler.submit(at(rev('c', 2))); // T
    clock.advance(1000);
    detector.calls[0].resolve(ok(1));
    await settle();
    clock.advance(1000);
    const d = at(rev('d', 3)); // T + 2000
    scheduler.submit(d);

    clock.advance(QUIET - 1); // T + 4999
    expect(detector.outstanding).toBe(1);
    clock.advance(1); // T + 5000
    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(d.content));
  });

  it('clears waiting work and its wake-up on a change back to the running content (US3-4)', async () => {
    const { scheduler, detector, clock, at, lines } = debounced();
    const a = rev('a', 1);
    scheduler.submit(at(a));
    clock.advance(QUIET); // A starts
    scheduler.submit(at(rev('c', 2)));
    clock.advance(500);

    scheduler.submit(at({ ...a, version: 3 }));

    expect(lines.at(-1)).toBe(
      `1970-01-01T00:00:03.500Z pending cleared v3 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(clock.pendingCount).toBe(0);

    detector.calls[0].resolve(ok(1));
    await settle();
    clock.advance(10_000);

    expect(detector.outstanding).toBe(1);
  });

  it('debounces each file on its own clock (US4-1)', () => {
    const { scheduler, detector, clock, at } = debounced();
    scheduler.submit(at(rev('a', 1))); // T
    clock.advance(2000);
    scheduler.submit(at(snapshot({ fileUri: B_URI, content: 'class B {}' })));

    expect(scheduler.fileState(W, A_URI)?.eligibleAt).toBe(QUIET);
    clock.advance(1000); // T + 3000
    expect(detector.calls.map((c) => c.input.fileUri)).toEqual([A_URI]);
    clock.advance(1999);
    expect(detector.outstanding).toBe(1);
    clock.advance(1); // T + 5000
    expect(detector.calls.map((c) => c.input.fileUri)).toEqual([A_URI, B_URI]);
  });

  it('drops waiting work and its wake-up on close (US4-2)', () => {
    const { scheduler, detector, clock, at, lines } = debounced();
    const a = rev('a', 1);
    scheduler.submit(at(a));
    scheduler.submit(at(snapshot({ fileUri: B_URI, content: 'class B {}' })));
    expect(clock.pendingCount).toBe(2);

    scheduler.closed({ workspaceId: W, fileUri: A_URI, observedAt: 0 });

    expect(lines.at(-1)).toBe(
      `${T0} pending dropped (closed) v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(clock.pendingCount).toBe(1);
    clock.advance(10_000);
    expect(detector.calls.map((c) => c.input.fileUri)).toEqual([B_URI]);
  });

  it('clears every wake-up on dispose and starts nothing afterwards (US4-3)', () => {
    const { scheduler, detector, clock, at } = debounced();
    scheduler.submit(at(rev('a', 1)));
    scheduler.submit(at(snapshot({ fileUri: B_URI, content: 'class B {}' })));

    scheduler.dispose();

    expect(clock.pendingCount).toBe(0);
    clock.advance(10_000);
    expect(detector.outstanding).toBe(0);
  });

  it('leaves no wake-up after dispatch, a cache hit, a drop, or only repeats (US4-4, SC-003)', async () => {
    const { scheduler, detector, clock, at, cache } = debounced();
    const C_URI = 'file:///w/C.java';
    const a = rev('a', 1);
    const b = snapshot({ fileUri: B_URI, content: 'class B {}' });
    await cache.store(identity(b), ok(1));
    scheduler.submit(at(a));
    scheduler.submit(at(b));
    scheduler.submit(at(snapshot({ fileUri: C_URI, content: 'class C {}' })));

    scheduler.closed({ workspaceId: W, fileUri: C_URI, observedAt: 0 });
    expect(clock.pendingCount).toBe(2);
    clock.advance(QUIET); // A dispatched, B a cache hit

    expect(clock.pendingCount).toBe(0);
    detector.calls[0].resolve(ok(1));
    await settle();
    repeatBurst(scheduler, at(a), 5);

    expect(clock.pendingCount).toBe(0);
    expect(detector.outstanding).toBe(1);
  });

  it('writes quiet-period lines in an agreed, metadata-only format (SC-007, US5-2)', async () => {
    const { scheduler, detector, clock, at, lines } = debounced();
    const a = rev('a', 1);
    scheduler.submit(at(a)); // quiet until 3 s
    clock.advance(1000);
    scheduler.submit(at(rev('b', 2))); // quiet until 4 s
    clock.advance(QUIET); // b starts
    scheduler.submit(at(rev('c', 3))); // quiet until 7 s, while b runs
    detector.calls[0].resolve(ok(1));
    await settle();
    clock.advance(QUIET);

    const time = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
    const format = new RegExp(
      String.raw`^${time} quiet until ${time} v\d+ sha [0-9a-f]{8} scripted@1 file:///w/A\.java$`,
    );
    const quiet = lines.filter((l) => l.includes(' quiet until '));

    expect(quiet).toHaveLength(3);
    expect(quiet.filter((l) => !format.test(l))).toEqual([]);
    expect(quiet[0]).toBe(
      `${T0} quiet until 1970-01-01T00:00:03.000Z v1 sha ${sha8(a)} scripted@1 ${A_URI}`,
    );
    expect(detector.outstanding).toBe(2);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('keeps its timer invariants through a long seeded sequence (US5)', async () => {
    const { scheduler, detector, clock, at } = debounced();
    const uris = [A_URI, B_URI, 'file:///w/C.java'];
    const resolved = new Set<number>();
    const last = new Map<string, FileSnapshot>();
    let seed = 6;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let version = 0;

    for (let step = 0; step < 300; step++) {
      const fileUri = uris[random(uris.length)];
      const action = random(10);
      const callsBefore = detector.calls.length;
      if (action < 4) {
        const s = at(
          snapshot({ fileUri, version: ++version, content: `v${random(3)}` }),
        );
        scheduler.submit(s);
        last.set(fileUri, s);
      } else if (action < 5) {
        const previous = last.get(fileUri);
        if (previous !== undefined) {
          const before = scheduler.fileState(W, fileUri);
          scheduler.submit(at({ ...previous, trigger: 'save' }));
          if (
            before?.open === true &&
            before.latestHash === sha256Hex(previous.content)
          ) {
            // A repeat: nothing may change, least of all the deadline.
            expect(scheduler.fileState(W, fileUri)).toEqual(before);
            expect(detector.calls).toHaveLength(callsBefore);
          }
        }
      } else if (action < 7) {
        const index = detector.calls.findIndex(
          (c, i) => c.input.fileUri === fileUri && !resolved.has(i),
        );
        if (index >= 0) {
          resolved.add(index);
          detector.calls[index].resolve(
            random(4) === 0 ? fail('failed') : ok(1),
          );
        }
      } else if (action < 9) {
        clock.advance(random(4001));
      } else {
        scheduler.closed({ workspaceId: W, fileUri, observedAt: clock.now() });
        last.delete(fileUri);
      }
      if (random(2) === 0) {
        await settle();
      }

      expect(clock.pendingCount).toBeLessThanOrEqual(scheduler.pendingCount());
      for (const call of detector.calls.slice(callsBefore)) {
        // Nothing starts inside a quiet period.
        const state = scheduler.fileState(W, call.input.fileUri);
        expect((state?.lastChangeAt ?? 0) + QUIET).toBeLessThanOrEqual(
          clock.now(),
        );
      }
      for (const uri of uris) {
        const unresolved = detector.calls.filter(
          (c, i) => c.input.fileUri === uri && !resolved.has(i),
        );
        expect(unresolved.length).toBeLessThanOrEqual(1);
        const state = scheduler.fileState(W, uri);
        if (state?.pending !== undefined && state.active === undefined) {
          expect(state.eligibleAt ?? 0).toBeGreaterThan(clock.now());
        }
      }
    }
    expect(detector.calls.length).toBeGreaterThan(10);
  });

  it.each([Infinity, NaN, -1, 2 ** 31])(
    'rejects a quiet period of %p, which no timer can wait for',
    (quietMs) => {
      expect(() => setup({ quietMs })).toThrow(RangeError);
    },
  );

  it.each([0, QUIET, 2 ** 31 - 1])(
    'accepts a quiet period of %p',
    (quietMs) => {
      expect(() => setup({ quietMs })).not.toThrow();
    },
  );

  it.each([Infinity, NaN, -1, 2 ** 31])(
    'rejects a cooldown of %p, which no timer can wait for (card 07 FR-012)',
    (cooldownMs) => {
      expect(() => setup({ cooldownMs })).toThrow(RangeError);
    },
  );

  it.each([0, 30_000, 2 ** 31 - 1])(
    'accepts a cooldown of %p',
    (cooldownMs) => {
      expect(() => setup({ cooldownMs })).not.toThrow();
    },
  );
});

describe('cooldown (card 07)', () => {
  const QUIET = 3000;
  const COOL = 30_000;

  /** A scripted scheduler with both deadlines on and one fake clock for every timestamp. */
  function cooled() {
    const clock = createFakeTimers();
    const detector = new ScriptedDetector();
    const run = setup({ detector, clock, quietMs: QUIET, cooldownMs: COOL });
    const at = (s: FileSnapshot): FileSnapshot => ({
      ...s,
      observedAt: clock.now(),
    });
    return { ...run, detector, clock, at };
  }

  /** Runs `a` through its quiet period and settles it; returns C, the completion time. */
  async function completeFirst(
    run: ReturnType<typeof cooled>,
    result: DetectorResult = ok(1),
  ): Promise<number> {
    run.scheduler.submit(run.at(rev('a', 1)));
    run.clock.advance(QUIET);
    run.detector.calls[0].resolve(result);
    await settle();
    return run.clock.now();
  }

  /** Advances the fake clock to absolute time `t`. */
  function until(run: ReturnType<typeof cooled>, t: number): void {
    run.clock.advance(t - run.clock.now());
  }

  it('starts nothing for 30 s after a completion, then the latest content once (SC-001, US1-1, US1-2)', async () => {
    const run = cooled();
    const { scheduler, detector, at } = run;
    const c = await completeFirst(run);
    until(run, c + 5000);
    const b = at(rev('b', 2));
    scheduler.submit(b);

    until(run, c + COOL - 1);
    expect(detector.outstanding).toBe(1);
    until(run, c + COOL);

    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(b.content));
  });

  it('runs only the newest of several paused edits, once, after the cooldown (US1-3)', async () => {
    const run = cooled();
    const { scheduler, detector, at } = run;
    const c = await completeFirst(run);
    let last = rev('none', 1);
    for (const t of [5000, 12_000, 20_000]) {
      until(run, c + t);
      last = at(rev(`e${t}`, t));
      scheduler.submit(last);
      run.clock.advance(3500); // a pause longer than the quiet period
    }

    expect(detector.outstanding).toBe(1);
    until(run, c + COOL);
    expect(detector.outstanding).toBe(2);
    expect(detector.calls[1].input.contentHash).toBe(sha256Hex(last.content));
    run.clock.advance(60_000);
    expect(detector.outstanding).toBe(2);
  });

  it('never retries a failure on repeats, however long they go on (SC-002, US2-1)', async () => {
    const run = cooled();
    const { scheduler, detector, at } = run;
    await completeFirst(run, fail('failed'));
    for (let i = 0; i < 12; i++) {
      run.clock.advance(5000);
      scheduler.submit(
        at({ ...rev('a', 1), trigger: i % 2 ? 'save' : 'activate' }),
      );
    }

    expect(detector.outstanding).toBe(1);
  });

  it.each(['failed', 'timeout', 'cancelled'] as const)(
    'cools down after a %s request like after a success (US2-2)',
    async (kind) => {
      const run = cooled();
      const { scheduler, detector, at } = run;
      const c = await completeFirst(run, fail(kind));
      until(run, c + 2000);
      scheduler.submit(at(rev('b', 2)));

      until(run, c + COOL - 1);
      expect(detector.outstanding).toBe(1);
      until(run, c + COOL);
      expect(detector.outstanding).toBe(2);
    },
  );
});
