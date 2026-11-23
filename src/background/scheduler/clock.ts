import type { MockTimers } from '@/background/detector/mockDetector';

/**
 * The scheduler's only source of time. Extends the mock detector's `MockTimers`, so one fake
 * drives both in tests; the real clock is bound in the composition root, never in core code.
 */
export interface Clock extends MockTimers {
  /** Milliseconds, on the same scale as `FileSnapshot.observedAt`. */
  now(): number;
}
