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

export const DEFAULT_TIMELINE_LIMIT = 200;

export interface RequestTimelineOptions {
  /**
   * Monotonic milliseconds (`performance.now()` in the extension, the fake clock in tests), so
   * a wall-clock jump never distorts a measured duration.
   */
  readonly now: () => number;
  /** One line per finished request or cache hit; the caller adds its own timestamp. */
  readonly log: (line: string) => void;
  /** Records kept for `records()`; the oldest go first. */
  readonly limit?: number;
}

const NO_WAIT: WaitSplit = { quietMs: 0, cooldownMs: 0, inFlightMs: 0 };

interface Waiting {
  readonly wait: WaitSplit;
  /** Monotonic time the work became due, for the slot wait. */
  readonly dueAt?: number;
}

interface Running {
  readonly wait: WaitSplit;
  readonly slotMs: number;
  readonly startedAt: number;
}

function outcomeOf(
  result: DetectorResult,
): Pick<TimingRecord, 'outcome' | 'skipReason' | 'findings'> {
  if (result.ok) {
    return { outcome: 'done', findings: result.output.findings.length };
  }
  const { failure } = result;
  return failure.kind === 'skipped'
    ? { outcome: 'skipped', skipReason: failure.reason }
    : { outcome: failure.kind };
}

const ms = (value: number): number => Math.round(value);

/** The `timing …` line: metadata and durations, never file text. */
export function formatTiming(record: TimingRecord): string {
  const head =
    record.kind === 'hit' || record.n === undefined
      ? 'timing hit'
      : `timing #${record.n}`;
  const outcome =
    record.outcome === 'skipped' && record.skipReason !== undefined
      ? `skipped:${record.skipReason}`
      : record.outcome;
  const findings =
    record.findings === undefined ? '' : ` findings=${record.findings}`;
  return [
    `${head} v${record.version} ${record.detector}`,
    `wait quiet=${ms(record.quietMs)} cooldown=${ms(record.cooldownMs)} inflight=${ms(record.inFlightMs)} slot=${ms(record.slotMs)}`,
    `detector=${ms(record.detectorMs)} outcome=${outcome}${findings}`,
    `delivery=${record.delivery} ${record.fileUri}`,
  ].join(' ');
}

/**
 * Card 15A: turns the scheduler's transitions into one `TimingRecord` per request or cache hit.
 * Detector time and the slot wait come from the monotonic clock; the quiet, cooldown and
 * in-flight parts come from the scheduler's own deadlines. Observe-only.
 */
export class RequestTimeline implements SchedulerObserver {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly limit: number;
  private readonly waiting = new Map<string, Waiting>();
  private readonly running = new Map<number, Running>();
  private kept: TimingRecord[] = [];

  constructor(options: RequestTimelineOptions) {
    this.now = options.now;
    this.log = options.log;
    this.limit = options.limit ?? DEFAULT_TIMELINE_LIMIT;
  }

  /** The most recent records, oldest first. */
  records(): readonly TimingRecord[] {
    return [...this.kept];
  }

  changed(subject: TransitionSubject): void {
    this.waiting.set(subject.key, { wait: NO_WAIT });
  }

  due(subject: TransitionSubject, wait: WaitSplit): void {
    this.waiting.set(subject.key, { wait, dueAt: this.now() });
  }

  cacheHit(
    subject: TransitionSubject,
    wait: WaitSplit,
    findings: number,
  ): void {
    this.waiting.delete(subject.key);
    this.add({
      kind: 'hit',
      ...this.about(subject),
      ...wait,
      slotMs: 0,
      detectorMs: 0,
      outcome: 'hit',
      findings,
      delivery: 'n/a',
    });
  }

  slotWait(subject: TransitionSubject): void {
    const waiting = this.waiting.get(subject.key);
    if (waiting?.dueAt === undefined) {
      this.waiting.set(subject.key, {
        wait: waiting?.wait ?? NO_WAIT,
        dueAt: this.now(),
      });
    }
  }

  started(subject: TransitionSubject, n: number): void {
    const now = this.now();
    const waiting = this.waiting.get(subject.key);
    this.waiting.delete(subject.key);
    this.running.set(n, {
      wait: waiting?.wait ?? NO_WAIT,
      slotMs: waiting?.dueAt === undefined ? 0 : now - waiting.dueAt,
      startedAt: now,
    });
  }

  settled(subject: TransitionSubject, n: number, result: DetectorResult): void {
    const running = this.running.get(n);
    if (running === undefined) {
      return;
    }
    this.running.delete(n);
    this.add({
      kind: 'request',
      n,
      ...this.about(subject),
      ...running.wait,
      slotMs: running.slotMs,
      detectorMs: this.now() - running.startedAt,
      ...outcomeOf(result),
      delivery: 'n/a',
    });
  }

  private about(
    subject: TransitionSubject,
  ): Pick<TimingRecord, 'fileUri' | 'sha8' | 'version' | 'detector'> {
    return {
      fileUri: subject.fileUri,
      sha8: subject.sha8,
      version: subject.version,
      detector: subject.detector,
    };
  }

  private add(record: TimingRecord): void {
    this.kept.push(record);
    if (this.kept.length > this.limit) {
      this.kept = this.kept.slice(this.kept.length - this.limit);
    }
    this.log(formatTiming(record));
  }
}
