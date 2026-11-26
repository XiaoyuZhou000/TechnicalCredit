/** Why a snapshot was taken; `'version'` re-reports open files after a detector version change. */
export type TriggerKind =
  | 'open'
  | 'activate'
  | 'edit'
  | 'startup'
  | 'save'
  | 'version';

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

/**
 * Which loaded documents a runtime rescan reports, and in what order (card 11): only those shown
 * in an editor tab, so a closed tab whose document is still loaded and documents other
 * extensions load are skipped; the `preferred` ones (active editor, then visible editors)
 * first, then the rest in their loaded order, each once.
 */
export function rescanOrder<D extends MonitoredDocument>(
  loaded: readonly D[],
  tabbedUris: ReadonlySet<string>,
  preferred: readonly (D | undefined)[],
): D[] {
  const ordered: D[] = [];
  const seen = new Set<string>();
  for (const doc of [...preferred, ...loaded]) {
    if (doc === undefined) {
      continue;
    }
    const uri = doc.uri.toString();
    if (tabbedUris.has(uri) && !seen.has(uri)) {
      seen.add(uri);
      ordered.push(doc);
    }
  }
  return ordered;
}

export interface FileEventHandlerOptions<D extends MonitoredDocument> {
  readonly sink: SnapshotSink;
  readonly now: () => number;
  readonly workspaceIdOf: (doc: D) => string | undefined;
  readonly onSinkError: (error: unknown) => void;
}

/**
 * Turns editor document events into snapshots. It reports and never decides: no
 * remembered versions, no merging, delaying or hashing (cards 04–08 do that). A rescan after
 * a detector version change (card 11) is one more reason to report.
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

  /** Change events with no content changes only flip the dirty or saved state. */
  changed(doc: D, contentChangeCount: number): void {
    if (contentChangeCount === 0) {
      return;
    }
    this.forward(doc, 'edit');
  }

  /** Returns how many documents were forwarded, for card 11's version-change report. */
  startup(docs: readonly D[]): number {
    return this.forwardAll(docs, 'startup');
  }

  /** Re-reports open documents, in the given order, after a detector version change (card 11). */
  rescan(docs: readonly D[]): number {
    return this.forwardAll(docs, 'version');
  }

  /**
   * Saves don't change the version, so this repeats the last edit's version and text.
   * Whether a save triggers analysis is the scheduler's decision (card 05).
   */
  saved(doc: D): void {
    this.forward(doc, 'save');
  }

  /** Only reports the close; the scheduler decides what happens to pending or in-flight work. */
  closed(doc: D): void {
    if (this.stopped || !isSupported(doc)) {
      return;
    }
    const notice: FileClosedNotice = {
      workspaceId: this.workspaceIdFor(doc),
      fileUri: doc.uri.toString(),
      observedAt: this.options.now(),
    };
    this.deliver(() => this.options.sink.closed(notice));
  }

  stop(): void {
    this.stopped = true;
  }

  private forwardAll(docs: readonly D[], trigger: TriggerKind): number {
    let count = 0;
    for (const doc of docs) {
      if (this.forward(doc, trigger)) {
        count++;
      }
    }
    return count;
  }

  /** True when the document passed the filter, even if the sink then threw. */
  private forward(doc: D, trigger: TriggerKind): boolean {
    if (this.stopped || !isSupported(doc)) {
      return false;
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
    return true;
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
