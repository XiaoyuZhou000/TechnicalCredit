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
} from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
import {
  createDeferredCacheStore,
  createMemoryCacheStore,
} from '@/test/background/memoryCacheStore';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/*
 * Card 16A through the real scheduler: a stale result settling after the file changed no longer
 * evicts the cached result of the content the file went back to (known issue 24), so going back
 * to already-analysed content costs no second detector call.
 */

const T0 = '1970-01-01T00:00:00.000Z';
const W = 'file:///w';
const A_URI = 'file:///w/A.java';
const SECRET = 'SECRET_BODY_16A';

function rev(text: string, version: number): FileSnapshot {
  return {
    workspaceId: W,
    fileUri: A_URI,
    languageId: 'java',
    version,
    content: `class A { ${SECRET} ${text} }`,
    trigger: 'edit',
    observedAt: 0,
  };
}

const sha8 = (s: FileSnapshot): string => sha256Hex(s.content).slice(0, 8);

function identityOf(s: FileSnapshot): CacheIdentity {
  return {
    workspaceId: W,
    fileUri: A_URI,
    contentHash: sha256Hex(s.content),
    detectorId: 'scripted',
    detectorVersion: '1',
  };
}

interface Call {
  readonly input: DetectorInput;
  resolve(result: DetectorResult): void;
}

/** Resolves only when the test says so, or once aborted. */
class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  readonly calls: Call[] = [];

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return new Promise((resolve) => {
      this.calls.push({ input, resolve });
      signal.addEventListener(
        'abort',
        () => resolve(failureFromAbort(signal)),
        { once: true },
      );
    });
  }

  /** The content each call analysed, in start order. */
  analysed(): string[] {
    return this.calls.map((c) => c.input.content);
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
          signals: ['s'],
          not_tc_reason: null,
        },
      })),
    },
  };
}

/** Lets every pending promise chain run, however many turns it takes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup(store: CacheStore = createMemoryCacheStore()) {
  const detector = new ScriptedDetector();
  const lines: string[] = [];
  const inner: SnapshotSink = { submit: () => {}, closed: () => {} };
  const cache = new ResultCache({ store, now: () => 0 });
  const scheduler = new Scheduler({
    inner,
    detector,
    cache,
    hash: sha256Hex,
    log: (line) => lines.push(line),
    clock: createFakeTimers(),
    quietMs: 0,
    cooldownMs: 0,
    maxConcurrent: 0,
  });
  return { scheduler, detector, cache, lines };
}

describe('US1: going back to earlier content reuses its result', () => {
  it('C cached, A runs, back to C: after A settles, C is a hit and no second call happens (US1-1, SC-001)', async () => {
    const { scheduler, detector, cache, lines } = setup();
    const [a, c] = [rev('a', 1), rev('c', 2)];
    await cache.store(identityOf(c), ok(3));

    scheduler.submit(a);
    scheduler.submit(c);
    detector.calls[0].resolve(ok(1));
    await settle();

    expect(detector.analysed()).toEqual([a.content]);
    const stale = lines.indexOf(`${T0} result stale #1 v1 ${A_URI}`);
    const hit = lines.indexOf(
      `${T0} cache hit 3 findings v2 sha ${sha8(c)} scripted@1 ${A_URI}`,
    );
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(hit).toBeGreaterThan(stale);
    expect(scheduler.pendingCount()).toBe(0);
    // A's stale result is kept for its own content too.
    expect(cache.lookup(identityOf(a)).hit).toBe(true);
    expect(cache.lookup(identityOf(c)).hit).toBe(true);
  });

  it('analyses each distinct content once while a file goes back and forth (US1-2, SC-002)', async () => {
    const { scheduler, detector, lines } = setup();
    const [a, b, c] = [rev('a', 0), rev('b', 0), rev('c', 0)];
    let version = 0;
    const submit = (s: FileSnapshot) =>
      scheduler.submit({ ...s, version: ++version });

    submit(a); // call #1 (A)
    submit(c); // pending while A runs
    detector.calls[0].resolve(ok(1));
    await settle(); // A stored (stale); C misses: call #2 (C)
    submit(a); // pending while C runs
    detector.calls[1].resolve(ok(2));
    await settle(); // C stored (stale); A's follow-up is a hit
    submit(c); // idle: a hit
    submit(b); // call #3 (B)
    submit(c); // pending while B runs
    detector.calls[2].resolve(ok(3));
    await settle(); // B stored (stale); C's follow-up is a hit

    expect(detector.analysed()).toEqual([a.content, c.content, b.content]);
    expect(lines.filter((l) => l.includes(' cache hit '))).toHaveLength(3);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('lets the follow-up lookup see the stored result even before the write is applied (US1-3)', async () => {
    const store = createDeferredCacheStore();
    const { scheduler, detector, cache } = setup(store);
    const [a, c] = [rev('a', 1), rev('c', 2)];
    const seeded = cache.store(identityOf(c), ok(3));
    store.flush();
    await seeded;

    scheduler.submit(a);
    scheduler.submit(c);
    detector.calls[0].resolve(ok(1));
    await settle();

    // A's store is written but not yet applied by the store: reads already see it.
    expect(store.held()).toBeGreaterThan(0);
    expect(cache.lookup(identityOf(a)).hit).toBe(true);

    store.flush();
    await settle();

    expect(detector.analysed()).toEqual([a.content]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(store.keys()).toHaveLength(1);
  });
});

describe('eviction is logged without file text', () => {
  it('logs the least recently used content a fifth distinct result evicts', async () => {
    const { scheduler, detector, lines } = setup();
    const contents = [1, 2, 3, 4, 5].map((i) => rev(`c${i}`, i));

    for (const [i, s] of contents.entries()) {
      scheduler.submit(s);
      detector.calls[i].resolve(ok(1));
      await settle();
    }

    const evicted = lines.filter((l) => l.includes(' cache evicted '));
    expect(evicted).toEqual([
      `${T0} cache evicted sha ${sha8(contents[0])} scripted@1 ${A_URI}`,
    ]);
    expect(evicted[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z cache evicted sha [0-9a-f]{8} scripted@1 file:\/\/\/w\/A\.java$/,
    );
    expect(lines.some((l) => l.includes(SECRET))).toBe(false);
  });
});
