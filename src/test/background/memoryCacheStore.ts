import type { CacheStore } from '@/background/cache/resultCache';

export interface MemoryCacheStore extends CacheStore {
  keys(): readonly string[];
  /** Stores a value without encoding it, so tests can plant values JSON could never hold. */
  rawSet(key: string, value: unknown): void;
}

/**
 * Test-only stand-in for `context.globalState`. Values go through JSON on the way in, as
 * VS Code's storage does, so a test can't accidentally rely on getting the same object back.
 */
export function createMemoryCacheStore(): MemoryCacheStore {
  const values = new Map<string, () => unknown>();
  return {
    get: (key) => values.get(key)?.(),
    update: (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        const json = JSON.stringify(value);
        values.set(key, (): unknown => JSON.parse(json));
      }
      return Promise.resolve();
    },
    keys: () => [...values.keys()],
    rawSet: (key, value) => {
      values.set(key, () => value);
    },
  };
}

export function throwingGetStore(message: string): CacheStore {
  return {
    get: () => {
      throw new Error(message);
    },
    update: () => Promise.resolve(),
  };
}

export function rejectingUpdateStore(message: string): CacheStore {
  return {
    get: () => undefined,
    update: () => Promise.reject(new Error(message)),
  };
}

export function throwingUpdateStore(message: string): CacheStore {
  return {
    get: () => undefined,
    update: () => {
      throw new Error(message);
    },
  };
}
