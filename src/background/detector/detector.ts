import type { TCResult } from '@/comment/tcResult';

/** One immutable snapshot of a supported file, handed to a detector for analysis. */
export interface DetectorInput {
  /** Stable id of the workspace folder the file belongs to. */
  readonly workspaceId: string;
  /** Document URI as a string, so this module never depends on `vscode`. */
  readonly fileUri: string;
  /** Unsupported files are filtered out before a detector is ever called. */
  readonly languageId: 'java';
  /** Editor document version when the snapshot was taken. */
  readonly version: number;
  /** 64 lowercase hex characters (SHA-256 of `content`), computed by the caller before the call. */
  readonly contentHash: string;
  readonly content: string;
}

/** One Technical Credit finding. */
export interface DetectorFinding {
  /** 0-based line of the class or interface declaration the finding anchors to. */
  readonly line: number;
  /** Reuses the existing finding shape; always has `is_tc_candidate: true`. */
  readonly result: TCResult;
}

export interface DetectorOutput {
  readonly detectorId: string;
  /**
   * Covers code and configuration; part of the cache identity. The `version` in effect when the
   * call started, which a later version change doesn't alter.
   */
  readonly detectorVersion: string;
  /** May be empty: finding nothing is a valid, cacheable success. */
  readonly findings: readonly DetectorFinding[];
}

export type DetectorFailure =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Failures are returned rather than rejected: rejections cannot be typed, and a union
 * forces every caller to handle the failure branch before using the output.
 */
export type DetectorResult =
  | { readonly ok: true; readonly output: DetectorOutput }
  | { readonly ok: false; readonly failure: DetectorFailure };

export interface Detector {
  /** Stable name, e.g. 'mock'. */
  readonly id: string;
  /**
   * Known before any call, so a valid cached result can be reused without calling. Changes
   * whenever prompts, model, model configuration or detection logic change in a way that can
   * change findings; never for timing-only settings. It may change during the detector's life
   * only if the detector implements `onVersionChange`.
   */
  readonly version: string;
  /**
   * Resolves with a result and never rejects. Must not block the editor and must never
   * edit documents. Once `signal` aborts, resolves promptly with `failureFromAbort(signal)`.
   * A version change never alters a call already started: its output keeps the version it
   * started under.
   */
  analyse(input: DetectorInput, signal: AbortSignal): Promise<DetectorResult>;
  /**
   * Optional: only for a detector whose version can change while it lives. Listeners run
   * synchronously, in subscription order, after `version` already returns the new value, and
   * are never called when the version did not change. Returns the unsubscribe.
   */
  onVersionChange?(listener: (version: string) => void): () => void;
}

/** Only successful results, including empty ones, may be cached; failures are always retried. */
export function isCacheable(result: DetectorResult): boolean {
  return result.ok;
}

/**
 * Maps an aborted signal to a failure. Callers own the timeout policy and usually combine
 * it with cancellation, e.g. `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`.
 */
export function failureFromAbort(signal: AbortSignal): DetectorResult {
  const reason: unknown = signal.reason;
  const timedOut =
    reason instanceof DOMException && reason.name === 'TimeoutError';
  return {
    ok: false,
    failure: timedOut ? { kind: 'timeout' } : { kind: 'cancelled' },
  };
}
