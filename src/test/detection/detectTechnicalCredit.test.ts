import * as fs from 'fs';
import * as path from 'path';

import { buildContextFromSource, type TcContext } from '@/context/buildContext';
import type { AdrSummary } from '@/context/findAdrs';
import { setExtensionPath } from '@/context/javaParser';
import { detectTechnicalCredit } from '@/detection/detectTechnicalCredit';
import { ADR_SYSTEM_PROMPT, createAdrUserPrompt } from '@/prompts/adrPrompt';
import { HEURISTIC_CATEGORIES } from '@/prompts/heuristics';
import { createUserPrompt } from '@/prompts/userPrompts';

import {
  answer,
  candidate,
  candidateResult,
  createFakeClaude,
  heuristicSystemPrompt,
  hold,
  type Script,
} from './fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/*
 * Card 13: the shared detection service, called with a supplied context and a fake client.
 * No `vscode` mock: the service must load and run without the extension host.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const POSITIVE = fs
  .readFileSync(
    path.join(REPO_ROOT, 'src/test/creational/prototype/Positive.java'),
    'utf-8',
  )
  .replace(/\r\n/g, '\n');

const ADRS: readonly AdrSummary[] = [
  {
    id: 'ADR-0001',
    title: 'Plugin registry',
    tcContext: 'tc-category: modularity',
  },
  { id: 'ADR-0002', title: 'Config loading', tcContext: '' },
];

let context: TcContext;

beforeAll(async () => {
  setExtensionPath(REPO_ROOT);
  const line = POSITIVE.split('\n').findIndex((l) =>
    l.startsWith('class Circle'),
  );
  const built = await buildContextFromSource(
    POSITIVE,
    line,
    'class '.length,
    'java',
    'Positive.java',
  );
  if (built === null) {
    throw new Error('expected a context for Circle');
  }
  context = built;
});

const signal = () => new AbortController().signal;

const TWO_CANDIDATES: Script = {
  modularity: answer(candidate('modularity')),
  reusability: answer(candidate('reusability')),
};

describe('US1: detection runs without an editor', () => {
  it("makes one heuristic call per category with today's prompts and a signal", async () => {
    const claude = createFakeClaude();
    await detectTechnicalCredit({ context, adrs: [] }, claude.client, signal());

    expect(claude.calls).toHaveLength(HEURISTIC_CATEGORIES.length);
    HEURISTIC_CATEGORIES.forEach((category, i) => {
      const call = claude.calls[i];
      expect(call.kind).toBe('heuristic');
      expect(call.category).toBe(category);
      expect(call.system).toBe(heuristicSystemPrompt(category));
      expect(call.user).toBe(createUserPrompt(context));
      expect(call.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it('returns the candidates in category order, whatever order the calls finish in', async () => {
    const claude = createFakeClaude({
      reusability: hold(candidate('reusability')),
      modularity: hold(candidate('modularity')),
      abstraction: hold(candidate('abstraction')),
    });
    const pending = detectTechnicalCredit(
      { context, adrs: [] },
      claude.client,
      signal(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    claude.releaseAll('reverse');
    const outcome = await pending;

    expect(outcome.ok && outcome.findings.map((f) => f.category)).toEqual([
      'abstraction',
      'modularity',
      'reusability',
    ]);
  });

  it('returns the full answers of the candidates only', async () => {
    const claude = createFakeClaude(TWO_CANDIDATES);
    const outcome = await detectTechnicalCredit(
      { context, adrs: [] },
      claude.client,
      signal(),
    );

    expect(outcome).toEqual({
      ok: true,
      findings: [candidateResult('modularity'), candidateResult('reusability')],
    });
  });

  it('treats no candidates as a successful, empty result', async () => {
    const claude = createFakeClaude();
    expect(
      await detectTechnicalCredit(
        { context, adrs: ADRS },
        claude.client,
        signal(),
      ),
    ).toEqual({ ok: true, findings: [] });
    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(0);
  });

  it('matches each candidate to the ADRs with one call, recording the answer', async () => {
    const claude = createFakeClaude({
      ...TWO_CANDIDATES,
      'adr:modularity': answer({ adr: 'ADR-0001' }),
      'adr:reusability': answer({ adr: null }),
    });
    const outcome = await detectTechnicalCredit(
      { context, adrs: ADRS },
      claude.client,
      signal(),
    );

    const adrCalls = claude.calls.filter((c) => c.kind === 'adr');
    expect(adrCalls.map((c) => c.category).sort()).toEqual([
      'modularity',
      'reusability',
    ]);
    for (const call of adrCalls) {
      expect(call.system).toBe(ADR_SYSTEM_PROMPT);
    }
    expect(adrCalls.map((c) => c.user).sort()).toEqual(
      [
        createAdrUserPrompt(candidateResult('modularity'), [...ADRS]),
        createAdrUserPrompt(candidateResult('reusability'), [...ADRS]),
      ].sort(),
    );
    expect(outcome).toEqual({
      ok: true,
      findings: [
        { ...candidateResult('modularity'), adr: 'ADR-0001' },
        { ...candidateResult('reusability'), adr: null },
      ],
    });
  });

  it('makes no ADR call without ADRs, and the findings carry no adr key', async () => {
    const claude = createFakeClaude(TWO_CANDIDATES);
    const outcome = await detectTechnicalCredit(
      { context, adrs: [] },
      claude.client,
      signal(),
    );

    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(0);
    expect(outcome.ok).toBe(true);
    for (const finding of outcome.ok ? outcome.findings : []) {
      expect(Object.hasOwn(finding, 'adr')).toBe(false);
    }
  });

  it('leaves the request untouched and keeps no state between calls', async () => {
    const adrs = [...ADRS];
    const frozen = JSON.stringify({ context, adrs });
    const claude = createFakeClaude({
      ...TWO_CANDIDATES,
      'adr:modularity': answer({ adr: 'ADR-0001' }),
    });

    const first = await detectTechnicalCredit(
      { context, adrs },
      claude.client,
      signal(),
    );
    const second = await detectTechnicalCredit(
      { context, adrs },
      claude.client,
      signal(),
    );

    expect(JSON.stringify({ context, adrs })).toBe(frozen);
    expect(second).toEqual(first);
    if (!first.ok || !second.ok) {
      throw new Error('expected two successes');
    }
    expect(second.findings[0]).not.toBe(first.findings[0]);
  });
});
