import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { analyseForTC } from '@/analyse';
import type { PendingAnnotation } from '@/comment/pendingAnnotation';
import { setExtensionPath } from '@/context/javaParser';
import { HEURISTIC_CATEGORIES } from '@/prompts/heuristics';

import {
  answer,
  candidate,
  createFakeClaude,
  type FakeClaude,
  type Script,
} from './fakeClaude';
import * as fake from './vscodeFake';

jest.mock(
  'vscode',
  () => jest.requireActual<typeof fake>('./vscodeFake').vscodeModule,
  { virtual: true },
);

const mockClaude: { current: FakeClaude } = { current: createFakeClaude() };
jest.mock('@/utils/claude', () => ({
  callClaude: (system: string, user: string) =>
    mockClaude.current.client(system, user, new AbortController().signal),
}));

/*
 * Pins what the manual "Analyse for TC" command sends and previews, so card 13's refactor can
 * prove it unchanged. Written against the code before the refactor; afterwards only the way the
 * fake client reaches the command may change. Run with --ci: a snapshot diff is a regression.
 *
 * Previews are sorted because, before card 13, their order followed call completion.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'src/test/creational/prototype');
const FIXTURES = ['Positive.java', 'Negative.java'].map((name) => ({
  name,
  // LF, so the snapshot doesn't depend on the checkout's line endings (core.autocrlf).
  source: fs
    .readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')
    .replace(/\r\n/g, '\n'),
  // A stable, machine-independent path: it appears in the prompt.
  fileName: `/workspace/src/test/creational/prototype/${name}`,
}));

setExtensionPath(REPO_ROOT);

/** Top-level declarations: unindented lines declaring a class, interface or enum. */
function declarations(source: string) {
  return source.split('\n').flatMap((text, line) => {
    const match = /^[\w\s]*?\b(?:class|interface|enum)\s+(\w+)/.exec(text);
    return match && !/^\s/.test(text)
      ? [{ name: match[1], line, column: text.indexOf(match[1], match.index) }]
      : [];
  });
}

const CANDIDATES: Script = {
  modularity: answer(candidate('modularity')),
  reusability: answer(candidate('reusability')),
  'adr:modularity': answer({ adr: 'ADR-0001' }),
  'adr:reusability': answer({ adr: null }),
};

let adrRoot = '';

beforeAll(() => {
  adrRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-adrs-'));
  const docs = path.join(adrRoot, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(
    path.join(docs, '0001-plugin-registry.md'),
    '---\ntc-category: modularity\n---\n# Plugin registry\n',
  );
  fs.writeFileSync(
    path.join(docs, '0002-config-loading.md'),
    '---\ntc-category: configurability\n---\n# Config loading\n',
  );
});

afterAll(() => {
  fs.rmSync(adrRoot, { recursive: true, force: true });
});

interface Run {
  readonly claude: FakeClaude;
  readonly controller: ReturnType<typeof fake.fakeController>;
}

async function run(
  editor: fake.FakeEditor | undefined,
  script: Script,
  withAdrs: boolean,
  controller = fake.fakeController(),
): Promise<Run> {
  fake.resetVscodeFake();
  fake.state.activeTextEditor = editor;
  fake.state.workspaceFolders = withAdrs
    ? [{ uri: { fsPath: adrRoot } }]
    : undefined;
  mockClaude.current = createFakeClaude(script);
  await analyseForTC(controller as unknown as PendingAnnotation);
  return { claude: mockClaude.current, controller };
}

const sha16 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

function summary({ claude, controller }: Run) {
  const heuristic = claude.calls.filter((c) => c.kind === 'heuristic');
  const userPrompts = [...new Set(heuristic.map((c) => c.user))];
  expect(userPrompts.length).toBeLessThanOrEqual(1);
  if (heuristic.length > 0) {
    expect(heuristic.map((c) => c.category).sort()).toEqual(
      [...HEURISTIC_CATEGORIES].sort(),
    );
  }
  return {
    callCount: claude.calls.length,
    userPrompt: userPrompts[0] ?? null,
    systemPrompts: heuristic.map((c) => sha16(c.system)).sort(),
    adrPrompts: claude.calls
      .filter((c) => c.kind === 'adr')
      .map((c) => c.user)
      .sort(),
    previews: controller.previews.map((p) => ({
      insertLine: p.insertLine,
      texts: [...p.texts].sort(),
    })),
    messages: fake.state.messages,
    progress: fake.state.progress,
  };
}

describe('manual Analyse for TC: calls and previews', () => {
  for (const fixture of FIXTURES) {
    for (const decl of declarations(fixture.source)) {
      const editor = () =>
        fake.fakeEditor(
          fixture.source,
          decl.line,
          decl.column,
          fixture.fileName,
        );

      it(`${fixture.name} ${decl.name}: candidates with ADRs`, async () => {
        const result = await run(editor(), CANDIDATES, true);
        expect(result.controller.previews).toHaveLength(1);
        expect(summary(result)).toMatchSnapshot();
      });

      it(`${fixture.name} ${decl.name}: candidates without ADRs`, async () => {
        const result = await run(editor(), CANDIDATES, false);
        expect(
          result.claude.calls.filter((c) => c.kind === 'adr'),
        ).toHaveLength(0);
        expect(summary(result)).toMatchSnapshot();
      });

      it(`${fixture.name} ${decl.name}: no candidates`, async () => {
        const result = await run(editor(), {}, true);
        expect(result.controller.previews).toHaveLength(0);
        expect(summary(result)).toMatchSnapshot();
      });
    }
  }

  it('finds every top-level declaration in the fixtures', () => {
    expect(
      FIXTURES.map((f) => declarations(f.source).map((d) => d.name)),
    ).toEqual([
      ['Shape', 'Circle', 'Animal', 'Dog', 'Document', 'TextDocument'],
      ['ContactCard', 'ContactCardSnapshot', 'Invoice', 'Point'],
    ]);
  });
});

describe('manual Analyse for TC: no analysis', () => {
  it('reports a missing editor and makes no call', async () => {
    const result = await run(undefined, CANDIDATES, true);
    expect(result.claude.calls).toHaveLength(0);
    expect(summary(result)).toMatchSnapshot();
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: a cursor on the leading comment makes no call`, async () => {
      const result = await run(
        fake.fakeEditor(fixture.source, 0, 0, fixture.fileName),
        CANDIDATES,
        true,
      );
      expect(result.claude.calls).toHaveLength(0);
      expect(summary(result)).toMatchSnapshot();
    });
  }
});

describe('manual Analyse for TC: failure', () => {
  it('shows a failure, previews nothing, after the 8 heuristic calls', async () => {
    const [positive] = FIXTURES;
    const [first] = declarations(positive.source);
    const result = await run(
      fake.fakeEditor(
        positive.source,
        first.line,
        first.column,
        positive.fileName,
      ),
      {
        ...CANDIDATES,
        abstraction: { kind: 'reject', error: new Error('boom') },
      },
      true,
    );

    expect(result.claude.calls).toHaveLength(8);
    expect(result.controller.previews).toHaveLength(0);
    const errors = fake.state.messages.filter((m) => m.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].text.startsWith('Analyse for TC failed: ')).toBe(true);
  });
});
