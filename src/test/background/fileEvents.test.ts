import {
  FileEventHandler,
  NO_WORKSPACE_ID,
  type FileClosedNotice,
  type FileEventHandlerOptions,
  type FileSnapshot,
  type MonitoredDocument,
  type SnapshotSink,
} from '@/background/events/fileEvents';

interface FakeDoc extends MonitoredDocument {
  version: number;
  text: string;
}

function fakeDoc({
  uri = 'file:///w/A.java',
  scheme = 'file',
  languageId = 'java',
  version = 1,
  text = 'class A {}',
}: {
  uri?: string;
  scheme?: string;
  languageId?: string;
  version?: number;
  text?: string;
} = {}): FakeDoc {
  return {
    uri: { scheme, toString: () => uri },
    languageId,
    version,
    text,
    getText() {
      return this.text;
    },
  };
}

class RecordingSink implements SnapshotSink {
  readonly snapshots: FileSnapshot[] = [];
  readonly notices: FileClosedNotice[] = [];

  submit(snapshot: FileSnapshot): void {
    this.snapshots.push(snapshot);
  }

  closed(notice: FileClosedNotice): void {
    this.notices.push(notice);
  }
}

function makeHandler(
  overrides: Partial<FileEventHandlerOptions<FakeDoc>> = {},
): {
  handler: FileEventHandler<FakeDoc>;
  sink: RecordingSink;
  errors: unknown[];
} {
  const sink = new RecordingSink();
  const errors: unknown[] = [];
  const handler = new FileEventHandler<FakeDoc>({
    sink,
    now: () => 1000,
    workspaceIdOf: (doc) =>
      doc.uri.toString().startsWith('file:///w/') ? 'file:///w' : undefined,
    onSinkError: (error) => errors.push(error),
    ...overrides,
  });
  return { handler, sink, errors };
}

const UNSUPPORTED: readonly FakeDoc[] = [
  fakeDoc({ uri: 'untitled:Untitled-1', scheme: 'untitled' }),
  fakeDoc({ uri: 'git:/w/A.java', scheme: 'git' }),
  fakeDoc({ uri: 'output:ext.log', scheme: 'output' }),
  fakeDoc({ uri: 'file:///w/notes.txt', languageId: 'plaintext' }),
  fakeDoc({ uri: 'vscode-userdata:/A.java', scheme: 'vscode-userdata' }),
];

describe('US1', () => {
  it('forwards one complete "open" snapshot for a Java file on disk', () => {
    const { handler, sink } = makeHandler();
    handler.opened(fakeDoc({ version: 3, text: 'class A { int x; }' }));

    expect(sink.snapshots).toEqual([
      {
        workspaceId: 'file:///w',
        fileUri: 'file:///w/A.java',
        languageId: 'java',
        version: 3,
        content: 'class A { int x; }',
        trigger: 'open',
        observedAt: 1000,
      },
    ]);
    expect(sink.notices).toEqual([]);
  });

  it('forwards "activate" and ignores focus leaving all editors', () => {
    const { handler, sink } = makeHandler();
    handler.activated(fakeDoc());
    handler.activated(undefined);

    expect(sink.snapshots.map((s) => s.trigger)).toEqual(['activate']);
  });

  it.each(UNSUPPORTED.map((doc) => [doc.uri.toString(), doc] as const))(
    'ignores %s silently',
    (_name, doc) => {
      const { handler, sink, errors } = makeHandler();
      handler.opened(doc);
      handler.activated(doc);

      expect(sink.snapshots).toEqual([]);
      expect(errors).toEqual([]);
    },
  );

  it('uses the placeholder workspace for files outside every folder', () => {
    const { handler, sink } = makeHandler();
    handler.opened(fakeDoc({ uri: 'file:///elsewhere/B.java' }));

    expect(sink.snapshots[0]?.workspaceId).toBe(NO_WORKSPACE_ID);
  });

  it('forwards duplicates as-is, leaving merging to the scheduler', () => {
    const { handler, sink } = makeHandler();
    const doc = fakeDoc();
    handler.opened(doc);
    handler.activated(doc);

    expect(sink.snapshots.map((s) => [s.trigger, s.version])).toEqual([
      ['open', 1],
      ['activate', 1],
    ]);
  });

  it('reports a throwing sink and keeps forwarding later events', () => {
    const boom = new Error('boom');
    let calls = 0;
    const delivered: FileSnapshot[] = [];
    const { handler, errors } = makeHandler({
      sink: {
        submit: (snapshot) => {
          calls += 1;
          if (calls === 1) {
            throw boom;
          }
          delivered.push(snapshot);
        },
        closed: () => undefined,
      },
    });

    handler.opened(fakeDoc());
    handler.opened(fakeDoc({ uri: 'file:///w/B.java' }));

    expect(errors).toEqual([boom]);
    expect(delivered.map((s) => s.fileUri)).toEqual(['file:///w/B.java']);
  });
});

describe('US2', () => {
  it('forwards each real edit with a higher version and the full new text', () => {
    const { handler, sink } = makeHandler();
    const doc = fakeDoc({ version: 1, text: 'class A {}' });

    for (const [version, text] of [
      [2, 'class A {x}'],
      [3, 'class A {xy}'],
      [4, 'class A {xyz}'],
    ] as const) {
      doc.version = version;
      doc.text = text;
      handler.changed(doc, 1);
    }

    expect(sink.snapshots.map((s) => [s.trigger, s.version])).toEqual([
      ['edit', 2],
      ['edit', 3],
      ['edit', 4],
    ]);
    expect(sink.snapshots.at(-1)?.content).toBe('class A {xyz}');
  });

  it('ignores change events that carry no content changes', () => {
    const { handler, sink } = makeHandler();
    handler.changed(fakeDoc(), 0);

    expect(sink.snapshots).toEqual([]);
  });

  it('ignores edits to unsupported files', () => {
    const { handler, sink } = makeHandler();
    handler.changed(
      fakeDoc({ uri: 'file:///w/notes.txt', languageId: 'plaintext' }),
      1,
    );

    expect(sink.snapshots).toEqual([]);
  });
});

describe('US3', () => {
  const notes = (): FakeDoc =>
    fakeDoc({ uri: 'file:///w/notes.txt', languageId: 'plaintext' });

  it('reports each supported document already open at startup once', () => {
    const { handler, sink } = makeHandler();
    handler.startup([fakeDoc(), notes(), fakeDoc({ uri: 'file:///w/B.java' })]);

    expect(sink.snapshots.map((s) => [s.trigger, s.fileUri])).toEqual([
      ['startup', 'file:///w/A.java'],
      ['startup', 'file:///w/B.java'],
    ]);
  });

  it('forwards a save with the current version and text', () => {
    const { handler, sink } = makeHandler();
    handler.saved(fakeDoc({ version: 5, text: 'class A { }' }));

    expect(sink.snapshots).toEqual([
      expect.objectContaining({
        trigger: 'save',
        version: 5,
        content: 'class A { }',
      }),
    ]);
  });

  it('reports a close without any file text', () => {
    const { handler, sink } = makeHandler();
    handler.closed(fakeDoc());
    handler.closed(notes());

    expect(sink.notices).toEqual([
      {
        workspaceId: 'file:///w',
        fileUri: 'file:///w/A.java',
        observedAt: 1000,
      },
    ]);
    expect(sink.snapshots).toEqual([]);
  });

  it('forwards nothing after stop', () => {
    const { handler, sink } = makeHandler();
    const doc = fakeDoc();
    handler.stop();

    handler.opened(doc);
    handler.activated(doc);
    handler.changed(doc, 1);
    handler.saved(doc);
    handler.closed(doc);
    handler.startup([doc]);

    expect(sink.snapshots).toEqual([]);
    expect(sink.notices).toEqual([]);
  });

  it('reports a throwing closed() and keeps forwarding later events', () => {
    const boom = new Error('boom');
    const delivered: FileSnapshot[] = [];
    const { handler, errors } = makeHandler({
      sink: {
        submit: (snapshot) => delivered.push(snapshot),
        closed: () => {
          throw boom;
        },
      },
    });

    handler.closed(fakeDoc());
    handler.opened(fakeDoc());

    expect(errors).toEqual([boom]);
    expect(delivered.map((s) => s.trigger)).toEqual(['open']);
  });
});
