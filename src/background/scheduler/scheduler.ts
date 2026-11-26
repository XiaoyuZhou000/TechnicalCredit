import type {
  CacheIdentity,
  CacheLookup,
  ResultCache,
} from '@/background/cache/resultCache';
import type { Detector, DetectorResult } from '@/background/detector/detector';
import type {
  FileClosedNotice,
  FileSnapshot,
  SnapshotSink,
} from '@/background/events/fileEvents';
import type { Clock } from '@/background/scheduler/clock';

/** Card 06's initial quiet period; tunable in code for Sprint 1. */
export const DEFAULT_QUIET_MS = 3000;

/** Card 07's initial cooldown after each detector completion; tunable in code for Sprint 1. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** Card 11's limit on background detector calls running at once, across all files. */
export const DEFAULT_MAX_CONCURRENT = 2;

/**
 * Node runs a timer with any longer delay after 1 ms, so a longer duration would make `wake`
 * reschedule itself in a tight loop.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One rule for every tunable duration, so a setting no timer can wait for fails loudly once. */
function durationOption(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be between 0 and ${MAX_TIMER_MS} ms, got ${value}`,
    );
  }
  return value;
}

function concurrencyOption(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `maxConcurrent must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}

export interface SchedulerOptions {
  /** Card 02's logging sink; always called first, so its lines stay unchanged. */
  readonly inner: SnapshotSink;
  readonly detector: Detector;
  readonly cache: ResultCache;
  /** SHA-256 hex of the content; the composition root passes card 04's `sha256Hex`. */
  readonly hash: (content: string) => string;
  readonly log: (line: string) => void;
  /** The only source of time; the composition root binds the real one. */
  readonly clock: Clock;
  /** Quiet period after a file's last meaningful change (card 06); 0 starts work at once. */
  readonly quietMs?: number;
  /** Pause after each detector completion, success or failure (card 07); 0 disables it. */
  readonly cooldownMs?: number;
  /** Most detector calls running at once across all files (card 11); 0 = no limit. */
  readonly maxConcurrent?: number;
  /** Called once per released request, after its store; tests and the later display use it. */
  readonly onSettled?: (event: SettledRequest) => void;
}

/** Never carries file text, so it is safe to log or keep. */
export interface SettledRequest {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly version: number;
  readonly n: number;
  readonly contentHash: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly result: DetectorResult;
  readonly stored: boolean;
  /** A success whose content and detector version still match the open file's latest snapshot. */
  readonly eligible: boolean;
}

export interface FileStateView {
  readonly active?: {
    readonly n: number;
    readonly version: number;
    readonly contentHash: string;
    readonly detectorVersion: string;
  };
  readonly pending?: {
    readonly version: number;
    readonly contentHash: string;
  };
  readonly latestHash: string;
  /** `observedAt` of the latest first report or meaningful change; repeats never move it. */
  readonly lastChangeAt: number;
  /**
   * While work is pending: when it may start, the later of `lastChangeAt` + the quiet period
   * and `lastSettledAt` + the cooldown (card 07).
   */
  readonly eligibleAt?: number;
  /**
   * While work is pending: which of the two deadlines sets `eligibleAt`, or `'slot'` when both
   * have passed and the work waits for a free call slot (card 11).
   */
  readonly waitingFor?: 'quiet' | 'cooldown' | 'slot';
  /**
   * `false` after close: while the closed file's request still runs, or (card 07) while its
   * cooldown does, so a reopen still waits for it. Closed files never receive results.
   */
  readonly open: boolean;
  readonly lastSettledAt?: number;
}

/**
 * Cumulative decision counts. "Pending" means work that can't start yet, for any of three
 * reasons: a request is running for the file, its quiet period hasn't passed (card 06), or its
 * cooldown hasn't (card 07). Read `fileState()` (`active`, `eligibleAt`, `waitingFor`) to tell
 * them apart.
 */
export interface SchedulerStats {
  readonly started: number;
  /** Calls started for pending work when the file's running request settled. */
  readonly followUps: number;
  /** Repeats (card 05), idle or not. */
  readonly duplicates: number;
  /** Pending work created: behind a running request, inside a quiet period or a cooldown. */
  readonly pendingHeld: number;
  /** Pending work replaced by newer content, for any of those reasons. */
  readonly pendingReplaced: number;
  /** Pending work cleared by a change back to the running content. */
  readonly pendingCleared: number;
  /** Pending work dropped on close. */
  readonly pendingDropped: number;
  /** Due work that missed the cache and queued for a free call slot (card 11). */
  readonly slotWaits: number;
}

/**
 * A file's latest detector result or cache answer, as card 09's status page shows it. Whether
 * it is current is decided when read, never stored, so a result can't go stale unnoticed.
 */
export interface Latest {
  readonly source: 'detector' | 'cache';
  /** `false` only for a failed, cancelled or timed-out request. */
  readonly ok: boolean;
  readonly findings?: number;
  /** Document version the outcome is for. */
  readonly version: number;
  /** Its content and detector version still match the open file. */
  readonly current: boolean;
  readonly at: number;
}

/** One row of `files()`: where the file is, its state, and its latest outcome. */
export interface FileStatus extends FileStateView {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly latest?: Latest;
  /** For a closed file kept only for its cooldown (card 07): when that record expires. */
  readonly keptUntil?: number;
}

interface LastOutcome {
  readonly source: 'detector' | 'cache';
  readonly ok: boolean;
  readonly findings?: number;
  readonly version: number;
  readonly contentHash: string;
  readonly detectorVersion: string;
  readonly at: number;
}

interface ActiveRequest {
  readonly n: number;
  readonly snapshot: FileSnapshot;
  readonly contentHash: string;
  readonly detectorVersion: string;
  readonly controller: AbortController;
}

interface PendingSnapshot {
  readonly snapshot: FileSnapshot;
  readonly contentHash: string;
  /** Detector version when it was observed: the same content under another version is new work. */
  readonly detectorVersion: string;
}

/** The file's single scheduled check; `token` tells a superseded callback apart from the current one. */
interface Wakeup {
  readonly token: number;
  readonly handle: unknown;
  readonly due: number;
}

interface FileState {
  readonly key: string;
  readonly workspaceId: string;
  readonly fileUri: string;
  active?: ActiveRequest;
  pending?: PendingSnapshot;
  /** Only while pending work waits for a deadline still ahead (card 06). */
  wakeup?: Wakeup;
  latestHash: string;
  /** Detector version when `latestHash` was observed; a new version makes old content new work. */
  latestDetectorVersion: string;
  /** `observedAt` of the latest first report or meaningful change; card 06 debounces from it. */
  lastChangeAt: number;
  open: boolean;
  lastSettledAt?: number;
  /** For card 09's status page; set on every settle and every cache hit. */
  lastOutcome?: LastOutcome;
  /** In the slot queue: due, missed the cache, waiting for a free call slot (card 11). */
  queued: boolean;
}

/** JSON encoding keeps two URIs from colliding the way plain concatenation could. */
function keyOf(workspaceId: string, fileUri: string): string {
  return JSON.stringify([workspaceId, fileUri]);
}

const iso = (ms: number): string => new Date(ms).toISOString();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * The single owner of per-file Background Agent state (ARCHITECTURE.md). Card 08 adds in-flight
 * deduplication: at most one detector request per file, with the latest different content kept
 * as pending. Card 05 makes repeats of a file's latest content observation only, whether or not
 * a request is running. Card 06 makes pending work wait for a quiet period after the last
 * meaningful change, with at most one wake-up per file. Card 07 adds a cooldown after every
 * detector completion to the same deadline, and keeps a closed file's state while it runs.
 * Card 09 adds read-only `files()` and `onChange` for the status page. Never logs file text or
 * findings.
 */
export class Scheduler implements SnapshotSink {
  private readonly inner: SnapshotSink;
  private readonly detector: Detector;
  private readonly cache: ResultCache;
  private readonly hash: (content: string) => string;
  private readonly log: (line: string) => void;
  private readonly clock: Clock;
  private readonly quietMs: number;
  private readonly cooldownMs: number;
  private readonly maxConcurrent: number;
  private readonly onSettled?: (event: SettledRequest) => void;
  private readonly states = new Map<string, FileState>();
  private readonly listeners = new Set<() => void>();
  private notifyQueued = false;
  private readonly counts: Record<keyof SchedulerStats, number> = {
    started: 0,
    followUps: 0,
    duplicates: 0,
    pendingHeld: 0,
    pendingReplaced: 0,
    pendingCleared: 0,
    pendingDropped: 0,
    slotWaits: 0,
  };
  private runningCount = 0;
  /** Files whose due work waits for a free slot, oldest first (card 11). */
  private slotQueue: FileState[] = [];
  private requests = 0;
  private wakeups = 0;
  private disposed = false;

  constructor(options: SchedulerOptions) {
    this.inner = options.inner;
    this.detector = options.detector;
    this.cache = options.cache;
    this.hash = options.hash;
    this.log = options.log;
    this.clock = options.clock;
    this.quietMs = durationOption(
      'quietMs',
      options.quietMs ?? DEFAULT_QUIET_MS,
    );
    this.cooldownMs = durationOption(
      'cooldownMs',
      options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    );
    this.maxConcurrent = concurrencyOption(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    );
    this.onSettled = options.onSettled;
  }

  submit(snapshot: FileSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.inner.submit(snapshot);
    const contentHash = this.hash(snapshot.content);
    const detectorVersion = this.detector.version;
    const key = keyOf(snapshot.workspaceId, snapshot.fileUri);
    const item: PendingSnapshot = { snapshot, contentHash, detectorVersion };
    let state = this.states.get(key);
    // A closed file's state survives only until its request settles, so a reopen is a first
    // report rather than a repeat.
    if (
      state?.open === true &&
      contentHash === state.latestHash &&
      detectorVersion === state.latestDetectorVersion
    ) {
      this.repeat(state, item);
      return;
    }
    if (state === undefined) {
      state = {
        key,
        workspaceId: snapshot.workspaceId,
        fileUri: snapshot.fileUri,
        latestHash: contentHash,
        latestDetectorVersion: detectorVersion,
        lastChangeAt: snapshot.observedAt,
        open: true,
        queued: false,
      };
      this.states.set(key, state);
    } else {
      state.latestHash = contentHash;
      state.latestDetectorVersion = detectorVersion;
      state.lastChangeAt = snapshot.observedAt;
      state.open = true;
    }
    if (state.active === undefined && this.isDue(state)) {
      if (state.pending !== undefined) {
        // Superseded by this snapshot, which starts now instead.
        state.pending = undefined;
        this.cancelWakeup(state);
      }
      this.dispatch(state, item);
    } else {
      this.hold(state, state.active, item);
    }
  }

  closed(notice: FileClosedNotice): void {
    if (this.disposed) {
      return;
    }
    this.inner.closed(notice);
    // Closes are rare, so they also clear out closed files whose cooldown has since expired.
    for (const other of this.states.values()) {
      this.forgetIfClosed(other);
    }
    const state = this.states.get(keyOf(notice.workspaceId, notice.fileUri));
    if (state === undefined) {
      return;
    }
    if (state.pending !== undefined) {
      this.counts.pendingDropped++;
      this.line(`pending dropped (closed) ${this.suffix(state.pending)}`);
      state.pending = undefined;
    }
    this.dequeue(state);
    this.cancelWakeup(state);
    state.open = false;
    // An active request is left to finish: a success is still worth caching for a reopen.
    this.forgetIfClosed(state);
    // A close with nothing pending logs no decision, but the file did change (PR #12 review).
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const state of this.states.values()) {
      this.cancelWakeup(state);
      state.active?.controller.abort();
    }
    this.states.clear();
    this.slotQueue = [];
    this.runningCount = 0;
  }

  fileState(workspaceId: string, fileUri: string): FileStateView | undefined {
    const key = keyOf(workspaceId, fileUri);
    const kept = this.states.get(key);
    // A closed file kept for its cooldown has no timer to drop it, so expiry is checked here too.
    if (kept !== undefined) {
      this.forgetIfClosed(kept);
    }
    const state = this.states.get(key);
    return state === undefined ? undefined : this.viewOf(state);
  }

  /**
   * Every tracked file, sorted, for card 09's status page. Like `fileState()`, it applies the
   * rules as they stand now: expired kept records are dropped first, and `latest.current` is
   * worked out here rather than stored.
   */
  files(): readonly FileStatus[] {
    for (const state of this.states.values()) {
      this.forgetIfClosed(state);
    }
    const rows = [...this.states.values()]
      .sort(
        (a, b) =>
          a.workspaceId.localeCompare(b.workspaceId) ||
          a.fileUri.localeCompare(b.fileUri),
      )
      .map((state) => this.statusOf(state));
    return Object.freeze(rows);
  }

  /**
   * Called once after any burst of decisions, never during one, so a slow or throwing listener
   * can't delay scheduling or see a half-made change (constitution VIII). Read the new state
   * through `files()` or `stats()`. Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private statusOf(state: FileState): FileStatus {
    const outcome = state.lastOutcome;
    const latest: Latest | undefined = outcome && {
      source: outcome.source,
      ok: outcome.ok,
      ...(outcome.findings !== undefined && { findings: outcome.findings }),
      version: outcome.version,
      current:
        outcome.contentHash === state.latestHash &&
        outcome.detectorVersion === this.detector.version &&
        state.open,
      at: outcome.at,
    };
    const kept =
      !state.open && state.active === undefined && state.pending === undefined
        ? this.cooldownDeadline(state)
        : undefined;
    return Object.freeze({
      workspaceId: state.workspaceId,
      fileUri: state.fileUri,
      ...this.viewOf(state),
      ...(latest && { latest: Object.freeze(latest) }),
      ...(kept !== undefined && { keptUntil: kept }),
    });
  }

  private viewOf(state: FileState): FileStateView {
    const { active, pending } = state;
    return Object.freeze({
      ...(active && {
        active: Object.freeze({
          n: active.n,
          version: active.snapshot.version,
          contentHash: active.contentHash,
          detectorVersion: active.detectorVersion,
        }),
      }),
      ...(pending && {
        pending: Object.freeze({
          version: pending.snapshot.version,
          contentHash: pending.contentHash,
        }),
      }),
      latestHash: state.latestHash,
      lastChangeAt: state.lastChangeAt,
      ...(pending && {
        eligibleAt: this.eligibleAt(state),
        waitingFor: state.queued ? 'slot' : this.waitingFor(state),
      }),
      open: state.open,
      ...(state.lastSettledAt !== undefined && {
        lastSettledAt: state.lastSettledAt,
      }),
    });
  }

  stats(): SchedulerStats {
    return Object.freeze({ ...this.counts });
  }

  /** Detector calls started and not yet settled, across all files (card 11). */
  running(): number {
    return this.runningCount;
  }

  /** Files currently holding a not-yet-started snapshot; never more than one each. */
  pendingCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.pending !== undefined) {
        count++;
      }
    }
    return count;
  }

  private identityOf(
    item: PendingSnapshot,
    detectorVersion = this.detector.version,
  ): CacheIdentity {
    return {
      workspaceId: item.snapshot.workspaceId,
      fileUri: item.snapshot.fileUri,
      contentHash: item.contentHash,
      detectorId: this.detector.id,
      detectorVersion,
    };
  }

  /** Lines about a running or settled request pass the version it ran under (card 11). */
  private suffix(
    item: PendingSnapshot,
    detectorVersion = this.detector.version,
  ): string {
    const { snapshot, contentHash } = item;
    return `v${snapshot.version} sha ${contentHash.slice(0, 8)} ${this.detector.id}@${detectorVersion} ${snapshot.fileUri}`;
  }

  /** Every decision is logged here, so this is also the one place that marks a change. */
  private line(text: string): void {
    this.log(`${iso(this.clock.now())} ${text}`);
    this.changed();
  }

  /** Batches a burst of decisions into one notification, delivered after the burst. */
  private changed(): void {
    if (this.notifyQueued || this.listeners.size === 0) {
      return;
    }
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      if (this.disposed) {
        return;
      }
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          // Logged past `line()`, so a listener that always throws can't re-arm the flush.
          this.log(
            `${iso(this.clock.now())} status listener error: ${messageOf(error)}`,
          );
        }
      }
    });
  }

  private quietDeadline(state: FileState): number {
    return state.lastChangeAt + this.quietMs;
  }

  /** Only after a completion (card 07); a cache hit is never one, so it never cools a file. */
  private cooldownDeadline(state: FileState): number | undefined {
    return state.lastSettledAt === undefined
      ? undefined
      : state.lastSettledAt + this.cooldownMs;
  }

  /**
   * When the file's pending work may start: the later of the quiet-period and cooldown
   * deadlines. Every timing rule lives here and in `isDue`, nowhere else.
   */
  private eligibleAt(state: FileState): number {
    return Math.max(
      this.quietDeadline(state),
      this.cooldownDeadline(state) ?? -Infinity,
    );
  }

  /*
   * A deadline whose setting is 0 never makes work wait, whatever the timestamps say; that
   * keeps earlier cards' behaviour exact (card 06 FR-010, card 07 FR-011).
   */
  private isQuiet(state: FileState): boolean {
    return this.quietMs === 0 || this.quietDeadline(state) <= this.clock.now();
  }

  private isCooled(state: FileState): boolean {
    const cooldown = this.cooldownDeadline(state);
    return (
      this.cooldownMs === 0 ||
      cooldown === undefined ||
      cooldown <= this.clock.now()
    );
  }

  /** Whether a detector call may start: past both deadlines. */
  private isDue(state: FileState): boolean {
    return this.isQuiet(state) && this.isCooled(state);
  }

  /**
   * When pending work can next move on: its quiet deadline, when the cache gets to answer, then
   * `eligibleAt`, when a call may start. The wake-up is always set for this time.
   */
  private nextCheckAt(state: FileState): number {
    return this.isQuiet(state)
      ? this.eligibleAt(state)
      : this.quietDeadline(state);
  }

  /** Which deadline sets `eligibleAt`: what card 09's status page shows as the waiting reason. */
  private waitingFor(state: FileState): 'quiet' | 'cooldown' {
    const cooldown = this.cooldownDeadline(state);
    return this.cooldownMs > 0 &&
      cooldown !== undefined &&
      cooldown > this.quietDeadline(state)
      ? 'cooldown'
      : 'quiet';
  }

  /**
   * A closed file with nothing running or waiting is forgotten, except while its cooldown runs:
   * closing and reopening a tab must not bypass the limit on calls (card 07 FR-016). The kept
   * state holds no timer, so an expired one goes on the next close or report.
   */
  private forgetIfClosed(state: FileState): void {
    if (
      state.open ||
      state.active !== undefined ||
      state.pending !== undefined
    ) {
      return;
    }
    const cooldown = this.cooldownDeadline(state);
    const coolingDown =
      this.cooldownMs > 0 &&
      cooldown !== undefined &&
      cooldown > this.clock.now();
    if (!coolingDown) {
      this.states.delete(state.key);
      // Also reached from reads such as `files()`: one extra render, and then nothing to drop.
      this.changed();
    }
  }

  /** At most one wake-up per file: a new deadline replaces the old timer rather than adding one. */
  private schedule(state: FileState, item: PendingSnapshot): void {
    this.cancelWakeup(state);
    const due = this.nextCheckAt(state);
    const token = ++this.wakeups;
    const handle = this.clock.setTimeout(
      () => this.wake(state, token),
      Math.max(0, due - this.clock.now()),
    );
    state.wakeup = { token, handle, due };
    // Names what the wake-up waits for: the quiet period first, then the cooldown.
    const reason = this.isQuiet(state) ? 'cooldown' : 'quiet';
    this.line(`${reason} until ${iso(due)} ${this.suffix(item)}`);
  }

  /** Keeps the file's one wake-up on its next check, rescheduling only when that moved. */
  private ensureWakeup(state: FileState, item: PendingSnapshot): void {
    if (state.wakeup?.due !== this.nextCheckAt(state)) {
      this.schedule(state, item);
    }
  }

  /**
   * Moves an idle file's pending work on, and reports whether a call started. Once the quiet
   * period has passed the cache answers at once: a hit costs no detector call, so the cooldown,
   * which limits calls, doesn't hold it back. A miss waits out the cooldown, and `dispatch`
   * checks the cache again right before the call.
   */
  private advance(state: FileState, fromQueue = false): boolean {
    const next = state.pending;
    if (next === undefined || state.active !== undefined || !state.open) {
      return false;
    }
    if (this.isDue(state)) {
      state.pending = undefined;
      this.cancelWakeup(state);
      return this.dispatch(state, next, fromQueue);
    }
    // A newer change moved the deadline: no longer due, so it gives up its place (rule 11).
    this.dequeue(state);
    if (this.isQuiet(state) && this.lookup(state, next)) {
      state.pending = undefined;
      this.cancelWakeup(state);
      return false;
    }
    this.ensureWakeup(state, next);
    return false;
  }

  private cancelWakeup(state: FileState): void {
    if (state.wakeup !== undefined) {
      this.clock.clearTimeout(state.wakeup.handle);
      state.wakeup = undefined;
    }
  }

  /**
   * The file's deadline has come. Nothing seen when the timer was set is trusted: the work may
   * have been replaced, cleared or closed since, or a request may now be running.
   */
  private wake(state: FileState, token: number): void {
    if (
      this.disposed ||
      this.states.get(state.key) !== state ||
      state.wakeup?.token !== token
    ) {
      return;
    }
    state.wakeup = undefined;
    const next = state.pending;
    if (!state.open || next === undefined) {
      return;
    }
    // The running request settles first, and its settlement moves `next` on.
    if (state.active !== undefined) {
      return;
    }
    this.advance(state);
  }

  /**
   * Same content and detector version as the file's latest report, which is what saves, Auto
   * Save and tab switches mostly are. The cache is not consulted: after a failed or unstored
   * analysis a lookup would miss and retry it with nothing new to analyse (card 05).
   */
  private repeat(state: FileState, item: PendingSnapshot): void {
    if (state.active !== undefined || state.pending !== undefined) {
      // The latest report is the running or the pending content, so `hold` only logs it.
      this.hold(state, state.active, item);
      return;
    }
    this.counts.duplicates++;
    this.line(`unchanged ${this.suffix(item)}`);
  }

  /**
   * Work that can't start yet: a request is running for this file, or its quiet period or
   * cooldown hasn't passed. Never starts or aborts a request. Content compares by hash, so
   * `open` + `activate`, unchanged saves and an edit followed by its undo are all duplicates.
   * The running request or the pending snapshot covers a snapshot only under its own detector
   * version: after a version change the same content is new work (card 11, rule 3), so a queued
   * file's replacement is re-checked against its quiet period and the slot queue.
   */
  private hold(
    state: FileState,
    active: ActiveRequest | undefined,
    item: PendingSnapshot,
  ): void {
    if (
      active !== undefined &&
      item.contentHash === active.contentHash &&
      item.detectorVersion === active.detectorVersion
    ) {
      if (state.pending === undefined) {
        this.counts.duplicates++;
        this.line(`duplicate of running ${this.suffix(item)}`);
      } else {
        // Back to the running content, which the active request already covers.
        state.pending = undefined;
        this.dequeue(state);
        this.cancelWakeup(state);
        this.counts.pendingCleared++;
        this.line(`pending cleared ${this.suffix(item)}`);
      }
      return;
    }
    if (
      item.contentHash === state.pending?.contentHash &&
      item.detectorVersion === state.pending.detectorVersion
    ) {
      this.counts.duplicates++;
      this.line(`duplicate of pending ${this.suffix(item)}`);
      return;
    }
    if (state.pending === undefined) {
      this.counts.pendingHeld++;
      this.line(`pending ${this.suffix(item)}`);
    } else {
      this.counts.pendingReplaced++;
      this.line(`pending replaced ${this.suffix(item)}`);
    }
    state.pending = item;
    if (active === undefined) {
      this.advance(state);
    } else if (this.isDue(state)) {
      // The running request's settlement starts this work.
      this.cancelWakeup(state);
    } else {
      this.ensureWakeup(state, item);
    }
  }

  /** Looks the content up and logs the outcome; true on a hit. */
  private lookup(state: FileState, item: PendingSnapshot): boolean {
    const lookup = this.cache.lookup(this.identityOf(item));
    if (lookup.hit) {
      const findings = lookup.entry.output.findings.length;
      state.lastOutcome = {
        source: 'cache',
        ok: true,
        findings,
        version: item.snapshot.version,
        contentHash: item.contentHash,
        detectorVersion: this.detector.version,
        at: this.clock.now(),
      };
      this.line(`cache hit ${findings} findings ${this.suffix(item)}`);
      return true;
    }
    this.line(`cache miss (${describeMiss(lookup)}) ${this.suffix(item)}`);
    return false;
  }

  /**
   * Only for a file with no active request: the cache decides whether a request starts, then
   * the global limit whether it starts now (rule 11). Only queued work may take a slot while
   * others wait, so a freed slot always goes to the file that has waited longest.
   */
  private dispatch(
    state: FileState,
    item: PendingSnapshot,
    fromQueue = false,
  ): boolean {
    if (this.lookup(state, item)) {
      this.dequeue(state);
      return false;
    }
    if (!this.hasSlot() || (!fromQueue && this.slotQueue.length > 0)) {
      this.enqueue(state, item);
      return false;
    }
    this.start(state, item);
    return true;
  }

  private hasSlot(): boolean {
    return this.maxConcurrent === 0 || this.runningCount < this.maxConcurrent;
  }

  /** Keeps the work pending with no timer; a still-due replacement keeps its place. */
  private enqueue(state: FileState, item: PendingSnapshot): void {
    state.pending = item;
    this.cancelWakeup(state);
    if (state.queued) {
      return;
    }
    state.queued = true;
    this.slotQueue.push(state);
    this.counts.slotWaits++;
    this.line(
      `waiting for slot (${this.runningCount} running) ${this.suffix(item)}`,
    );
  }

  private dequeue(state: FileState): void {
    if (!state.queued) {
      return;
    }
    state.queued = false;
    this.slotQueue = this.slotQueue.filter((queued) => queued !== state);
  }

  /** Gives freed slots to queued files in order; each is re-checked before its call. */
  private drain(): void {
    while (this.hasSlot() && this.slotQueue.length > 0) {
      const [state, ...rest] = this.slotQueue;
      this.slotQueue = rest;
      state.queued = false;
      if (this.states.get(state.key) === state) {
        this.advance(state, true);
      }
    }
  }

  private start(state: FileState, item: PendingSnapshot): void {
    const { snapshot, contentHash } = item;
    const active: ActiveRequest = {
      n: ++this.requests,
      snapshot,
      contentHash,
      detectorVersion: this.detector.version,
      controller: new AbortController(),
    };
    state.active = active;
    this.runningCount++;
    this.counts.started++;
    this.line(
      `${this.detector.id} start #${active.n} v${snapshot.version} ${snapshot.fileUri}`,
    );

    let call: Promise<DetectorResult>;
    try {
      // Called synchronously, so the request has started by the time `submit` returns.
      call = this.detector.analyse(
        {
          workspaceId: snapshot.workspaceId,
          fileUri: snapshot.fileUri,
          languageId: snapshot.languageId,
          version: snapshot.version,
          contentHash,
          content: snapshot.content,
        },
        active.controller.signal,
      );
    } catch (error) {
      call = Promise.reject(error);
    }
    // The contract says detectors never reject; a rejection is a defect, reported as a failure.
    const settled = call.catch(
      (error: unknown): DetectorResult => ({
        ok: false,
        failure: { kind: 'failed', message: messageOf(error) },
      }),
    );
    void this.settle(state, active, settled);
  }

  /** A throwing listener must not leave the file's pending work stranded. */
  private report(event: SettledRequest): void {
    if (this.onSettled === undefined) {
      return;
    }
    try {
      this.onSettled(event);
    } catch (error) {
      this.line(`settle listener error: ${messageOf(error)}`);
    }
  }

  /** A settlement only acts while its request is still the file's active one. */
  private isCurrent(state: FileState, active: ActiveRequest): boolean {
    return (
      !this.disposed &&
      this.states.get(state.key) === state &&
      state.active === active
    );
  }

  private async settle(
    state: FileState,
    active: ActiveRequest,
    call: Promise<DetectorResult>,
  ): Promise<void> {
    const result = await call;
    if (!this.isCurrent(state, active)) {
      return;
    }
    const { snapshot } = active;
    this.line(
      `${this.detector.id} ${describeOutcome(result)} #${active.n} v${snapshot.version} ${snapshot.fileUri}`,
    );

    let stored = false;
    let eligible = false;
    if (result.ok) {
      // Stored under the content actually analysed, and before release, so the next lookup
      // for this file already sees it. A stale result is still correct for its own content.
      const outcome = await this.cache.store(
        this.identityOf(active, active.detectorVersion),
        result,
      );
      if (!this.isCurrent(state, active)) {
        return;
      }
      stored = outcome.status === 'stored';
      if (outcome.status === 'stored') {
        this.line(
          `cache stored ${result.output.findings.length} findings ${this.suffix(active, active.detectorVersion)}`,
        );
      } else if (outcome.status === 'failed') {
        this.line(
          `cache store failed: ${outcome.message} ${this.suffix(active, active.detectorVersion)}`,
        );
      }
      // Decided after the store, so snapshots that arrived while storing count too. Caching and
      // showing are separate: only a current result may ever be shown (stale-result guard).
      eligible =
        active.contentHash === state.latestHash &&
        active.detectorVersion === this.detector.version &&
        state.open;
      this.line(
        `result ${eligible ? 'current' : 'stale'} #${active.n} v${snapshot.version} ${snapshot.fileUri}`,
      );
    }

    state.active = undefined;
    this.runningCount--;
    state.lastSettledAt = this.clock.now();
    state.lastOutcome = {
      source: 'detector',
      ok: result.ok,
      ...(result.ok && { findings: result.output.findings.length }),
      version: snapshot.version,
      contentHash: active.contentHash,
      detectorVersion: active.detectorVersion,
      at: state.lastSettledAt,
    };
    this.report({
      workspaceId: snapshot.workspaceId,
      fileUri: snapshot.fileUri,
      version: snapshot.version,
      n: active.n,
      contentHash: active.contentHash,
      detectorId: this.detector.id,
      detectorVersion: active.detectorVersion,
      result,
      stored,
      eligible,
    });

    // Only the latest pending snapshot goes on, through the cache; the settled request itself
    // is never retried here, even if it failed. This completion starts a cooldown, so work that
    // isn't due keeps waiting, its wake-up moved to its next check if that changed. While other
    // files wait for a slot, due follow-up work joins the back of their queue (rule 11).
    if (state.pending !== undefined) {
      if (this.advance(state)) {
        this.counts.followUps++;
      }
    } else {
      this.forgetIfClosed(state);
    }
    this.drain();
  }
}
