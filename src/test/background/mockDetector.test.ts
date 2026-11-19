import type {
  Detector,
  DetectorInput,
  DetectorResult,
} from '@/background/detector/detector';
import {
  DEFAULT_MOCK_DELAY_MS,
  DEFAULT_MOCK_VERSION,
  MOCK_DETECTOR_ID,
  MockDetector,
} from '@/background/detector/mockDetector';

import { createFakeTimers } from './fakeTimers';

/** Offline tests: no `vscode`, no live Claude client, no real waiting. */

const INPUT: DetectorInput = {
  workspaceId: 'file:///w',
  fileUri: 'file:///w/A.java',
  languageId: 'java',
  version: 1,
  contentHash: 'a'.repeat(64),
  content: 'class A {}',
};

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

/** A caller that knows only the contract, as the scheduler will (SC-007). */
function run(
  detector: Detector,
  input: DetectorInput,
): Promise<DetectorResult> {
  return detector.analyse(input, new AbortController().signal);
}

describe('US1 analysis runs in the background without blocking', () => {
  it('lets other work finish while a delayed call is pending (SC-001)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const call = track(mock.analyse(INPUT, new AbortController().signal));

    let otherWork = 0;
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      otherWork++;
    }
    timers.advance(DEFAULT_MOCK_DELAY_MS - 1);
    await flush();

    expect(otherWork).toBe(10);
    expect(call.settled).toBe(false);

    timers.advance(1);
    await flush();

    expect(call.settled).toBe(true);
    expect(call.value?.ok).toBe(true);
  });

  it('answers on a later tick even with no delay', async () => {
    const mock = new MockDetector({ delayMs: 0 });
    const call = track(mock.analyse(INPUT, new AbortController().signal));

    expect(call.settled).toBe(false);
    await flush();
    expect(call.value?.ok).toBe(true);
  });

  it('stops at once when cancelled mid-delay (SC-004)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const controller = new AbortController();
    const call = track(mock.analyse(INPUT, controller.signal));

    timers.advance(1000);
    controller.abort();
    await flush();

    expect(call.value).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(timers.pendingCount).toBe(0);
  });

  it('answers an already-cancelled call without starting a timer', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const controller = new AbortController();
    controller.abort();

    const call = track(mock.analyse(INPUT, controller.signal));

    expect(call.settled).toBe(false);
    await flush();
    expect(call.value).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(timers.pendingCount).toBe(0);
  });

  it('reports a time limit as a timeout', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const controller = new AbortController();
    const call = track(mock.analyse(INPUT, controller.signal));

    controller.abort(new DOMException('limit', 'TimeoutError'));
    await flush();

    expect(call.value).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('runs unchanged behind a caller that only knows the contract (SC-007)', async () => {
    const mock = new MockDetector({ delayMs: 0 });

    const result = await run(mock, INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.detectorId).toBe(MOCK_DETECTOR_ID);
      expect(result.output.detectorId).toBe(mock.id);
      expect(result.output.detectorVersion).toBe(mock.version);
      expect(mock.version).toBe(DEFAULT_MOCK_VERSION);
    }
  });

  it.each([
    ['a negative delay', { delayMs: -1 }],
    ['a NaN delay', { delayMs: Number.NaN }],
    ['an empty version', { version: '' }],
  ])('refuses %s', (_name, options) => {
    expect(() => new MockDetector(options)).toThrow(Error);
  });
});
