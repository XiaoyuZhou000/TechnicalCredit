import { Parser } from 'web-tree-sitter';

import { buildContextFromSource, extractImports } from '@/context/buildContext';
import {
  enumerateConstructs,
  type ConstructDescriptor,
  type EnumerationResult,
} from '@/context/enumerateConstructs';
import { FIXTURES } from '@/test/context/fixtures';
import { initParser } from '@/test/context/parserSetup';

/** Offline tests for card 12's construct enumeration: no `vscode`, no Claude. */

beforeAll(() => {
  initParser();
});

/** The descriptors of a successful enumeration; fails the test otherwise. */
async function constructsOf(
  source: string,
  languageId = 'java',
): Promise<readonly ConstructDescriptor[]> {
  const result: EnumerationResult = await enumerateConstructs(
    source,
    'Fixture.java',
    languageId,
  );
  if (!result.ok) {
    throw new Error(
      `enumeration unavailable: is dist/*.wasm built (npm run compile)?`,
    );
  }
  return result.constructs;
}

/** The text between two zero-based positions, as `span` describes it. */
function sliceAt(source: string, span: ConstructDescriptor['span']): string {
  const lines = source.split('\n');
  const offset = (line: number, column: number): number =>
    lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) +
    column;
  return source.slice(
    offset(span.start.line, span.start.column),
    offset(span.end.line, span.end.column),
  );
}

const FOUR = [
  'package com.example;', // 0
  '', // 1
  'import java.util.List;', // 2
  'import java.util.Map;', // 3
  '', // 4
  '// first', // 5
  'class A {}', // 6
  '', // 7
  'public final class B {', // 8
  '  List<String> names;', // 9
  '}', // 10
  '', // 11
  'interface C { void c(); }', // 12
  '', // 13
  '  enum D { X, Y }', // 14
].join('\n');

describe('US1: every top-level construct, in source order', () => {
  it('returns classes, an interface and an enum in order, with names and positions', async () => {
    const constructs = await constructsOf(FOUR);

    expect(
      constructs.map((c) => [
        c.kind,
        c.name,
        c.line,
        c.column,
        c.nameLine,
        c.nameColumn,
      ]),
    ).toEqual([
      ['class', 'A', 6, 0, 6, 6],
      ['class', 'B', 8, 0, 8, 19],
      ['interface', 'C', 12, 0, 12, 10],
      ['enum', 'D', 14, 2, 14, 7],
    ]);
    expect(constructs.every((c) => !c.incomplete)).toBe(true);
  });

  it('starts a declaration at its annotations and leaves its Javadoc out', async () => {
    const source = [
      '/** Documented. */', // 0
      '@Deprecated', // 1
      '@SuppressWarnings("x")', // 2
      'public class A {}', // 3
    ].join('\n');
    const [a] = await constructsOf(source);

    expect([a.line, a.column, a.nameLine, a.nameColumn]).toEqual([1, 0, 3, 13]);
    expect(a.source.startsWith('@Deprecated')).toBe(true);
    expect(a.source).not.toContain('Documented');
    expect(a.context.insertLine).toBe(1);
  });

  it('gives the same positions for CRLF and LF line endings', async () => {
    const lf = await constructsOf(FOUR);
    const crlf = await constructsOf(FOUR.replace(/\n/g, '\r\n'));

    expect(crlf.map((c) => [c.line, c.column, c.span])).toEqual(
      lf.map((c) => [c.line, c.column, c.span]),
    );
  });

  it('gives each of two declarations on one line its own column', async () => {
    const constructs = await constructsOf('class A {} class B {}');

    expect(constructs.map((c) => [c.name, c.line, c.column])).toEqual([
      ['A', 0, 0],
      ['B', 0, 11],
    ]);
  });

  it('counts columns in UTF-16 code units, like editor positions', async () => {
    const [b] = await constructsOf('/* 学习 */ class B {}');

    expect([b.line, b.column]).toEqual([0, 9]);
  });

  it('skips records and annotation types', async () => {
    const constructs = await constructsOf(
      ['record R(int x) {}', '@interface Ann {}', 'class Kept {}'].join('\n'),
    );

    expect(constructs.map((c) => c.name)).toEqual(['Kept']);
  });

  it('gives each construct the exact source its span covers', async () => {
    const constructs = await constructsOf(FOUR);

    for (const c of constructs) {
      expect(sliceAt(FOUR, c.span)).toBe(c.source);
      expect(c.context.constructMetrics.classSource).toBe(c.source);
    }
  });

  it('is deterministic and frozen', async () => {
    const first = await enumerateConstructs(FOUR, 'Fixture.java', 'java');
    const second = await enumerateConstructs(FOUR, 'Fixture.java', 'java');

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    if (!first.ok) {
      throw new Error('enumeration unavailable');
    }
    expect(Object.isFrozen(first.constructs)).toBe(true);
    expect(Object.isFrozen(first.constructs[0])).toBe(true);
    expect(Object.isFrozen(first.constructs[0].span)).toBe(true);
    expect(Object.isFrozen(first.constructs[0].span.start)).toBe(true);
  });
});

describe('US2: each construct carries the manual context, from one parse', () => {
  it.each(FIXTURES)(
    '%s: class and interface contexts equal the manual one at the name',
    async (_name, source) => {
      const constructs = await constructsOf(source);
      const comparable = constructs.filter(
        (c) =>
          c.kind !== 'enum' && c.nameLine !== null && c.nameColumn !== null,
      );
      for (const c of comparable) {
        const manual = await buildContextFromSource(
          source,
          c.nameLine ?? 0,
          c.nameColumn ?? 0,
          'java',
          'Fixture.java',
        );
        expect(c.context).toEqual(manual);
      }
    },
  );

  it('compares at least one class and one interface across the fixtures', async () => {
    const kinds = new Set<string>();
    for (const [, source] of FIXTURES) {
      for (const c of await constructsOf(source)) {
        kinds.add(c.kind);
      }
    }
    expect(kinds).toEqual(new Set(['class', 'interface', 'enum']));
  });

  it('gives every descriptor the file package and imports, as its own copy', async () => {
    const constructs = await constructsOf(FOUR);

    for (const c of constructs) {
      expect(c.context.importLines).toEqual(extractImports(FOUR));
    }
    expect(constructs[0].context.importLines).not.toBe(
      constructs[1].context.importLines,
    );
  });

  it('parses the file once, however many constructs it holds', async () => {
    const five = [
      'class A {}',
      'class B {}',
      'interface C {}',
      'enum D { X }',
      'class E {}',
    ].join('\n');
    const parse = jest.spyOn(Parser.prototype, 'parse');
    try {
      const constructs = await constructsOf(five);
      expect(constructs).toHaveLength(5);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('adds no enumMetrics key to class or interface contexts, so prompts are unchanged', async () => {
    const constructs = await constructsOf(FOUR);

    for (const c of constructs.filter((d) => d.kind !== 'enum')) {
      expect('enumMetrics' in c.context.constructMetrics).toBe(false);
    }
  });
});

describe('US3: empty, declaration-free and broken files never crash', () => {
  it('gives an empty list for an empty file', async () => {
    expect(await enumerateConstructs('', 'Fixture.java', 'java')).toEqual({
      ok: true,
      constructs: [],
    });
  });

  it('gives an empty list for a file with only a package, imports and comments', async () => {
    const source = [
      'package com.example;',
      'import java.util.List;',
      '// nothing declared yet',
      '/* still nothing */',
    ].join('\n');

    expect(await constructsOf(source)).toEqual([]);
  });

  it('gives an empty list for text that is not Java at all', async () => {
    expect(await constructsOf('hello world @@@ ###')).toEqual([]);
  });

  it('does not parse a non-Java document', async () => {
    const parse = jest.spyOn(Parser.prototype, 'parse');
    try {
      expect(await constructsOf('class A {}', 'plaintext')).toEqual([]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('returns a class missing its closing braces, marked incomplete, and keeps the one before it', async () => {
    const constructs = await constructsOf(
      ['class A { void f() {} }', 'class B {', '  void g() {'].join('\n'),
    );

    expect(constructs.map((c) => [c.name, c.line, c.incomplete])).toEqual([
      ['A', 0, false],
      ['B', 1, true],
    ]);
  });

  it('marks only the class with a broken method as incomplete', async () => {
    const constructs = await constructsOf(
      ['class A {}', 'class B { void g( { }', 'class C {}'].join('\n'),
    );

    expect(constructs[0]).toMatchObject({ name: 'A', incomplete: false });
    expect(constructs[1]).toMatchObject({
      name: 'B',
      line: 1,
      incomplete: true,
    });
  });

  it('keeps both classes complete when the only error lies between them', async () => {
    const constructs = await constructsOf(
      ['class A {}', '}}} ;;', 'class C {}'].join('\n'),
    );

    expect(constructs.map((c) => [c.name, c.line, c.incomplete])).toEqual([
      ['A', 0, false],
      ['C', 2, false],
    ]);
  });

  it('reports "unavailable" without throwing or logging file text when the parser was never set up', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {
      // Silenced: the call itself is what this test checks.
    });
    try {
      let fresh: typeof enumerateConstructs | undefined;
      jest.isolateModules(() => {
        // A fresh module registry: this copy of the parser has no extension path.
        fresh = jest.requireActual<{
          enumerateConstructs: typeof enumerateConstructs;
        }>('@/context/enumerateConstructs').enumerateConstructs;
      });
      if (fresh === undefined) {
        throw new Error('isolated module did not load');
      }
      const result = await fresh(
        'class SECRET_TEXT_12 {}',
        'Fixture.java',
        'java',
      );

      expect(result).toEqual({ ok: false, reason: 'unavailable' });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errors.mock.calls)).not.toContain('SECRET_TEXT_12');
    } finally {
      errors.mockRestore();
    }
  });
});
