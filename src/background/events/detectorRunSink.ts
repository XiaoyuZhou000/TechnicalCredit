import type {
  CacheIdentity,
  CacheLookup,
  ResultCache,
  StoreOutcome,
} from '@/background/cache/resultCache';
import type { Detector, DetectorResult } from '@/background/detector/detector';
import type { SnapshotSink } from '@/background/events/fileEvents';

export interface DetectorRunSinkOptions {
  /** Card 02's logging sink; always called first so its lines stay unchanged. */
  readonly inner: SnapshotSink;
  readonly detector: Detector;
  /** SHA-256 hex of the content; the composition root passes card 04's `sha256Hex`. */
  readonly hash: (content: string) => string;
  readonly log: (line: string) => void;
  readonly now: () => number;
  /** Without it, the sink behaves exactly as on card 03. */
  readonly cache?: ResultCache;
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

function describeMiss(lookup: Exclude<CacheLookup, { hit: true }>): string {
  switch (lookup.reason) {
    case 'absent':
    case 'unreadable':
      return lookup.reason;
    case 'content-changed':
      return 'content changed';
    case 'error':
      return `error: ${lookup.message}`;
  }
}

/**
 * Placeholder until the scheduler (card 05) replaces it, so cards 03 and 04 can be checked by
 * hand. It cancels a file's previous call and, given a cache, skips the call on a hit; it never
 * debounces or schedules. Never logs file text or findings.
 */
export function createDetectorRunSink(
  options: DetectorRunSinkOptions,
): SnapshotSink & { dispose(): void } {
  const { inner, detector, hash, log, now, cache } = options;
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
      running.delete(s.fileUri);
      const contentHash = hash(s.content);
      const identity: CacheIdentity = {
        workspaceId: s.workspaceId,
        fileUri: s.fileUri,
        contentHash,
        detectorId: detector.id,
        detectorVersion: detector.version,
      };
      const cacheSuffix = `v${s.version} sha ${contentHash.slice(0, 8)} ${detector.id}@${detector.version} ${s.fileUri}`;

      if (cache !== undefined) {
        const lookup = cache.lookup(identity);
        if (lookup.hit) {
          log(
            `${iso(now())} cache hit ${lookup.entry.output.findings.length} findings ${cacheSuffix}`,
          );
          return;
        }
        log(
          `${iso(now())} cache miss (${describeMiss(lookup)}) ${cacheSuffix}`,
        );
      }

      const controller = new AbortController();
      running.set(s.fileUri, controller);
      const n = ++started;
      const suffix = `#${n} v${s.version} ${s.fileUri}`;
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
          if (stopped) {
            return;
          }
          log(`${iso(now())} mock ${describeOutcome(result)} ${suffix}`);
          if (cache === undefined) {
            return;
          }
          // `store` never rejects, and skips failures itself.
          void cache.store(identity, result).then((outcome: StoreOutcome) => {
            if (stopped) {
              return;
            }
            if (outcome.status === 'stored' && result.ok) {
              log(
                `${iso(now())} cache stored ${result.output.findings.length} findings ${cacheSuffix}`,
              );
            } else if (outcome.status === 'failed') {
              log(
                `${iso(now())} cache store failed: ${outcome.message} ${cacheSuffix}`,
              );
            }
          });
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
