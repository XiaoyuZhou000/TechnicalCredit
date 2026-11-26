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
  notCandidate,
  type Behaviour,
  type FakeClient,
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

  it('drops an ADR id that is not among the workspace ADRs', async () => {
    const claude = createFakeClaude({
      ...TWO_CANDIDATES,
      'adr:modularity': answer({ adr: 'ADR-0007' }),
      'adr:reusability': answer({ adr: 'ADR-0002' }),
    });
    const outcome = await detectTechnicalCredit(
      { context, adrs: ADRS },
      claude.client,
      signal(),
    );

    expect(outcome).toEqual({
      ok: true,
      findings: [
        { ...candidateResult('modularity'), adr: null },
        { ...candidateResult('reusability'), adr: 'ADR-0002' },
      ],
    });
  });

  it('keeps the id of an ADR with a nonnumeric filename, as listed', async () => {
    const adrs: readonly AdrSummary[] = [
      ...ADRS,
      {
        id: 'architecture-record',
        title: 'Architecture record',
        tcContext: '',
      },
    ];
    const claude = createFakeClaude({
      modularity: answer(candidate('modularity')),
      'adr:modularity': answer({ adr: 'architecture-record' }),
    });
    const outcome = await detectTechnicalCredit(
      { context, adrs },
      claude.client,
      signal(),
    );

    const [adrCall] = claude.calls.filter((c) => c.kind === 'adr');
    expect(adrCall.user.split('\n')).toContain(
      'architecture-record — Architecture record',
    );
    expect(outcome).toEqual({
      ok: true,
      findings: [
        { ...candidateResult('modularity'), adr: 'architecture-record' },
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every heuristic call held: honouring its signal, or ignoring it. */
function allHeld(ignoreSignal: boolean, overrides: Script = {}): Script {
  return {
    ...Object.fromEntries(
      HEURISTIC_CATEGORIES.map((c) => [c, hold(notCandidate(), ignoreSignal)]),
    ),
    ...overrides,
  };
}

/** A call that ends on the client's own deadline, as `callClaude` reports it. */
const timedOut: Behaviour = {
  kind: 'reject',
  error: new DOMException('The operation timed out.', 'TimeoutError'),
};

async function failureOf(script: Script, adrs: readonly AdrSummary[] = []) {
  const claude = createFakeClaude(script);
  const outcome = await detectTechnicalCredit(
    { context, adrs },
    claude.client,
    signal(),
  );
  return { claude, outcome };
}

describe('US3: cancellation', () => {
  it('makes no call when the signal is already aborted', async () => {
    const claude = createFakeClaude();
    const controller = new AbortController();
    controller.abort();

    expect(
      await detectTechnicalCredit(
        { context, adrs: ADRS },
        claude.client,
        controller.signal,
      ),
    ).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(claude.calls).toHaveLength(0);
  });

  it('settles promptly on abort even when the client ignores its signal', async () => {
    const claude = createFakeClaude(
      allHeld(true, { modularity: hold(candidate('modularity'), true) }),
    );
    const controller = new AbortController();
    const pending = detectTechnicalCredit(
      { context, adrs: ADRS },
      claude.client,
      controller.signal,
    );
    await tick();
    expect(claude.calls).toHaveLength(8);

    controller.abort();
    const settled = await Promise.race([
      pending,
      tick().then(() => 'still pending'),
    ]);

    expect(settled).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(claude.calls.every((c) => c.signal.aborted)).toBe(true);
    claude.releaseAll();
    await tick();
    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(0);
  });

  it('starts no ADR call when the abort lands as the heuristic phase ends', async () => {
    const claude = createFakeClaude({
      modularity: answer(candidate('modularity')),
    });
    const controller = new AbortController();
    let heuristicCalls = 0;
    const client: FakeClient = (system, user, callSignal) => {
      const call = claude.client(system, user, callSignal);
      if (system !== ADR_SYSTEM_PROMPT && ++heuristicCalls === 8) {
        void call.then(() => controller.abort());
      }
      return call;
    };

    expect(
      await detectTechnicalCredit(
        { context, adrs: ADRS },
        client,
        controller.signal,
      ),
    ).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(0);
  });

  it('reports a timeout, not a cancellation, when the abort reason is a timeout', async () => {
    const claude = createFakeClaude(allHeld(false));
    const controller = new AbortController();
    const pending = detectTechnicalCredit(
      { context, adrs: [] },
      claude.client,
      controller.signal,
    );
    await tick();
    controller.abort(new DOMException('took too long', 'TimeoutError'));

    expect(await pending).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('ignores an abort after it has settled, with no unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const claude = createFakeClaude({
        modularity: answer(candidate('modularity')),
      });
      const controller = new AbortController();
      const outcome = await detectTechnicalCredit(
        { context, adrs: ADRS },
        claude.client,
        controller.signal,
      );
      controller.abort();
      await tick();
      await tick();

      expect(outcome).toEqual({
        ok: true,
        findings: [{ ...candidateResult('modularity'), adr: null }],
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('US3: failures are typed, whole-run and safe', () => {
  it('fails the whole run on one rejected heuristic call and aborts the others', async () => {
    const { claude, outcome } = await failureOf(
      allHeld(false, {
        modularity: hold(candidate('modularity')),
        abstraction: { kind: 'reject', error: new Error('boom') },
      }),
      ADRS,
    );

    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'failed', message: 'heuristic "abstraction": boom' },
    });
    expect(
      claude.calls
        .filter((c) => c.category !== 'abstraction')
        .every((c) => c.signal.aborted),
    ).toBe(true);
    expect(claude.calls.filter((c) => c.kind === 'adr')).toHaveLength(0);
  });

  it('names the ADR step when an ADR-matching call fails', async () => {
    const { claude, outcome } = await failureOf(
      {
        modularity: answer(candidate('modularity')),
        reusability: answer(candidate('reusability')),
        'adr:modularity': { kind: 'reject', error: new Error('overloaded') },
        'adr:reusability': hold({ adr: null }),
      },
      ADRS,
    );

    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'failed',
        message: 'ADR matching for "modularity": overloaded',
      },
    });
    expect(
      claude.calls.find((c) => c.category === 'reusability' && c.kind === 'adr')
        ?.signal.aborted,
    ).toBe(true);
  });

  it.each([
    [
      'a non-Error rejection',
      { kind: 'reject', error: 'plain text' } as const,
      'heuristic "abstraction": plain text',
    ],
    [
      'a client that throws synchronously',
      { kind: 'throw', error: new Error('sync') } as const,
      'heuristic "abstraction": sync',
    ],
    [
      'an answer that is not valid JSON',
      {
        kind: 'reject',
        error: new SyntaxError(
          `Unexpected token 'c', "class Secret {}" is not valid JSON`,
        ),
      } as const,
      'heuristic "abstraction": the answer is not valid JSON',
    ],
    [
      'a candidate with an unknown category',
      answer(candidate('abstraction', { category: 'foo' })),
      'heuristic "abstraction": the answer has no valid category',
    ],
  ])('turns %s into a typed failure', async (_label, behaviour, message) => {
    const { outcome } = await failureOf({ abstraction: behaviour });

    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'failed', message },
    });
    expect(JSON.stringify(outcome)).not.toContain('Secret');
  });

  it('turns an unusable ADR answer into a typed failure', async () => {
    const { outcome } = await failureOf(
      {
        modularity: answer(candidate('modularity')),
        'adr:modularity': answer({ adr: 7 }),
      },
      ADRS,
    );

    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'failed',
        message: 'ADR matching for "modularity": the answer has no valid adr',
      },
    });
  });

  it.each([
    ['a heuristic call', { abstraction: timedOut }],
    [
      'an ADR-matching call',
      {
        modularity: answer(candidate('modularity')),
        'adr:modularity': timedOut,
      },
    ],
  ])(
    "reports the client's own timeout in %s as a timeout, not a failure",
    async (_label, script) => {
      const { outcome } = await failureOf(script, ADRS);

      expect(outcome).toEqual({ ok: false, failure: { kind: 'timeout' } });
    },
  );
});
