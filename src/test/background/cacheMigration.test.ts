import {
  CACHE_KEY_PREFIX,
  LEGACY_KEY_PREFIX,
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

/** Card 16A: card 04's single-result (v1) entries are migrated into the bounded format. */

const hash = (n: number): string => sha256Hex(`content ${n}`);

function id(n: number): CacheIdentity {
  return {
    workspaceId: 'file:///w',
    fileUri: 'file:///w/A.java',
    contentHash: hash(n),
    detectorId: 'mock',
    detectorVersion: 'mock-1',
  };
}

const SCOPE = JSON.stringify([
  'file:///w',
  'file:///w/A.java',
  'mock',
  'mock-1',
]);
const V1_KEY = `${LEGACY_KEY_PREFIX}${SCOPE}`;
const V2_KEY = `${CACHE_KEY_PREFIX}${SCOPE}`;

const FINDING: DetectorFinding = {
  line: 3,
  result: {
    is_tc_candidate: true,
    category: 'reusability',
    benefit: 'b',
    conditions: 'c',
    signals: ['s'],
    not_tc_reason: null,
  },
};

const OUTPUT = {
  detectorId: 'mock',
  detectorVersion: 'mock-1',
  findings: [FINDING],
};

/** Exactly the shape card 04 wrote under the v1 prefix. */
function v1Entry(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    contentHash: hash(1),
    storedAt: 1234,
    output: OUTPUT,
    ...overrides,
  };
}

function ok(): DetectorResult {
  return { ok: true, output: { ...OUTPUT, findings: [] } };
}

function newCache(store: CacheStore) {
  return new ResultCache({ store, now: () => 0 });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function storedHashes(store: CacheStore): string[] {
  const value: unknown = store.get(V2_KEY);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('format' in value) ||
    value.format !== 2 ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('no format 2 scope');
  }
  const entries: { contentHash: string }[] = value.entries;
  return entries.map((e) => e.contentHash).sort();
}

describe('US4: v1 entries are migrated', () => {
  it('hits a valid v1 entry, then rewrites it as format 2 and deletes the v1 key (US4-1)', async () => {
    const store = createMemoryCacheStore();
    store.rawSet(V1_KEY, v1Entry());
    const cache = newCache(store);

    expect(cache.lookup(id(1))).toEqual({
      hit: true,
      entry: {
        format: 2,
        contentHash: hash(1),
        storedAt: 1234,
        output: OUTPUT,
      },
    });
    await settle();

    expect(store.keys()).toEqual([V2_KEY]);
    expect(storedHashes(store)).toEqual([hash(1)]);
    expect(cache.stats().migrated).toBe(1);
    expect(newCache(store).lookup(id(1)).hit).toBe(true);
  });

  it('migrates on a miss for other content too, keeping the v1 result (US4-2)', async () => {
    const store = createMemoryCacheStore();
    store.rawSet(V1_KEY, v1Entry());
    const cache = newCache(store);

    expect(cache.lookup(id(2))).toEqual({
      hit: false,
      reason: 'content-changed',
    });
    await settle();

    expect(store.keys()).toEqual([V2_KEY]);
    expect(cache.lookup(id(1)).hit).toBe(true);
    expect(cache.stats().migrated).toBe(1);
  });

  it('keeps the v1 result beside a new store, and deletes the v1 key (US4-2)', async () => {
    const store = createMemoryCacheStore();
    store.rawSet(V1_KEY, v1Entry());
    const cache = newCache(store);

    expect(await cache.store(id(2), ok())).toEqual({
      status: 'stored',
      replaced: false,
    });

    expect(store.keys()).toEqual([V2_KEY]);
    expect(storedHashes(store)).toEqual([hash(1), hash(2)].sort());
    expect(cache.stats().migrated).toBe(1);
  });

  it.each<[string, unknown]>([
    ['a bad hash', v1Entry({ contentHash: 'not-a-hash' })],
    [
      'another detector version inside',
      v1Entry({ output: { ...OUTPUT, detectorVersion: 'mock-2' } }),
    ],
    ['junk', 'text'],
  ])(
    'treats a v1 value with %s as unreadable, deletes it and reuses nothing (US4-3)',
    async (_, value) => {
      const store = createMemoryCacheStore();
      store.rawSet(V1_KEY, value);
      const cache = newCache(store);

      expect(cache.lookup(id(1))).toEqual({
        hit: false,
        reason: 'unreadable',
      });
      await settle();

      expect(store.keys()).toEqual([]);
      expect(cache.lookup(id(1))).toEqual({ hit: false, reason: 'absent' });
      expect(cache.stats().migrated).toBe(0);
    },
  );

  it('prefers format 2 when both exist, and the next store deletes the v1 key', async () => {
    const store = createMemoryCacheStore();
    const cache = newCache(store);
    await cache.store(id(2), ok());
    store.rawSet(V1_KEY, v1Entry());

    expect(cache.lookup(id(1))).toEqual({
      hit: false,
      reason: 'content-changed',
    });

    await cache.store(id(3), ok());

    expect(store.keys()).toEqual([V2_KEY]);
    expect(storedHashes(store)).toEqual([hash(2), hash(3)].sort());
    expect(cache.stats().migrated).toBe(0);
  });

  it('survives a failed v1 delete, and deletes the key on a later store', async () => {
    const store = createDeferredCacheStore();
    store.rawSet(V1_KEY, v1Entry());
    const cache = newCache(store);

    expect(cache.lookup(id(1)).hit).toBe(true);
    expect(store.held()).toBe(2); // the format 2 write, then the v1 delete
    store.flushNext();
    store.flushNext('locked');
    await settle();

    expect([...store.keys()].sort()).toEqual([V1_KEY, V2_KEY].sort());
    expect(cache.lookup(id(1)).hit).toBe(true);

    const pending = cache.store(id(2), ok());
    await settle();
    store.flush();
    expect((await pending).status).toBe('stored');
    store.flush();
    await settle();

    expect(store.keys()).toEqual([V2_KEY]);
  });
});
