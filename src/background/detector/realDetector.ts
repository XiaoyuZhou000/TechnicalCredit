import { fileURLToPath } from 'url';

import {
  failureFromAbort,
  type Detector,
  type DetectorFinding,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import {
  currentFingerprintInputs,
  detectorFingerprint,
  type FingerprintInputs,
} from '@/background/detector/fingerprint';
import type { Clock } from '@/background/scheduler/clock';
import {
  enumerateConstructs,
  type EnumerationResult,
} from '@/context/enumerateConstructs';
import type { AdrSummary } from '@/context/findAdrs';
import {
  detectTechnicalCredit,
  type ClaudeClient,
} from '@/detection/detectTechnicalCredit';

export const REAL_DETECTOR_ID = 'claude';

/**
 * One type is a parallel heuristic phase, then a parallel ADR phase, each bounded by the
 * client's 30 s per-call timeout, so about 60 s at worst.
 */
export const PER_TYPE_TIMEOUT_MS = 60_000;
/** Keeps a file with many types from holding a call slot for longer. */
export const FILE_TIMEOUT_CAP_MS = 300_000;

/** The file's limit: `PER_TYPE_TIMEOUT_MS` per type, at most `FILE_TIMEOUT_CAP_MS`. */
export function fileTimeoutMs(typeCount: number): number {
  return Math.min(PER_TYPE_TIMEOUT_MS * typeCount, FILE_TIMEOUT_CAP_MS);
}

export interface RealDetectorOptions {
  /** Bound to `callClaude` only in the composition root; tests pass a fake. */
  readonly client: ClaudeClient;
  /** The ADRs of the snapshot's workspace, read by the caller; empty skips ADR matching. */
  readonly adrsFor: (input: DetectorInput) => readonly AdrSummary[];
  /** For the file time limit (card 14 US2), so tests can drive it with fake timers. */
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  /**
   * The file name the context carries, as the manual command's `document.fileName` would be.
   * Defaults to the path of a `file:` URI, else the URI itself.
   */
  readonly fileNameOf?: (fileUri: string) => string;
  /** Card 12's enumeration; replaceable in tests. */
  readonly enumerate?: (
    source: string,
    fileName: string,
    languageId: string,
  ) => Promise<EnumerationResult>;
  /** Defaults to the prompts, model and logic revision as built. */
  readonly fingerprintInputs?: FingerprintInputs;
}

function defaultFileName(fileUri: string): string {
  try {
    return fileURLToPath(fileUri);
  } catch {
    return fileUri;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Card 14: the background detector over card 13's shared detection service. One analysis is
 * one snapshot: card 12 enumerates its top-level classes, interfaces and enums from a single
 * parse, and each is analysed in source order, one at a time, with the context built from the
 * original full text. Inner classes are analysed only inside their outer type.
 *
 * The file succeeds only if every type does: the first failure, timeout or cancellation stops
 * the file and is its outcome, so a partial result is never cacheable. A snapshot whose parse
 * reports syntax errors is skipped as a whole (`skipped: syntax-errors`). The scheduler's signal
 * and the file's own time limit (`fileTimeoutMs`) reach every call in flight. Never touches `vscode`,
 * the manual command or the labeling UI, and never rejects.
 */
export class RealDetector implements Detector {
  readonly id = REAL_DETECTOR_ID;
  readonly version: string;
  private readonly client: ClaudeClient;
  private readonly adrsFor: (input: DetectorInput) => readonly AdrSummary[];
  private readonly fileNameOf: (fileUri: string) => string;
  private readonly enumerate: NonNullable<RealDetectorOptions['enumerate']>;
  private readonly clock: RealDetectorOptions['clock'];

  constructor(options: RealDetectorOptions) {
    this.client = options.client;
    this.clock = options.clock;
    this.adrsFor = options.adrsFor;
    this.fileNameOf = options.fileNameOf ?? defaultFileName;
    this.enumerate = options.enumerate ?? enumerateConstructs;
    this.version = detectorFingerprint(
      options.fingerprintInputs ?? currentFingerprintInputs(),
    );
  }

  async analyse(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<DetectorResult> {
    try {
      return await this.run(input, signal);
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'failed',
          message: `real detector: ${messageOf(error)}`,
        },
      };
    }
  }

  private async run(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<DetectorResult> {
    if (signal.aborted) {
      return failureFromAbort(signal);
    }
    const enumeration = await this.enumerate(
      input.content,
      this.fileNameOf(input.fileUri),
      input.languageId,
    );
    if (!enumeration.ok) {
      return {
        ok: false,
        failure: {
          kind: 'failed',
          message: 'construct enumeration unavailable',
        },
      };
    }
    if (signal.aborted) {
      return failureFromAbort(signal);
    }
    // Card 12 rule 7: with a syntax error anywhere, types may be missing or misplaced, so even
    // "complete" ones could carry guessed context. Nothing is sent, cached or treated as deleted.
    if (enumeration.hasSyntaxErrors) {
      return {
        ok: false,
        failure: { kind: 'skipped', reason: 'syntax-errors' },
      };
    }
    const { constructs } = enumeration;
    if (constructs.length === 0) {
      return this.success([]);
    }

    const adrs = this.adrsFor(input);
    // A timeout reason, so the service and `failureFromAbort` report `timeout`, not `cancelled`.
    const timer = new AbortController();
    const handle = this.clock.setTimeout(
      () =>
        timer.abort(
          new DOMException('file analysis timed out', 'TimeoutError'),
        ),
      fileTimeoutMs(constructs.length),
    );
    const callSignal = AbortSignal.any([signal, timer.signal]);
    try {
      const findings: DetectorFinding[] = [];
      for (const construct of constructs) {
        if (callSignal.aborted) {
          return failureFromAbort(callSignal);
        }
        const outcome = await detectTechnicalCredit(
          { context: construct.context, adrs },
          this.client,
          callSignal,
        );
        if (!outcome.ok) {
          return outcome;
        }
        for (const result of outcome.findings) {
          findings.push({ line: construct.line, result });
        }
      }
      // An abort as the last answers arrive still wins: the run is no longer wanted.
      if (callSignal.aborted) {
        return failureFromAbort(callSignal);
      }
      return this.success(findings);
    } finally {
      this.clock.clearTimeout(handle);
    }
  }

  private success(findings: readonly DetectorFinding[]): DetectorResult {
    return {
      ok: true,
      output: {
        detectorId: this.id,
        detectorVersion: this.version,
        findings,
      },
    };
  }
}
