import * as fs from 'fs';
import * as path from 'path';

import {
  ASSUMED_SERVICE_MS,
  REPLAY_FILE,
  REPLAY_GRID,
  replayCell,
  replayTableJson,
  runReplay,
} from '@/measurement/replay';
import { TRACES, type EditTrace } from '@/measurement/traces';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 15A US2: the offline replay runs the real scheduler on a simulated clock over edit
 * traces and candidate timing settings. No live call; deterministic.
 */

const REPO_ROOT = path.join(__dirname, '../../..');

function trace(name: string): EditTrace {
  const found = TRACES.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`no trace ${name}`);
  }
  return found;
}

describe('replayCell, checked by hand (US2-1, US2-2)', () => {
  /*
   * burst-pause, quiet 3 s, no cooldown, 10 s detector:
   * a8 at 2.8 s → due 5.8 s → call #1 until 15.8 s; the second burst (12.8–15.2 s) arrives
   * meanwhile, so #1 settles stale. b5 (15.2 s) is due at 18.2 s → call #2 until 28.2 s,
   * current: 13 s after the last edit. Each call waited 3 s of quiet.
   */
  test('burst-pause at 3 s / 0 s: 2 calls, 1 stale, current 13 s after the last edit', async () => {
    expect(await replayCell(trace('burst-pause'), 3000, 0, 10_000)).toEqual({
      trace: 'burst-pause',
      quietMs: 3000,
      cooldownMs: 0,
      serviceMs: 10_000,
      calls: 2,
      stale: 1,
      toCurrentMs: 13_000,
      waitMs: 6000,
    });
  });

  /*
   * Same trace, quiet 0.5 s: #1 starts at 3.3 s (until 13.3 s, stale); b1's pending work is
   * due as #1 settles, so #2 runs 13.3–23.3 s on b1 (stale too); #3 analyses b5, current.
   */
  test('a shorter quiet period on the same trace costs more calls and more stale results', async () => {
    const short = await replayCell(trace('burst-pause'), 500, 0, 10_000);
    const current = await replayCell(trace('burst-pause'), 3000, 0, 10_000);

    expect(short.calls).toBe(3);
    expect(short.stale).toBe(2);
    expect(short.calls).toBeGreaterThan(current.calls);
  });

  /*
   * undo-back, quiet 3 s, cooldown 30 s, 10 s detector: A is analysed 3–13 s (cooldown until
   * 43 s). B at 14 s, back to A at 16 s: A's quiet period ends at 19 s, and the cache answers
   * during the cooldown. 1 call, current 3 s after the undo; 3 s + 3 s of quiet waited.
   */
  test('undo-back at 3 s / 30 s: the undo is a cache hit 3 s later, during the cooldown', async () => {
    expect(await replayCell(trace('undo-back'), 3000, 30_000, 10_000)).toEqual({
      trace: 'undo-back',
      quietMs: 3000,
      cooldownMs: 30_000,
      serviceMs: 10_000,
      calls: 1,
      stale: 0,
      toCurrentMs: 3000,
      waitMs: 6000,
    });
  });

  test('saves of unchanged content never start a call', async () => {
    const withSaves = await replayCell(trace('save-heavy'), 3000, 0, 1000);
    expect(withSaves.calls).toBe(12);
  });
});

describe('runReplay (US2-3, US2-4)', () => {
  test('covers every trace and the whole grid, today’s 3 s / 30 s included', async () => {
    const table = await runReplay();

    expect(REPLAY_GRID.quietMs).toContain(3000);
    expect(REPLAY_GRID.cooldownMs).toContain(30_000);
    expect(table.cells).toHaveLength(
      TRACES.length *
        REPLAY_GRID.quietMs.length *
        REPLAY_GRID.cooldownMs.length *
        ASSUMED_SERVICE_MS.length,
    );
    expect(
      table.cells.some(
        (c) =>
          c.trace === 'recorded-f5' &&
          c.quietMs === 3000 &&
          c.cooldownMs === 30_000,
      ),
    ).toBe(true);
  });

  test('is deterministic: two runs give identical JSON', async () => {
    expect(replayTableJson(await runReplay())).toBe(
      replayTableJson(await runReplay()),
    );
  });

  test(`the committed ${REPLAY_FILE} matches a fresh run (UPDATE_REPLAY=1 rewrites it)`, async () => {
    const file = path.join(REPO_ROOT, REPLAY_FILE);
    const fresh = replayTableJson(await runReplay());
    if (process.env.UPDATE_REPLAY === '1') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh);
    }
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(fresh);
  });

  test('never loads the Claude client', () => {
    jest.isolateModules(() => {
      jest.doMock('@/utils/claude', () => {
        throw new Error('@/utils/claude must not be loaded');
      });
      expect(() =>
        jest.requireActual<typeof import('@/measurement/replay')>(
          '@/measurement/replay',
        ),
      ).not.toThrow();
    });
  });
});
