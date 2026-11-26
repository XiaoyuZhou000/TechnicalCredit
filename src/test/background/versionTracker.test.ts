import type { CacheStore } from '@/background/cache/resultCache';
import {
  ACTIVE_DETECTOR_KEY,
  DetectorVersionTracker,
  type DetectorIdentity,
} from '@/background/detector/versionTracker';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

/**
 * Card 11's version tracker: the startup comparison and recording. Offline: an in-memory
 * store stands in for `context.globalState`, and a fake clock stamps the log lines.
 */

const identity = (detectorVersion: string): DetectorIdentity => ({
  detectorId: 'mock',
  detectorVersion,
});

/** A detector stand-in whose version a test can set before building a tracker. */
function detectorAt(version: string): { readonly id: string; version: string } {
  return { id: 'mock', version };
}

function harness(
  options: {
    store?: CacheStore;
    version?: string;
    recorded?: DetectorIdentity;
  } = {},
) {
  const store: CacheStore = options.store ?? createMemoryCacheStore();
  if (options.recorded !== undefined) {
    void store.update(ACTIVE_DETECTOR_KEY, options.recorded);
  }
  const clock = createFakeTimers();
  const detector = detectorAt(options.version ?? 'mock-1');
  const lines: string[] = [];
  const tracker = new DetectorVersionTracker({
    detector,
    store,
    clock,
    log: (line) => lines.push(line),
    rescan: () => 0,
  });
  return { store, clock, detector, lines, tracker };
}

/** Log lines without their ISO timestamp. */
const texts = (lines: readonly string[]): string[] =>
  lines.map((line) => line.replace(/^\S+ /, ''));

describe('US1: a new detector version is reported at startup', () => {
  it('returns a startup change from the recorded to the active identity', () => {
    const { tracker, clock } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });

    expect(tracker.begin()).toEqual({
      from: identity('mock-1'),
      to: identity('mock-2'),
      source: 'startup',
      at: clock.now(),
      scheduled: 0,
    });
  });

  it('logs nothing and records nothing in begin()', () => {
    const { tracker, lines, store } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    tracker.begin();

    expect(lines).toEqual([]);
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-1'));
  });

  it('logs the change with the startup count and keeps it as the last change', () => {
    const { tracker, lines } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    tracker.begin();
    tracker.startupScheduled(3);

    expect(texts(lines)).toEqual([
      'detector version changed mock@mock-1 → mock@mock-2 (startup), 3 open files scheduled',
    ]);
    expect(tracker.lastChange()).toMatchObject({
      from: identity('mock-1'),
      to: identity('mock-2'),
      source: 'startup',
      scheduled: 3,
    });
  });

  it('treats a rollback as a change', () => {
    const { tracker } = harness({
      recorded: identity('mock-2'),
      version: 'mock-1',
    });

    expect(tracker.begin()).toMatchObject({
      from: identity('mock-2'),
      to: identity('mock-1'),
    });
  });

  it('keeps the old identity until confirmStarted(), so a failed start is detected again', async () => {
    const store = createMemoryCacheStore();
    const first = harness({
      store,
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    first.tracker.begin();
    first.tracker.startupScheduled(2);
    // The start fails here: confirmStarted() never runs.

    const retry = harness({ store, version: 'mock-2' });
    expect(retry.tracker.begin()).toMatchObject({
      from: identity('mock-1'),
      to: identity('mock-2'),
    });

    await retry.tracker.confirmStarted();
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-2'));
    const after = harness({ store, version: 'mock-2' });
    expect(after.tracker.begin()).toBeUndefined();
  });

  it('records the identity active when confirmStarted() runs', async () => {
    const { tracker, store, detector } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    tracker.begin();
    detector.version = 'mock-3';
    await tracker.confirmStarted();

    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-3'));
  });

  it('logs a failed record and never rejects', async () => {
    const failing: CacheStore = {
      get: () => undefined,
      update: () => Promise.reject(new Error('disk full')),
    };
    const { tracker, lines } = harness({ store: failing, version: 'mock-2' });
    tracker.begin();

    await expect(tracker.confirmStarted()).resolves.toBeUndefined();
    expect(texts(lines)).toEqual(['detector record failed: disk full']);
  });

  it('notifies change listeners once, after the startup change is logged', async () => {
    const { tracker } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    const seen: (number | undefined)[] = [];
    tracker.onChange(() => seen.push(tracker.lastChange()?.scheduled));
    tracker.begin();
    tracker.startupScheduled(4);
    expect(seen).toEqual([]);

    await Promise.resolve();
    expect(seen).toEqual([4]);
  });

  it('does nothing after dispose()', async () => {
    const { tracker, lines, store } = harness({
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    tracker.begin();
    tracker.dispose();
    tracker.startupScheduled(1);
    await tracker.confirmStarted();

    expect(lines).toEqual([]);
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-1'));
  });
});
