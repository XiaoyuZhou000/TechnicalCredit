import { RealDetector } from '@/background/detector/realDetector';
import { buildContextFromSource } from '@/context/buildContext';
import type { AdrSummary } from '@/context/findAdrs';
import { detectTechnicalCredit } from '@/detection/detectTechnicalCredit';
import { createFakeTimers } from '@/test/background/fakeTimers';
import { initParser } from '@/test/context/parserSetup';
import {
  answer,
  candidate,
  createFakeClaude,
  type RecordedCall,
  type Script,
} from '@/test/detection/fakeClaude';

jest.mock('@/utils/claude', () => {
  throw new Error('@/utils/claude must not be loaded by offline tests');
});

/**
 * Card 14 (FR-003, SC-002): for the same type and the same fake client, the background detector
 * sends exactly the prompts the manual path sends, and gets the same findings. The manual path
 * is modelled as `analyse.ts` runs it: context from the cursor's declaration, then the service.
 */

beforeAll(() => {
  initParser();
});

const FILE_NAME = '/w/src/demo/Service.java';
const SOURCE = `package demo;

import java.util.List;
import demo.store.Store;

/** Stores items behind an interface. */
public class Service implements Runnable {
  private final Store store;

  public Service(Store store) {
    this.store = store;
  }

  @Override
  public void run() {
    store.save(List.of());
  }
}
`;
/** The line of `public class Service`, where a user would put the cursor. */
const CLASS_LINE = 6;

const ADRS: readonly AdrSummary[] = [
  {
    id: 'ADR-003',
    title: 'Inject stores',
    tcContext: 'tc-category: modularity',
  },
];

const SCRIPT: Script = {
  abstraction: answer(candidate('abstraction')),
  modularity: answer(candidate('modularity')),
  'adr:modularity': answer({ adr: 'ADR-003' }),
};

/** Calls as an order-free multiset: the service runs each phase in parallel. */
function promptsOf(calls: readonly RecordedCall[]): string[] {
  return calls.map((c) => JSON.stringify([c.system, c.user])).sort();
}

describe('background and manual paths share one detection core (card 14)', () => {
  test('the same prompts, in the same set of calls, give the same findings', async () => {
    const manualClaude = createFakeClaude(SCRIPT);
    const context = await buildContextFromSource(
      SOURCE,
      CLASS_LINE,
      0,
      'java',
      FILE_NAME,
    );
    if (context === null) {
      throw new Error('the fixture must have a class at the cursor');
    }
    const manual = await detectTechnicalCredit(
      { context, adrs: ADRS },
      manualClaude.client,
      new AbortController().signal,
    );

    const backgroundClaude = createFakeClaude(SCRIPT);
    const detector = new RealDetector({
      client: backgroundClaude.client,
      adrsFor: () => ADRS,
      clock: createFakeTimers(),
      fileNameOf: () => FILE_NAME,
    });
    const background = await detector.analyse(
      {
        workspaceId: 'file:///w',
        fileUri: 'file:///w/src/demo/Service.java',
        languageId: 'java',
        version: 1,
        contentHash: 'b'.repeat(64),
        content: SOURCE,
      },
      new AbortController().signal,
    );

    expect(promptsOf(backgroundClaude.calls)).toEqual(
      promptsOf(manualClaude.calls),
    );
    // 8 heuristic calls, then one ADR-matching call per candidate.
    expect(backgroundClaude.calls).toHaveLength(10);
    if (!manual.ok || !background.ok) {
      throw new Error('both paths must succeed');
    }
    expect(background.output.findings.map((f) => f.result)).toEqual(
      manual.findings,
    );
    expect(manual.findings.map((f) => f.adr)).toEqual([null, 'ADR-003']);
  });
});
