import {
  CACHE_KEY_PREFIX,
  ResultCache,
  sha256Hex,
  type CacheStore,
} from '@/background/cache/resultCache';
import { MockDetector } from '@/background/detector/mockDetector';
import { DetectorVersionTracker } from '@/background/detector/versionTracker';
import {
  FileEventHandler,
  type MonitoredDocument,
} from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
import {
  createMemoryCacheStore,
  type MemoryCacheStore,
} from '@/test/background/memoryCacheStore';

/**
 * Card 09's functional suite: real file-event handling, the scheduler with its production
 * quiet period and cooldown, the mock detector and the result cache, on one fake clock. No
 * `vscode`, no live client, no wall-clock waiting.
 */

const W = 'file:///w';
const QUIET = 3000;
const COOL = 30_000;
const MOCK_DELAY = 2000;

/** Just enough of a `vscode.TextDocument` for the event handler. */
class FakeDoc implements MonitoredDocument {
  version = 1;
  readonly uri: { readonly scheme: string; toString(): string };

  constructor(
    name: string,
    private text: string,
    readonly languageId = 'java',
    scheme = 'file',
  ) {
    const uri = `${scheme}:///w/${name}`;
    this.uri = { scheme, toString: () => uri };
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.version++;
  }
}

/** Lets every pending promise chain and microtask run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The whole Background Agent minus `vscode`, over `store` so a restart can share it. The
 * tracker shares the store too, as it shares `globalState` in production (card 11).
 */
function pipeline(
  store: CacheStore = createMemoryCacheStore(),
  options: { readonly version?: string } = {},
) {
  const clock = createFakeTimers();
  const mock = new MockDetector({
    timers: clock,
    delayMs: MOCK_DELAY,
    ...(options.version !== undefined && { version: options.version }),
  });
  const cache = new ResultCache({ store, now: () => clock.now() });
  const lines: string[] = [];
  const scheduler = new Scheduler({
    inner: { submit: () => undefined, closed: () => undefined },
    detector: mock,
    cache,
    hash: sha256Hex,
    log: (line) => lines.push(line),
    clock,
  });
  const errors: unknown[] = [];
  const events = new FileEventHandler<FakeDoc>({
    sink: scheduler,
    now: () => clock.now(),
    workspaceIdOf: () => W,
    onSinkError: (error) => errors.push(error),
  });
  const tracker = new DetectorVersionTracker({
    detector: mock,
    store,
    clock,
    log: (line) => lines.push(line),
    rescan: () => 0,
  });

  /** The composition root's start order: compare, startup scan, report, record. */
  const start = async (docs: readonly FakeDoc[]): Promise<void> => {
    tracker.begin();
    tracker.startupScheduled(events.startup(docs));
    await tracker.confirmStarted();
  };

  /** Advances in 100 ms steps, so async completions settle in order between timers. */
  const tick = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 100) {
      clock.advance(Math.min(100, left));
      await settle();
    }
  };
  /** Advances the fake clock to absolute time `t`. */
  const until = (t: number): Promise<void> => tick(t - clock.now());
  const edit = (doc: FakeDoc, text: string): void => {
    doc.setText(text);
    events.changed(doc, 1);
  };
  const shutdown = (): void => {
    events.stop();
    tracker.dispose();
    scheduler.dispose();
  };

  return {
    clock,
    mock,
    cache,
    scheduler,
    events,
    tracker,
    start,
    lines,
    errors,
    tick,
    until,
    edit,
    shutdown,
  };
}

const hashOf = (doc: FakeDoc): string => sha256Hex(doc.getText());

describe('functional suite: the Sprint 1 pipeline (card 09 US1)', () => {
  it('runs the full call sequence 0 -> 1 -> 1 -> 2 -> 2, newest content only (SC-001, US1-1)', async () => {
    const p = pipeline();
    const doc = new FakeDoc('A.java', 'class A { 0 }');
    const counts: number[] = [];

    p.events.opened(doc);
    for (let i = 1; i <= 5; i++) {
      await p.tick(1000);
      p.edit(doc, `class A { ${i} }`); // an edit every second
    }
    counts.push(p.mock.callCount);

    await p.tick(QUIET); // 3 s of quiet: the first analysis
    counts.push(p.mock.callCount);
    expect(p.mock.calls()[0].contentHash).toBe(hashOf(doc));

    for (let i = 6; i <= 15; i++) {
      await p.tick(1000);
      p.edit(doc, `class A { ${i} }`); // while running, then cooling down
    }
    counts.push(p.mock.callCount);
    expect(p.scheduler.files()[0].pending?.contentHash).toBe(hashOf(doc));

    await p.tick(COOL); // past both deadlines
    counts.push(p.mock.callCount);
    expect(p.mock.calls()[1].contentHash).toBe(hashOf(doc));

    await p.tick(COOL * 2); // nothing new to analyse
    counts.push(p.mock.callCount);

    expect(counts).toEqual([0, 1, 1, 2, 2]);
    expect(p.errors).toEqual([]);
    p.shutdown();
  });

  it('starts at the quiet and cooldown deadlines, never a millisecond before', async () => {
    const p = pipeline();
    const doc = new FakeDoc('A.java', 'class A { 1 }');
    p.events.opened(doc); // t = 0

    await p.until(QUIET - 1);
    expect(p.mock.callCount).toBe(0);
    await p.until(QUIET);
    expect(p.mock.callCount).toBe(1);

    const completion = QUIET + MOCK_DELAY;
    await p.until(completion + 1000);
    p.edit(doc, 'class A { 2 }');
    await p.until(completion + COOL - 1);
    expect(p.mock.callCount).toBe(1);
    await p.until(completion + COOL);
    expect(p.mock.callCount).toBe(2);
    p.shutdown();
  });

  it('adds no call or cache lookup for unchanged saves, Auto Saves, opens and activates (US1-2)', async () => {
    const p = pipeline();
    const doc = new FakeDoc('A.java', 'class A {}');
    p.events.opened(doc);
    await p.tick(QUIET + MOCK_DELAY + 100);
    const calls = p.mock.callCount;
    const lookups = p.cache.stats().hits + p.cache.stats().misses;

    for (let i = 0; i < 10; i++) {
      p.events.saved(doc); // Auto Save fires on every pause
      p.events.activated(doc);
      p.events.opened(doc);
      p.events.startup([doc]);
      await p.tick(1000);
    }
    await p.tick(COOL * 2);

    expect(p.mock.callCount).toBe(calls);
    expect(p.cache.stats().hits + p.cache.stats().misses).toBe(lookups);
    p.shutdown();
  });

  it('answers an undo from the cache once its quiet period ends, with no call (US1-3)', async () => {
    const p = pipeline();
    const doc = new FakeDoc('A.java', 'class A { 1 }');
    p.events.opened(doc);
    await p.until(QUIET + MOCK_DELAY + 1000); // analysed and stored, now cooling down
    p.edit(doc, 'class A { 2 }');
    await p.tick(1000);
    p.edit(doc, 'class A { 1 }'); // undo back to analysed content
    const undoneAt = p.clock.now();

    await p.until(undoneAt + QUIET);

    expect(p.lines.at(-1)).toContain('cache hit 1 findings');
    expect(p.mock.callCount).toBe(1);
    expect(p.scheduler.pendingCount()).toBe(0);
    p.shutdown();
  });

  it('leaves no timers behind once settled, and none after shutdown (US1-4)', async () => {
    const p = pipeline();
    const doc = new FakeDoc('A.java', 'class A { 1 }');
    p.events.opened(doc);
    await p.tick(QUIET + MOCK_DELAY + 100);

    expect(p.clock.pendingCount).toBe(0);

    p.edit(doc, 'class A { 2 }');
    expect(p.clock.pendingCount).toBe(1);
    await p.until(QUIET + MOCK_DELAY + COOL + 100); // the second analysis is running
    expect(p.mock.callCount).toBe(2);

    p.shutdown();

    expect(p.clock.pendingCount).toBe(0);
    await p.tick(COOL * 2);
    expect(p.mock.callCount).toBe(2);
  });

  it('drops work on close, ignores unsupported documents and treats startup like opens (US1-5)', async () => {
    const p = pipeline();
    const a = new FakeDoc('A.java', 'class A {}');
    const b = new FakeDoc('B.java', 'class B {}');
    const notes = new FakeDoc('notes.txt', 'hello', 'plaintext');
    const draft = new FakeDoc('Untitled-1', 'class D {}', 'java', 'untitled');

    p.events.startup([a, b, notes, draft]);
    p.events.opened(notes);
    expect(p.scheduler.files().map((f) => f.fileUri)).toEqual([
      'file:///w/A.java',
      'file:///w/B.java',
    ]);

    p.events.closed(b);
    await p.tick(QUIET + 100);

    expect(p.mock.calls().map((c) => c.fileUri)).toEqual(['file:///w/A.java']);
    expect(p.scheduler.stats().pendingDropped).toBe(1);
    p.shutdown();
  });
});

describe('functional suite: restart (card 09 US2)', () => {
  /** Session 1 analyses A and shuts down, leaving its result in `store`. */
  async function firstSession(store: CacheStore, doc: FakeDoc): Promise<void> {
    const first = pipeline(store);
    first.events.opened(doc);
    await first.tick(QUIET + MOCK_DELAY + 100);
    expect(first.mock.callCount).toBe(1);
    first.shutdown();
  }

  it('serves unchanged files from the cache after a restart, with a fresh call counter (SC-002, US2-1, US2-2)', async () => {
    const store = createMemoryCacheStore();
    const doc = new FakeDoc('A.java', 'class A {}');
    await firstSession(store, doc);

    const second = pipeline(store); // new scheduler, detector and cache over the same store
    second.events.startup([doc]);
    await second.tick(QUIET + 100);

    expect(second.lines.at(-1)).toContain('cache hit 1 findings');
    expect(second.mock.callCount).toBe(0);
    expect(second.scheduler.stats().started).toBe(0);
    expect(second.cache.stats().hits).toBe(1);
    expect(second.scheduler.files()[0].latest).toMatchObject({
      source: 'cache',
      current: true,
    });
    second.shutdown();
  });

  it('analyses a change after the restart with no cooldown carried over (US2-3)', async () => {
    const store = createMemoryCacheStore();
    const doc = new FakeDoc('A.java', 'class A {}');
    await firstSession(store, doc);

    const second = pipeline(store);
    second.events.startup([doc]);
    await second.tick(QUIET + 100);
    second.edit(doc, 'class A { int x; }');
    const changedAt = second.clock.now();

    await second.until(changedAt + QUIET - 1);
    expect(second.mock.callCount).toBe(0);
    await second.until(changedAt + QUIET);
    expect(second.mock.callCount).toBe(1);
    second.shutdown();
  });
});

describe('functional suite: detector version change at restart (card 11 US1)', () => {
  const docs = (): FakeDoc[] => [
    new FakeDoc('A.java', 'class A {}'),
    new FakeDoc('B.java', 'interface B {}'),
    new FakeDoc('C.java', 'class C { int c; }'),
  ];

  /** Session 1 under `mock-1`: analyses every file, records `mock-1`, shuts down. */
  async function firstSession(
    store: MemoryCacheStore,
    open: readonly FakeDoc[],
  ): Promise<void> {
    const first = pipeline(store, { version: 'mock-1' });
    await first.start(open);
    await first.tick(QUIET + MOCK_DELAY + 100);
    expect(first.mock.callCount).toBe(open.length);
    first.shutdown();
  }

  const storedVersions = (store: MemoryCacheStore): string[] =>
    store
      .keys()
      .filter((key) => key.startsWith(CACHE_KEY_PREFIX))
      .map((key) => {
        const parts: unknown = JSON.parse(key.slice(CACHE_KEY_PREFIX.length));
        return Array.isArray(parts) ? String(parts[3]) : '';
      })
      .sort();

  it('re-analyses every open file once under the new version, with no edit or reopen (US1-1, US1-2)', async () => {
    const store = createMemoryCacheStore();
    const open = docs();
    await firstSession(store, open);

    const second = pipeline(store, { version: 'mock-2' });
    await second.start(open);

    expect(
      second.lines.filter((line) => line.includes('detector version')),
    ).toEqual([
      expect.stringContaining(
        'detector version changed mock@mock-1 → mock@mock-2 (startup), 3 open files scheduled',
      ),
    ]);
    expect(second.tracker.lastChange()).toMatchObject({ scheduled: 3 });

    await second.tick(QUIET + MOCK_DELAY + 100);

    expect(second.mock.callCount).toBe(3);
    expect(second.mock.calls().map((c) => c.fileUri)).toEqual([
      'file:///w/A.java',
      'file:///w/B.java',
      'file:///w/C.java',
    ]);
    expect(
      second.scheduler
        .files()
        .map((f) => [f.latest?.source, f.latest?.current]),
    ).toEqual([
      ['detector', true],
      ['detector', true],
      ['detector', true],
    ]);
    expect(
      second.lines.filter((line) => line.includes('cache stored')).length,
    ).toBe(3);
    expect(
      second.lines.every(
        (line) =>
          !line.includes('cache stored') || line.includes('mock@mock-2'),
      ),
    ).toBe(true);
    // Versions never cross, and old entries are kept so a rollback can hit (cache rule 4).
    expect(storedVersions(store)).toEqual([
      'mock-1',
      'mock-1',
      'mock-1',
      'mock-2',
      'mock-2',
      'mock-2',
    ]);
    second.shutdown();
  });

  it('answers a file already analysed under the new version from the cache (US1-3)', async () => {
    const store = createMemoryCacheStore();
    const open = docs();
    await firstSession(store, open);
    // A session that analysed A under mock-2 but never confirmed its start.
    const partial = pipeline(store, { version: 'mock-2' });
    partial.events.opened(open[0]);
    await partial.tick(QUIET + MOCK_DELAY + 100);
    partial.shutdown();

    const second = pipeline(store, { version: 'mock-2' });
    await second.start(open);
    await second.tick(QUIET + MOCK_DELAY + 100);

    expect(second.tracker.lastChange()).toMatchObject({ scheduled: 3 });
    expect(second.mock.calls().map((c) => c.fileUri)).toEqual([
      'file:///w/B.java',
      'file:///w/C.java',
    ]);
    expect(second.scheduler.files()[0].latest).toMatchObject({
      source: 'cache',
      current: true,
    });
    second.shutdown();
  });

  it('answers a rollback from the old entries, with no call (US1-4)', async () => {
    const store = createMemoryCacheStore();
    const open = docs();
    await firstSession(store, open);
    const upgraded = pipeline(store, { version: 'mock-2' });
    await upgraded.start(open);
    await upgraded.tick(QUIET + MOCK_DELAY + 100);
    upgraded.shutdown();

    const rolledBack = pipeline(store, { version: 'mock-1' });
    await rolledBack.start(open);
    await rolledBack.tick(QUIET + MOCK_DELAY + 100);

    expect(rolledBack.tracker.lastChange()).toMatchObject({
      from: { detectorVersion: 'mock-2' },
      to: { detectorVersion: 'mock-1' },
    });
    expect(rolledBack.mock.callCount).toBe(0);
    rolledBack.shutdown();
  });
});

describe('functional suite: no version change, no extra calls (card 11 US2)', () => {
  it('makes no call for 60 s after an unchanged restart with every file analysed (US2-1, SC-001)', async () => {
    const store = createMemoryCacheStore();
    const a = new FakeDoc('A.java', 'class A {}');
    const b = new FakeDoc('B.java', 'class B {}');
    const first = pipeline(store, { version: 'mock-1' });
    await first.start([a, b]);
    await first.tick(QUIET + MOCK_DELAY + 100);
    expect(first.mock.callCount).toBe(2);
    first.shutdown();

    const second = pipeline(store, { version: 'mock-1' });
    await second.start([a, b]);
    await second.tick(60_000);

    expect(
      second.lines.filter((line) => line.includes('detector version')),
    ).toEqual([
      expect.stringContaining('detector version mock@mock-1 (unchanged)'),
    ]);
    expect(second.mock.callCount).toBe(0);
    expect(second.cache.stats().hits).toBe(2);
    second.shutdown();
  });

  it('analyses a file changed while VS Code was closed as ordinary new content (US2-3)', async () => {
    const store = createMemoryCacheStore();
    const a = new FakeDoc('A.java', 'class A {}');
    const b = new FakeDoc('B.java', 'class B {}');
    const first = pipeline(store, { version: 'mock-1' });
    await first.start([a, b]);
    await first.tick(QUIET + MOCK_DELAY + 100);
    first.shutdown();

    b.setText('class B { int edited; }'); // edited outside VS Code
    const second = pipeline(store, { version: 'mock-1' });
    await second.start([a, b]);
    await second.tick(QUIET + MOCK_DELAY + 100);

    expect(second.mock.calls().map((c) => c.fileUri)).toEqual([
      'file:///w/B.java',
    ]);
    expect(second.tracker.lastChange()).toBeUndefined();
    expect(second.lines.some((line) => line.includes('version changed'))).toBe(
      false,
    );
    second.shutdown();
  });
});
