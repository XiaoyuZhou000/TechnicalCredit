import type { CacheStore } from '@/background/cache/resultCache';
import { MockDetector } from '@/background/detector/mockDetector';
import {
  ACTIVE_DETECTOR_KEY,
  DetectorVersionTracker,
  type DetectorIdentity,
} from '@/background/detector/versionTracker';
import { createFakeTimers } from '@/test/background/fakeTimers';
import {
  createMemoryCacheStore,
  throwingGetStore,
} from '@/test/background/memoryCacheStore';

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

describe('US2: an unchanged or first start reports no change', () => {
  it('reports a first start, and records the identity', async () => {
    const { tracker, lines, store } = harness({ version: 'mock-1' });

    expect(tracker.begin()).toBeUndefined();
    tracker.startupScheduled(2);
    await tracker.confirmStarted();

    expect(texts(lines)).toEqual([
      'detector version mock@mock-1 (first start)',
    ]);
    expect(tracker.lastChange()).toBeUndefined();
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-1'));
  });

  it('reports an unchanged identity', () => {
    const { tracker, lines } = harness({
      recorded: identity('mock-1'),
      version: 'mock-1',
    });

    expect(tracker.begin()).toBeUndefined();
    tracker.startupScheduled(5);

    expect(texts(lines)).toEqual(['detector version mock@mock-1 (unchanged)']);
    expect(tracker.lastChange()).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['a bare string', 'mock-1'],
    ['an empty object', {}],
    ['a missing version', { detectorId: 'mock' }],
    ['an empty id', { detectorId: '', detectorVersion: 'x' }],
    ['a numeric id', { detectorId: 1, detectorVersion: 'x' }],
    ['an array', ['mock', 'mock-1']],
  ])('treats %s as nothing recorded', (_label, value) => {
    const store = createMemoryCacheStore();
    store.rawSet(ACTIVE_DETECTOR_KEY, value);
    const { tracker, lines } = harness({ store, version: 'mock-2' });

    expect(tracker.begin()).toBeUndefined();
    tracker.startupScheduled(1);
    expect(texts(lines)).toEqual([
      'detector version mock@mock-2 (first start)',
    ]);
  });

  it('treats a throwing store as nothing recorded, without throwing', () => {
    const { tracker, lines } = harness({
      store: throwingGetStore('storage unavailable'),
      version: 'mock-1',
    });

    expect(() => tracker.begin()).not.toThrow();
    tracker.startupScheduled(0);
    expect(texts(lines)).toEqual([
      'detector version mock@mock-1 (first start)',
    ]);
  });

  it('lets a second window with the same build see no change', async () => {
    const store = createMemoryCacheStore();
    const first = harness({
      store,
      recorded: identity('mock-1'),
      version: 'mock-2',
    });
    first.tracker.begin();
    await first.tracker.confirmStarted();

    const second = harness({ store, version: 'mock-2' });
    expect(second.tracker.begin()).toBeUndefined();
    second.tracker.startupScheduled(1);
    expect(texts(second.lines)).toEqual([
      'detector version mock@mock-2 (unchanged)',
    ]);
  });
});

describe('US4: a version announced while running is handled like a startup change', () => {
  function runtime(
    options: { rescan?: () => number; confirmed?: boolean } = {},
  ) {
    const store = createMemoryCacheStore();
    const clock = createFakeTimers();
    const mock = new MockDetector({ timers: clock });
    const lines: string[] = [];
    let rescans = 0;
    const tracker = new DetectorVersionTracker({
      detector: mock,
      store,
      clock,
      log: (line) => lines.push(line),
      rescan:
        options.rescan ??
        (() => {
          rescans++;
          return 3;
        }),
    });
    return { store, clock, mock, lines, tracker, rescans: () => rescans };
  }

  /** Lets the never-rejecting store write settle. */
  const flushWrites = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  it('rescans once and logs the runtime change with the rescan count', () => {
    const { mock, lines, tracker, rescans } = runtime();
    tracker.begin();

    mock.setVersion('mock-2');

    expect(rescans()).toBe(1);
    expect(texts(lines)).toEqual([
      'detector version changed mock@mock-1 → mock@mock-2 (runtime), 3 open files scheduled',
    ]);
    expect(tracker.lastChange()).toMatchObject({
      from: identity('mock-1'),
      to: identity('mock-2'),
      source: 'runtime',
      scheduled: 3,
    });
  });

  it('records the new identity once the start was confirmed', async () => {
    const { mock, store, tracker } = runtime();
    tracker.begin();
    await tracker.confirmStarted();

    mock.setVersion('mock-2');
    await flushWrites();

    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-2'));
  });

  it('handles but does not record a change before the start is confirmed', async () => {
    const { mock, store, tracker, rescans } = runtime();
    tracker.begin();

    mock.setVersion('mock-2');
    await flushWrites();
    expect(rescans()).toBe(1);
    expect(store.get(ACTIVE_DETECTOR_KEY)).toBeUndefined();

    await tracker.confirmStarted();
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-2'));
  });

  it('ignores an announcement of the version already active', () => {
    // The mock skips a same-value set itself, so this detector re-announces on purpose.
    let announce: (version: string) => void = () => undefined;
    const detector = {
      id: 'mock',
      version: 'mock-1',
      onVersionChange: (listener: (version: string) => void) => {
        announce = listener;
        return () => undefined;
      },
    };
    let rescans = 0;
    const lines: string[] = [];
    const tracker = new DetectorVersionTracker({
      detector,
      store: createMemoryCacheStore(),
      clock: createFakeTimers(),
      log: (line) => lines.push(line),
      rescan: () => ++rescans,
    });
    tracker.begin();

    announce('mock-1');
    expect(rescans).toBe(0);

    detector.version = 'mock-2';
    announce('mock-2');
    announce('mock-2');

    expect(rescans).toBe(1);
    expect(texts(lines)).toHaveLength(1);
  });

  it('chains quick changes, each from the previous one', () => {
    const { mock, tracker } = runtime();
    tracker.begin();

    mock.setVersion('mock-2');
    mock.setVersion('mock-3');

    expect(tracker.lastChange()).toMatchObject({
      from: identity('mock-2'),
      to: identity('mock-3'),
    });
  });

  it('logs a failing rescan and counts it as 0', () => {
    const { mock, lines, tracker } = runtime({
      rescan: () => {
        throw new Error('no editor');
      },
    });
    tracker.begin();

    expect(() => mock.setVersion('mock-2')).not.toThrow();
    expect(texts(lines)).toEqual([
      'detector rescan failed: no editor',
      'detector version changed mock@mock-1 → mock@mock-2 (runtime), 0 open files scheduled',
    ]);
  });

  it('accepts a detector that never announces changes', () => {
    const { tracker } = harness({ version: 'mock-1' });

    expect(() => tracker.dispose()).not.toThrow();
  });

  it('ignores announcements and records nothing after dispose()', async () => {
    const { mock, lines, store, tracker, rescans } = runtime();
    tracker.begin();
    await tracker.confirmStarted();
    tracker.dispose();

    mock.setVersion('mock-2');
    await flushWrites();

    expect(rescans()).toBe(0);
    expect(lines).toEqual([]);
    expect(store.get(ACTIVE_DETECTOR_KEY)).toEqual(identity('mock-1'));
  });

  it('notifies change listeners once per change', async () => {
    const { mock, tracker } = runtime();
    tracker.begin();
    const seen: (string | undefined)[] = [];
    tracker.onChange(() => seen.push(tracker.lastChange()?.to.detectorVersion));

    mock.setVersion('mock-2');
    await Promise.resolve();
    mock.setVersion('mock-3');
    await Promise.resolve();

    expect(seen).toEqual(['mock-2', 'mock-3']);
  });

  it('never sets a timer, so nothing runs while no change is announced (FR-005)', () => {
    const { clock, tracker } = runtime();
    tracker.begin();
    tracker.startupScheduled(2);

    expect(clock.pendingCount).toBe(0);
  });
});
