import { buildContextFromSource } from '@/context/buildContext';
import { FIXTURES } from '@/test/context/fixtures';
import { initParser } from '@/test/context/parserSetup';

/**
 * Card 12: pins what the manual "Analyse for TC" path builds, before the shared context code is
 * refactored for construct enumeration (constitution v1.1.0 Principle V). Run with `--ci`, which
 * never writes a snapshot: a diff means the manual context changed, so fix the code, not the
 * snapshot. Offline: no `vscode`, no Claude.
 */

/** Every line's first non-blank column, plus each declared type's name position. */
function positions(source: string): readonly (readonly [number, number])[] {
  const seen = new Set<string>();
  const result: [number, number][] = [];
  const add = (line: number, column: number): void => {
    const key = `${line}:${column}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push([line, column]);
    }
  };
  source.split('\n').forEach((text, line) => {
    const first = text.search(/\S/);
    add(line, first === -1 ? 0 : first);
    for (const match of text.matchAll(/\b(?:class|interface|enum)\s+(\w+)/g)) {
      add(line, (match.index ?? 0) + match[0].length - match[1].length);
    }
  });
  return result;
}

beforeAll(() => {
  initParser();
});

describe('manual context, pinned before card 12', () => {
  it.each(FIXTURES)('%s', async (name, source) => {
    for (const [line, column] of positions(source)) {
      const context = await buildContextFromSource(
        source,
        line,
        column,
        'java',
        'Fixture.java',
      );
      expect(context).toMatchSnapshot(`${name} line ${line} col ${column}`);
    }
  });
});
