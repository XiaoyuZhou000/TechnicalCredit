import type { ResultCache } from '@/background/cache/resultCache';
import type { Detector } from '@/background/detector/detector';
import type {
  DetectorVersionTracker,
  VersionChange,
} from '@/background/detector/versionTracker';
import type { Clock } from '@/background/scheduler/clock';
import type { FileStatus, Scheduler } from '@/background/scheduler/scheduler';

/** This session's work; a restart starts every count again at 0 (card 09 US2). */
export interface SessionCounts {
  readonly analyses: number;
  readonly followUps: number;
  readonly repeats: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheStored: number;
}

/** What card 09's status page shows: metadata and counts only, never file text or findings. */
export interface StatusSnapshot {
  readonly label: string;
  /** `<id>@<version>`. */
  readonly detector: string;
  readonly takenAt: number;
  readonly session: SessionCounts;
  /** The session's last detector version change, if any (card 11). */
  readonly versionChange?: VersionChange;
  /** Background calls running now, and the limit on them; `limit: 0` means no limit (card 11). */
  readonly concurrency: { readonly running: number; readonly limit: number };
  readonly files: readonly FileStatus[];
  /**
   * The earliest future time this snapshot would change with no scheduler event: a waiting
   * file's eligible time, or a kept record's expiry. A page refreshes then instead of polling.
   */
  readonly nextChangeAt?: number;
}

/** The read-only status interface a page depends on; it can observe, never steer. */
export interface StatusSource {
  snapshot(): StatusSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface BackgroundStatusOptions {
  readonly scheduler: Scheduler;
  readonly cache: ResultCache;
  readonly clock: Clock;
  readonly detector: Pick<Detector, 'id' | 'version'>;
  /**
   * Read on every snapshot, so it follows the active detector: "Sprint 1 mock detector" while
   * the mock is in use (constitution VIII), and the real detector's label otherwise (card 14).
   */
  readonly label: () => string;
  /** Card 11's version tracker, for the last change and its notifications. */
  readonly tracker: Pick<DetectorVersionTracker, 'lastChange' | 'onChange'>;
  /** The scheduler's `maxConcurrent`, shown next to the running count. */
  readonly limit: number;
}

/** Composes the scheduler and cache into snapshots for card 09's status page. Vscode-free. */
export class BackgroundStatus implements StatusSource {
  constructor(private readonly options: BackgroundStatusOptions) {}

  snapshot(): StatusSnapshot {
    const { scheduler, cache, clock, detector, label, tracker, limit } =
      this.options;
    const versionChange = tracker.lastChange();
    const takenAt = clock.now();
    const files = scheduler.files();
    const stats = scheduler.stats();
    const cached = cache.stats();
    const nextChangeAt = files
      .flatMap((file) => [file.eligibleAt, file.keptUntil])
      .filter((t): t is number => t !== undefined && t > takenAt)
      .reduce<number | undefined>(
        (earliest, t) =>
          earliest === undefined || t < earliest ? t : earliest,
        undefined,
      );
    return Object.freeze({
      label: label(),
      detector: `${detector.id}@${detector.version}`,
      takenAt,
      session: Object.freeze({
        analyses: stats.started,
        followUps: stats.followUps,
        repeats: stats.duplicates,
        cacheHits: cached.hits,
        cacheMisses: cached.misses,
        cacheStored: cached.stored,
      }),
      ...(versionChange !== undefined && {
        versionChange: Object.freeze({ ...versionChange }),
      }),
      concurrency: Object.freeze({ running: scheduler.running(), limit }),
      files,
      ...(nextChangeAt !== undefined && { nextChangeAt }),
    });
  }

  subscribe(listener: () => void): () => void {
    const fromScheduler = this.options.scheduler.onChange(listener);
    const fromTracker = this.options.tracker.onChange(listener);
    return () => {
      fromScheduler();
      fromTracker();
    };
  }
}
