import { createHash } from 'crypto';

import {
  isCacheable,
  type DetectorFinding,
  type DetectorOutput,
  type DetectorResult,
} from '@/background/detector/detector';
import type { TCCategory, TCResult } from '@/comment/tcResult';

/**
 * Bump whenever the stored shape changes. The key prefix, the stored `format` field and the
 * read check all derive from it, so entries in an old shape are never read as this one.
 * Format 2 (card 16A) keeps up to `CACHE_CAPACITY` results per scope.
 */
export const CACHE_FORMAT = 2;

export const CACHE_KEY_PREFIX = `technicalCredit.resultCache.v${CACHE_FORMAT}:`;

/** Results kept per workspace + file URI + detector id + detector version (card 16A). */
export const CACHE_CAPACITY = 4;

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
  /** Only `prune` lists keys; a store without it is never pruned. */
  keys?(): readonly string[];
}

/** What a scope's key names: everything in `CacheIdentity` but the content. */
export type ScopeIdentity = Omit<CacheIdentity, 'contentHash'>;

export interface PruneOutcome {
  readonly removed: number;
  readonly failures: number;
}

/** Everything a lookup must match before a stored result may be reused. */
export interface CacheIdentity {
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly contentHash: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
}

/** The result a hit returns. Never represents a failure: failures are never written. */
export interface CachedEntry {
  readonly format: typeof CACHE_FORMAT;
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

export interface StoreOptions {
  /** Content hashes never evicted to make room: the file's current and pending content. */
  readonly protect?: readonly string[];
}

export type StoreOutcome =
  | {
      readonly status: 'stored';
      /** The same content was already stored; its entry was replaced, taking no extra slot. */
      readonly replaced: boolean;
      /** The content hash evicted to make room, when the scope was full. */
      readonly evicted?: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'not-cacheable' | 'mismatch' | 'protected';
    }
  | { readonly status: 'failed'; readonly message: string };

/** Running totals since this cache was created; in memory only, so they restart at zero. */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly stored: number;
  /** Includes `notRetained`. */
  readonly skipped: number;
  readonly storeFailures: number;
  readonly evicted: number;
  /** Stale results not kept because every entry was protected. */
  readonly notRetained: number;
  /** Hits whose recency write failed; the hit itself still counted. */
  readonly recencyFailures: number;
}

export interface ResultCacheOptions {
  readonly store: CacheStore;
  readonly now: () => number;
}

/**
 * One key per scope: the content hash is deliberately not in the key, so a scope's entries
 * live in one value and storage per file and version stays bounded (card 16A).
 */
function keyFor(identity: ScopeIdentity): string {
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

/** The scope a key of this format names; `undefined` for any other key. */
function scopeOfKey(key: string): ScopeIdentity | undefined {
  if (!key.startsWith(CACHE_KEY_PREFIX)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(key.slice(CACHE_KEY_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isStringArray(parsed) || parsed.length !== 4) {
    return undefined;
  }
  const [workspaceId, fileUri, detectorId, detectorVersion] = parsed;
  return { workspaceId, fileUri, detectorId, detectorVersion };
}

/** One stored result. `lastUse` is the scope's `uses` at its last store or hit. */
interface StoredEntry {
  readonly contentHash: string;
  readonly storedAt: number;
  readonly lastUse: number;
  readonly output: DetectorOutput;
}

/**
 * The persisted value of one scope. `uses` counts stores and hits, so recency is deterministic
 * whatever the clock does, and survives restarts.
 */
interface StoredScope {
  readonly format: typeof CACHE_FORMAT;
  readonly uses: number;
  readonly entries: readonly StoredEntry[];
}

type ScopeRead =
  | { readonly kind: 'ok'; readonly scope: StoredScope }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'error'; readonly message: string };

const EMPTY_SCOPE: StoredScope = { format: CACHE_FORMAT, uses: 0, entries: [] };

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** The output must belong to the scope's detector and version, with every finding valid. */
function parseOutput(
  value: unknown,
  identity: CacheIdentity,
): DetectorOutput | undefined {
  if (
    !isRecord(value) ||
    value.detectorId !== identity.detectorId ||
    value.detectorVersion !== identity.detectorVersion ||
    !isArray(value.findings)
  ) {
    return undefined;
  }
  const findings: DetectorFinding[] = [];
  for (const raw of value.findings) {
    const finding = parseFinding(raw);
    if (finding === undefined) {
      return undefined;
    }
    findings.push(finding);
  }
  return {
    detectorId: identity.detectorId,
    detectorVersion: identity.detectorVersion,
    findings,
  };
}

function isUse(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 1;
}

/**
 * Stored values come back from storage that other versions of the extension, or a crash, may
 * have written, so the whole scope is checked and fresh objects are built rather than cast.
 * One bad entry makes the scope unreadable: the next store replaces it with a valid one.
 */
function parseScope(
  value: unknown,
  identity: CacheIdentity,
): StoredScope | undefined {
  if (
    !isRecord(value) ||
    value.format !== CACHE_FORMAT ||
    !isUse(value.uses) ||
    !isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > CACHE_CAPACITY
  ) {
    return undefined;
  }
  const uses = value.uses;
  const entries: StoredEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw)) {
      return undefined;
    }
    const { contentHash, storedAt, lastUse } = raw;
    const output = parseOutput(raw.output, identity);
    if (
      typeof contentHash !== 'string' ||
      !HASH.test(contentHash) ||
      typeof storedAt !== 'number' ||
      !Number.isFinite(storedAt) ||
      !isUse(lastUse) ||
      lastUse > uses ||
      output === undefined ||
      entries.some(
        (e) => e.contentHash === contentHash || e.lastUse === lastUse,
      )
    ) {
      return undefined;
    }
    entries.push({ contentHash, storedAt, lastUse, output });
  }
  return { format: CACHE_FORMAT, uses, entries };
}

/** A `keep` that throws keeps the scope: deleting results is never the safe default. */
function keepSafely(
  keep: (scope: ScopeIdentity) => boolean,
  scope: ScopeIdentity,
): boolean {
  try {
    return keep(scope);
  } catch {
    return true;
  }
}

/** The entry used least recently: the eviction victim when a scope is full. */
function leastRecentlyUsed(
  entries: readonly StoredEntry[],
): StoredEntry | undefined {
  let victim: StoredEntry | undefined;
  for (const entry of entries) {
    if (victim === undefined || entry.lastUse < victim.lastUse) {
      victim = entry;
    }
  }
  return victim;
}

/**
 * Reuses a successful detector output for identical content under the same detector version
 * (card 04), keeping up to `CACHE_CAPACITY` contents per file and version, least recently used
 * evicted first (card 16A). It never starts an analysis and never logs; callers log from the
 * returned outcomes.
 */
export class ResultCache {
  private readonly storage: CacheStore;
  private readonly now: () => number;
  /**
   * Values whose `update` hasn't settled yet, read before storage, so operations on one scope
   * always build on the newest value even if the store applies writes late (card 16A FR-012).
   * Each write is its own slot, so only the write that set it may clear it.
   */
  private readonly inFlight = new Map<string, { readonly value: unknown }>();
  private readonly counts: Record<keyof CacheStats, number> = {
    hits: 0,
    misses: 0,
    stored: 0,
    skipped: 0,
    storeFailures: 0,
    evicted: 0,
    notRetained: 0,
    recencyFailures: 0,
  };

  constructor(options: ResultCacheOptions) {
    this.storage = options.store;
    this.now = options.now;
  }

  /**
   * Synchronous, so the caller can decide before starting any work. Never throws. A `recheck`
   * repeats a lookup whose miss the caller already counted, so a second miss isn't counted.
   */
  lookup(
    identity: CacheIdentity,
    options: { readonly recheck?: boolean } = {},
  ): CacheLookup {
    const result = this.read(identity);
    if (result.hit) {
      this.counts.hits++;
    } else if (options.recheck !== true) {
      this.counts.misses++;
    }
    return result;
  }

  /** Never rejects: a storage failure is an outcome, and the caller just analyses again later. */
  async store(
    identity: CacheIdentity,
    result: DetectorResult,
    options: StoreOptions = {},
  ): Promise<StoreOutcome> {
    const outcome = await this.write(identity, result, options);
    switch (outcome.status) {
      case 'stored':
        this.counts.stored++;
        if (outcome.evicted !== undefined) {
          this.counts.evicted++;
        }
        break;
      case 'skipped':
        this.counts.skipped++;
        if (outcome.reason === 'protected') {
          this.counts.notRetained++;
        }
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

  /**
   * Deletes every scope of this format that `keep` rejects. A scope's key names its detector
   * version, so scopes of a version no longer in use would otherwise stay in storage forever.
   * Keys are listed and deletes issued in one synchronous turn, so a store made after this
   * call is never deleted by it. Keys of other formats are left alone. Never rejects.
   */
  async prune(keep: (scope: ScopeIdentity) => boolean): Promise<PruneOutcome> {
    let keys: readonly string[];
    try {
      keys = this.storage.keys?.() ?? [];
    } catch {
      return { removed: 0, failures: 1 };
    }
    const deletes: Promise<string | undefined>[] = [];
    for (const key of keys) {
      const scope = scopeOfKey(key);
      if (scope !== undefined && !keepSafely(keep, scope)) {
        deletes.push(this.writeValue(key, undefined));
      }
    }
    const failures = (await Promise.all(deletes)).filter(
      (failure) => failure !== undefined,
    ).length;
    return { removed: deletes.length - failures, failures };
  }

  /** Throws only if the store's `get` throws. */
  private readValue(key: string): unknown {
    const slot = this.inFlight.get(key);
    return slot === undefined ? this.storage.get(key) : slot.value;
  }

  /**
   * Must be called in the same synchronous turn as the read it builds on: the value is visible
   * to every later read at once, before `update` settles. Resolves with a failure message, or
   * `undefined` once written; never rejects.
   */
  private async writeValue(
    key: string,
    value: unknown,
  ): Promise<string | undefined> {
    const slot = { value };
    this.inFlight.set(key, slot);
    try {
      // Inside the `try`, so an `update` that throws instead of rejecting is caught too.
      await Promise.resolve(this.storage.update(key, value));
      return undefined;
    } catch (error) {
      return messageOf(error);
    } finally {
      if (this.inFlight.get(key) === slot) {
        this.inFlight.delete(key);
      }
    }
  }

  private readScope(identity: CacheIdentity): ScopeRead {
    let value: unknown;
    try {
      value = this.readValue(keyFor(identity));
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    }
    if (value === undefined) {
      return { kind: 'absent' };
    }
    const scope = parseScope(value, identity);
    return scope === undefined ? { kind: 'unreadable' } : { kind: 'ok', scope };
  }

  private read(identity: CacheIdentity): CacheLookup {
    const read = this.readScope(identity);
    switch (read.kind) {
      case 'error':
        return { hit: false, reason: 'error', message: read.message };
      case 'absent':
        return { hit: false, reason: 'absent' };
      case 'unreadable':
        return { hit: false, reason: 'unreadable' };
      case 'ok':
        break;
    }
    const entry = read.scope.entries.find(
      (e) => e.contentHash === identity.contentHash,
    );
    if (entry === undefined) {
      return { hit: false, reason: 'content-changed' };
    }
    this.touch(identity, read.scope, entry);
    return {
      hit: true,
      entry: {
        format: CACHE_FORMAT,
        contentHash: entry.contentHash,
        storedAt: entry.storedAt,
        output: entry.output,
      },
    };
  }

  /**
   * A hit counts as use (card 16A), written at once so the order survives restarts. The write
   * runs in the background, because `lookup` must answer synchronously; a failed write only
   * leaves the order slightly older, so it is counted and never reported as an error.
   * An entry that is already the most recent is not rewritten: the order wouldn't change, and
   * every write rewrites the whole scope, which can also drop an entry another window just
   * stored (known issue 27).
   */
  private touch(
    identity: CacheIdentity,
    scope: StoredScope,
    used: StoredEntry,
  ): void {
    if (used.lastUse === scope.uses) {
      return;
    }
    const uses = scope.uses + 1;
    const touched: StoredScope = {
      format: CACHE_FORMAT,
      uses,
      entries: scope.entries.map((e) =>
        e === used ? { ...e, lastUse: uses } : e,
      ),
    };
    void this.writeValue(keyFor(identity), touched).then((failure) => {
      if (failure !== undefined) {
        this.counts.recencyFailures++;
      }
    });
  }

  private async write(
    identity: CacheIdentity,
    result: DetectorResult,
    options: StoreOptions,
  ): Promise<StoreOutcome> {
    // `isCacheable` owns the policy; the `ok` check only narrows the type.
    if (!isCacheable(result) || !result.ok) {
      return { status: 'skipped', reason: 'not-cacheable' };
    }
    // Filing an output under another detector's key would let a lookup for that version hit
    // results it never produced.
    if (
      result.output.detectorId !== identity.detectorId ||
      result.output.detectorVersion !== identity.detectorVersion
    ) {
      return { status: 'skipped', reason: 'mismatch' };
    }
    const read = this.readScope(identity);
    // Unknown contents can't be merged, and writing over them could discard valid entries.
    if (read.kind === 'error') {
      return { status: 'failed', message: read.message };
    }
    // An unreadable scope is replaced by a valid one.
    const base = read.kind === 'ok' ? read.scope : EMPTY_SCOPE;
    const uses = base.uses + 1;
    const fresh: StoredEntry = {
      contentHash: identity.contentHash,
      storedAt: this.now(),
      lastUse: uses,
      output: result.output,
    };

    let entries: readonly StoredEntry[];
    let replaced = false;
    let evicted: string | undefined;
    if (base.entries.some((e) => e.contentHash === fresh.contentHash)) {
      entries = base.entries.map((e) =>
        e.contentHash === fresh.contentHash ? fresh : e,
      );
      replaced = true;
    } else if (base.entries.length < CACHE_CAPACITY) {
      entries = [...base.entries, fresh];
    } else {
      const protect = new Set(options.protect ?? []);
      const victim = leastRecentlyUsed(
        base.entries.filter((e) => !protect.has(e.contentHash)),
      );
      if (victim === undefined) {
        return { status: 'skipped', reason: 'protected' };
      }
      entries = base.entries.map((e) => (e === victim ? fresh : e));
      evicted = victim.contentHash;
    }

    const scope: StoredScope = { format: CACHE_FORMAT, uses, entries };
    const failure = await this.writeValue(keyFor(identity), scope);
    if (failure !== undefined) {
      return { status: 'failed', message: failure };
    }
    return evicted === undefined
      ? { status: 'stored', replaced }
      : { status: 'stored', replaced, evicted };
  }
}
