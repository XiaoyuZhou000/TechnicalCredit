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

export interface SchedulerOptions {
  /** Card 02's logging sink; always called first, so its lines stay unchanged. */
  readonly inner: SnapshotSink;
  readonly detector: Detector;
  readonly cache: ResultCache;
  /** SHA-256 hex of the content; the composition root passes card 04's `sha256Hex`. */
  readonly hash: (content: string) => string;
  readonly log: (line: string) => void;
  readonly now: () => number;
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
  readonly open: boolean;
  readonly lastSettledAt?: number;
}

export interface SchedulerStats {
  readonly started: number;
  readonly followUps: number;
  readonly duplicates: number;
  readonly pendingHeld: number;
  readonly pendingReplaced: number;
  readonly pendingCleared: number;
  readonly pendingDropped: number;
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
}

interface FileState {
  readonly key: string;
  active?: ActiveRequest;
  pending?: PendingSnapshot;
  latestHash: string;
  open: boolean;
  lastSettledAt?: number;
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
 * as pending. Cards 05–07 extend this class rather than adding their own state. Never logs file
 * text or findings.
 */
export class Scheduler implements SnapshotSink {
  private readonly inner: SnapshotSink;
  private readonly detector: Detector;
  private readonly cache: ResultCache;
  private readonly hash: (content: string) => string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly files = new Map<string, FileState>();
  private readonly counts: Record<keyof SchedulerStats, number> = {
    started: 0,
    followUps: 0,
    duplicates: 0,
    pendingHeld: 0,
    pendingReplaced: 0,
    pendingCleared: 0,
    pendingDropped: 0,
  };
  private requests = 0;
  private disposed = false;

  constructor(options: SchedulerOptions) {
    this.inner = options.inner;
    this.detector = options.detector;
    this.cache = options.cache;
    this.hash = options.hash;
    this.log = options.log;
    this.now = options.now;
  }

  submit(snapshot: FileSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.inner.submit(snapshot);
    const contentHash = this.hash(snapshot.content);
    const key = keyOf(snapshot.workspaceId, snapshot.fileUri);
    let state = this.files.get(key);
    if (state === undefined) {
      state = { key, latestHash: contentHash, open: true };
      this.files.set(key, state);
    }
    state.latestHash = contentHash;
    state.open = true;
    if (state.active !== undefined) {
      return;
    }
    this.dispatch(state, { snapshot, contentHash });
  }

  closed(notice: FileClosedNotice): void {
    if (this.disposed) {
      return;
    }
    this.inner.closed(notice);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.files.values()) {
      state.active?.controller.abort();
    }
    this.files.clear();
  }

  fileState(workspaceId: string, fileUri: string): FileStateView | undefined {
    const state = this.files.get(keyOf(workspaceId, fileUri));
    if (state === undefined) {
      return undefined;
    }
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
      open: state.open,
      ...(state.lastSettledAt !== undefined && {
        lastSettledAt: state.lastSettledAt,
      }),
    });
  }

  stats(): SchedulerStats {
    return Object.freeze({ ...this.counts });
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

  private suffix(item: PendingSnapshot): string {
    const { snapshot, contentHash } = item;
    return `v${snapshot.version} sha ${contentHash.slice(0, 8)} ${this.detector.id}@${this.detector.version} ${snapshot.fileUri}`;
  }

  private line(text: string): void {
    this.log(`${iso(this.now())} ${text}`);
  }

  /** Only for a file with no active request: the cache decides whether a request starts. */
  private dispatch(state: FileState, item: PendingSnapshot): boolean {
    const lookup = this.cache.lookup(this.identityOf(item));
    if (lookup.hit) {
      this.line(
        `cache hit ${lookup.entry.output.findings.length} findings ${this.suffix(item)}`,
      );
      return false;
    }
    this.line(`cache miss (${describeMiss(lookup)}) ${this.suffix(item)}`);
    this.start(state, item);
    return true;
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

  /** A settlement only acts while its request is still the file's active one. */
  private isCurrent(state: FileState, active: ActiveRequest): boolean {
    return (
      !this.disposed &&
      this.files.get(state.key) === state &&
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

    if (result.ok) {
      // Stored under the content actually analysed, and before release, so the next lookup
      // for this file already sees it.
      const outcome = await this.cache.store(
        this.identityOf(active, active.detectorVersion),
        result,
      );
      if (!this.isCurrent(state, active)) {
        return;
      }
      if (outcome.status === 'stored') {
        this.line(
          `cache stored ${result.output.findings.length} findings ${this.suffix(active)}`,
        );
      } else if (outcome.status === 'failed') {
        this.line(
          `cache store failed: ${outcome.message} ${this.suffix(active)}`,
        );
      }
    }

    state.active = undefined;
    state.lastSettledAt = this.now();
  }
}
