/** Why a snapshot was taken. */
export type TriggerKind = 'open' | 'activate' | 'edit' | 'startup' | 'save';

/** Workspace id for files outside every workspace folder; can't collide with a URI (no ':'). */
export const NO_WORKSPACE_ID = 'no-workspace';

/** One notification about a supported file. Field names match `DetectorInput` minus `contentHash`. */
export interface FileSnapshot {
  /** Workspace folder URI string, or `NO_WORKSPACE_ID`. */
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly languageId: 'java';
  /** Document version at the moment of the event. */
  readonly version: number;
  /** Full document text at the moment of the event, read together with `version`. */
  readonly content: string;
  readonly trigger: TriggerKind;
  /** Milliseconds, from the injected time source. */
  readonly observedAt: number;
}

export interface FileClosedNotice {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly observedAt: number;
}

/**
 * The single hand-off from the monitor to the scheduler. Both methods run inside editor
 * event listeners, so they are synchronous and only record state: never hash, wait or call
 * a detector here. Whether a save triggers analysis, and what happens to a closed file's
 * work, is the sink's decision.
 */
export interface SnapshotSink {
  submit(snapshot: FileSnapshot): void;
  closed(notice: FileClosedNotice): void;
}

/** The parts of a document the monitor reads; `vscode.TextDocument` satisfies it structurally. */
export interface MonitoredDocument {
  readonly uri: { readonly scheme: string; toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
}

/** Supported means Java on disk; untitled buffers, diff views, output panels and the rest are ignored. */
export function isSupported(doc: MonitoredDocument): boolean {
  return doc.languageId === 'java' && doc.uri.scheme === 'file';
}

export interface FileEventHandlerOptions<D extends MonitoredDocument> {
  readonly sink: SnapshotSink;
  readonly now: () => number;
  readonly workspaceIdOf: (doc: D) => string | undefined;
  readonly onSinkError: (error: unknown) => void;
}

/**
 * Turns editor document events into snapshots. It reports and never decides: no
 * remembered versions, no merging, delaying or hashing (cards 04–08 do that).
 */
export class FileEventHandler<D extends MonitoredDocument> {
  private stopped = false;

  constructor(private readonly options: FileEventHandlerOptions<D>) {}

  opened(doc: D): void {
    this.forward(doc, 'open');
  }

  activated(doc: D | undefined): void {
    if (doc === undefined) {
      return;
    }
    this.forward(doc, 'activate');
  }

  stop(): void {
    this.stopped = true;
  }

  private forward(doc: D, trigger: TriggerKind): void {
    if (this.stopped || !isSupported(doc)) {
      return;
    }
    const snapshot: FileSnapshot = {
      workspaceId: this.workspaceIdFor(doc),
      fileUri: doc.uri.toString(),
      languageId: 'java',
      version: doc.version,
      content: doc.getText(),
      trigger,
      observedAt: this.options.now(),
    };
    this.deliver(() => this.options.sink.submit(snapshot));
  }

  private workspaceIdFor(doc: D): string {
    return this.options.workspaceIdOf(doc) ?? NO_WORKSPACE_ID;
  }

  /** One bad event must not silently disable monitoring for the rest of the session. */
  private deliver(send: () => void): void {
    try {
      send();
    } catch (error: unknown) {
      this.options.onSinkError(error);
    }
  }
}
