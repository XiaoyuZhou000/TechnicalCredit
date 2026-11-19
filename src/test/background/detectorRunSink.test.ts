import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import { createDetectorRunSink } from '@/background/events/detectorRunSink';
import type {
  FileClosedNotice,
  FileSnapshot,
  SnapshotSink,
} from '@/background/events/fileEvents';

/** Offline tests for card 03's temporary hookup: no `vscode`, no live client. */

const T0 = '1970-01-01T00:00:00.000Z';
const HASH = 'h'.repeat(64);

function snapshot(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
  return {
    workspaceId: 'file:///w',
    fileUri: 'file:///w/A.java',
    languageId: 'java',
    version: 3,
    content: 'class A { SECRET_BODY }',
    trigger: 'edit',
    observedAt: 0,
    ...overrides,
  };
}

interface Call {
  readonly input: DetectorInput;
  readonly signal: AbortSignal;
  resolve(result: DetectorResult): void;
}

/** Resolves only when the test says so, or with `failureFromAbort` once aborted. */
class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '1';
  readonly calls: Call[] = [];

  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return new Promise((resolve) => {
      this.calls.push({ input, signal, resolve });
      signal.addEventListener(
        'abort',
        () => resolve(failureFromAbort(signal)),
        {
          once: true,
        },
      );
    });
  }
}

class RejectingDetector implements Detector {
  readonly id = 'rejecting';
  readonly version = '1';

  analyse(): Promise<DetectorResult> {
    return Promise.reject(new Error('boom'));
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
          signals: [],
          not_tc_reason: null,
        },
      })),
    },
  };
}

async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function setup(detector: Detector = new ScriptedDetector()) {
  const order: string[] = [];
  const lines: string[] = [];
  const inner: SnapshotSink = {
    submit: (s) => order.push(`inner submit ${s.fileUri}`),
    closed: (n) => order.push(`inner closed ${n.fileUri}`),
  };
  const sink = createDetectorRunSink({
    inner,
    detector,
    hash: () => HASH,
    log: (line) => {
      lines.push(line);
      order.push('log');
    },
    now: () => 0,
  });
  return { sink, lines, order };
}

describe('detector run sink (temporary, until card 05)', () => {
  it('forwards to the inner sink before logging the start (S1)', () => {
    const { sink, order } = setup();

    sink.submit(snapshot());

    expect(order).toEqual(['inner submit file:///w/A.java', 'log']);
  });

  it('hashes the content and copies the snapshot into the detector input (S3)', () => {
    const detector = new ScriptedDetector();
    const { sink } = setup(detector);

    sink.submit(snapshot());

    expect(detector.calls[0].input).toEqual({
      workspaceId: 'file:///w',
      fileUri: 'file:///w/A.java',
      languageId: 'java',
      version: 3,
      contentHash: HASH,
      content: 'class A { SECRET_BODY }',
    });
  });

  it('logs start and end lines without file text (S4, S5)', async () => {
    const detector = new ScriptedDetector();
    const { sink, lines } = setup(detector);

    sink.submit(snapshot());
    detector.calls[0].resolve(ok(2));
    await flush();

    expect(lines).toEqual([
      `${T0} mock start #1 v3 file:///w/A.java`,
      `${T0} mock done 2 findings #1 v3 file:///w/A.java`,
    ]);
    expect(lines.join('\n')).not.toContain('SECRET_BODY');
  });

  it("cancels only the same file's previous call (S2)", async () => {
    const detector = new ScriptedDetector();
    const { sink, lines } = setup(detector);

    sink.submit(snapshot());
    sink.submit(snapshot({ fileUri: 'file:///w/B.java' }));
    sink.submit(snapshot({ version: 4 }));
    await flush();

    expect(detector.calls.map((c) => c.signal.aborted)).toEqual([
      true,
      false,
      false,
    ]);
    expect(lines).toContain(`${T0} mock cancelled #1 v3 file:///w/A.java`);
    expect(lines).toContain(`${T0} mock start #3 v4 file:///w/A.java`);
  });

  it('only forwards a close; it starts and cancels nothing (S6)', () => {
    const detector = new ScriptedDetector();
    const { sink, order } = setup(detector);
    sink.submit(snapshot());
    const notice: FileClosedNotice = {
      workspaceId: 'file:///w',
      fileUri: 'file:///w/A.java',
      observedAt: 0,
    };

    sink.closed(notice);

    expect(order.at(-1)).toBe('inner closed file:///w/A.java');
    expect(detector.calls).toHaveLength(1);
    expect(detector.calls[0].signal.aborted).toBe(false);
  });

  it('reports a rejecting detector as a failure (S7)', async () => {
    const { sink, lines } = setup(new RejectingDetector());

    sink.submit(snapshot());
    await flush();

    expect(lines.at(-1)).toBe(`${T0} mock failed: boom #1 v3 file:///w/A.java`);
  });

  it('aborts everything and goes quiet once disposed (S8)', async () => {
    const detector = new ScriptedDetector();
    const { sink, lines, order } = setup(detector);
    sink.submit(snapshot());
    sink.submit(snapshot({ fileUri: 'file:///w/B.java' }));
    const before = order.length;

    sink.dispose();
    sink.submit(snapshot({ version: 9 }));
    sink.closed({
      workspaceId: 'w',
      fileUri: 'file:///w/A.java',
      observedAt: 0,
    });
    await flush();

    expect(detector.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(detector.calls).toHaveLength(2);
    expect(order).toHaveLength(before);
    expect(lines.filter((l) => l.includes('cancelled'))).toEqual([]);
  });

  it('lets errors from the inner sink propagate (S10)', () => {
    const sink = createDetectorRunSink({
      inner: {
        submit: () => {
          throw new Error('inner broke');
        },
        closed: () => undefined,
      },
      detector: new ScriptedDetector(),
      hash: () => HASH,
      log: () => undefined,
      now: () => 0,
    });

    expect(() => sink.submit(snapshot())).toThrow('inner broke');
  });
});
