import type {
  Detector,
  DetectorInput,
  DetectorResult,
} from '@/background/detector/detector';

export const BACKGROUND_DETECTOR_ID = 'technicalcredit';

/** Which detector background analysis uses: the Sprint 1 mock or the real one (card 14). */
export type DetectorMode = 'mock' | 'real';

/** Whether live automatic calls may be made now. Card 15 supplies the real answer. */
export type LiveCallGate =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

export interface BackgroundDetectorOptions {
  readonly mock: Detector;
  readonly real: Detector;
  readonly mode: DetectorMode;
  /** Asked on every real-mode call, so the gate can open or close while the agent runs. */
  readonly liveCalls: () => LiveCallGate;
}

function versionOf(inner: Detector): string {
  return `${inner.id}:${inner.version}`;
}

const MOCK_LABEL = 'Sprint 1 mock detector';
const REAL_LABEL = 'Claude detector';

/**
 * Card 14: the one detector the scheduler and version tracker bind, delegating to the mock or
 * the real detector. Its version is `<inner id>:<inner version>`, so a switch is an ordinary
 * card 11 version change: it is announced, the open files are rescanned, and results never
 * cross between the two. Outputs carry this detector's id and the version in effect when the
 * call started. In real mode, a closed live-call gate skips the call (`live-disabled`) without
 * reaching the real detector, so no Claude call is made.
 */
export class BackgroundDetector implements Detector {
  readonly id = BACKGROUND_DETECTOR_ID;
  private currentMode: DetectorMode;
  private readonly mock: Detector;
  private readonly real: Detector;
  private readonly liveCalls: () => LiveCallGate;
  private readonly listeners = new Set<(version: string) => void>();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(options: BackgroundDetectorOptions) {
    this.mock = options.mock;
    this.real = options.real;
    this.currentMode = options.mode;
    this.liveCalls = options.liveCalls;
    for (const [mode, inner] of [
      ['mock', this.mock],
      ['real', this.real],
    ] as const) {
      const unsubscribe = inner.onVersionChange?.(() => {
        if (this.currentMode === mode) {
          this.announce();
        }
      });
      if (unsubscribe !== undefined) {
        this.unsubscribes.push(unsubscribe);
      }
    }
  }

  get mode(): DetectorMode {
    return this.currentMode;
  }

  get version(): string {
    return versionOf(this.active());
  }

  /** The version each mode would report now: every version whose results are still wanted. */
  get versions(): readonly string[] {
    return [versionOf(this.mock), versionOf(this.real)];
  }

  /** For the status page; read-only. */
  get label(): string {
    if (this.currentMode === 'mock') {
      return MOCK_LABEL;
    }
    const gate = this.liveCalls();
    return gate.permitted
      ? REAL_LABEL
      : `${REAL_LABEL} (live calls disabled: ${gate.reason})`;
  }

  /** Switches detector; announces when the version changes. The same mode is a no-op. */
  setMode(mode: DetectorMode): void {
    if (mode === this.currentMode) {
      return;
    }
    const before = this.version;
    this.currentMode = mode;
    if (this.version !== before) {
      this.announce();
    }
  }

  onVersionChange(listener: (version: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async analyse(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<DetectorResult> {
    // Captured at entry: a later switch must not relabel this call's output (rule 14).
    const mode = this.currentMode;
    const version = this.version;
    if (mode === 'real' && !this.liveCalls().permitted) {
      return {
        ok: false,
        failure: { kind: 'skipped', reason: 'live-disabled' },
      };
    }
    const result = await (mode === 'mock' ? this.mock : this.real).analyse(
      input,
      signal,
    );
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      output: {
        ...result.output,
        detectorId: this.id,
        detectorVersion: version,
      },
    };
  }

  dispose(): void {
    this.unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    this.listeners.clear();
  }

  private active(): Detector {
    return this.currentMode === 'mock' ? this.mock : this.real;
  }

  private announce(): void {
    const version = this.version;
    for (const listener of [...this.listeners]) {
      try {
        listener(version);
      } catch {
        // A subscriber's failure is its own to report; the others still hear the change.
      }
    }
  }
}
