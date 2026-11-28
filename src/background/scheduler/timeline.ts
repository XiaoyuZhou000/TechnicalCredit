import type {
  DetectorResult,
  SkipReason,
} from '@/background/detector/detector';

/**
 * How long a file's work waited, split by the scheduler's own deadlines (card 15A): the quiet
 * period, the cooldown, and the time spent behind the file's own running request (anything
 * else up to the moment the work became due).
 */
export interface WaitSplit {
  readonly quietMs: number;
  readonly cooldownMs: number;
  readonly inFlightMs: number;
}

/** What a transition is about. Never carries file text. */
export interface TransitionSubject {
  /** The scheduler's per-file key. */
  readonly key: string;
  readonly fileUri: string;
  /** Document version. */
  readonly version: number;
  /** First 8 characters of the content hash. */
  readonly sha8: string;
  /** `detectorId@detectorVersion` the work is for. */
  readonly detector: string;
}

/**
 * Card 15A: an optional observer of the scheduler's transitions, for timing. The scheduler
 * calls it inside `try/catch` and ignores what it returns, so an observer can never change a
 * decision. It must not call back into the scheduler, set timers or do I/O beyond logging.
 */
export interface SchedulerObserver {
  /** New work for the file: a first report or a meaningful change. */
  changed?(subject: TransitionSubject): void;
  /** The work became due: the quiet period and cooldown are over. */
  due?(subject: TransitionSubject, wait: WaitSplit): void;
  /** The cache answered; no detector call. */
  cacheHit?(
    subject: TransitionSubject,
    wait: WaitSplit,
    findings: number,
  ): void;
  /** Due work waits for a free call slot. */
  slotWait?(subject: TransitionSubject): void;
  /** A detector request started. */
  started?(subject: TransitionSubject, n: number): void;
  /** That request settled and was stored, and the slot is about to be released. */
  settled?(subject: TransitionSubject, n: number, result: DetectorResult): void;
}

/** One request or cache hit, as the timeline records it: metadata and durations only. */
export interface TimingRecord {
  readonly kind: 'request' | 'hit';
  /** The request number, as in `start #n`; absent for a cache hit. */
  readonly n?: number;
  readonly fileUri: string;
  readonly sha8: string;
  readonly version: number;
  readonly detector: string;
  readonly quietMs: number;
  readonly cooldownMs: number;
  readonly inFlightMs: number;
  /** From due (or the slot wait) to the start, on the monotonic clock. */
  readonly slotMs: number;
  /** From start to settle, on the monotonic clock; 0 for a cache hit. */
  readonly detectorMs: number;
  readonly outcome:
    | 'hit'
    | 'done'
    | 'failed'
    | 'timeout'
    | 'cancelled'
    | 'skipped';
  readonly skipReason?: SkipReason;
  readonly findings?: number;
  /** Result delivery is card 17's; until then it is not available. */
  readonly delivery: 'n/a';
}
