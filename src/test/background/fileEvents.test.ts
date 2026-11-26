import {
  FileEventHandler,
  NO_WORKSPACE_ID,
  rescanOrder,
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

describe('card 11: startup counts and rescans', () => {
  const mixed = (): FakeDoc[] => [
    fakeDoc(),
    ...UNSUPPORTED,
    fakeDoc({ uri: 'file:///w/B.java' }),
  ];

  it('startup returns how many supported documents it forwarded', () => {
    const { handler, sink } = makeHandler();

    expect(handler.startup(mixed())).toBe(2);
    expect(sink.snapshots).toHaveLength(2);
  });

  it('rescan forwards "version" snapshots in the given order and returns the count', () => {
    const { handler, sink } = makeHandler();
    const b = fakeDoc({
      uri: 'file:///w/B.java',
      version: 7,
      text: 'class B {}',
    });

    expect(handler.rescan([b, ...UNSUPPORTED, fakeDoc()])).toBe(2);
    expect(
      sink.snapshots.map((s) => [s.trigger, s.fileUri, s.version, s.content]),
    ).toEqual([
      ['version', 'file:///w/B.java', 7, 'class B {}'],
      ['version', 'file:///w/A.java', 1, 'class A {}'],
    ]);
  });

  it('rescan after stop forwards nothing and returns 0', () => {
    const { handler, sink } = makeHandler();
    handler.stop();

    expect(handler.rescan([fakeDoc()])).toBe(0);
    expect(handler.startup([fakeDoc()])).toBe(0);
    expect(sink.snapshots).toEqual([]);
  });

  it('still counts a document whose delivery threw, and reports the error', () => {
    const boom = new Error('sink failed');
    const { handler, errors } = makeHandler({
      sink: {
        submit: () => {
          throw boom;
        },
        closed: () => undefined,
      },
    });

    expect(
      handler.rescan([fakeDoc(), fakeDoc({ uri: 'file:///w/B.java' })]),
    ).toBe(2);
    expect(errors).toEqual([boom, boom]);
  });
});

describe('card 11: which open documents a runtime rescan reports', () => {
  const doc = (name: string): FakeDoc =>
    fakeDoc({ uri: `file:///w/${name}.java` });
  const uris = (docs: readonly FakeDoc[]): string[] =>
    docs.map((d) => d.uri.toString());

  it('keeps only documents shown in a tab', () => {
    const [a, b, c] = [doc('A'), doc('B'), doc('C')];
    const tabbed = new Set([a.uri.toString(), c.uri.toString()]);

    expect(uris(rescanOrder([a, b, c], tabbed, []))).toEqual([
      'file:///w/A.java',
      'file:///w/C.java',
    ]);
  });

  it('puts the active editor first, then visible editors, then the rest, each once', () => {
    const [a, b, c, d] = [doc('A'), doc('B'), doc('C'), doc('D')];
    const tabbed = new Set([a, b, c, d].map((x) => x.uri.toString()));

    expect(uris(rescanOrder([a, b, c, d], tabbed, [c, b, c]))).toEqual([
      'file:///w/C.java',
      'file:///w/B.java',
      'file:///w/A.java',
      'file:///w/D.java',
    ]);
  });

  it('skips a missing active editor and a preferred document with no tab', () => {
    const [a, b] = [doc('A'), doc('B')];
    const tabbed = new Set([a.uri.toString()]);

    expect(uris(rescanOrder([a, b], tabbed, [undefined, b]))).toEqual([
      'file:///w/A.java',
    ]);
  });

  it('feeds the handler, which still drops unsupported documents', () => {
    const { handler, sink } = makeHandler();
    const notes = fakeDoc({
      uri: 'file:///w/notes.txt',
      languageId: 'plaintext',
    });
    const a = doc('A');
    const tabbed = new Set([a.uri.toString(), notes.uri.toString()]);

    expect(handler.rescan(rescanOrder([notes, a], tabbed, [notes]))).toBe(1);
    expect(sink.snapshots.map((s) => s.fileUri)).toEqual(['file:///w/A.java']);
  });
});
