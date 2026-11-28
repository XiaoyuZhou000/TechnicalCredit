import type {
  DetectorInput,
  DetectorResult,
} from '@/background/detector/detector';
import {
  currentFingerprintInputs,
  detectorFingerprint,
} from '@/background/detector/fingerprint';
import {
  REAL_DETECTOR_ID,
  RealDetector,
  type RealDetectorOptions,
} from '@/background/detector/realDetector';
import type { AdrSummary } from '@/context/findAdrs';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { initParser } from '@/test/context/parserSetup';
import {
  answer,
  candidate,
  candidateResult,
  createFakeClaude,
  hold,
  type RecordedCall,
  type Script,
} from '@/test/detection/fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 14 US1: the real background detector analyses every top-level type of one clean
 * snapshot through the shared detection service, with an injected fake client. Offline only.
 */

beforeAll(() => {
  initParser();
});

const W = 'file:///w';
const URI = 'file:///w/src/demo/Shapes.java';
const SECRET = 'SECRET_BODY_14';

/** Four top-level types; `A` holds an inner class, and `B` starts with an annotation. */
const FOUR_TYPES = `package demo;

import java.util.List;

public class A {
  public static class Inner {
    void inner() { String s = "${SECRET}"; }
  }
}

interface I {
  void run();
}

enum E {
  ONE, TWO
}

@Deprecated
class B {
  List<String> items;
}
`;

/** 0-based declaration lines in FOUR_TYPES, counted by hand (annotations included). */
const LINES = { A: 4, I: 10, E: 14, B: 18 } as const;
type TypeName = keyof typeof LINES;

function input(content: string): DetectorInput {
  return {
    workspaceId: W,
    fileUri: URI,
    languageId: 'java',
    version: 7,
    contentHash: 'a'.repeat(64),
    content,
  };
}

/** The top-level type a call was made for, read from its "Class source" section. */
function typeOf(call: RecordedCall): TypeName {
  const source = call.user.split('Class source:\n')[1] ?? '';
  const match =
    /^(?:@\w+\s+)?(?:public\s+)?(class|interface|enum)\s+(\w+)/.exec(source);
  const name = match?.[2];
  if (name === 'A' || name === 'I' || name === 'E' || name === 'B') {
    return name;
  }
  throw new Error(`call for an unexpected type: ${String(name)}`);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup(
  script: Script = {},
  overrides: Partial<RealDetectorOptions> = {},
) {
  const claude = createFakeClaude(script);
  const adrRequests: DetectorInput[] = [];
  const detector = new RealDetector({
    client: claude.client,
    adrsFor: (request) => {
      adrRequests.push(request);
      return [];
    },
    clock: createFakeTimers(),
    fileNameOf: () => 'Shapes.java',
    ...overrides,
  });
  return { claude, detector, adrRequests };
}

function okFindings(result: DetectorResult) {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  }
  return result.output.findings;
}

describe('RealDetector identity', () => {
  test('has the id claude and the fingerprint of the code as built', () => {
    const { detector } = setup();
    expect(detector.id).toBe(REAL_DETECTOR_ID);
    expect(detector.id).toBe('claude');
    expect(detector.version).toBe(
      detectorFingerprint(currentFingerprintInputs()),
    );
  });
});

describe('RealDetector over a clean snapshot (US1)', () => {
  test('analyses each top-level type once, in source order, anchored to its declaration line (US1-1, SC-001)', async () => {
    const { claude, detector } = setup({
      abstraction: answer(candidate('abstraction')),
    });

    const result = await detector.analyse(
      input(FOUR_TYPES),
      new AbortController().signal,
    );

    const findings = okFindings(result);
    expect(findings).toEqual(
      (['A', 'I', 'E', 'B'] as const).map((name) => ({
        line: LINES[name],
        result: candidateResult('abstraction'),
      })),
    );
    if (result.ok) {
      expect(result.output.detectorId).toBe('claude');
      expect(result.output.detectorVersion).toBe(detector.version);
    }
    // 8 heuristic calls per type, grouped by type in source order.
    expect(claude.calls.map(typeOf)).toEqual([
      ...Array<TypeName>(8).fill('A'),
      ...Array<TypeName>(8).fill('I'),
      ...Array<TypeName>(8).fill('E'),
      ...Array<TypeName>(8).fill('B'),
    ]);
    expect(claude.calls.every((c) => c.kind === 'heuristic')).toBe(true);
  });

  test('never runs two types at once', async () => {
    const { claude, detector } = setup({
      modularity: hold(candidate('modularity')),
    });
    const pending = detector.analyse(
      input(FOUR_TYPES),
      new AbortController().signal,
    );

    const seenWhileHeld: TypeName[][] = [];
    for (let round = 0; round < 4; round++) {
      await settle();
      seenWhileHeld.push([...new Set(claude.calls.map(typeOf))]);
      expect(claude.held()).toBe(1);
      claude.releaseAll();
    }
    const findings = okFindings(await pending);

    expect(seenWhileHeld).toEqual([
      ['A'],
      ['A', 'I'],
      ['A', 'I', 'E'],
      ['A', 'I', 'E', 'B'],
    ]);
    expect(findings.map((f) => f.line)).toEqual([
      LINES.A,
      LINES.I,
      LINES.E,
      LINES.B,
    ]);
  });

  test('analyses an inner class only inside its outer type (US1-2)', async () => {
    const { claude, detector } = setup();
    await detector.analyse(input(FOUR_TYPES), new AbortController().signal);

    const forA = claude.calls.filter((c) => typeOf(c) === 'A');
    expect(forA).toHaveLength(8);
    expect(forA.every((c) => c.user.includes('class Inner'))).toBe(true);
    expect(
      claude.calls.some((c) =>
        /Class source:\n\s*public static class Inner/.test(c.user),
      ),
    ).toBe(false);
  });

  test.each([
    ['an empty file', ''],
    [
      'a file with only package and imports',
      'package demo;\n\nimport java.util.List;\n',
    ],
    ['a file with only comments', '// nothing here\n/* class Hidden {} */\n'],
  ])('%s is an empty success with no call (US1-4)', async (_name, content) => {
    const { claude, detector, adrRequests } = setup();

    const result = await detector.analyse(
      input(content),
      new AbortController().signal,
    );

    expect(okFindings(result)).toEqual([]);
    expect(claude.calls).toHaveLength(0);
    expect(adrRequests).toHaveLength(0);
  });

  test('no candidate in any type is an empty success (US1-5)', async () => {
    const { claude, detector } = setup();

    const result = await detector.analyse(
      input(FOUR_TYPES),
      new AbortController().signal,
    );

    expect(okFindings(result)).toEqual([]);
    expect(claude.calls).toHaveLength(32);
  });

  test('reads ADRs once per analysis and matches each type’s candidates against them', async () => {
    const adrs: readonly AdrSummary[] = [
      { id: 'ADR-007', title: 'Depend on abstractions', tcContext: '' },
    ];
    const requests: DetectorInput[] = [];
    const { claude, detector } = setup(
      {
        abstraction: answer(candidate('abstraction')),
        'adr:abstraction': answer({ adr: 'ADR-007' }),
      },
      {
        adrsFor: (request) => {
          requests.push(request);
          return adrs;
        },
      },
    );
    const snapshot = input(FOUR_TYPES);

    const findings = okFindings(
      await detector.analyse(snapshot, new AbortController().signal),
    );

    expect(requests).toEqual([snapshot]);
    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(4);
    expect(findings.map((f) => f.result.adr)).toEqual([
      'ADR-007',
      'ADR-007',
      'ADR-007',
      'ADR-007',
    ]);
  });

  test('builds each context with the file name it is given', async () => {
    const { claude, detector } = setup(
      {},
      { fileNameOf: (uri) => `name-of:${uri}` },
    );
    await detector.analyse(input(FOUR_TYPES), new AbortController().signal);

    expect(claude.calls[0].user).toContain(`File: name-of:${URI}`);
  });

  test('defaults the file name to the path of a file: URI', async () => {
    const claude = createFakeClaude();
    const detector = new RealDetector({
      client: claude.client,
      adrsFor: () => [],
      clock: createFakeTimers(),
    });
    await detector.analyse(input(FOUR_TYPES), new AbortController().signal);

    expect(claude.calls[0].user).toMatch(/File: .*Shapes\.java/);
  });

  test('an unavailable parser is a failure without file text, not an empty success', async () => {
    const { claude, detector } = setup(
      {},
      {
        enumerate: () =>
          Promise.resolve({ ok: false, reason: 'unavailable' } as const),
      },
    );

    const result = await detector.analyse(
      input(FOUR_TYPES),
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'construct enumeration unavailable' },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(claude.calls).toHaveLength(0);
  });

  test('an enumeration that throws becomes a failure, never a rejection', async () => {
    const { detector } = setup(
      {},
      { enumerate: () => Promise.reject(new Error('parser exploded')) },
    );

    const result = await detector.analyse(
      input(FOUR_TYPES),
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'real detector: parser exploded' },
    });
  });
});

describe('realDetector module', () => {
  test('loads without the Claude client, vscode, the manual command or the labeling UI (FR-008, FR-009)', () => {
    const forbidden = [
      '@/utils/claude',
      '@/analyse',
      '@/registry',
      '@/comment/pendingAnnotation',
    ];
    jest.isolateModules(() => {
      for (const name of forbidden) {
        jest.doMock(name, () => {
          throw new Error(`${name} must not be loaded`);
        });
      }
      jest.doMock(
        'vscode',
        () => {
          throw new Error('vscode must not be loaded');
        },
        { virtual: true },
      );
      expect(() =>
        jest.requireActual<typeof import('@/background/detector/realDetector')>(
          '@/background/detector/realDetector',
        ),
      ).not.toThrow();
      // Control: the guard fires for a forbidden module.
      expect(() => jest.requireMock('@/comment/pendingAnnotation')).toThrow(
        'must not be loaded',
      );
    });
  });
});
