import type { AdrSummary } from '@/context/findAdrs';

/** Only return an ADR id that was found in this workspace. */
export function resolveAdrId(
  candidate: unknown,
  adrs: readonly AdrSummary[],
): string | null {
  return typeof candidate === 'string' &&
    adrs.some((adr) => adr.id === candidate)
    ? candidate
    : null;
}
