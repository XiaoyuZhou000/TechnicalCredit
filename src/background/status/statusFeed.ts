import type { Clock } from '@/background/scheduler/clock';
import type { StatusSource } from '@/background/status/backgroundStatus';
import { renderStatusHtml } from '@/background/status/statusView';

/** Typing produces bursts of changes; one render per this many ms is plenty for a page. */
export const RENDER_THROTTLE_MS = 200;

export interface StatusFeedOptions {
  readonly status: StatusSource;
  readonly clock: Clock;
  /** Receives each rendered page; the adapter assigns it to the webview. */
  readonly render: (html: string) => void;
  /** A fresh CSP nonce per render. */
  readonly nonce: () => string;
  readonly formatTime?: (ms: number) => string;
  /** A failed render is reported here and skipped; the next change renders again. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Keeps one page in step with the agent. It renders on opening, then at most once per
 * `RENDER_THROTTLE_MS` after changes, and once more at the snapshot's `nextChangeAt`, when
 * something changes with no event (a kept record expiring). It never polls. Every timer runs
 * on the injected clock, so it is tested offline (card 09). Vscode-free.
 */
export class StatusFeed {
  private readonly unsubscribe: () => void;
  private throttle?: unknown;
  private refresh?: unknown;
  private disposed = false;

  constructor(private readonly options: StatusFeedOptions) {
    this.unsubscribe = options.status.subscribe(() => this.changed());
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clear();
  }

  private changed(): void {
    if (this.disposed || this.throttle !== undefined) {
      return;
    }
    this.throttle = this.options.clock.setTimeout(() => {
      this.throttle = undefined;
      this.render();
    }, RENDER_THROTTLE_MS);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const { status, clock, render, nonce, formatTime, onError } = this.options;
    if (this.refresh !== undefined) {
      clock.clearTimeout(this.refresh);
      this.refresh = undefined;
    }
    const snapshot = status.snapshot();
    try {
      render(
        renderStatusHtml(snapshot, {
          nonce: nonce(),
          ...(formatTime && { formatTime }),
        }),
      );
    } catch (error) {
      // A page that can't draw must not take scheduling, or the next render, down with it.
      onError?.(error);
    }
    if (snapshot.nextChangeAt !== undefined) {
      this.refresh = clock.setTimeout(
        () => {
          this.refresh = undefined;
          this.render();
        },
        Math.max(0, snapshot.nextChangeAt - clock.now()),
      );
    }
  }

  private clear(): void {
    const { clock } = this.options;
    for (const handle of [this.throttle, this.refresh]) {
      if (handle !== undefined) {
        clock.clearTimeout(handle);
      }
    }
    this.throttle = undefined;
    this.refresh = undefined;
  }
}
