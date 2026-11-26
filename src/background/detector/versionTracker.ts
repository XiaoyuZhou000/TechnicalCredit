import type { CacheStore } from '@/background/cache/resultCache';
import type { Detector } from '@/background/detector/detector';
import type { Clock } from '@/background/scheduler/clock';

/** Where the identity of the last successful start is kept (machine-local, never synced). */
export const ACTIVE_DETECTOR_KEY = 'technicalCredit.activeDetector.v1';

export interface DetectorIdentity {
  readonly detectorId: string;
  readonly detectorVersion: string;
}

export interface VersionChange {
  readonly from: DetectorIdentity;
  readonly to: DetectorIdentity;
  readonly source: 'startup' | 'runtime';
  readonly at: number;
  /** Files the startup scan or rescan forwarded. */
  readonly scheduled: number;
}

/** `vscode.Memento` (`context.globalState`) satisfies this, as it does the result cache's store. */
export type IdentityStore = CacheStore;

export interface DetectorVersionTrackerOptions {
  readonly detector: Pick<Detector, 'id' | 'version' | 'onVersionChange'>;
  readonly store: IdentityStore;
  readonly clock: Pick<Clock, 'now'>;
  readonly log: (line: string) => void;
  /** Re-reports open files for a runtime change; returns how many were forwarded. */
  readonly rescan: () => number;
}

type StartupOutcome =
  | { readonly kind: 'first start' | 'unchanged' }
  | { readonly kind: 'changed'; readonly change: VersionChange };

export function formatIdentity(identity: DetectorIdentity): string {
  return `${identity.detectorId}@${identity.detectorVersion}`;
}

function sameIdentity(a: DetectorIdentity, b: DetectorIdentity): boolean {
  return (
    a.detectorId === b.detectorId && a.detectorVersion === b.detectorVersion
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Anything but a well-formed identity counts as nothing recorded, never as an error. */
function asIdentity(value: unknown): DetectorIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { detectorId, detectorVersion } = value;
  return isNonEmptyString(detectorId) && isNonEmptyString(detectorVersion)
    ? { detectorId, detectorVersion }
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const iso = (ms: number): string => new Date(ms).toISOString();

// "files", not "open files": the startup scan also forwards loaded documents with no tab.
const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Card 11: tells a restart under a different detector identity apart from an ordinary one,
 * handles a detector announcing a new version while it runs, and records the identity once the
 * agent has started. It never polls: it reacts only to `begin()` at startup and to the
 * detector's `onVersionChange`. Re-analysis itself is ordinary snapshots through the scheduler,
 * so this holds no per-file state. Nothing it does throws into its caller.
 */
export class DetectorVersionTracker {
  private readonly detector: DetectorVersionTrackerOptions['detector'];
  private readonly store: IdentityStore;
  private readonly clock: Pick<Clock, 'now'>;
  private readonly log: (line: string) => void;
  private readonly rescan: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe?: () => void;
  private startup?: StartupOutcome;
  private change?: VersionChange;
  /** The identity runtime announcements are compared with. */
  private lastActive: DetectorIdentity;
  /** Runtime changes are recorded only once the start itself has been. */
  private confirmed = false;
  private notifyQueued = false;
  private disposed = false;

  constructor(options: DetectorVersionTrackerOptions) {
    this.detector = options.detector;
    this.store = options.store;
    this.clock = options.clock;
    this.log = options.log;
    this.rescan = options.rescan;
    this.lastActive = this.active();
    this.unsubscribe = this.detector.onVersionChange?.(() => {
      this.announced();
    });
  }

  /** Compares the recorded identity with the active one. Logs and records nothing. */
  begin(): VersionChange | undefined {
    const recorded = this.readRecorded();
    const active = this.active();
    if (recorded === undefined) {
      this.startup = { kind: 'first start' };
    } else if (sameIdentity(recorded, active)) {
      this.startup = { kind: 'unchanged' };
    } else {
      this.change = {
        from: recorded,
        to: active,
        source: 'startup',
        at: this.clock.now(),
        scheduled: 0,
      };
      this.startup = { kind: 'changed', change: this.change };
    }
    return this.startup.kind === 'changed' ? this.startup.change : undefined;
  }

  /** Logs the startup outcome, with how many files the startup scan forwarded. */
  startupScheduled(count: number): void {
    if (this.disposed) {
      return;
    }
    if (this.startup === undefined) {
      this.begin();
    }
    const startup = this.startup;
    if (startup === undefined) {
      return;
    }
    if (startup.kind !== 'changed') {
      this.line(
        `detector version ${formatIdentity(this.active())} (${startup.kind})`,
      );
      return;
    }
    const change = { ...startup.change, scheduled: count };
    this.startup = { kind: 'changed', change };
    this.change = change;
    this.line(
      `detector version changed ${formatIdentity(change.from)} → ${formatIdentity(change.to)} (startup), ${files(count)} scheduled`,
    );
    this.changed();
  }

  /**
   * Records the identity active now. Called last in the composition root, so a start that
   * throws earlier leaves the old identity and the next start detects the change again.
   */
  async confirmStarted(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.confirmed = true;
    await this.record(this.active());
  }

  /** The session's last change, if any. */
  lastChange(): VersionChange | undefined {
    return this.change;
  }

  /** Notified once after each burst of changes, never during one. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.unsubscribe?.();
  }

  /**
   * The detector announced a version while running: handled like a startup change, through a
   * rescan of the open files. An announcement of the identity already active changes nothing.
   */
  private announced(): void {
    const to = this.active();
    if (this.disposed || sameIdentity(to, this.lastActive)) {
      return;
    }
    const from = this.lastActive;
    this.lastActive = to;
    let scheduled = 0;
    try {
      scheduled = this.rescan();
    } catch (error) {
      this.line(`detector rescan failed: ${messageOf(error)}`);
    }
    this.change = {
      from,
      to,
      source: 'runtime',
      at: this.clock.now(),
      scheduled,
    };
    this.line(
      `detector version changed ${formatIdentity(from)} → ${formatIdentity(to)} (runtime), ${files(scheduled)} scheduled`,
    );
    if (this.confirmed) {
      void this.record(to);
    }
    this.changed();
  }

  private active(): DetectorIdentity {
    return {
      detectorId: this.detector.id,
      detectorVersion: this.detector.version,
    };
  }

  private readRecorded(): DetectorIdentity | undefined {
    try {
      return asIdentity(this.store.get(ACTIVE_DETECTOR_KEY));
    } catch {
      return undefined;
    }
  }

  private async record(identity: DetectorIdentity): Promise<void> {
    try {
      await this.store.update(ACTIVE_DETECTOR_KEY, {
        detectorId: identity.detectorId,
        detectorVersion: identity.detectorVersion,
      });
    } catch (error) {
      this.line(`detector record failed: ${messageOf(error)}`);
    }
  }

  private line(text: string): void {
    this.log(`${iso(this.clock.now())} ${text}`);
  }

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
          this.line(`version listener error: ${messageOf(error)}`);
        }
      }
    });
  }
}
