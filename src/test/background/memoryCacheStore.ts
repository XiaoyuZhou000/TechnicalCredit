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

export interface DeferredCacheStore extends MemoryCacheStore {
  /** Applies and resolves every held update, in the order they were made. */
  flush(): void;
  /** Makes the next held update reject with `message` instead of applying. */
  failNext(message: string): void;
  /** Settles only the oldest held update: applies it, or rejects it with `failWith`. */
  flushNext(failWith?: string): void;
  /** Updates made but not yet applied. */
  held(): number;
}

/**
 * Like `createMemoryCacheStore`, but an `update` is only applied when the test calls `flush()`,
 * so a test can observe reads that happen while a write is still in flight (card 16A).
 */
export function createDeferredCacheStore(): DeferredCacheStore {
  const base = createMemoryCacheStore();
  const queue: {
    readonly apply: () => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  const failures: string[] = [];
  return {
    get: (key) => base.get(key),
    update: (key, value) =>
      new Promise<void>((resolve, reject) => {
        queue.push({
          apply: () => {
            void base.update(key, value);
            resolve();
          },
          reject,
        });
      }),
    keys: () => base.keys(),
    rawSet: (key, value) => base.rawSet(key, value),
    flush: () => {
      for (const item of queue.splice(0)) {
        const failure = failures.shift();
        if (failure === undefined) {
          item.apply();
        } else {
          item.reject(new Error(failure));
        }
      }
    },
    failNext: (message) => {
      failures.push(message);
    },
    flushNext: (failWith) => {
      const item = queue.shift();
      if (item === undefined) {
        throw new Error('no held update');
      }
      if (failWith === undefined) {
        item.apply();
      } else {
        item.reject(new Error(failWith));
      }
    },
    held: () => queue.length,
  };
}
