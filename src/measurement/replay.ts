import {
  ResultCache,
  sha256Hex,
  type CacheStore,
} from '@/background/cache/resultCache';
import {
  failureFromAbort,
  type Detector,
  type DetectorInput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { TriggerKind } from '@/background/events/fileEvents';
import type { Clock } from '@/background/scheduler/clock';
import { Scheduler } from '@/background/scheduler/scheduler';
import {
  RequestTimeline,
  type SchedulerObserver,
} from '@/background/scheduler/timeline';
import {
  contentFor,
  TRACES,
  type EditTrace,
  type TraceEventKind,
} from '@/measurement/traces';

/** Where the committed replay table lives, relative to the repository root. */
export const REPLAY_FILE = 'measurements/ba-15a-replay.json';

/** Candidate settings; today's defaults (3 s quiet, 30 s cooldown) are part of the grid. */
export const REPLAY_GRID = {
  quietMs: [1000, 2000, 3000, 5000],
  cooldownMs: [0, 10_000, 30_000, 60_000],
} as const;

/**
 * Detector service times, measured by the live sample on 2026-11-28
 * (`measurements/ba-15a-live-runs.json`): the low end, median and high end of the per-file
 * detector time over its 4 runs (1, 1, 2 and 3 top-level types). Before that run the replay
 * used assumed values of 10, 20 and 40 s.
 */
export const SERVICE_MS: readonly number[] = [8567, 12_550, 22_539];

/** Matches the extension's default limit on calls running at once. */
const MAX_CONCURRENT = 2;
const W = 'file:///replay';
const URI = 'file:///replay/Replay.java';

export interface ReplayCell {
  readonly trace: string;
  readonly quietMs: number;
  readonly cooldownMs: number;
  readonly serviceMs: number;
  /** Detector calls started. */
  readonly calls: number;
  /** Successful results that were no longer current when they settled. */
  readonly stale: number;
  /**
   * From the last content change until a current result existed (a current settle or a cache
   * hit for that content); `null` if none did by the end of the replay.
   */
  readonly toCurrentMs: number | null;
  /** Quiet, cooldown, in-flight, late and slot waiting, summed over every request and hit. */
  readonly waitMs: number;
}

export interface ReplayTable {
  readonly note: string;
  readonly serviceMs: readonly number[];
  readonly grid: {
    readonly quietMs: readonly number[];
    readonly cooldownMs: readonly number[];
  };
  readonly cells: readonly ReplayCell[];
}

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

/** A discrete-event clock: time only moves when the replay moves it, to the next due event. */
class ReplayClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, due: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** The earliest pending timer's due time. */
  nextDue(): number | undefined {
    return this.timers.reduce<number | undefined>(
      (earliest, t) =>
        earliest === undefined || t.due < earliest ? t.due : earliest,
      undefined,
    );
  }

  /** Moves to `time`, running every timer due by then in due order. */
  advanceTo(time: number): void {
    for (;;) {
      const next = [...this.timers]
        .filter((t) => t.due <= time)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (next === undefined) {
        break;
      }
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.time = next.due;
      next.callback();
    }
    this.time = Math.max(this.time, time);
  }
}

/** Settles each call `serviceMs` after it starts, with no findings. */
class ReplayDetector implements Detector {
  readonly id = 'replay';
  readonly version = '1';

  constructor(
    private readonly clock: Clock,
    private readonly serviceMs: number,
  ) {}

  analyse(_input: DetectorInput, signal: AbortSignal): Promise<DetectorResult> {
    return new Promise((resolve) => {
      const handle = this.clock.setTimeout(
        () =>
          resolve({
            ok: true,
            output: {
              detectorId: this.id,
              detectorVersion: this.version,
              findings: [],
            },
          }),
        this.serviceMs,
      );
      signal.addEventListener(
        'abort',
        () => {
          this.clock.clearTimeout(handle);
          resolve(failureFromAbort(signal));
        },
        { once: true },
      );
    });
  }
}

function memoryStore(): CacheStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    update: (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
    keys: () => [...values.keys()],
  };
}

const TRIGGER: Readonly<Record<TraceEventKind, TriggerKind>> = {
  open: 'open',
  edit: 'edit',
  save: 'save',
  'undo-to': 'edit',
};

/** Lets the scheduler's promise chains (settle, store) finish before time moves on. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One trace under one candidate setting, through the real scheduler. */
export async function replayCell(
  trace: EditTrace,
  quietMs: number,
  cooldownMs: number,
  serviceMs: number,
): Promise<ReplayCell> {
  const clock = new ReplayClock();
  const timeline = new RequestTimeline({
    now: () => clock.now(),
    log: () => {},
  });
  const changes = trace.events.filter((e) => e.kind !== 'save');
  const last = changes[changes.length - 1];
  const lastHash8 =
    last === undefined
      ? undefined
      : sha256Hex(contentFor(last.contentId)).slice(0, 8);
  const lastAt = last?.atMs ?? 0;
  let currentAt: number | undefined;
  let stale = 0;

  const markCurrent = (sha8: string): void => {
    if (
      currentAt === undefined &&
      sha8 === lastHash8 &&
      clock.now() >= lastAt
    ) {
      currentAt = clock.now();
    }
  };
  // Fans out to the timeline, and spots the first current cache hit for the final content.
  const observer: SchedulerObserver = {
    changed: (s) => timeline.changed(s),
    due: (s, wait) => timeline.due(s, wait),
    cacheHit: (s, wait, findings) => {
      timeline.cacheHit(s, wait, findings);
      markCurrent(s.sha8);
    },
    slotWait: (s) => timeline.slotWait(s),
    started: (s, n) => timeline.started(s, n),
    settled: (s, n, result) => timeline.settled(s, n, result),
  };

  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector: new ReplayDetector(clock, serviceMs),
    cache: new ResultCache({ store: memoryStore(), now: () => clock.now() }),
    hash: sha256Hex,
    log: () => {},
    clock,
    quietMs,
    cooldownMs,
    maxConcurrent: MAX_CONCURRENT,
    observer,
    onSettled: (event) => {
      if (event.result.ok && !event.eligible) {
        stale++;
      }
      if (event.eligible) {
        markCurrent(event.contentHash.slice(0, 8));
      }
    },
  });

  let version = 0;
  const events = [...trace.events].sort((a, b) => a.atMs - b.atMs);
  let index = 0;
  for (;;) {
    const nextEvent = events[index]?.atMs;
    const nextTimer = clock.nextDue();
    if (nextEvent === undefined && nextTimer === undefined) {
      break;
    }
    if (
      nextEvent !== undefined &&
      (nextTimer === undefined || nextEvent <= nextTimer)
    ) {
      clock.advanceTo(nextEvent);
      const event = events[index++];
      if (event.kind !== 'save') {
        version++;
      }
      scheduler.submit({
        workspaceId: W,
        fileUri: URI,
        languageId: 'java',
        version,
        content: contentFor(event.contentId),
        trigger: TRIGGER[event.kind],
        observedAt: clock.now(),
      });
    } else if (nextTimer !== undefined) {
      clock.advanceTo(nextTimer);
    }
    await flush();
  }

  const records = timeline.records();
  scheduler.dispose();
  return {
    trace: trace.name,
    quietMs,
    cooldownMs,
    serviceMs,
    calls: records.filter((r) => r.kind === 'request').length,
    stale,
    toCurrentMs: currentAt === undefined ? null : currentAt - lastAt,
    waitMs: records.reduce(
      (sum, r) =>
        sum + r.quietMs + r.cooldownMs + r.inFlightMs + r.lateMs + r.slotMs,
      0,
    ),
  };
}

/** Every trace × candidate × service time, in a fixed order. */
export async function runReplay(
  serviceMs: readonly number[] = SERVICE_MS,
  traces: readonly EditTrace[] = TRACES,
): Promise<ReplayTable> {
  const cells: ReplayCell[] = [];
  for (const trace of traces) {
    for (const quietMs of REPLAY_GRID.quietMs) {
      for (const cooldownMs of REPLAY_GRID.cooldownMs) {
        for (const service of serviceMs) {
          cells.push(await replayCell(trace, quietMs, cooldownMs, service));
        }
      }
    }
  }
  return {
    note:
      serviceMs === SERVICE_MS
        ? 'serviceMs values are the low end, median and high end of per-file detector time measured by the live sample on 2026-11-28 (card 15A)'
        : 'serviceMs values were supplied by the caller (card 15A)',
    serviceMs: [...serviceMs],
    grid: {
      quietMs: [...REPLAY_GRID.quietMs],
      cooldownMs: [...REPLAY_GRID.cooldownMs],
    },
    cells,
  };
}

/** Stable, readable JSON with a final newline, as committed. */
export function replayTableJson(table: ReplayTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
