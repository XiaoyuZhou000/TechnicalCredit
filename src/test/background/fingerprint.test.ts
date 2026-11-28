import {
  currentFingerprintInputs,
  detectorFingerprint,
  type FingerprintInputs,
} from '@/background/detector/fingerprint';
import { HEURISTIC_CATEGORIES } from '@/prompts/heuristics';

/**
 * Card 14: the real detector's version is derived from everything that can change findings, so
 * a prompt or model change can never be served results cached under the old one.
 */
const BASE: FingerprintInputs = {
  model: 'model-a',
  maxTokens: 100,
  primingTurns: [
    { role: 'user', content: 'json please' },
    { role: 'assistant', content: '{}' },
  ],
  systemPrompt: 'system',
  heuristicPrompts: [
    ['abstraction', 'prompt a'],
    ['modularity', 'prompt m'],
  ],
  userPromptSample: 'user sample',
  adrSystemPrompt: 'adr system',
  adrUserPromptSample: 'adr user sample',
  logicRevision: 1,
};

describe('detectorFingerprint', () => {
  test('is fp- plus 16 lowercase hex characters, and deterministic', () => {
    const fingerprint = detectorFingerprint(BASE);
    expect(fingerprint).toMatch(/^fp-[0-9a-f]{16}$/);
    expect(detectorFingerprint({ ...BASE })).toBe(fingerprint);
  });

  const changes: readonly [string, Partial<FingerprintInputs>][] = [
    ['model', { model: 'model-b' }],
    ['maxTokens', { maxTokens: 101 }],
    [
      'primingTurns',
      {
        primingTurns: [
          { role: 'user', content: 'JSON please' },
          { role: 'assistant', content: '{}' },
        ],
      },
    ],
    ['systemPrompt', { systemPrompt: 'system!' }],
    [
      'one heuristic prompt',
      {
        heuristicPrompts: [
          ['abstraction', 'prompt a!'],
          ['modularity', 'prompt m'],
        ],
      },
    ],
    [
      'heuristic order',
      {
        heuristicPrompts: [
          ['modularity', 'prompt m'],
          ['abstraction', 'prompt a'],
        ],
      },
    ],
    ['userPromptSample', { userPromptSample: 'user sample!' }],
    ['adrSystemPrompt', { adrSystemPrompt: 'adr system!' }],
    ['adrUserPromptSample', { adrUserPromptSample: 'adr user sample!' }],
    ['logicRevision', { logicRevision: 2 }],
  ];

  test.each(changes)('changes when %s changes', (_name, change) => {
    expect(detectorFingerprint({ ...BASE, ...change })).not.toBe(
      detectorFingerprint(BASE),
    );
  });

  test('a value moved between fields still changes it', () => {
    expect(
      detectorFingerprint({ ...BASE, systemPrompt: 'a', adrSystemPrompt: 'b' }),
    ).not.toBe(
      detectorFingerprint({ ...BASE, systemPrompt: 'b', adrSystemPrompt: 'a' }),
    );
  });
});

describe('currentFingerprintInputs', () => {
  test('covers every heuristic category and no timing setting', () => {
    const inputs = currentFingerprintInputs();
    expect(inputs.heuristicPrompts.map(([category]) => category)).toEqual([
      ...HEURISTIC_CATEGORIES,
    ]);
    expect(inputs.heuristicPrompts).toHaveLength(8);
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'adrSystemPrompt',
        'adrUserPromptSample',
        'heuristicPrompts',
        'logicRevision',
        'maxTokens',
        'model',
        'primingTurns',
        'systemPrompt',
        'userPromptSample',
      ].sort(),
    );
  });

  test('renders the class source and an ADR into the samples', () => {
    const inputs = currentFingerprintInputs();
    expect(inputs.userPromptSample).toContain('class Sample');
    expect(inputs.adrUserPromptSample).toContain('ADR-001');
  });

  /**
   * A reviewer alarm, not a value to keep: when a prompt, the model or the logic revision
   * changes, this snapshot fails. Updating it acknowledges that every cached real result is
   * invalidated.
   */
  test('the current fingerprint is acknowledged', () => {
    expect(detectorFingerprint(currentFingerprintInputs())).toMatchSnapshot();
  });
});

describe('fingerprint module', () => {
  test('never loads the Claude client', () => {
    jest.isolateModules(() => {
      jest.doMock('@/utils/claude', () => {
        throw new Error('@/utils/claude must not be loaded');
      });
      expect(() =>
        jest.requireActual<typeof import('@/background/detector/fingerprint')>(
          '@/background/detector/fingerprint',
        ),
      ).not.toThrow();
      // Control: the guard does fire for a module that loads the client.
      expect(() => jest.requireMock('@/utils/claude')).toThrow(
        'must not be loaded',
      );
    });
  });
});
