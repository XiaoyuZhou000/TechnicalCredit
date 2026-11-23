import type { Clock } from '@/background/scheduler/clock';
import type { StatusSource } from '@/background/status/backgroundStatus';
import { renderStatusHtml } from '@/background/status/statusView';

export interface StatusFeedOptions {
  readonly status: StatusSource;
  readonly clock: Clock;
  /** Receives each rendered page; the adapter assigns it to the webview. */
  readonly render: (html: string) => void;
  /** A fresh CSP nonce per render. */
  readonly nonce: () => string;
  readonly formatTime?: (ms: number) => string;
}

/**
 * Keeps one page in step with the agent: renders now and whenever the agent changes. All of
 * its timing runs on the injected clock, so it is tested offline (card 09). Vscode-free.
 */
export class StatusFeed {
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly options: StatusFeedOptions) {
    this.unsubscribe = options.status.subscribe(() => this.render());
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const { status, render, nonce, formatTime } = this.options;
    render(
      renderStatusHtml(status.snapshot(), {
        nonce: nonce(),
        ...(formatTime && { formatTime }),
      }),
    );
  }
}
