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
import { BackgroundStatus } from '@/background/status/backgroundStatus';
import { StatusFeed } from '@/background/status/statusFeed';
import { renderStatusHtml } from '@/background/status/statusView';
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

describe('background status model (card 09 US3)', () => {
  const LABEL = 'Sprint 1 mock detector';

  function withStatus(options: { quietMs?: number; cooldownMs?: number } = {}) {
    const run = harness(options);
    const status = new BackgroundStatus({
      scheduler: run.scheduler,
      cache: run.cache,
      clock: run.clock,
      detector: run.detector,
      label: LABEL,
    });
    return { ...run, status };
  }

  it('labels the session and counts its work from the scheduler and the cache', async () => {
    const { scheduler, detector, cache, status } = withStatus();
    const b = snapshot(B_URI, 'class B {}');
    await cache.store(identity(b), ok(1));
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    scheduler.submit(b);
    detector.calls[0].resolve(ok(2));
    await settle();

    const snap = status.snapshot();

    expect(snap).toMatchObject({
      label: LABEL,
      detector: 'scripted@1',
      session: {
        analyses: 1,
        followUps: 0,
        repeats: 0,
        cacheHits: 1,
        cacheMisses: 1,
        cacheStored: 2,
      },
    });
    expect(snap.files).toEqual(scheduler.files());
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.session)).toBe(true);
  });

  it('points nextChangeAt at the earliest future deadline, including a kept record expiry', async () => {
    const { scheduler, detector, clock, status } = withStatus({
      quietMs: 3000,
      cooldownMs: 30_000,
    });
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    expect(status.snapshot().nextChangeAt).toBe(3000);

    clock.advance(3000);
    detector.calls[0].resolve(ok(1));
    await settle(); // settles at 3 s, cooling until 33 s
    scheduler.closed({ workspaceId: W, fileUri: A_URI, observedAt: 3000 });

    expect(status.snapshot().files[0]).toMatchObject({
      open: false,
      keptUntil: 33_000,
    });
    expect(status.snapshot().nextChangeAt).toBe(33_000);
    clock.advance(30_000);
    expect(status.snapshot().nextChangeAt).toBeUndefined();
    expect(status.snapshot().files).toEqual([]);
  });

  it('delivers scheduler changes to subscribers', async () => {
    const { scheduler, status } = withStatus();
    let calls = 0;
    const unsubscribe = status.subscribe(() => calls++);

    scheduler.submit(snapshot(A_URI, 'class A {}'));
    await settle();
    unsubscribe();
    scheduler.submit(snapshot(B_URI, 'class B {}'));
    await settle();

    expect(calls).toBe(1);
  });
});

describe('status page rendering (card 09 US3)', () => {
  const time = (ms: number): string => `t+${ms}`;

  function render(status: BackgroundStatus): string {
    return renderStatusHtml(status.snapshot(), {
      nonce: 'NONCE123',
      formatTime: time,
    });
  }

  function withStatus(options: { quietMs?: number; cooldownMs?: number } = {}) {
    const run = harness(options);
    const status = new BackgroundStatus({
      scheduler: run.scheduler,
      cache: run.cache,
      clock: run.clock,
      detector: run.detector,
      label: 'Sprint 1 mock detector',
    });
    return { ...run, status };
  }

  it('shows an empty state before any file is reported', () => {
    const html = render(withStatus().status);

    expect(html).toContain('No Java files tracked yet');
    expect(html).toContain('Sprint 1 mock detector');
  });

  it('shows the label, the counters and each row', async () => {
    const { scheduler, detector, clock, status } = withStatus({
      quietMs: 3000,
      cooldownMs: 30_000,
    });
    const a = snapshot(A_URI, 'class A {}');
    scheduler.submit(a);
    clock.advance(3000); // A starts
    const c = snapshot(A_URI, 'class A { int x; }', 2, 3000);
    scheduler.submit(c); // waits behind A, then the cooldown

    const html = render(status);

    expect(html).toContain('Sprint 1 mock detector');
    expect(html).toContain('A.java');
    expect(html).toContain(A_URI);
    expect(html).toContain(`v1 ${sha256Hex(a.content).slice(0, 8)}`);
    expect(html).toContain(`v2 ${sha256Hex(c.content).slice(0, 8)}`);
    expect(html).toContain('quiet');
    expect(html).toContain('t+6000');

    detector.calls[0].resolve(ok(2));
    await settle();
    const after = render(status);

    expect(after).toContain('cooldown');
    expect(after).toContain('t+33000');
    expect(after).toContain('stale');
    expect(after).toContain('2 findings');
    expect(after).toMatch(/Analyses<\/dt>\s*<dd>1</);
  });

  it('marks a current result, a failure and a cache answer', async () => {
    const { scheduler, detector, cache, status } = withStatus();
    const b = snapshot(B_URI, 'class B {}');
    await cache.store(identity(b), ok(1));
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    scheduler.submit(b);
    scheduler.submit(snapshot('file:///w/C.java', 'class C {}'));
    detector.calls[0].resolve(ok(2));
    detector.calls[1].resolve(failed);
    await settle();

    const html = render(status);

    expect(html).toMatch(/A\.java[\s\S]*current[\s\S]*2 findings/);
    expect(html).toMatch(/B\.java[\s\S]*cached[\s\S]*1 finding/);
    expect(html).toMatch(/C\.java[\s\S]*failed/);
  });

  it('declares a strict CSP and has no scripts, forms, inputs or handlers', async () => {
    const { scheduler, status } = withStatus();
    scheduler.submit(snapshot(A_URI, 'class A {}'));

    const html = render(status);

    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-NONCE123'">`,
    );
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html).not.toMatch(/<script|<form|<input|<button|\son[a-z]+=/i);
  });
});

describe('status feed: live and truthful (card 09 US4)', () => {
  function feedHarness(
    options: { quietMs?: number; cooldownMs?: number } = {},
  ) {
    const run = harness(options);
    const status = new BackgroundStatus({
      scheduler: run.scheduler,
      cache: run.cache,
      clock: run.clock,
      detector: run.detector,
      label: 'Sprint 1 mock detector',
    });
    const renders: string[] = [];
    const feed = new StatusFeed({
      status,
      clock: run.clock,
      render: (html) => renders.push(html),
      nonce: () => 'N',
      formatTime: (ms) => `t+${ms}`,
    });
    return { ...run, status, renders, feed };
  }

  it('renders a burst of changes at most once per 200 ms, ending on the final state (FR-008, SC-004)', async () => {
    const { scheduler, clock, renders } = feedHarness({ quietMs: 3000 });
    expect(renders).toHaveLength(1); // the first render, on opening

    let last = snapshot(A_URI, 'class A { 0 }');
    for (let i = 1; i <= 20; i++) {
      clock.advance(2); // 20 changes in 40 ms
      last = snapshot(A_URI, `class A { ${i} }`, i + 1, clock.now());
      scheduler.submit(last);
      await settle();
    }

    expect(renders).toHaveLength(1);
    clock.advance(200);
    expect(renders).toHaveLength(2);
    expect(renders[1]).toContain(`v21 ${sha256Hex(last.content).slice(0, 8)}`);
  });

  it('refreshes at a kept record expiry, with no event and no polling before it (FR-011, US4-3)', async () => {
    const { scheduler, detector, clock, renders } = feedHarness({
      cooldownMs: 30_000,
    });
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    detector.calls[0].resolve(ok(1));
    await settle();
    scheduler.closed({ workspaceId: W, fileUri: A_URI, observedAt: 0 });
    await settle();
    clock.advance(200);
    const before = renders.length;

    expect(renders.at(-1)).toContain('closed · cooldown until t+30000');
    clock.advance(30_000 - 200 - 1);
    expect(renders).toHaveLength(before);
    clock.advance(1);

    expect(renders).toHaveLength(before + 1);
    expect(renders.at(-1)).toContain('No Java files tracked yet');
  });

  it('shows a result that settled after the file changed as stale, never current (US4-2)', async () => {
    const { scheduler, detector, clock, renders } = feedHarness();
    scheduler.submit(snapshot(A_URI, 'class A {}'));
    scheduler.submit(snapshot(A_URI, 'class A { int x; }', 2));
    detector.calls[0].resolve(ok(1));
    await settle();
    clock.advance(200);

    expect(renders.at(-1)).toContain('stale · analysed v1');
    expect(renders.at(-1)).not.toContain('current ·');
  });

  it('escapes a file location full of markup (US4-4, SC-005)', async () => {
    const { scheduler, clock, renders } = feedHarness();
    const nasty = `file:///w/<script>alert(1)</script>&"'.java`;
    scheduler.submit(snapshot(nasty, 'class A {}'));
    await settle();
    clock.advance(200);

    const html = renders.at(-1) ?? '';
    expect(html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;.java',
    );
    expect(html).not.toMatch(/<script/i);
  });
});
