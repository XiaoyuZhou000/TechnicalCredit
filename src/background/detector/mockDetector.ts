import {
  failureFromAbort,
  type Detector,
  type DetectorFinding,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { TCResult } from '@/comment/tcResult';

export const MOCK_DETECTOR_ID = 'mock';
export const DEFAULT_MOCK_VERSION = 'mock-1';
/** Long enough to keep editing while a call runs in the card 09 demo. */
export const DEFAULT_MOCK_DELAY_MS = 2000;

/**
 * The only timer operations the mock needs. A structural subset of the `Clock` planned for
 * cards 06/07/09, so one fake clock can later drive both the scheduler and the mock.
 */
export interface MockTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MockBehaviour =
  | { readonly kind: 'sample' }
  | {
      readonly kind: 'findings';
      readonly findings: (content: string) => readonly DetectorFinding[];
    }
  | { readonly kind: 'fail'; readonly message: string };

interface CommonOptions {
  readonly delayMs?: number;
  readonly timers?: MockTimers;
}

/**
 * Changing results without naming a new version is a type error, so a cache keyed on the
 * version (card 04) can never return old findings as new ones.
 */
export type MockDetectorOptions = CommonOptions &
  (
    | {
        readonly behaviour?: { readonly kind: 'sample' };
        readonly version?: string;
      }
    | {
        readonly behaviour: Exclude<MockBehaviour, { kind: 'sample' }>;
        readonly version: string;
      }
  );

export type MockOutcome =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly findingCount: number }
  | {
      readonly status: 'failed';
      readonly failure: 'timeout' | 'cancelled' | 'failed';
    };

/** Deliberately excludes the file text, so records are safe to print in tests and demos. */
export interface MockCallRecord {
  readonly fileUri: string;
  readonly version: number;
  readonly contentHash: string;
  readonly outcome: MockOutcome;
}

// Lines starting with `//` or `*` can't match, which skips most commented-out declarations.
const DECLARATION =
  /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface)\s+([A-Za-z_$][\w$]*)/;

function sampleResult(keyword: string, name: string): TCResult {
  return {
    is_tc_candidate: true,
    category: 'modularity',
    benefit: 'Mock sample finding; not a real Technical Credit assessment.',
    conditions: 'Produced by the Sprint 1 mock detector for testing only.',
    signals: [`mock: ${keyword} ${name}`],
    not_tc_reason: null,
  };
}

/** Pure; exported so tests can state expected findings without running the mock. */
export function sampleFindings(content: string): readonly DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  content.split(/\r?\n/).forEach((text, line) => {
    const match = DECLARATION.exec(text);
    if (match !== null) {
      findings.push({ line, result: sampleResult(match[1], match[2]) });
    }
  });
  return findings;
}

/**
 * Why a string can't be a version, or `undefined` if it can. Shared with the setting reader in
 * the composition root, so a value the setting accepts is always one the mock accepts. A
 * blank or padded version would read like no version at all in logs and on the status page.
 */
export function versionProblem(version: string): string | undefined {
  if (version === '') {
    return 'empty';
  }
  if (version.trim() === '') {
    return 'blank';
  }
  if (version !== version.trim()) {
    return 'padded with whitespace';
  }
  return undefined;
}

/** One rule for the constructor and `setVersion`. */
function checkVersion(version: string, behaviour: MockBehaviour): void {
  const problem = versionProblem(version);
  if (problem !== undefined) {
    throw new Error(`version must not be ${problem}`);
  }
  if (behaviour.kind !== 'sample' && version === DEFAULT_MOCK_VERSION) {
    throw new Error(
      `a '${behaviour.kind}' mock changes results, so it needs a version other than ${DEFAULT_MOCK_VERSION}`,
    );
  }
}

const realTimers: MockTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // Handles only ever come from `setTimeout` above, so the narrowing is safe.
  clearTimeout: (handle) =>
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

function outcomeOf(result: DetectorResult): MockOutcome {
  return result.ok
    ? { status: 'ok', findingCount: result.output.findings.length }
    : { status: 'failed', failure: result.failure.kind };
}

/**
 * Deterministic stand-in for the live detector (card 03). Never contacts Claude. Callers that
 * only need a detector must depend on `Detector`, not on this class (contract rule 7).
 */
export class MockDetector implements Detector {
  readonly id = MOCK_DETECTOR_ID;
  readonly delayMs: number;
  private currentVersion: string;
  private readonly behaviour: MockBehaviour;
  private readonly timers: MockTimers;
  private readonly records: MockCallRecord[] = [];
  private readonly versionListeners = new Set<(version: string) => void>();

  constructor(options: MockDetectorOptions = {}) {
    const delayMs = options.delayMs ?? DEFAULT_MOCK_DELAY_MS;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`delayMs must be a finite number >= 0, got ${delayMs}`);
    }
    const version = options.version ?? DEFAULT_MOCK_VERSION;
    const behaviour = options.behaviour ?? { kind: 'sample' };
    checkVersion(version, behaviour);
    this.delayMs = delayMs;
    this.currentVersion = version;
    this.behaviour = behaviour;
    this.timers = options.timers ?? realTimers;
  }

  /** Set from configuration in the extension (card 11); timing is never part of it. */
  get version(): string {
    return this.currentVersion;
  }

  /**
   * Changes the version and then announces it (card 11). Same rules as the constructor, so a
   * results-changing mock still can't claim the default version. Calls already started keep
   * the version they started under.
   */
  setVersion(version: string): void {
    checkVersion(version, this.behaviour);
    if (version === this.currentVersion) {
      return;
    }
    this.currentVersion = version;
    for (const listener of [...this.versionListeners]) {
      try {
        listener(version);
      } catch {
        // A subscriber's failure is its own to report; the others still hear the change.
      }
    }
  }

  onVersionChange(listener: (version: string) => void): () => void {
    this.versionListeners.add(listener);
    return () => {
      this.versionListeners.delete(listener);
    };
  }

  /** Every call, counted on entry, so cancelled and failed calls count too. */
  get callCount(): number {
    return this.records.length;
  }

  /** A frozen copy in call order; records are replaced, never mutated, so old copies stay valid. */
  calls(): readonly MockCallRecord[] {
    return Object.freeze([...this.records]);
  }

  async analyse(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<DetectorResult> {
    const record: MockCallRecord = {
      fileUri: input.fileUri,
      version: input.version,
      contentHash: input.contentHash,
      outcome: { status: 'pending' },
    };
    const index = this.records.push(record) - 1;
    // Captured at entry: a later `setVersion` must not relabel this call's output (rule 14).
    const version = this.currentVersion;
    const result = await this.respond(input, signal, version);
    this.records[index] = { ...record, outcome: outcomeOf(result) };
    return result;
  }

  private async respond(
    input: DetectorInput,
    signal: AbortSignal,
    version: string,
  ): Promise<DetectorResult> {
    if (signal.aborted) {
      // Still answer on a later tick, as the contract requires.
      await Promise.resolve();
      return failureFromAbort(signal);
    }
    if (this.delayMs === 0) {
      await Promise.resolve();
    } else {
      await this.wait(signal);
    }
    if (signal.aborted) {
      return failureFromAbort(signal);
    }
    switch (this.behaviour.kind) {
      case 'sample':
        return this.success(sampleFindings(input.content), version);
      case 'findings':
        return this.success(this.behaviour.findings(input.content), version);
      case 'fail':
        return {
          ok: false,
          failure: { kind: 'failed', message: this.behaviour.message },
        };
    }
  }

  private success(
    findings: readonly DetectorFinding[],
    detectorVersion: string,
  ): DetectorResult {
    return {
      ok: true,
      output: {
        detectorId: this.id,
        detectorVersion,
        findings,
      },
    };
  }

  /** Resolves when the delay elapses or `signal` aborts, whichever comes first. */
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.timers.clearTimeout(handle);
        resolve();
      };
      const handle = this.timers.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
