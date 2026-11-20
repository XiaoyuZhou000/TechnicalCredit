import { createHash } from 'crypto';

import {
  isCacheable,
  type DetectorFinding,
  type DetectorOutput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { TCCategory, TCResult } from '@/comment/tcResult';

/** The `v1` must change together with `CachedEntry.format`, so entries in an old shape are never read. */
export const CACHE_KEY_PREFIX = 'technicalCredit.resultCache.v1:';

/**
 * SHA-256 of the exact text as UTF-8, as 64 lowercase hex characters. Line endings are not
 * normalised: the detector sees the text as it is, so CRLF and LF text are different content.
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The only storage operations the cache needs. `vscode.Memento` (`context.globalState`)
 * satisfies it structurally, so this module never imports `vscode` and needs no adapter.
 */
export interface CacheStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Everything a lookup must match before a stored result may be reused. */
export interface CacheIdentity {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly contentHash: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
}

/** The stored value. Never represents a failure: failures are never written. */
export interface CachedEntry {
  readonly format: 1;
  readonly contentHash: string;
  readonly storedAt: number;
  readonly output: DetectorOutput;
}

export type CacheLookup =
  | { readonly hit: true; readonly entry: CachedEntry }
  | {
      readonly hit: false;
      readonly reason: 'absent' | 'content-changed' | 'unreadable';
    }
  | { readonly hit: false; readonly reason: 'error'; readonly message: string };

export type StoreOutcome =
  | { readonly status: 'stored' }
  | {
      readonly status: 'skipped';
      readonly reason: 'not-cacheable' | 'mismatch';
    }
  | { readonly status: 'failed'; readonly message: string };

/** Running totals since this cache was created; in memory only, so they restart at zero. */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly stored: number;
  readonly skipped: number;
  readonly storeFailures: number;
}

export interface ResultCacheOptions {
  readonly store: CacheStore;
  readonly now: () => number;
}

/**
 * The content hash is deliberately not in the key: each file and detector version keeps
 * only its latest result, so storage does not grow with every edit.
 */
function keyFor(identity: CacheIdentity): string {
  return (
    CACHE_KEY_PREFIX +
    JSON.stringify([
      identity.workspaceId,
      identity.fileUri,
      identity.detectorId,
      identity.detectorVersion,
    ])
  );
}

const HASH = /^[0-9a-f]{64}$/;

// `satisfies` makes the compiler reject this list if a category is added or removed.
const CATEGORIES = {
  abstraction: true,
  modularity: true,
  'api-stability': true,
  automation: true,
  'compliance-readiness': true,
  configurability: true,
  observability: true,
  reusability: true,
} satisfies Record<TCCategory, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArray(value) && value.every((item) => typeof item === 'string');
}

function isCategory(value: unknown): value is TCCategory {
  return typeof value === 'string' && Object.hasOwn(CATEGORIES, value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseResult(value: unknown): TCResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value.is_tc_candidate;
  const category = value.category;
  const benefit = value.benefit;
  const conditions = value.conditions;
  const signals = value.signals;
  const notTcReason = value.not_tc_reason;
  const adr = value.adr;
  if (
    candidate !== true ||
    !isCategory(category) ||
    typeof benefit !== 'string' ||
    typeof conditions !== 'string' ||
    !isStringArray(signals) ||
    !isNullableString(notTcReason) ||
    !(adr === undefined || isNullableString(adr))
  ) {
    return undefined;
  }
  const result: TCResult = {
    is_tc_candidate: candidate,
    category,
    benefit,
    conditions,
    signals: [...signals],
    not_tc_reason: notTcReason,
  };
  return adr === undefined ? result : { ...result, adr };
}

function parseFinding(value: unknown): DetectorFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const line = value.line;
  const result = parseResult(value.result);
  if (
    typeof line !== 'number' ||
    !Number.isInteger(line) ||
    line < 0 ||
    result === undefined
  ) {
    return undefined;
  }
  return { line, result };
}

/**
 * Stored values come back from storage that other versions of the extension, or a crash, may
 * have written, so every field is checked and a fresh object is built rather than cast.
 */
function parseEntry(
  value: unknown,
  identity: CacheIdentity,
): CachedEntry | undefined {
  if (!isRecord(value) || value.format !== 1) {
    return undefined;
  }
  const contentHash = value.contentHash;
  const storedAt = value.storedAt;
  const output = value.output;
  if (
    typeof contentHash !== 'string' ||
    !HASH.test(contentHash) ||
    typeof storedAt !== 'number' ||
    !Number.isFinite(storedAt) ||
    !isRecord(output) ||
    output.detectorId !== identity.detectorId ||
    output.detectorVersion !== identity.detectorVersion ||
    !isArray(output.findings)
  ) {
    return undefined;
  }
  const findings: DetectorFinding[] = [];
  for (const raw of output.findings) {
    const finding = parseFinding(raw);
    if (finding === undefined) {
      return undefined;
    }
    findings.push(finding);
  }
  return {
    format: 1,
    contentHash,
    storedAt,
    output: {
      detectorId: identity.detectorId,
      detectorVersion: identity.detectorVersion,
      findings,
    },
  };
}

/**
 * Reuses a successful detector output for identical content under the same detector version
 * (card 04). It never starts an analysis and never logs; callers log from the returned outcomes.
 */
export class ResultCache {
  private readonly storage: CacheStore;
  private readonly now: () => number;
  private readonly counts: Record<keyof CacheStats, number> = {
    hits: 0,
    misses: 0,
    stored: 0,
    skipped: 0,
    storeFailures: 0,
  };

  constructor(options: ResultCacheOptions) {
    this.storage = options.store;
    this.now = options.now;
  }

  /** Synchronous, so the caller can decide before starting any work. */
  lookup(identity: CacheIdentity): CacheLookup {
    const result = this.read(identity);
    if (result.hit) {
      this.counts.hits++;
    } else {
      this.counts.misses++;
    }
    return result;
  }

  async store(
    identity: CacheIdentity,
    result: DetectorResult,
  ): Promise<StoreOutcome> {
    const outcome = await this.write(identity, result);
    switch (outcome.status) {
      case 'stored':
        this.counts.stored++;
        break;
      case 'skipped':
        this.counts.skipped++;
        break;
      case 'failed':
        this.counts.storeFailures++;
        break;
    }
    return outcome;
  }

  stats(): CacheStats {
    return Object.freeze({ ...this.counts });
  }

  private read(identity: CacheIdentity): CacheLookup {
    const value = this.storage.get(keyFor(identity));
    if (value === undefined) {
      return { hit: false, reason: 'absent' };
    }
    const entry = parseEntry(value, identity);
    if (entry === undefined) {
      return { hit: false, reason: 'unreadable' };
    }
    return entry.contentHash === identity.contentHash
      ? { hit: true, entry }
      : { hit: false, reason: 'content-changed' };
  }

  private async write(
    identity: CacheIdentity,
    result: DetectorResult,
  ): Promise<StoreOutcome> {
    // `isCacheable` owns the policy; the `ok` check only narrows the type.
    if (!isCacheable(result) || !result.ok) {
      return { status: 'skipped', reason: 'not-cacheable' };
    }
    const entry: CachedEntry = {
      format: 1,
      contentHash: identity.contentHash,
      storedAt: this.now(),
      output: result.output,
    };
    await this.storage.update(keyFor(identity), entry);
    return { status: 'stored' };
  }
}
