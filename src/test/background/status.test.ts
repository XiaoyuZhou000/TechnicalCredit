import {
  ResultCache,
  sha256Hex,
  type CacheIdentity,
} from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

/** Offline tests for card 09's read-only status surfaces: no `vscode`, no live client. */

const W = 'file:///w';
const A_URI = 'file:///w/A.java';
const B_URI = 'file:///w/B.java';

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

const failed: DetectorResult = {
  ok: false,
  failure: { kind: 'failed', message: 'nope' },
};

function snapshot(
  fileUri: string,
  content: string,
  version = 1,
  observedAt = 0,
): FileSnapshot {
  return {
    workspaceId: W,
    fileUri,
    languageId: 'java',
    version,
    content,
    trigger: 'edit',
    observedAt,
  };
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

/** Lets every pending promise chain and microtask run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: { quietMs?: number; cooldownMs?: number } = {}) {
  const clock = createFakeTimers();
  const detector = new ScriptedDetector();
  const store = createMemoryCacheStore();
  const cache = new ResultCache({ store, now: () => clock.now() });
  const lines: string[] = [];
  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector,
    cache,
    hash: sha256Hex,
    log: (line) => lines.push(line),
    clock,
    quietMs: options.quietMs ?? 0,
    cooldownMs: options.cooldownMs ?? 0,
  });
  return { clock, detector, store, cache, lines, scheduler };
}

describe('scheduler file listing (card 09)', () => {
  it('lists nothing before any report', () => {
    expect(harness().scheduler.files()).toEqual([]);
  });

  it('lists every tracked file, sorted, with its location and state', () => {
    const { scheduler } = harness();
    const b = snapshot(B_URI, 'class B {}');
    const a = snapshot(A_URI, 'class A {}');
    scheduler.submit(b);
    scheduler.submit(a);

    const files = scheduler.files();

    expect(files.map((f) => f.fileUri)).toEqual([A_URI, B_URI]);
    expect(files[0]).toMatchObject({
      workspaceId: W,
      fileUri: A_URI,
      latestHash: sha256Hex(a.content),
      open: true,
      active: { n: 2, version: 1, contentHash: sha256Hex(a.content) },
    });
    expect(Object.isFrozen(files)).toBe(true);
    expect(Object.isFrozen(files[0])).toBe(true);
  });

  it('reports the latest result as current, then stale once the file changes', async () => {
    const { scheduler, detector } = harness();
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    detector.calls[0].resolve(ok(2));
    await settle();

    expect(scheduler.files()[0].latest).toMatchObject({
      source: 'detector',
      ok: true,
      findings: 2,
      version: 1,
      current: true,
    });

    scheduler.submit(snapshot(A_URI, 'class A { int x; }', 2));

    expect(scheduler.files()[0].latest).toMatchObject({
      source: 'detector',
      version: 1,
      current: false,
    });
  });

  it('reports a failure as a failed latest outcome', async () => {
    const { scheduler, detector } = harness();
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    detector.calls[0].resolve(failed);
    await settle();

    const latest = scheduler.files()[0].latest;
    expect(latest).toMatchObject({ source: 'detector', ok: false });
    expect(latest?.findings).toBeUndefined();
  });

  it('reports a cache answer as the latest outcome', async () => {
    const { scheduler, cache } = harness();
    const a = snapshot(A_URI, 'class A {}');
    await cache.store(identity(a), ok(3));

    scheduler.submit(a);

    expect(scheduler.files()[0].latest).toMatchObject({
      source: 'cache',
      ok: true,
      findings: 3,
      current: true,
    });
  });

  it('never lists a closed file once its kept cooldown record expired', async () => {
    const { scheduler, detector, clock } = harness({ cooldownMs: 30_000 });
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    detector.calls[0].resolve(ok(1));
    await settle();
    scheduler.closed({ workspaceId: W, fileUri: A_URI, observedAt: 0 });

    expect(scheduler.files()).toMatchObject([{ fileUri: A_URI, open: false }]);
    clock.advance(30_000);
    expect(scheduler.files()).toEqual([]);
  });
});

describe('scheduler change notifications (card 09)', () => {
  it('sends one notification for a burst of changes, after the burst', async () => {
    const { scheduler } = harness();
    let calls = 0;
    scheduler.onChange(() => calls++);

    for (let i = 0; i < 20; i++) {
      scheduler.submit(snapshot(A_URI, `class A { ${i} }`, i + 1));
    }

    expect(calls).toBe(0);
    await settle();
    expect(calls).toBe(1);
  });

  it('logs a throwing listener once and still calls the others', async () => {
    const { scheduler, lines } = harness();
    let second = 0;
    scheduler.onChange(() => {
      throw new Error('boom');
    });
    scheduler.onChange(() => second++);

    scheduler.submit(snapshot(A_URI, 'class A {}'));
    await settle();

    expect(second).toBe(1);
    expect(
      lines.filter((l) => l.includes('status listener error: boom')),
    ).toHaveLength(1);
  });

  it('stops notifying after unsubscribe and after dispose', async () => {
    const { scheduler } = harness();
    let first = 0;
    let second = 0;
    const unsubscribe = scheduler.onChange(() => first++);
    scheduler.onChange(() => second++);

    unsubscribe();
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    await settle();
    scheduler.dispose();
    await settle();

    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('notifies nothing that was not a decision, such as reading state', async () => {
    const { scheduler } = harness();
    let calls = 0;
    scheduler.onChange(() => calls++);

    scheduler.files();
    scheduler.fileState(W, A_URI);
    scheduler.stats();
    await settle();

    expect(calls).toBe(0);
  });
});
