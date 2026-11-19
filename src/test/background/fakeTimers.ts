import type { MockTimers } from '@/background/detector/mockDetector';

export interface FakeTimers extends MockTimers {
  /** Moves virtual time forward, running due callbacks in due-time order. */
  advance(ms: number): void;
  readonly pendingCount: number;
}

interface Scheduled {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

/** Hand-written so tests never patch global timers (time is injected; see ARCHITECTURE.md). */
export function createFakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  let scheduled: Scheduled[] = [];

  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      scheduled.push({ id, due: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      scheduled = scheduled.filter((s) => s.id !== handle);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = scheduled
          .filter((s) => s.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (due === undefined) {
          break;
        }
        scheduled = scheduled.filter((s) => s.id !== due.id);
        now = due.due;
        due.callback();
      }
      now = target;
    },
    get pendingCount() {
      return scheduled.length;
    },
  };
}
