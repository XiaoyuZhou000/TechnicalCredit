import * as fs from 'fs';
import * as path from 'path';

import {
  ResultCache,
  sha256Hex,
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
} from '@/background/events/fileEvents';
import { MockDetector } from '@/background/detector/mockDetector';
import {
  Scheduler,
  type SettledRequest,
} from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
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
}

function setup(options: SetupOptions = {}) {
  const detector = options.detector ?? new ScriptedDetector();
  const store = options.store ?? createMemoryCacheStore();
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
    now: () => 0,
    onSettled:
      options.onSettled ??
      ((event) => {
        events.push(event);
      }),
  });
  return { scheduler, detector, store, cache, lines, order, events };
}

function scripted() {
  const detector = new ScriptedDetector();
  return { ...setup({ detector }), detector };
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

  it('logs a miss, runs the mock, stores, then hits (SC-001)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const { scheduler, order } = setup({ detector: mock });

    scheduler.submit(positive());
    timers.advance(2000);
    await settle();
    scheduler.submit(positive({ version: 2, trigger: 'activate' }));

    expect(order).toEqual([
      `inner submit ${URI}`,
      `${T0} cache miss (absent) v1 sha ${P8} mock@mock-1 ${URI}`,
      `${T0} mock start #1 v1 ${URI}`,
      `${T0} mock done 6 findings #1 v1 ${URI}`,
      `${T0} cache stored 6 findings v1 sha ${P8} mock@mock-1 ${URI}`,
      `${T0} result current #1 v1 ${URI}`,
      `inner submit ${URI}`,
      `${T0} cache hit 6 findings v2 sha ${P8} mock@mock-1 ${URI}`,
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

  it('never stores a failed call, so the next submit misses again (SC-005)', async () => {
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
    scheduler.submit(positive({ version: 2 }));

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
