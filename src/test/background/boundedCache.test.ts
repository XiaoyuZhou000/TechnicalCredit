import {
  CACHE_KEY_PREFIX,
  ResultCache,
  sha256Hex,
  type CacheIdentity,
  type CacheStore,
} from '@/background/cache/resultCache';
import type {
  DetectorFinding,
  DetectorResult,
} from '@/background/detector/detector';
import {
  createDeferredCacheStore,
  createMemoryCacheStore,
} from '@/test/background/memoryCacheStore';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/** Card 16A: up to four results per file and detector version, least recently used first. */

const hash = (n: number): string => sha256Hex(`content ${n}`);

function id(n: number, overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    workspaceId: 'file:///w',
    fileUri: 'file:///w/A.java',
    contentHash: hash(n),
    detectorId: 'mock',
    detectorVersion: 'mock-1',
    ...overrides,
  };
}

const FINDING: DetectorFinding = {
  line: 0,
  result: {
    is_tc_candidate: true,
    category: 'modularity',
    benefit: 'b',
    conditions: 'c',
    signals: ['s'],
    not_tc_reason: null,
  },
};

function ok(
  findings: readonly DetectorFinding[] = [FINDING],
  detectorVersion = 'mock-1',
  detectorId = 'mock',
): DetectorResult {
  return { ok: true, output: { detectorId, detectorVersion, findings } };
}

const KEY = `${CACHE_KEY_PREFIX}${JSON.stringify(['file:///w', 'file:///w/A.java', 'mock', 'mock-1'])}`;

function newCache(store: CacheStore) {
  return new ResultCache({ store, now: () => 0 });
}

async function storeAll(cache: ResultCache, ns: readonly number[]) {
  for (const n of ns) {
    await cache.store(id(n), ok());
  }
}

/** Lets background writes (recency on hits) settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function entryCount(store: CacheStore): number {
  const value: unknown = store.get(KEY);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('no stored scope');
  }
  return value.entries.length;
}

describe('US2: up to four results per file survive restarts, least recently used first', () => {
  it('keeps four contents reusable from a new cache over the same storage (US2-1, SC-004)', async () => {
    const store = createMemoryCacheStore();
    await storeAll(newCache(store), [1, 2, 3, 4]);

    const restarted = newCache(store);
    for (const n of [1, 2, 3, 4]) {
      expect(restarted.lookup(id(n)).hit).toBe(true);
    }
    expect(store.keys()).toEqual([KEY]);
  });

  it('evicts the least recently used content when a fifth is stored (US2-2)', async () => {
    const cache = newCache(createMemoryCacheStore());
    await storeAll(cache, [1, 2, 3, 4]);

    expect(await cache.store(id(5), ok())).toEqual({
      status: 'stored',
      replaced: false,
      evicted: hash(1),
    });
    expect(cache.lookup(id(1))).toEqual({
      hit: false,
      reason: 'content-changed',
    });
    for (const n of [2, 3, 4, 5]) {
      expect(cache.lookup(id(n)).hit).toBe(true);
    }
    expect(cache.stats().evicted).toBe(1);
  });

  it('keeps a content that was hit since the others were stored (US2-3)', async () => {
    const cache = newCache(createMemoryCacheStore());
    await storeAll(cache, [1, 2, 3, 4]);
    expect(cache.lookup(id(1)).hit).toBe(true);
    await settle();

    const outcome = await cache.store(id(5), ok());

    expect(outcome.status === 'stored' && outcome.evicted).toBe(hash(2));
    expect(cache.lookup(id(1)).hit).toBe(true);
  });

  it('persists the recency of a hit across a restart (US2-3, SC-004)', async () => {
    const store = createMemoryCacheStore();
    const before = newCache(store);
    await storeAll(before, [1, 2, 3, 4]);
    expect(before.lookup(id(1)).hit).toBe(true);
    await settle();

    const after = newCache(store);
    const outcome = await after.store(id(5), ok());

    expect(outcome.status === 'stored' && outcome.evicted).toBe(hash(2));
  });

  it('replaces a repeated content without taking a slot, and counts it as use (US2-4)', async () => {
    const store = createMemoryCacheStore();
    const cache = newCache(store);
    await storeAll(cache, [1, 2, 3]);

    expect(await cache.store(id(2), ok([]))).toEqual({
      status: 'stored',
      replaced: true,
    });
    expect(entryCount(store)).toBe(3);
    const two = cache.lookup(id(2));
    expect(two.hit && two.entry.output.findings).toEqual([]);

    await cache.store(id(4), ok());
    const fifth = await cache.store(id(5), ok());
    const sixth = await cache.store(id(6), ok());

    expect(fifth.status === 'stored' && fifth.evicted).toBe(hash(1));
    expect(sixth.status === 'stored' && sixth.evicted).toBe(hash(3));
    expect(entryCount(store)).toBe(4);
  });

  it('stores empty successes and never failures (US2-5)', async () => {
    const store = createMemoryCacheStore();
    const cache = newCache(store);

    for (const result of [
      { ok: false, failure: { kind: 'failed', message: 'nope' } },
      { ok: false, failure: { kind: 'cancelled' } },
      { ok: false, failure: { kind: 'timeout' } },
    ] as const) {
      expect(await cache.store(id(1), result)).toEqual({
        status: 'skipped',
        reason: 'not-cacheable',
      });
    }
    expect(store.keys()).toEqual([]);

    expect((await cache.store(id(1), ok([]))).status).toBe('stored');
    const lookup = cache.lookup(id(1));
    expect(lookup.hit && lookup.entry.output.findings).toEqual([]);
  });

  it('still returns a hit when its recency write fails, and counts the failure', async () => {
    const store = createDeferredCacheStore();
    const cache = newCache(store);
    const seeded = cache.store(id(1), ok());
    store.flush();
    await seeded;

    expect(cache.lookup(id(1)).hit).toBe(true);
    expect(store.held()).toBe(1);
    store.failNext('quota');
    store.flush();
    await settle();

    expect(cache.stats()).toMatchObject({
      hits: 1,
      stored: 1,
      recencyFailures: 1,
    });
    expect(cache.lookup(id(1)).hit).toBe(true);
  });
});
