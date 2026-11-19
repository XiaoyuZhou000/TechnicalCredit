import * as fs from 'fs';
import * as path from 'path';

import {
  isCacheable,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import {
  DEFAULT_MOCK_DELAY_MS,
  DEFAULT_MOCK_VERSION,
  MOCK_DETECTOR_ID,
  MockDetector,
  sampleFindings,
} from '@/background/detector/mockDetector';
import { createFakeTimers } from '@/test/background/fakeTimers';

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

describe('US2 calls and results can be inspected', () => {
  it('starts with no calls', () => {
    const mock = new MockDetector();

    expect(mock.callCount).toBe(0);
    expect(mock.calls()).toEqual([]);
  });

  it('counts a call as soon as it is made', () => {
    const mock = new MockDetector({ timers: createFakeTimers() });

    void mock.analyse(INPUT, new AbortController().signal);

    expect(mock.callCount).toBe(1);
    expect(mock.calls()[0].outcome).toEqual({ status: 'pending' });
  });

  it('records every call in order, whatever its outcome (SC-003)', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers });
    const cancelled = new AbortController();
    const preAborted = new AbortController();
    preAborted.abort();
    const timedOut = new AbortController();

    void mock.analyse({ ...INPUT, version: 1 }, new AbortController().signal);
    void mock.analyse({ ...INPUT, version: 2 }, cancelled.signal);
    void mock.analyse({ ...INPUT, version: 3 }, preAborted.signal);
    void mock.analyse({ ...INPUT, version: 4 }, timedOut.signal);
    cancelled.abort();
    timedOut.abort(new DOMException('limit', 'TimeoutError'));
    await flush();

    expect(mock.calls()[0].outcome).toEqual({ status: 'pending' });

    timers.advance(DEFAULT_MOCK_DELAY_MS);
    await flush();

    expect(mock.callCount).toBe(4);
    expect(mock.calls().map((c) => [c.version, c.outcome])).toEqual([
      [1, { status: 'ok', findingCount: 1 }],
      [2, { status: 'failed', failure: 'cancelled' }],
      [3, { status: 'failed', failure: 'cancelled' }],
      [4, { status: 'failed', failure: 'timeout' }],
    ]);
  });

  it('never records the file text (FR-008)', async () => {
    const mock = new MockDetector({ delayMs: 0 });

    await mock.analyse(
      { ...INPUT, content: 'class SECRET_BODY {}' },
      new AbortController().signal,
    );

    expect(mock.calls()[0]).toEqual({
      fileUri: INPUT.fileUri,
      version: INPUT.version,
      contentHash: INPUT.contentHash,
      outcome: { status: 'ok', findingCount: 1 },
    });
    expect(JSON.stringify(mock.calls())).not.toContain('SECRET_BODY');
  });

  it('hands out copies that later calls do not change', async () => {
    const mock = new MockDetector({ delayMs: 0 });
    await mock.analyse(INPUT, new AbortController().signal);
    const earlier = mock.calls();

    await mock.analyse(INPUT, new AbortController().signal);

    expect(earlier).toHaveLength(1);
    expect(Object.isFrozen(earlier)).toBe(true);
    expect(mock.calls()).toHaveLength(2);
  });
});

describe('sample findings', () => {
  const fixture = (name: string): string =>
    fs.readFileSync(
      path.join(__dirname, '../creational/prototype', `${name}.java`),
      'utf8',
    );

  it.each([
    ['Positive', [1, 6, 23, 28, 45, 50]],
    ['Negative', [1, 20, 31, 46]],
  ])('anchors to each declaration in %s.java', (name, lines) => {
    const findings = sampleFindings(fixture(name));

    expect(findings.map((f) => f.line)).toEqual(lines);
    for (const { result } of findings) {
      expect(result.is_tc_candidate).toBe(true);
      expect(result.category).toBe('modularity');
      expect(result.not_tc_reason).toBeNull();
    }
  });

  it('names the declared type in the signal', () => {
    expect(sampleFindings(fixture('Positive'))[0].result.signals).toEqual([
      'mock: interface Shape',
    ]);
  });

  it.each([[''], ['// class Commented {}'], ['int x = 1;']])(
    'finds nothing in %j, which is still a cacheable success',
    async (content) => {
      const result = await new MockDetector({ delayMs: 0 }).analyse(
        { ...INPUT, content },
        new AbortController().signal,
      );

      expect(sampleFindings(content)).toEqual([]);
      expect(result).toEqual({
        ok: true,
        output: {
          detectorId: MOCK_DETECTOR_ID,
          detectorVersion: DEFAULT_MOCK_VERSION,
          findings: [],
        },
      });
      expect(isCacheable(result)).toBe(true);
    },
  );

  it('reads CRLF content the same way', () => {
    const lf = 'package p;\npublic class A {}\ninterface B {}';

    expect(sampleFindings(lf.replace(/\n/g, '\r\n'))).toEqual(
      sampleFindings(lf),
    );
  });

  it('gives identical findings for identical content (SC-002)', async () => {
    const mock = new MockDetector({ delayMs: 0 });
    const content = fixture('Positive');
    const expected = sampleFindings(content);

    for (let i = 0; i < 100; i++) {
      const result = await mock.analyse(
        {
          ...INPUT,
          workspaceId: `file:///w${i}`,
          fileUri: `file:///w${i}/F${i}.java`,
          version: i,
          content,
        },
        new AbortController().signal,
      );
      expect(result.ok && result.output.findings).toEqual(expected);
    }
  });
});
