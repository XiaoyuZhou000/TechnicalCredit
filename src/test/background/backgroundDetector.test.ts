import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import {
  BACKGROUND_DETECTOR_ID,
  BackgroundDetector,
  type DetectorMode,
  type LiveCallGate,
} from '@/background/detector/backgroundDetector';
import type {
  Detector,
  DetectorInput,
  DetectorResult,
} from '@/background/detector/detector';
import { MockDetector } from '@/background/detector/mockDetector';
import { DetectorVersionTracker } from '@/background/detector/versionTracker';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 14 US3: one background detector over the mock and the real detector. Its version names
 * the detector in use, so a switch is an ordinary card 11 version change, and results never
 * cross between the two.
 */

const W = 'file:///w';
const URI = 'file:///w/A.java';
const OPEN: LiveCallGate = { permitted: true };
const CLOSED: LiveCallGate = {
  permitted: false,
  reason: 'live background analysis waits for card 15',
};

const INPUT: DetectorInput = {
  workspaceId: W,
  fileUri: URI,
  languageId: 'java',
  version: 1,
  contentHash: 'c'.repeat(64),
  content: 'class A {}',
};

/** A stand-in for `RealDetector`: answers each call with one finding, or holds it. */
class ScriptedReal implements Detector {
  readonly id = 'claude';
  readonly version = 'fp-0123456789abcdef';
  readonly inputs: DetectorInput[] = [];
  private held: (() => void)[] = [];
  holdCalls = false;

  analyse(input: DetectorInput): Promise<DetectorResult> {
    this.inputs.push(input);
    const result: DetectorResult = {
      ok: true,
      output: {
        detectorId: this.id,
        detectorVersion: this.version,
        findings: [
          {
            line: 0,
            result: {
              is_tc_candidate: true,
              category: 'modularity',
              benefit: 'b',
              conditions: 'c',
              signals: [],
              not_tc_reason: null,
            },
          },
        ],
      },
    };
    if (!this.holdCalls) {
      return Promise.resolve(result);
    }
    return new Promise((resolve) => this.held.push(() => resolve(result)));
  }

  release(): void {
    const held = this.held;
    this.held = [];
    held.forEach((settle) => settle());
  }
}

function setup(
  mode: DetectorMode = 'mock',
  gate: () => LiveCallGate = () => OPEN,
) {
  const timers = createFakeTimers();
  const mock = new MockDetector({ timers, delayMs: 0 });
  const real = new ScriptedReal();
  const detector = new BackgroundDetector({
    mock,
    real,
    mode,
    liveCalls: gate,
  });
  const announced: string[] = [];
  detector.onVersionChange((version) =>
    announced.push(`${version}=${detector.version}`),
  );
  return { timers, mock, real, detector, announced };
}

const signal = (): AbortSignal => new AbortController().signal;

describe('BackgroundDetector identity (US3)', () => {
  test('has one stable id, and a version naming the detector in use', () => {
    const { detector } = setup();
    expect(detector.id).toBe(BACKGROUND_DETECTOR_ID);
    expect(detector.id).toBe('technicalcredit');
    expect(detector.mode).toBe('mock');
    expect(detector.version).toBe('mock:mock-1');

    detector.setMode('real');
    expect(detector.id).toBe('technicalcredit');
    expect(detector.version).toBe('claude:fp-0123456789abcdef');
  });

  test('a switch announces once, after the version changed; the same mode is a no-op', () => {
    const { detector, announced } = setup();

    detector.setMode('mock');
    detector.setMode('real');
    detector.setMode('real');
    detector.setMode('mock');

    expect(announced).toEqual([
      'claude:fp-0123456789abcdef=claude:fp-0123456789abcdef',
      'mock:mock-1=mock:mock-1',
    ]);
  });

  test("re-announces the mock's own version changes only while in mock mode", () => {
    const { detector, mock, announced } = setup();

    mock.setVersion('mock-2');
    expect(announced).toEqual(['mock:mock-2=mock:mock-2']);

    detector.setMode('real');
    mock.setVersion('mock-3');
    expect(announced).toHaveLength(2);

    detector.setMode('mock');
    expect(detector.version).toBe('mock:mock-3');
    expect(announced[2]).toBe('mock:mock-3=mock:mock-3');
  });

  test('a listener that throws does not stop the others', () => {
    const { detector, announced } = setup();
    detector.onVersionChange(() => {
      throw new Error('listener bug');
    });
    const later: string[] = [];
    detector.onVersionChange((v) => later.push(v));

    expect(() => detector.setMode('real')).not.toThrow();
    expect(announced).toHaveLength(1);
    expect(later).toEqual(['claude:fp-0123456789abcdef']);
  });

  test('unsubscribing and disposing stop announcements', () => {
    const { detector, mock } = setup();
    const seen: string[] = [];
    const unsubscribe = detector.onVersionChange((v) => seen.push(v));
    unsubscribe();
    detector.setMode('real');
    detector.setMode('mock');
    expect(seen).toEqual([]);

    const after: string[] = [];
    detector.onVersionChange((v) => after.push(v));
    detector.dispose();
    mock.setVersion('mock-2');
    expect(after).toEqual([]);
  });

  test.each([
    ['mock', () => OPEN, 'Sprint 1 mock detector'],
    ['real', () => OPEN, 'Claude detector'],
    [
      'real',
      () => CLOSED,
      'Claude detector (live calls disabled: live background analysis waits for card 15)',
    ],
  ] as const)('in %s mode the label reads correctly', (mode, gate, label) => {
    expect(setup(mode, gate).detector.label).toBe(label);
  });
});

describe('BackgroundDetector analysis (US3)', () => {
  test('mock mode runs the mock and never the real detector, re-stamped with its own identity', async () => {
    const { detector, mock, real } = setup('mock', () => {
      throw new Error('the gate is only asked in real mode');
    });

    const result = await detector.analyse(INPUT, signal());

    expect(mock.callCount).toBe(1);
    expect(real.inputs).toHaveLength(0);
    expect(result.ok && result.output.detectorId).toBe('technicalcredit');
    expect(result.ok && result.output.detectorVersion).toBe('mock:mock-1');
  });

  test('real mode with live calls closed is skipped, and nothing is delegated (US3-3)', async () => {
    const { detector, mock, real } = setup('real', () => CLOSED);

    const result = await detector.analyse(INPUT, signal());

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'skipped', reason: 'live-disabled' },
    });
    expect(real.inputs).toHaveLength(0);
    expect(mock.callCount).toBe(0);
  });

  test('real mode with live calls permitted delegates, re-stamped with its own identity', async () => {
    const { detector, real } = setup('real', () => OPEN);

    const result = await detector.analyse(INPUT, signal());

    expect(real.inputs).toEqual([INPUT]);
    expect(result).toMatchObject({
      ok: true,
      output: {
        detectorId: 'technicalcredit',
        detectorVersion: 'claude:fp-0123456789abcdef',
      },
    });
    expect(result.ok && result.output.findings).toHaveLength(1);
  });

  test('the gate is asked on every call, so it can open later', async () => {
    let gate: LiveCallGate = CLOSED;
    const { detector, real } = setup('real', () => gate);

    const first = await detector.analyse(INPUT, signal());
    gate = OPEN;
    const second = await detector.analyse(INPUT, signal());

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(real.inputs).toHaveLength(1);
  });

  test('a call keeps the detector and version it started under (contract rule 5)', async () => {
    const { detector, real } = setup('real', () => OPEN);
    real.holdCalls = true;
    const pending = detector.analyse(INPUT, signal());

    detector.setMode('mock');
    real.release();
    const result = await pending;

    expect(result.ok && result.output.detectorVersion).toBe(
      'claude:fp-0123456789abcdef',
    );
    expect(detector.version).toBe('mock:mock-1');
  });

  test('failures pass through unchanged', async () => {
    const timers = createFakeTimers();
    const detector = new BackgroundDetector({
      mock: new MockDetector({
        timers,
        delayMs: 0,
        version: 'mock-fail',
        behaviour: { kind: 'fail', message: 'boom' },
      }),
      real: new ScriptedReal(),
      mode: 'mock',
      liveCalls: () => OPEN,
    });

    expect(await detector.analyse(INPUT, signal())).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'boom' },
    });
  });
});

describe('switching through the scheduler and version tracker (US3-4, FR-013)', () => {
  function run() {
    const { timers, mock, real, detector } = setup('mock', () => OPEN);
    const store = createMemoryCacheStore();
    const cache = new ResultCache({ store, now: () => timers.now() });
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    const scheduler = new Scheduler({
      inner: { submit: () => undefined, closed: () => undefined },
      detector,
      cache,
      hash: sha256Hex,
      log,
      clock: timers,
      quietMs: 0,
      cooldownMs: 0,
    });
    const snapshot: FileSnapshot = {
      workspaceId: W,
      fileUri: URI,
      languageId: 'java',
      version: 1,
      content: 'class A {}',
      trigger: 'open',
      observedAt: 0,
    };
    let rescans = 0;
    const tracker = new DetectorVersionTracker({
      detector,
      store,
      clock: timers,
      log,
      rescan: () => {
        rescans++;
        scheduler.submit({ ...snapshot, trigger: 'version' });
        return 1;
      },
    });
    tracker.begin();
    return {
      mock,
      real,
      detector,
      scheduler,
      lines,
      snapshot,
      tracker,
      rescans: () => rescans,
    };
  }

  const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  test('a switch rescans, unchanged content misses under the new version, and switching back is a hit', async () => {
    const { mock, real, detector, scheduler, lines, snapshot, rescans } = run();
    scheduler.submit(snapshot);
    await settle();
    expect(mock.callCount).toBe(1);

    detector.setMode('real');
    await settle();
    expect(rescans()).toBe(1);
    expect(real.inputs).toHaveLength(1);
    expect(
      lines.some((l) =>
        l.includes(
          'detector version changed technicalcredit@mock:mock-1 → technicalcredit@claude:fp-0123456789abcdef (runtime)',
        ),
      ),
    ).toBe(true);

    detector.setMode('mock');
    await settle();
    expect(rescans()).toBe(2);
    expect(mock.callCount).toBe(1);
    expect(
      lines.some(
        (l) =>
          l.includes('cache hit') && l.includes('technicalcredit@mock:mock-1'),
      ),
    ).toBe(true);
    scheduler.dispose();
  });
});
