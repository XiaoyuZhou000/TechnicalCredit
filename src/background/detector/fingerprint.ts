import { createHash } from 'crypto';

import type { TCResult } from '@/comment/tcResult';
import type { TcContext } from '@/context/buildContext';
import type { AdrSummary } from '@/context/findAdrs';
import { ADR_SYSTEM_PROMPT, createAdrUserPrompt } from '@/prompts/adrPrompt';
import {
  createHeuristicPrompt,
  HEURISTIC_CATEGORIES,
} from '@/prompts/heuristics';
import { SYSTEM_PROMPT } from '@/prompts/systemPrompt';
import { createUserPrompt } from '@/prompts/userPrompts';
import {
  CLAUDE_MAX_TOKENS,
  CLAUDE_MODEL,
  CLAUDE_PRIMING_TURNS,
} from '@/utils/claudeConfig';

/**
 * Bump when detection logic that can't be rendered changes findings: what `validateAnswer.ts`
 * accepts, the set of calls `detectTechnicalCredit` makes, or how `realDetector.ts` selects
 * types and maps findings. Prompt, template and model changes need no bump: they change the
 * fingerprint on their own.
 */
export const DETECTION_LOGIC_REVISION = 1;

/** Everything that can change the real detector's findings, and nothing about timing. */
export interface FingerprintInputs {
  readonly model: string;
  readonly maxTokens: number;
  readonly primingTurns: readonly {
    readonly role: string;
    readonly content: string;
  }[];
  readonly systemPrompt: string;
  /** In `HEURISTIC_CATEGORIES` order, which is also the order of the findings. */
  readonly heuristicPrompts: readonly (readonly [string, string])[];
  /** The user prompt rendered for a fixed sample, so a template change is seen. */
  readonly userPromptSample: string;
  readonly adrSystemPrompt: string;
  readonly adrUserPromptSample: string;
  readonly logicRevision: number;
}

const SAMPLE_SOURCE = `public class Sample implements Runnable {
  private final Service service;

  public Sample(Service service) {
    this.service = service;
  }

  @Override
  public void run() {
    service.start();
  }
}`;

const SAMPLE_CONTEXT: TcContext = {
  fileName: 'Sample.java',
  language: 'java',
  importLines: ['package sample;', 'import sample.service.Service;'],
  constructMetrics: {
    constructType: 'class',
    name: 'Sample',
    annotations: [],
    startRow: 2,
    enclosingClassStartRow: null,
    classSource: SAMPLE_SOURCE,
    classMetrics: {
      superclass: null,
      implementedInterfaces: [{ name: 'Runnable', resolvedImport: null }],
      fields: [
        {
          name: 'service',
          type: 'Service',
          isFinal: true,
          annotations: [],
        },
      ],
      finalFieldTypes: ['Service'],
      constructors: [
        { paramCount: 1, paramTypes: ['Service'], hasAutowired: false },
      ],
      methodCount: 1,
      nestedDeclarations: [],
    },
    interfaceMetrics: null,
  },
  insertLine: 2,
  insertIndent: '',
};

const SAMPLE_FINDING: TCResult = {
  is_tc_candidate: true,
  category: 'abstraction',
  benefit: 'Callers depend on Runnable, not on Sample.',
  conditions: 'More Runnable implementations are expected.',
  signals: ['implements Runnable', 'constructor injection'],
  not_tc_reason: null,
};

const SAMPLE_ADRS: readonly AdrSummary[] = [
  {
    id: 'ADR-001',
    title: 'Depend on interfaces',
    tcContext: 'tc-category: abstraction',
  },
  { id: 'ADR-002', title: 'Log every request', tcContext: '' },
];

/** The inputs for the code as built: the real prompts, model and logic revision. */
export function currentFingerprintInputs(): FingerprintInputs {
  return {
    model: CLAUDE_MODEL,
    maxTokens: CLAUDE_MAX_TOKENS,
    primingTurns: CLAUDE_PRIMING_TURNS,
    systemPrompt: SYSTEM_PROMPT,
    heuristicPrompts: HEURISTIC_CATEGORIES.map(
      (category) => [category, createHeuristicPrompt(category)] as const,
    ),
    userPromptSample: createUserPrompt(SAMPLE_CONTEXT),
    adrSystemPrompt: ADR_SYSTEM_PROMPT,
    adrUserPromptSample: createAdrUserPrompt(SAMPLE_FINDING, [...SAMPLE_ADRS]),
    logicRevision: DETECTION_LOGIC_REVISION,
  };
}

/**
 * Card 14: `fp-` plus the first 16 hex characters of a SHA-256 over the inputs. An array fixes
 * the order, so the same inputs always give the same version, in dev and production builds.
 */
export function detectorFingerprint(inputs: FingerprintInputs): string {
  const canonical = JSON.stringify([
    inputs.model,
    inputs.maxTokens,
    inputs.primingTurns.map((turn) => [turn.role, turn.content]),
    inputs.systemPrompt,
    inputs.heuristicPrompts,
    inputs.userPromptSample,
    inputs.adrSystemPrompt,
    inputs.adrUserPromptSample,
    inputs.logicRevision,
  ]);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `fp-${hash.slice(0, 16)}`;
}
