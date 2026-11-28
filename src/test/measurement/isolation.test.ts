import * as fs from 'fs';
import * as path from 'path';

/**
 * Card 15A: the billed measurement code must be unreachable from the extension and from the
 * default test run. Walks the extension's import graph from `src/extension.ts`, through `@/`
 * aliases and relative imports, and checks nothing in it lives under `src/measurement/`.
 */

const SRC = path.join(__dirname, '../..');
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolve(from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = path.join(path.dirname(from), specifier);
  } else {
    return undefined; // a package
  }
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      const next =
        specifier === undefined ? undefined : resolve(file, specifier);
      if (next !== undefined) {
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('the live measurement code stays out of the extension and the default tests', () => {
  test('nothing reachable from src/extension.ts is under src/measurement/', () => {
    const files = reachable(path.join(SRC, 'extension.ts'));
    const relative = [...files].map((f) =>
      path.relative(SRC, f).replace(/\\/g, '/'),
    );

    expect(relative).toContain('background/backgroundAgent.ts');
    expect(relative).toContain('background/scheduler/timeline.ts');
    expect(relative.filter((f) => f.startsWith('measurement/'))).toEqual([]);
  });

  test('src/measurement/ holds no test file, so npm test never runs it', () => {
    const files = fs.readdirSync(path.join(SRC, 'measurement'));
    expect(files.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(files).toContain('liveLatency.ts');
  });
});
