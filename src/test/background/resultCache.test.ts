import * as fs from 'fs';
import * as path from 'path';

import {
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
  type MemoryCacheStore,
} from '@/test/background/memoryCacheStore';

/** Offline tests for card 04's cache: no `vscode`, an in-memory store, a fixed clock. */

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

describe('ResultCache', () => {
  it('returns the stored output unchanged for the same identity (SC-001)', async () => {
    const { cache } = memory();
    await cache.store(identity(), ok());

    for (let i = 0; i < 10; i++) {
      const lookup = cache.lookup(identity());
      expect(lookup).toEqual({
        hit: true,
        entry: {
          format: 1,
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

  it('keeps one entry per file and version, holding the latest content (SC-006)', async () => {
    const { cache, store } = memory();
    const versions = Array.from({ length: 20 }, (_, i) => `${POSITIVE}${i}`);

    for (const content of versions) {
      await cache.store(identity({ contentHash: sha256Hex(content) }), ok());
    }

    expect(store.keys()).toHaveLength(1);
    expect(store.keys()[0].startsWith(CACHE_KEY_PREFIX)).toBe(true);
    expect(
      cache.lookup(identity({ contentHash: sha256Hex(versions[19]) })).hit,
    ).toBe(true);
    expect(
      cache.lookup(identity({ contentHash: sha256Hex(versions[18]) })),
    ).toEqual({ hit: false, reason: 'content-changed' });
  });
});
