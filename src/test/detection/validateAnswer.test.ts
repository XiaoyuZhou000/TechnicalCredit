import { ResultCache, sha256Hex } from '@/background/cache/resultCache';
import type { TCResult } from '@/comment/tcResult';
import {
  parseAdrAnswer,
  parseHeuristicAnswer,
} from '@/detection/validateAnswer';
import { createMemoryCacheStore } from '@/test/background/memoryCacheStore';

import { candidate, notCandidate } from './fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/** Card 13: the shared detection service's answer validation (data-model rule tables). */

const TCRESULT_KEYS = [
  'benefit',
  'category',
  'conditions',
  'is_tc_candidate',
  'not_tc_reason',
  'signals',
];

function valid<T>(check: { ok: true; value: T } | { ok: false }): T {
  if (!check.ok) {
    throw new Error('expected a valid answer');
  }
  return check.value;
}

/** The finding a valid candidate answer becomes. */
function finding(answer: unknown): TCResult {
  const value = valid(parseHeuristicAnswer(answer));
  if (value === null) {
    throw new Error('expected a candidate');
  }
  return value;
}

describe('parseHeuristicAnswer', () => {
  it.each([
    ['null', null, 'the answer is not a JSON object'],
    ['an array', [candidate('modularity')], 'the answer is not a JSON object'],
    ['a string', 'yes', 'the answer is not a JSON object'],
    ['no is_tc_candidate', {}, 'the answer has no boolean is_tc_candidate'],
    [
      'a string is_tc_candidate',
      { is_tc_candidate: 'yes' },
      'the answer has no boolean is_tc_candidate',
    ],
  ])('rejects %s', (_label, answer, problem) => {
    expect(parseHeuristicAnswer(answer)).toEqual({ ok: false, problem });
  });

  it('accepts a non-candidate with no other fields, as "not a finding"', () => {
    expect(parseHeuristicAnswer({ is_tc_candidate: false })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseHeuristicAnswer(notCandidate())).toEqual({
      ok: true,
      value: null,
    });
  });

  it.each([
    ['category', { category: 'foo' }, 'the answer has no valid category'],
    ['benefit', { benefit: 3 }, 'the answer has no string benefit'],
    [
      'conditions',
      { conditions: undefined },
      'the answer has no string conditions',
    ],
    ['signals', { signals: [1] }, 'the answer has no string array signals'],
    [
      'not_tc_reason',
      { not_tc_reason: 0 },
      'the answer has an invalid not_tc_reason',
    ],
  ])(
    'rejects a candidate with an invalid %s, naming the field and not the value',
    (_field, overrides, problem) => {
      expect(parseHeuristicAnswer(candidate('modularity', overrides))).toEqual({
        ok: false,
        problem,
      });
    },
  );

  it('rejects a candidate whose signals are not an array', () => {
    expect(
      parseHeuristicAnswer(candidate('modularity', { signals: 'a, b' })),
    ).toEqual({ ok: false, problem: 'the answer has no string array signals' });
  });

  it('normalises a missing not_tc_reason to null', () => {
    const answer = candidate('modularity');
    delete answer.not_tc_reason;
    expect(finding(answer).not_tc_reason).toBeNull();
  });

  it('returns a new finding with exactly the TCResult keys and copied signals', () => {
    const answer = candidate('reusability', {
      adr: 'ADR-0009',
      extra: 'dropped',
    });
    const result = finding(answer);

    expect(result).toEqual({
      is_tc_candidate: true,
      category: 'reusability',
      benefit: 'reusability benefit',
      conditions: 'reusability conditions',
      signals: ['reusability-signal'],
      not_tc_reason: null,
    });
    expect(Object.keys(result).sort()).toEqual(TCRESULT_KEYS);
    expect(result.signals).not.toBe(answer.signals);
  });

  it('keeps a candidate whose category differs from the heuristic that asked', () => {
    // Today's behaviour: the category is not compared with the heuristic.
    expect(finding(candidate('abstraction')).category).toBe('abstraction');
  });
});

describe('parseAdrAnswer', () => {
  it('accepts an ADR id or null', () => {
    expect(parseAdrAnswer({ adr: 'ADR-0001' })).toEqual({
      ok: true,
      value: 'ADR-0001',
    });
    expect(parseAdrAnswer({ adr: null })).toEqual({ ok: true, value: null });
  });

  it.each([
    ['null', null, 'the answer is not a JSON object'],
    ['an array', [], 'the answer is not a JSON object'],
    ['a missing adr', {}, 'the answer has no valid adr'],
    ['a numeric adr', { adr: 7 }, 'the answer has no valid adr'],
  ])('rejects %s', (_label, answer, problem) => {
    expect(parseAdrAnswer(answer)).toEqual({ ok: false, problem });
  });
});

describe('consistency with the background result cache', () => {
  it('every validated finding, with or without adr, is read back by the cache', async () => {
    const base = finding(candidate('modularity'));
    const other = finding(candidate('observability'));
    const findings: TCResult[] = [
      base,
      { ...other, adr: valid(parseAdrAnswer({ adr: 'ADR-0002' })) },
      { ...base, adr: valid(parseAdrAnswer({ adr: null })) },
    ];
    const cache = new ResultCache({
      store: createMemoryCacheStore(),
      now: () => 1,
    });
    const identity = {
      workspaceId: 'file:///w',
      fileUri: 'file:///w/Positive.java',
      contentHash: sha256Hex('class A {}'),
      detectorId: 'shared',
      detectorVersion: 'shared-1',
    };
    const output = {
      detectorId: 'shared',
      detectorVersion: 'shared-1',
      findings: findings.map((result) => ({ line: 0, result })),
    };

    expect(await cache.store(identity, { ok: true, output })).toEqual({
      status: 'stored',
    });
    const lookup = cache.lookup(identity);
    expect(lookup.hit).toBe(true);
    expect(lookup.hit && lookup.entry.output).toEqual(output);
  });
});
