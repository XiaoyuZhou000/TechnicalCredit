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
  versionProblem,
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

describe('US3 the mock can be configured per scenario', () => {
  it('reports the configured version with otherwise identical results', async () => {
    const v1 = await new MockDetector({ version: 'v1', delayMs: 0 }).analyse(
      INPUT,
      new AbortController().signal,
    );
    const v2 = await new MockDetector({ version: 'v2', delayMs: 0 }).analyse(
      INPUT,
      new AbortController().signal,
    );

    expect(v1.ok && v1.output.detectorVersion).toBe('v1');
    expect(v2.ok && v2.output.detectorVersion).toBe('v2');
    expect(v1.ok && v1.output.findings).toEqual(v2.ok && v2.output.findings);
  });

  it('keeps the default version when only the delay changes', () => {
    expect(new MockDetector().version).toBe(DEFAULT_MOCK_VERSION);
    expect(new MockDetector({ delayMs: 5 }).version).toBe(DEFAULT_MOCK_VERSION);
  });

  it('returns configured findings under their own version', async () => {
    const custom = sampleFindings('class Custom {}');
    const mock = new MockDetector({
      behaviour: { kind: 'findings', findings: () => custom },
      version: 'custom-1',
      delayMs: 0,
    });

    const result = await mock.analyse(INPUT, new AbortController().signal);

    expect(mock.version).not.toBe(DEFAULT_MOCK_VERSION);
    expect(result).toEqual({
      ok: true,
      output: {
        detectorId: MOCK_DETECTOR_ID,
        detectorVersion: 'custom-1',
        findings: custom,
      },
    });
  });

  it('fails after the delay when configured to, and the failure is not cacheable', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({
      behaviour: { kind: 'fail', message: 'boom' },
      version: 'fail-1',
      timers,
    });
    const call = track(mock.analyse(INPUT, new AbortController().signal));

    await flush();
    expect(call.settled).toBe(false);

    timers.advance(DEFAULT_MOCK_DELAY_MS);
    await flush();

    expect(call.value).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'boom' },
    });
    expect(call.value !== undefined && isCacheable(call.value)).toBe(false);
    expect(mock.callCount).toBe(1);
    expect(mock.calls()[0].outcome).toEqual({
      status: 'failed',
      failure: 'failed',
    });
  });

  it('reports a cancelled failing mock as cancelled, not failed', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({
      behaviour: { kind: 'fail', message: 'boom' },
      version: 'fail-1',
      timers,
    });
    const controller = new AbortController();
    const call = track(mock.analyse(INPUT, controller.signal));

    controller.abort();
    await flush();

    expect(call.value).toEqual({ ok: false, failure: { kind: 'cancelled' } });
  });

  it('refuses to change results under the default version', () => {
    expect(
      () =>
        new MockDetector({
          behaviour: { kind: 'fail', message: 'x' },
          version: DEFAULT_MOCK_VERSION,
        }),
    ).toThrow(Error);
  });
});

describe('card 11: the version can change while the mock lives', () => {
  it('updates the version before telling listeners, in subscription order', () => {
    const mock = new MockDetector();
    const heard: string[] = [];
    mock.onVersionChange((version) =>
      heard.push(`1:${version}:${mock.version}`),
    );
    mock.onVersionChange((version) => heard.push(`2:${version}`));

    mock.setVersion('mock-2');

    expect(mock.version).toBe('mock-2');
    expect(heard).toEqual(['1:mock-2:mock-2', '2:mock-2']);
  });

  it('does nothing when the version is unchanged', () => {
    const mock = new MockDetector({ version: 'mock-2' });
    const heard: string[] = [];
    mock.onVersionChange((version) => heard.push(version));

    mock.setVersion('mock-2');

    expect(heard).toEqual([]);
  });

  it('rejects an empty version and keeps the current one', () => {
    const mock = new MockDetector();

    expect(() => mock.setVersion('')).toThrow('version must not be empty');
    expect(mock.version).toBe(DEFAULT_MOCK_VERSION);
  });

  it('refuses the default version for a mock that changes results', () => {
    const mock = new MockDetector({
      behaviour: { kind: 'fail', message: 'nope' },
      version: 'fail-1',
    });

    expect(() => mock.setVersion(DEFAULT_MOCK_VERSION)).toThrow(
      /needs a version other than/,
    );
    expect(mock.version).toBe('fail-1');
  });

  it('keeps telling the other listeners when one throws, and never rethrows', () => {
    const mock = new MockDetector();
    const heard: string[] = [];
    mock.onVersionChange(() => {
      throw new Error('listener bug');
    });
    mock.onVersionChange((version) => heard.push(version));

    expect(() => mock.setVersion('mock-2')).not.toThrow();
    expect(heard).toEqual(['mock-2']);
  });

  it('stops telling a listener once it unsubscribes', () => {
    const mock = new MockDetector();
    const heard: string[] = [];
    const unsubscribe = mock.onVersionChange((version) => heard.push(version));

    mock.setVersion('mock-2');
    unsubscribe();
    mock.setVersion('mock-3');

    expect(heard).toEqual(['mock-2']);
  });

  it('labels a call with the version it started under, even if the version changes first', async () => {
    const timers = createFakeTimers();
    const mock = new MockDetector({ timers, delayMs: 100 });
    const call = mock.analyse(INPUT, new AbortController().signal);
    await flush();

    mock.setVersion('mock-2');
    timers.advance(100);
    const result = await call;

    expect(result.ok && result.output.detectorVersion).toBe('mock-1');
    const next = await new MockDetector({
      version: 'mock-2',
      delayMs: 0,
    }).analyse(INPUT, new AbortController().signal);
    expect(next.ok && next.output.detectorVersion).toBe('mock-2');
  });
});

describe('card 11: blank and padded versions are rejected (F5 finding)', () => {
  it.each([
    ['', 'empty'],
    [' ', 'blank'],
    ['\t', 'blank'],
    [' mock-2', 'padded with whitespace'],
    ['mock-2 ', 'padded with whitespace'],
  ])('reports %j as %s', (version, problem) => {
    expect(versionProblem(version)).toBe(problem);
  });

  it.each(['mock-2', 'm', 'mock 2'])('accepts %j', (version) => {
    expect(versionProblem(version)).toBeUndefined();
  });

  it('rejects a blank version in the constructor', () => {
    expect(() => new MockDetector({ version: ' ' })).toThrow(
      'version must not be blank',
    );
  });

  it('rejects a blank or padded version in setVersion, and keeps the current one', () => {
    const mock = new MockDetector({ version: 'mock-2' });
    const heard: string[] = [];
    mock.onVersionChange((version) => heard.push(version));

    expect(() => mock.setVersion(' ')).toThrow('version must not be blank');
    expect(() => mock.setVersion(' mock-3')).toThrow(
      'version must not be padded with whitespace',
    );
    expect(mock.version).toBe('mock-2');
    expect(heard).toEqual([]);
  });
});
