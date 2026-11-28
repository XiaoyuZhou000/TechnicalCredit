import { fileURLToPath } from 'url';

import {
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
 * the file and is its outcome, so a partial result is never cacheable. Never touches `vscode`,
 * the manual command or the labeling UI, and never rejects.
 */
export class RealDetector implements Detector {
  readonly id = REAL_DETECTOR_ID;
  readonly version: string;
  private readonly client: ClaudeClient;
  private readonly adrsFor: (input: DetectorInput) => readonly AdrSummary[];
  private readonly fileNameOf: (fileUri: string) => string;
  private readonly enumerate: NonNullable<RealDetectorOptions['enumerate']>;

  constructor(options: RealDetectorOptions) {
    this.client = options.client;
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
    const findings: DetectorFinding[] = [];
    if (enumeration.constructs.length > 0) {
      const adrs = this.adrsFor(input);
      for (const construct of enumeration.constructs) {
        const outcome = await detectTechnicalCredit(
          { context: construct.context, adrs },
          this.client,
          signal,
        );
        if (!outcome.ok) {
          return outcome;
        }
        for (const result of outcome.findings) {
          findings.push({ line: construct.line, result });
        }
      }
    }
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
