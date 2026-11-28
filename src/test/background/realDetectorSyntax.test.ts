import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import type { DetectorInput } from '@/background/detector/detector';
import { RealDetector } from '@/background/detector/realDetector';
import type { FileSnapshot } from '@/background/events/fileEvents';
import { Scheduler } from '@/background/scheduler/scheduler';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';
import { initParser } from '@/test/context/parserSetup';
import {
  answer,
  candidate,
  createFakeClaude,
} from '@/test/detection/fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 14 US4: while a file is half-typed, Tree-sitter can hide or misplace top-level types
 * (card 12, rule 7). The real detector skips such a snapshot as a whole: no Claude call, no
 * guessed context, nothing cached, and no cooldown. A clean edit is analysed as usual.
 */

beforeAll(() => {
  initParser();
});

const W = 'file:///w';
const URI = 'file:///w/Foo.java';
const SECRET = 'SECRET_BODY_14_SYNTAX';
const COOLDOWN = 30_000;

/** Each broken file, and the clean file the user ends up with. */
const CASES = {
  // `@ class` reads as an annotation, so Foo's members scatter and Foo goes missing.
  'an unfinished @ above class Foo': {
    broken: [
      'class A {}',
      '@',
      'class Foo {',
      `  String s = "${SECRET}";`,
      '}',
      'class B {}',
    ],
    clean: [
      'class A {}',
      'class Foo {',
      `  String s = "${SECRET}";`,
      '}',
      'class B {}',
    ],
    types: 3,
  },
  'a misspelled clas': {
    broken: [
      'class A {}',
      'clas Foo {',
      `  String s = "${SECRET}";`,
      '}',
      'class B {}',
    ],
    clean: [
      'class A {}',
      'class Foo {',
      `  String s = "${SECRET}";`,
      '}',
      'class B {}',
    ],
    types: 3,
  },
  // A's missing `}` pulls B inside A.
  'a missing closing brace': {
    broken: [
      'class A {',
      `  void f() { String s = "${SECRET}"; }`,
      'class B {',
      '  void g() {}',
      '}',
    ],
    clean: [
      'class A {',
      `  void f() { String s = "${SECRET}"; }`,
      '}',
      'class B {',
      '  void g() {}',
      '}',
    ],
    types: 2,
  },
} as const;

const NAMES = Object.keys(CASES) as (keyof typeof CASES)[];

function input(content: string): DetectorInput {
  return {
    workspaceId: W,
    fileUri: URI,
    languageId: 'java',
    version: 1,
    contentHash: sha256Hex(content),
    content,
  };
}

function setup() {
  const claude = createFakeClaude({
    abstraction: answer(candidate('abstraction')),
  });
  const adrRequests: DetectorInput[] = [];
  const clock = createFakeTimers();
  const detector = new RealDetector({
    client: claude.client,
    adrsFor: (request) => {
      adrRequests.push(request);
      return [];
    },
    clock,
    fileNameOf: () => 'Foo.java',
  });
  return { claude, adrRequests, clock, detector };
}

describe('RealDetector skips snapshots with syntax errors (US4)', () => {
  test.each(NAMES)(
    '%s: skipped with no call, no ADR read and no timer (US4-1, US4-2)',
    async (name) => {
      const { claude, adrRequests, clock, detector } = setup();

      const result = await detector.analyse(
        input(CASES[name].broken.join('\n')),
        new AbortController().signal,
      );

      expect(result).toEqual({
        ok: false,
        failure: { kind: 'skipped', reason: 'syntax-errors' },
      });
      expect(claude.calls).toHaveLength(0);
      expect(adrRequests).toHaveLength(0);
      expect(clock.pendingCount).toBe(0);
    },
  );

  test.each(NAMES)(
    '%s: the clean file is analysed, every type called (US4-4)',
    async (name) => {
      const { claude, detector } = setup();

      const result = await detector.analyse(
        input(CASES[name].clean.join('\n')),
        new AbortController().signal,
      );

      expect(result.ok && result.output.findings).toHaveLength(
        CASES[name].types,
      );
      expect(claude.calls).toHaveLength(8 * CASES[name].types);
    },
  );

  test('an error outside every type still skips the whole file', async () => {
    const { claude, detector } = setup();

    const result = await detector.analyse(
      input(['class A {}', '}}} ;;', 'class C {}'].join('\n')),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'skipped' },
    });
    expect(claude.calls).toHaveLength(0);
  });
});

describe('a syntax-error snapshot through the scheduler (US4-3, SC-007)', () => {
  test.each(NAMES)(
    '%s: no cache write, no cooldown, the earlier result kept, and a clean edit resumes',
    async (name) => {
      const { claude, detector } = setup();
      const timers = createFakeTimers();
      const cache = new ResultCache({
        store: createMemoryCacheStore(),
        now: () => timers.now(),
      });
      const lines: string[] = [];
      const scheduler = new Scheduler({
        inner: { submit: () => undefined, closed: () => undefined },
        detector,
        cache,
        hash: sha256Hex,
        log: (line) => lines.push(line),
        clock: timers,
        quietMs: 0,
        cooldownMs: COOLDOWN,
      });
      let version = 0;
      const submit = (content: string): void => {
        scheduler.submit({
          workspaceId: W,
          fileUri: URI,
          languageId: 'java',
          version: ++version,
          content,
          trigger: 'edit',
          observedAt: timers.now(),
        } satisfies FileSnapshot);
      };
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      const { broken, clean, types } = CASES[name];
      const c = clean.join('\n');

      submit(c); // analysed and cached at t=0; cooldown until 30 s
      await settle();
      const callsForC = claude.calls.length;
      expect(callsForC).toBe(8 * types);
      expect(cache.stats().stored).toBe(1);

      timers.advance(COOLDOWN);
      submit(broken.join('\n')); // skipped
      await settle();
      expect(claude.calls).toHaveLength(callsForC);
      expect(cache.stats().stored).toBe(1);
      expect(
        lines.some((l) => l.includes('claude skipped: syntax errors')),
      ).toBe(true);
      expect(scheduler.fileState(W, URI)?.lastSettledAt).toBe(0);

      submit(c); // back to C: its result is still cached
      await settle();
      expect(claude.calls).toHaveLength(callsForC);
      expect(lines.some((l) => l.includes(' cache hit '))).toBe(true);

      submit(`${c}\n// edited`); // new clean content: no cooldown left from the skip
      await settle();
      expect(claude.calls).toHaveLength(2 * callsForC);
      expect(cache.stats().stored).toBe(2);

      expect(lines.join('\n')).not.toContain(SECRET);
      scheduler.dispose();
    },
  );
});
