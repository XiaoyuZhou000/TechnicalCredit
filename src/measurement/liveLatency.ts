import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

import type { Clock } from '@/background/scheduler/clock';
import { setExtensionPath } from '@/context/javaParser';
import {
  MAX_LIVE_BUDGET,
  runLiveSample,
  type LiveFixture,
} from '@/measurement/liveSample';
import { callClaude } from '@/utils/claude';
import { CLAUDE_MODEL } from '@/utils/claudeConfig';

/**
 * Card 15A: the opt-in, billed live latency sample. Run only with `npm run measure:live`,
 * `TC_LIVE_MEASURE=1` and an explicit `TC_LIVE_BUDGET`, and only after the person paying has
 * approved that run. Never part of the extension, `npm test` or the compile.
 */

/** The bundle runs from `dist/`, one level below the repository root. */
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'src/test/measurement/fixtures');
const FIXTURES = ['OneA.java', 'OneB.java', 'Two.java', 'Three.java'];
const OUTPUT = path.join(REPO_ROOT, 'measurements/ba-15a-live-runs.json');

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

function refuse(reason: string): never {
  console.error(`measure:live refused: ${reason}`);
  process.exit(1);
}

function readBudget(): number {
  const raw = process.env.TC_LIVE_BUDGET;
  const value = raw === undefined ? NaN : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIVE_BUDGET.requests
  ) {
    refuse(
      `set TC_LIVE_BUDGET to the approved request budget, 1–${MAX_LIVE_BUDGET.requests}`,
    );
  }
  return value;
}

function readPrice(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    refuse(`${name} must be a non-negative number (USD per million tokens)`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.TC_LIVE_MEASURE !== '1') {
    refuse('this run is billed; set TC_LIVE_MEASURE=1 once it is approved');
  }
  const requests = readBudget();
  const inputPrice = readPrice('TC_PRICE_IN');
  const outputPrice = readPrice('TC_PRICE_OUT');
  setExtensionPath(REPO_ROOT);

  const fixtures: LiveFixture[] = FIXTURES.map((name) => ({
    name,
    content: fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'),
  }));
  const startedAt = new Date();
  const result = await runLiveSample({
    fixtures,
    budget: { analyses: MAX_LIVE_BUDGET.analyses, requests },
    client: (systemPrompt, userMessage, signal, onUsage) =>
      callClaude(systemPrompt, userMessage, signal, onUsage),
    clock: realClock,
    monotonic: () => performance.now(),
    environment: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      node: process.version,
      model: CLAUDE_MODEL,
      date: startedAt.toISOString(),
    },
    runId: startedAt.getTime().toString(36),
    ...(inputPrice !== undefined &&
      outputPrice !== undefined && {
        prices: { inputPerMTok: inputPrice, outputPerMTok: outputPrice },
      }),
    log: (line) => console.log(line),
  });

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `measure:live done: ${result.used.analyses} runs, ${result.used.requests}/${requests} requests` +
      (result.stoppedBy === undefined
        ? ''
        : `, stopped by ${result.stoppedBy}`) +
      ` → ${path.relative(REPO_ROOT, OUTPUT)}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `measure:live failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
