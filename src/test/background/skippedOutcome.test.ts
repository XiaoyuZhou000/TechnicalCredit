import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
  type SkipReason,
} from '@/background/detector/detector';
import type { VersionChange } from '@/background/detector/versionTracker';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { BackgroundStatus } from '@/background/status/backgroundStatus';
import { renderStatusHtml } from '@/background/status/statusView';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/*
 * Card 14, scheduler rule 10: a `skipped` settlement made no call, so it is not a completion.
 * It starts no cooldown, stores nothing, and shows on the status page as a skip.
 */

const W = 'file:///w';
const A_URI = 'file:///w/A.java';
const SECRET = 'SECRET_BODY_14';
const COOLDOWN = 30_000;

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

const OK: DetectorResult = {
  ok: true,
  output: { detectorId: 'scripted', detectorVersion: '1', findings: [] },
};

function skipped(reason: SkipReason): DetectorResult {
  return { ok: false, failure: { kind: 'skipped', reason } };
}

/** Answers each call with the next scripted result, at once. */
class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  readonly inputs: DetectorInput[] = [];

  constructor(private readonly results: DetectorResult[]) {}

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    this.inputs.push(input);
    if (signal.aborted) {
      return Promise.resolve(failureFromAbort(signal));
    }
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error('no scripted result left');
    }
    return Promise.resolve(next);
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup(results: DetectorResult[]) {
  const clock = createFakeTimers();
  const detector = new ScriptedDetector(results);
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
    quietMs: 0,
    cooldownMs: COOLDOWN,
  });
  return { clock, detector, store, cache, lines, scheduler };
}

describe('a skipped settlement (card 14, scheduler rule 10)', () => {
  test.each([
    ['syntax-errors', 'syntax errors'],
    ['live-disabled', 'live disabled'],
  ] as const)(
    'is logged as skipped: %s, without file text',
    async (reason, logged) => {
      const { scheduler, lines } = setup([skipped(reason)]);
      scheduler.submit(rev('x', 1));
      await settle();

      expect(
        lines.some((l) =>
          l.endsWith(`scripted skipped: ${logged} #1 v1 ${A_URI}`),
        ),
      ).toBe(true);
      expect(lines.join('\n')).not.toContain(SECRET);
    },
  );

  test('starts no cooldown: the next content starts at once', async () => {
    const { scheduler, detector, lines } = setup([
      skipped('syntax-errors'),
      OK,
    ]);
    scheduler.submit(rev('broken', 1));
    await settle();
    scheduler.submit(rev('fixed', 2));
    await settle();

    expect(detector.inputs.map((i) => i.version)).toEqual([1, 2]);
    expect(scheduler.fileState(W, A_URI)?.lastSettledAt).toBe(0);
    expect(lines.some((l) => l.includes('cooldown'))).toBe(false);
  });

  test('for comparison, a failure does start the cooldown', async () => {
    const { scheduler, detector, clock } = setup([
      { ok: false, failure: { kind: 'failed', message: 'boom' } },
      OK,
    ]);
    scheduler.submit(rev('broken', 1));
    await settle();
    scheduler.submit(rev('fixed', 2));
    await settle();
    expect(detector.inputs).toHaveLength(1);

    clock.advance(COOLDOWN);
    await settle();
    expect(detector.inputs).toHaveLength(2);
  });

  test('keeps an earlier cooldown as it was', async () => {
    const { scheduler, detector, clock } = setup([
      OK,
      skipped('syntax-errors'),
      OK,
    ]);
    scheduler.submit(rev('c', 1)); // completes at t=0: cooldown until 30 s
    await settle();
    clock.advance(10_000);
    scheduler.submit(rev('broken', 2)); // waits for the cooldown
    await settle();
    expect(detector.inputs).toHaveLength(1);

    clock.advance(20_000); // t=30 s: starts, and is skipped
    await settle();
    expect(detector.inputs).toHaveLength(2);
    expect(scheduler.fileState(W, A_URI)?.lastSettledAt).toBe(0);

    scheduler.submit(rev('fixed', 3)); // the cooldown from t=0 is over
    await settle();
    expect(detector.inputs).toHaveLength(3);
  });

  test('stores nothing, so the same content misses again', async () => {
    const { scheduler, cache } = setup([skipped('syntax-errors')]);
    const broken = rev('broken', 1);
    scheduler.submit(broken);
    await settle();

    expect(cache.stats().stored).toBe(0);
    expect(
      cache.lookup({
        workspaceId: W,
        fileUri: A_URI,
        contentHash: sha256Hex(broken.content),
        detectorId: 'scripted',
        detectorVersion: '1',
      }).hit,
    ).toBe(false);
  });

  test('is the latest outcome, with its reason', async () => {
    const { scheduler } = setup([skipped('live-disabled')]);
    scheduler.submit(rev('x', 1));
    await settle();

    expect(scheduler.files()[0].latest).toMatchObject({
      source: 'detector',
      ok: false,
      skipped: 'live-disabled',
      version: 1,
    });
  });

  test('shows on the status page as a skip, not a failure', async () => {
    const run = setup([skipped('syntax-errors')]);
    const status = new BackgroundStatus({
      scheduler: run.scheduler,
      cache: run.cache,
      clock: run.clock,
      detector: run.detector,
      label: 'Sprint 1 mock detector',
      tracker: {
        lastChange: (): VersionChange | undefined => undefined,
        onChange: (): (() => void) => () => undefined,
      },
      limit: 2,
    });
    run.scheduler.submit(rev('x', 1));
    await settle();

    const html = renderStatusHtml(status.snapshot(), { nonce: 'N' });
    expect(html).toContain('skipped: syntax errors (v1)');
    expect(html).not.toContain('failed (v1)');
    expect(html).not.toContain(SECRET);
  });
});
