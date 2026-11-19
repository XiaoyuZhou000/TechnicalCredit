import type { Detector, DetectorResult } from '@/background/detector/detector';
import type { SnapshotSink } from '@/background/events/fileEvents';

export interface DetectorRunSinkOptions {
  /** Card 02's logging sink; always called first so its lines stay unchanged. */
  readonly inner: SnapshotSink;
  readonly detector: Detector;
  /** SHA-256 hex of the content; card 04 will own the real hashing helper. */
  readonly hash: (content: string) => string;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function describeOutcome(result: DetectorResult): string {
  if (result.ok) {
    return `done ${result.output.findings.length} findings`;
  }
  const { failure } = result;
  return failure.kind === 'failed'
    ? `failed: ${failure.message}`
    : failure.kind;
}

/**
 * Placeholder until the scheduler (card 05) replaces it, so card 03 can be checked by hand.
 * It only cancels a file's previous call; it never debounces, caches or schedules. Never
 * logs file text.
 */
export function createDetectorRunSink(
  options: DetectorRunSinkOptions,
): SnapshotSink & { dispose(): void } {
  const { inner, detector, hash, log, now } = options;
  const running = new Map<string, AbortController>();
  let started = 0;
  let stopped = false;

  return {
    submit: (s) => {
      if (stopped) {
        return;
      }
      inner.submit(s);
      running.get(s.fileUri)?.abort();
      const controller = new AbortController();
      running.set(s.fileUri, controller);
      const n = ++started;
      const suffix = `#${n} v${s.version} ${s.fileUri}`;
      const contentHash = hash(s.content);
      log(`${iso(now())} mock start ${suffix}`);

      // The contract says detectors never reject; a rejection is a defect, reported as a failure.
      void detector
        .analyse(
          {
            workspaceId: s.workspaceId,
            fileUri: s.fileUri,
            languageId: s.languageId,
            version: s.version,
            contentHash,
            content: s.content,
          },
          controller.signal,
        )
        .catch(
          (error: unknown): DetectorResult => ({
            ok: false,
            failure: {
              kind: 'failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        )
        .then((result) => {
          if (running.get(s.fileUri) === controller) {
            running.delete(s.fileUri);
          }
          if (!stopped) {
            log(`${iso(now())} mock ${describeOutcome(result)} ${suffix}`);
          }
        });
    },
    closed: (notice) => {
      if (!stopped) {
        inner.closed(notice);
      }
    },
    dispose: () => {
      stopped = true;
      for (const controller of running.values()) {
        controller.abort();
      }
      running.clear();
    },
  };
}
