import {
  failureFromAbort,
  isCacheable,
  type Detector,
  type DetectorFailure,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { TCResult } from '@/comment/tcResult';

/**
 * Offline contract tests: no `vscode`, no live Claude client.
 *
 * Two unrelated stand-in detectors are driven through one caller that only knows the
 * contract, proving a detector can be swapped without changing the code that calls it.
 */

const CANDIDATE: TCResult = {
  is_tc_candidate: true,
  category: 'modularity',
  benefit: 'Isolates storage behind an interface.',
  conditions: 'Holds while callers depend only on the interface.',
  signals: ['interface Repository'],
  not_tc_reason: null,
};

const INPUT: DetectorInput = {
  workspaceId: 'ws-1',
  fileUri: 'file:///workspace/src/Repository.java',
  languageId: 'java',
  version: 1,
  contentHash: 'a'.repeat(64),
  content: 'interface Repository { Object find(String id); }',
};

class EmptyDetector implements Detector {
  readonly id = 'empty';
  readonly version = '1';

  async analyse(): Promise<DetectorResult> {
    // Resolve on a later tick, as the contract requires.
    await Promise.resolve();
    return {
      ok: true,
      output: {
        detectorId: this.id,
        detectorVersion: this.version,
        findings: [],
      },
    };
  }
}

type Script = 'finding' | 'failed' | 'wait';

class ScriptedDetector implements Detector {
  readonly id = 'scripted';
  readonly version = '2';

  constructor(private readonly script: Script) {}

  async analyse(
    _input: DetectorInput,
    signal: AbortSignal,
  ): Promise<DetectorResult> {
    await Promise.resolve();
    if (this.script === 'finding') {
      return {
        ok: true,
        output: {
          detectorId: this.id,
          detectorVersion: this.version,
          findings: [{ line: 0, result: CANDIDATE }],
        },
      };
    }
    if (this.script === 'failed') {
      return { ok: false, failure: { kind: 'failed', message: 'boom' } };
    }
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(failureFromAbort(signal));
        return;
      }
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

interface Classified {
  kind: 'success' | DetectorFailure['kind'];
  cacheable: boolean;
  findings: number;
  detectorId?: string;
  detectorVersion?: string;
}

/** The contract-only caller: it must never reference a concrete detector class. */
async function runAndClassify(
  detector: Detector,
  input: DetectorInput,
  signal: AbortSignal,
): Promise<Classified> {
  const result = await detector.analyse(input, signal);
  if (result.ok) {
    return {
      kind: 'success',
      cacheable: isCacheable(result),
      findings: result.output.findings.length,
      detectorId: result.output.detectorId,
      detectorVersion: result.output.detectorVersion,
    };
  }
  return {
    kind: result.failure.kind,
    cacheable: isCacheable(result),
    findings: 0,
  };
}

describe('detector contract — successful outcomes', () => {
  test('an empty result is a cacheable success', async () => {
    const outcome = await runAndClassify(
      new EmptyDetector(),
      INPUT,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: 'success',
      cacheable: true,
      findings: 0,
    });
  });

  test('a finding result is cacheable and names its detector and version', async () => {
    const detector = new ScriptedDetector('finding');
    const outcome = await runAndClassify(
      detector,
      INPUT,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: 'success',
      cacheable: true,
      findings: 1,
      detectorId: detector.id,
      detectorVersion: detector.version,
    });
  });
});

describe('detector contract — failure outcomes are never cacheable', () => {
  test('a failed result carries a reason and is not cacheable', async () => {
    const result = await new ScriptedDetector('failed').analyse(
      INPUT,
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'boom' },
    });
    expect(isCacheable(result)).toBe(false);
  });

  test('aborting an in-flight request yields a cancelled result', async () => {
    const controller = new AbortController();
    const pending = runAndClassify(
      new ScriptedDetector('wait'),
      INPUT,
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({
      kind: 'cancelled',
      cacheable: false,
    });
  });

  test('a caller-owned timeout yields a timeout result', async () => {
    const outcome = await runAndClassify(
      new ScriptedDetector('wait'),
      INPUT,
      AbortSignal.timeout(10),
    );
    expect(outcome).toMatchObject({ kind: 'timeout', cacheable: false });
  });
});

describe('detector contract — swapping detectors', () => {
  test('the same caller handles different detectors without changes', async () => {
    const signal = new AbortController().signal;
    const detectors: Detector[] = [
      new EmptyDetector(),
      new ScriptedDetector('finding'),
      new ScriptedDetector('failed'),
    ];
    const kinds = await Promise.all(
      detectors.map(async (d) => (await runAndClassify(d, INPUT, signal)).kind),
    );
    expect(kinds).toEqual(['success', 'success', 'failed']);
  });
});

describe('failureFromAbort', () => {
  test('a plain abort without a reason maps to cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    expect(failureFromAbort(controller.signal)).toEqual({
      ok: false,
      failure: { kind: 'cancelled' },
    });
  });

  test('a custom abort reason maps to cancelled, not timeout', () => {
    const controller = new AbortController();
    controller.abort(new Error('file closed'));
    expect(failureFromAbort(controller.signal)).toEqual({
      ok: false,
      failure: { kind: 'cancelled' },
    });
  });
});
