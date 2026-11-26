import { resolveAdrId } from '@/context/resolveAdrId';
import type { AdrSummary } from '@/context/findAdrs';

const adrs: readonly AdrSummary[] = [
  { id: 'ADR-0001', title: 'First decision', tcContext: '' },
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
  });
});

