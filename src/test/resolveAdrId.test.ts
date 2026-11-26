import { resolveAdrId } from '@/context/resolveAdrId';
import type { AdrSummary } from '@/context/findAdrs';

const adrs: readonly AdrSummary[] = [
  { id: 'ADR-0001', title: 'First decision', tcContext: '' },
  {
    id: 'ADR-0012',
    title: 'Plugin registry',
    tcContext: 'tc-category: modularity',
  },
  { id: 'architecture-record', title: 'Named decision', tcContext: '' },
];

describe('resolveAdrId', () => {
  it('accepts only ids present in the workspace ADR list', () => {
    expect(resolveAdrId('ADR-0001', adrs)).toBe('ADR-0001');
    expect(resolveAdrId('architecture-record', adrs)).toBe(
      'architecture-record',
    );
    expect(resolveAdrId('ADR-9999', adrs)).toBeNull();
    expect(resolveAdrId('ADR-0001', [])).toBeNull();
  });

  it('treats a missing or non-string answer as no match', () => {
    expect(resolveAdrId(null, adrs)).toBeNull();
    expect(resolveAdrId(undefined, adrs)).toBeNull();
    expect(resolveAdrId(1, adrs)).toBeNull();
    expect(resolveAdrId('', adrs)).toBeNull();
  });

  it('ignores whitespace and case, returning the listed id', () => {
    expect(resolveAdrId('  ADR-0001\n', adrs)).toBe('ADR-0001');
    expect(resolveAdrId('adr-0001', adrs)).toBe('ADR-0001');
    expect(resolveAdrId('ADR - 0012', adrs)).toBe('ADR-0012');
    expect(resolveAdrId(' Architecture-Record ', adrs)).toBe(
      'architecture-record',
    );
  });

  it('ignores zero padding in a numbered id', () => {
    expect(resolveAdrId('ADR-1', adrs)).toBe('ADR-0001');
    expect(resolveAdrId('adr-12', adrs)).toBe('ADR-0012');
    expect(resolveAdrId('ADR-000012', adrs)).toBe('ADR-0012');
    expect(resolveAdrId('ADR-10', adrs)).toBeNull();
    expect(resolveAdrId('ADR-120', adrs)).toBeNull();
  });

  it('accepts an id followed by its listed title', () => {
    expect(resolveAdrId('ADR-0001 — First decision', adrs)).toBe('ADR-0001');
    expect(resolveAdrId('adr-1 —  first   DECISION ', adrs)).toBe('ADR-0001');
    expect(
      resolveAdrId(
        'ADR-0012 — Plugin registry — tc-category: modularity',
        adrs,
      ),
    ).toBe('ADR-0012');
    expect(resolveAdrId('architecture-record — Named decision', adrs)).toBe(
      'architecture-record',
    );
  });

  it('rejects an id followed by a title that is not its own', () => {
    expect(resolveAdrId('ADR-0001 — Plugin registry', adrs)).toBeNull();
    expect(resolveAdrId('ADR-0001 — First', adrs)).toBeNull();
    expect(resolveAdrId('ADR-0012 — tc-category: modularity', adrs)).toBeNull();
    expect(resolveAdrId('ADR-0001: First decision', adrs)).toBeNull();
  });

  it('splits at the separator that matches when ids or titles contain it', () => {
    const dashed: readonly AdrSummary[] = [
      { id: 'cache — eviction', title: 'Cache', tcContext: '' },
      { id: 'ADR-0003', title: 'Retry — backoff', tcContext: '' },
    ];
    expect(resolveAdrId('cache — eviction — Cache', dashed)).toBe(
      'cache — eviction',
    );
    expect(resolveAdrId('ADR-0003 — Retry — backoff', dashed)).toBe('ADR-0003');
  });

  it('rejects an id that several records share', () => {
    const shared: readonly AdrSummary[] = [
      { id: 'ADR-0007', title: 'Cache layer', tcContext: '' },
      { id: 'ADR-0007', title: 'Plugin registry', tcContext: '' },
      { id: 'ADR-0008', title: 'Logging', tcContext: '' },
    ];
    expect(resolveAdrId('ADR-0007', shared)).toBeNull();
    // A title does not pick one record out of an id that names two.
    expect(resolveAdrId('ADR-0007 — Plugin registry', shared)).toBeNull();
    expect(resolveAdrId('ADR-0008', shared)).toBe('ADR-0008');
  });

  it('rejects ids that differ only in case, whitespace or padding', () => {
    const lookalikes: readonly AdrSummary[] = [
      { id: 'ADR-0007', title: 'Numbered', tcContext: '' },
      { id: 'adr-7', title: 'Named', tcContext: '' },
      { id: 'Design Notes', title: 'Notes', tcContext: '' },
      { id: 'design  notes', title: 'More notes', tcContext: '' },
    ];
    expect(resolveAdrId('ADR-0007', lookalikes)).toBeNull();
    expect(resolveAdrId('adr-7', lookalikes)).toBeNull();
    expect(resolveAdrId('Design Notes', lookalikes)).toBeNull();
  });
});
