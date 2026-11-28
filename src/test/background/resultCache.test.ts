import * as fs from 'fs';
import * as path from 'path';

import {
  CACHE_CAPACITY,
  CACHE_FORMAT,
  CACHE_KEY_PREFIX,
  ResultCache,
  sha256Hex,
  type CacheIdentity,
} from '@/background/cache/resultCache';
import type {
  DetectorFinding,
  DetectorResult,
} from '@/background/detector/detector';
import { sampleFindings } from '@/background/detector/mockDetector';
import {
  createMemoryCacheStore,
  rejectingUpdateStore,
  throwingGetStore,
  throwingUpdateStore,
  type MemoryCacheStore,
} from '@/test/background/memoryCacheStore';

/** Offline tests for card 04's cache, in card 16A's bounded format: no `vscode`, an in-memory store, a fixed clock. */

const POSITIVE = fs.readFileSync(
  path.join(__dirname, '../creational/prototype/Positive.java'),
  'utf8',
);

function identity(overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    workspaceId: 'file:///w',
    fileUri: 'file:///w/Positive.java',
    contentHash: sha256Hex(POSITIVE),
    detectorId: 'mock',
    detectorVersion: 'mock-1',
    ...overrides,
  };
}

function ok(
  findings: readonly DetectorFinding[] = sampleFindings(POSITIVE),
  detectorVersion = 'mock-1',
  detectorId = 'mock',
): DetectorResult {
  return { ok: true, output: { detectorId, detectorVersion, findings } };
}

function memory(store: MemoryCacheStore = createMemoryCacheStore()) {
  return { cache: new ResultCache({ store, now: () => 1234 }), store };
}

describe('sha256Hex', () => {
  it('matches known SHA-256 digests', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('does not normalise line endings', () => {
    expect(sha256Hex('a\nb')).not.toBe(sha256Hex('a\r\nb'));
  });

  it('always returns 64 lowercase hex characters', () => {
    for (const text of ['', 'x', POSITIVE, 'é漢字\u0000']) {
      expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('cache format', () => {
  it('stores format 2 under its own prefix (card 16A)', () => {
    expect(CACHE_FORMAT).toBe(2);
    expect(CACHE_KEY_PREFIX).toBe('technicalCredit.resultCache.v2:');
    expect(CACHE_CAPACITY).toBe(4);
  });
});

describe('ResultCache', () => {
  it('returns the stored output unchanged for the same identity (SC-001)', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());

    for (let i = 0; i < 10; i++) {
      const lookup = cache.lookup(identity());
      expect(lookup).toEqual({
        hit: true,
        entry: {
          format: CACHE_FORMAT,
          contentHash: sha256Hex(POSITIVE),
          storedAt: 1234,
          output: {
            detectorId: 'mock',
            detectorVersion: 'mock-1',
            findings: sampleFindings(POSITIVE),
          },
        },
      });
    }
    expect(cache.stats().hits).toBe(10);
  });

  it('misses when one character changes (SC-003) or nothing was stored', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());

    expect(
      cache.lookup(identity({ contentHash: sha256Hex(`${POSITIVE} `) })),
    ).toEqual({ hit: false, reason: 'content-changed' });
    expect(cache.lookup(identity({ fileUri: 'file:///w/Other.java' }))).toEqual(
      { hit: false, reason: 'absent' },
    );
  });

  it('stores and returns empty findings', async () => {
    const { cache } = memory();

    expect(await cache.store(identity(), ok([]))).toEqual({
      status: 'stored',
      replaced: false,
    });
    const lookup = cache.lookup(identity());
    expect(lookup.hit && lookup.entry.output.findings).toEqual([]);
  });

  it.each<DetectorResult>([
    { ok: false, failure: { kind: 'failed', message: 'boom' } },
    { ok: false, failure: { kind: 'cancelled' } },
    { ok: false, failure: { kind: 'timeout' } },
  ])('never stores a failure: %j (SC-005)', async (result) => {
    const { cache, store } = memory();

    expect(await cache.store(identity(), result)).toEqual({
      status: 'skipped',
      reason: 'not-cacheable',
    });
    expect(store.keys()).toEqual([]);
    expect(cache.lookup(identity()).hit).toBe(false);
  });

  it('keeps files and workspaces apart for identical content', async () => {
    const { cache, store } = memory();
    const other = identity({ fileUri: 'file:///w/Copy.java' });
    const elsewhere = identity({ workspaceId: 'file:///other' });

    await cache.store(identity(), ok());
    expect(cache.lookup(other)).toEqual({ hit: false, reason: 'absent' });
    expect(cache.lookup(elsewhere)).toEqual({ hit: false, reason: 'absent' });

    await cache.store(other, ok([]));
    await cache.store(elsewhere, ok([]));
    expect(store.keys()).toHaveLength(3);
    const lookup = cache.lookup(identity());
    expect(lookup.hit && lookup.entry.output.findings).toHaveLength(6);
  });

  it('keeps at most four entries per file and version, under one key (SC-006, card 16A)', async () => {
    const { cache, store } = memory();
    const versions = Array.from({ length: 20 }, (_, i) => `${POSITIVE}${i}`);

    for (const content of versions) {
      await cache.store(identity({ contentHash: sha256Hex(content) }), ok());
    }

    expect(store.keys()).toHaveLength(1);
    expect(store.keys()[0].startsWith(CACHE_KEY_PREFIX)).toBe(true);
    for (const content of versions.slice(16)) {
      expect(
        cache.lookup(identity({ contentHash: sha256Hex(content) })).hit,
      ).toBe(true);
    }
    for (const content of versions.slice(0, 16)) {
      expect(
        cache.lookup(identity({ contentHash: sha256Hex(content) })),
      ).toEqual({ hit: false, reason: 'content-changed' });
    }
  });
});

describe('ResultCache across restarts and bad storage', () => {
  const KEY = `${CACHE_KEY_PREFIX}${JSON.stringify(['file:///w', 'file:///w/Positive.java', 'mock', 'mock-1'])}`;

  function result(overrides: Record<string, unknown> = {}) {
    return {
      is_tc_candidate: true,
      category: 'modularity',
      benefit: 'b',
      conditions: 'c',
      signals: ['s'],
      not_tc_reason: null,
      adr: 'kept',
      ...overrides,
    };
  }

  /** One valid entry, shaped as `store` writes it, for corrupting one field at a time. */
  function entry(
    overrides: Record<string, unknown> = {},
    findings: unknown = [{ line: 1, result: result() }],
  ): Record<string, unknown> {
    return {
      contentHash: sha256Hex(POSITIVE),
      storedAt: 1234,
      lastUse: 1,
      output: { detectorId: 'mock', detectorVersion: 'mock-1', findings },
      ...overrides,
    };
  }

  /** A valid v2 scope holding that one entry, as `store` writes it (card 16A). */
  function stored(
    overrides: Record<string, unknown> = {},
    findings?: unknown,
  ): Record<string, unknown> {
    return { format: 2, uses: 1, entries: [entry(overrides, findings)] };
  }

  it('returns identical entries from a new cache over the same store (SC-002)', async () => {
    const store = createMemoryCacheStore();
    const before = new ResultCache({ store, now: () => 1234 });
    await before.store(identity(), ok());
    const first = before.lookup(identity());

    const after = new ResultCache({ store, now: () => 9999 });

    expect(after.stats()).toEqual({
      hits: 0,
      misses: 0,
      stored: 0,
      skipped: 0,
      storeFailures: 0,
      evicted: 0,
      notRetained: 0,
      recencyFailures: 0,
    });
    const lookup = after.lookup(identity());
    expect(lookup.hit).toBe(true);
    expect(lookup).toEqual(first);
    expect(lookup.hit && lookup.entry.storedAt).toBe(1234);
  });

  it('reads back a value shaped exactly as the cache writes it', () => {
    const { cache, store } = memory();
    store.rawSet(KEY, stored());

    const planted = entry();
    expect(cache.lookup(identity())).toEqual({
      hit: true,
      entry: {
        format: CACHE_FORMAT,
        contentHash: planted.contentHash,
        storedAt: planted.storedAt,
        output: planted.output,
      },
    });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'text'],
    ['an array', [stored()]],
    ['an empty object', {}],
    ['another format', { ...stored(), format: 3 }],
    ['the v1 single-entry shape', { format: 1, ...entry() }],
    [
      'an uppercase hash',
      stored({ contentHash: sha256Hex(POSITIVE).toUpperCase() }),
    ],
    [
      'a 63-character hash',
      stored({ contentHash: sha256Hex(POSITIVE).slice(1) }),
    ],
    ['a non-finite time', stored({ storedAt: Infinity })],
    ['a string time', stored({ storedAt: '1234' })],
    ['no output', stored({ output: undefined })],
    [
      'another detector version inside',
      stored({
        output: { detectorId: 'mock', detectorVersion: 'mock-2', findings: [] },
      }),
    ],
    ['findings that are not an array', stored({}, {})],
    ['a negative line', stored({}, [{ line: -1, result: result() }])],
    ['a fractional line', stored({}, [{ line: 1.5, result: result() }])],
    [
      'a non-candidate finding',
      stored({}, [{ line: 1, result: result({ is_tc_candidate: false }) }]),
    ],
    [
      'an unknown category',
      stored({}, [{ line: 1, result: result({ category: 'prototype' }) }]),
    ],
    [
      'a numeric signal',
      stored({}, [{ line: 1, result: result({ signals: [1] }) }]),
    ],
    [
      'a missing benefit',
      stored({}, [{ line: 1, result: result({ benefit: undefined }) }]),
    ],
    [
      'a numeric not_tc_reason',
      stored({}, [{ line: 1, result: result({ not_tc_reason: 0 }) }]),
    ],
    ['a numeric adr', stored({}, [{ line: 1, result: result({ adr: 5 }) }])],
  ])('treats %s as unreadable, without throwing (FR-011)', (_, value) => {
    const { cache, store } = memory();
    store.rawSet(KEY, value);

    expect(cache.lookup(identity())).toEqual({
      hit: false,
      reason: 'unreadable',
    });
  });

  it('never reads entries written under another format prefix', () => {
    const { cache, store } = memory();
    store.rawSet(KEY.replace('.v2:', '.v0:'), stored());

    expect(cache.lookup(identity())).toEqual({ hit: false, reason: 'absent' });
  });

  it('reports a throwing read as a miss with the message (FR-012)', () => {
    const cache = new ResultCache({
      store: throwingGetStore('disk gone'),
      now: () => 0,
    });

    expect(cache.lookup(identity())).toEqual({
      hit: false,
      reason: 'error',
      message: 'disk gone',
    });
  });

  it.each([
    ['rejects', rejectingUpdateStore('quota')],
    ['throws', throwingUpdateStore('quota')],
  ])('resolves failed when the write %s (FR-012)', async (_, store) => {
    const cache = new ResultCache({ store, now: () => 0 });

    await expect(cache.store(identity(), ok())).resolves.toEqual({
      status: 'failed',
      message: 'quota',
    });
    expect(cache.stats().storeFailures).toBe(1);
  });
});

describe('ResultCache across detector versions', () => {
  const V2 = identity({ detectorVersion: 'mock-2' });

  it('misses for a new version even with identical content (SC-004)', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());

    expect(cache.lookup(V2)).toEqual({ hit: false, reason: 'absent' });
  });

  it('keeps the old version for rollback once the new one is stored', async () => {
    const { cache, store } = memory();
    await cache.store(identity(), ok());
    await cache.store(V2, ok([], 'mock-2'));

    expect(store.keys()).toHaveLength(2);
    const v2 = cache.lookup(V2);
    const v1 = cache.lookup(identity());
    expect(v2.hit && v2.entry.output).toEqual({
      detectorId: 'mock',
      detectorVersion: 'mock-2',
      findings: [],
    });
    expect(v1.hit && v1.entry.output.findings).toHaveLength(6);
  });

  it('keeps detectors apart that share a version string', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());

    expect(cache.lookup(identity({ detectorId: 'live' }))).toEqual({
      hit: false,
      reason: 'absent',
    });
  });

  it.each([
    ['version', ok(undefined, 'mock-2')],
    ['id', ok(undefined, 'mock-1', 'live')],
  ])(
    'refuses to store an output whose detector %s differs from the identity',
    async (_, result) => {
      const { cache, store } = memory();

      expect(await cache.store(identity(), result)).toEqual({
        status: 'skipped',
        reason: 'mismatch',
      });
      expect(store.keys()).toEqual([]);
    },
  );

  it('only ever returns results of the version looked up (SC-004)', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());
    await cache.store(V2, ok([], 'mock-2'));

    for (let i = 0; i < 100; i++) {
      const version = i % 2 === 0 ? 'mock-1' : 'mock-2';
      const lookup = cache.lookup(identity({ detectorVersion: version }));
      expect(lookup.hit && lookup.entry.output.detectorVersion).toBe(version);
    }
  });
});

describe('ResultCache stats', () => {
  it('counts every lookup and store outcome (FR-014)', async () => {
    const base = createMemoryCacheStore();
    let failWrites = false;
    const cache = new ResultCache({
      store: {
        get: (key) => base.get(key),
        update: (key, value) =>
          failWrites
            ? Promise.reject(new Error('quota'))
            : base.update(key, value),
      },
      now: () => 0,
    });
    const b = identity({ fileUri: 'file:///w/B.java' });
    const c = identity({ fileUri: 'file:///w/C.java' });
    base.rawSet(
      `${CACHE_KEY_PREFIX}${JSON.stringify(['file:///w', c.fileUri, 'mock', 'mock-1'])}`,
      { format: 1 },
    );

    cache.lookup(identity());
    await cache.store(identity(), ok());
    cache.lookup(identity());
    cache.lookup(identity());
    cache.lookup(identity());
    cache.lookup(identity({ contentHash: sha256Hex('other') }));
    cache.lookup(b);
    cache.lookup(c);
    await cache.store(b, ok([]));
    await cache.store(b, { ok: false, failure: { kind: 'cancelled' } });
    await cache.store(b, ok([], 'mock-2'));
    failWrites = true;
    await cache.store(c, ok());

    const stats = cache.stats();
    expect(stats).toEqual({
      hits: 3,
      misses: 4,
      stored: 2,
      skipped: 2,
      storeFailures: 1,
      evicted: 0,
      notRetained: 0,
      recencyFailures: 0,
    });
    expect(Object.isFrozen(stats)).toBe(true);
  });
});

describe('ResultCache.prune', () => {
  it('deletes the scopes keep rejects and leaves the rest readable', async () => {
    const { cache, store } = memory();
    await cache.store(identity(), ok());
    await cache.store(
      identity({ detectorVersion: 'mock-2' }),
      ok(undefined, 'mock-2'),
    );
    store.rawSet('technicalCredit.activeDetector.v1', { kept: true });
    store.rawSet('technicalCredit.resultCache.v1:old', { kept: true });

    const outcome = await cache.prune(
      (scope) => scope.detectorVersion === 'mock-2',
    );

    expect(outcome).toEqual({ removed: 1, failures: 0 });
    expect(cache.lookup(identity())).toEqual({ hit: false, reason: 'absent' });
    expect(cache.lookup(identity({ detectorVersion: 'mock-2' })).hit).toBe(
      true,
    );
    expect(store.keys()).toEqual(
      expect.arrayContaining([
        'technicalCredit.activeDetector.v1',
        'technicalCredit.resultCache.v1:old',
      ]),
    );
  });

  it('hands keep every part of the scope key', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());
    const seen: unknown[] = [];
    await cache.prune((scope) => {
      seen.push(scope);
      return true;
    });
    expect(seen).toEqual([
      {
        workspaceId: 'file:///w',
        fileUri: 'file:///w/Positive.java',
        detectorId: 'mock',
        detectorVersion: 'mock-1',
      },
    ]);
  });

  it('keeps a scope when keep throws, and ignores keys it cannot parse', async () => {
    const { cache, store } = memory();
    await cache.store(identity(), ok());
    store.rawSet(`${CACHE_KEY_PREFIX}not json`, { kept: true });
    store.rawSet(`${CACHE_KEY_PREFIX}["a","b"]`, { kept: true });

    const outcome = await cache.prune(() => {
      throw new Error('boom');
    });

    expect(outcome).toEqual({ removed: 0, failures: 0 });
    expect(store.keys()).toHaveLength(3);
  });

  it('prunes nothing from a store that cannot list its keys', async () => {
    const cache = new ResultCache({
      store: rejectingUpdateStore('never written'),
      now: () => 1234,
    });
    expect(await cache.prune(() => false)).toEqual({
      removed: 0,
      failures: 0,
    });
  });

  it('counts a failed delete instead of rejecting', async () => {
    const values = createMemoryCacheStore();
    await new ResultCache({ store: values, now: () => 1 }).store(
      identity(),
      ok(),
    );
    const cache = new ResultCache({
      store: {
        get: (key) => values.get(key),
        update: () => Promise.reject(new Error('read-only')),
        keys: () => values.keys(),
      },
      now: () => 1,
    });
    expect(await cache.prune(() => false)).toEqual({
      removed: 0,
      failures: 1,
    });
  });
});
