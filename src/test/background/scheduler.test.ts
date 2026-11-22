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
import {
  Scheduler,
  type SettledRequest,
} from '@/background/scheduler/scheduler';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

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
