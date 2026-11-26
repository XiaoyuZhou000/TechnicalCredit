import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TCResult } from '@/comment/tcResult';
import { findAdrs } from '@/context/findAdrs';
import { resolveAdrId } from '@/context/resolveAdrId';
import { ADR_SYSTEM_PROMPT, createAdrUserPrompt } from '@/prompts/adrPrompt';

const finding: TCResult = {
  is_tc_candidate: true,
  category: 'modularity',
  benefit: 'modularity benefit',
  conditions: 'modularity conditions',
  signals: ['modularity-signal'],
  not_tc_reason: null,
};

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-adr-prompt-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(
    path.join(docs, '0007-plugin-registry.md'),
    '# Plugin registry\n',
  );
  fs.writeFileSync(
    path.join(docs, 'architecture-record.md'),
    '# Architecture record\n',
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ADR prompt', () => {
  it('asks for an id exactly as listed, not a fixed ADR-nnnn format', () => {
    expect(ADR_SYSTEM_PROMPT).not.toContain('ADR-nnnn');
    expect(ADR_SYSTEM_PROMPT).toContain('exactly as listed');
  });

  it('lists an ADR with a nonnumeric filename by an id that resolveAdrId accepts', () => {
    const adrs = findAdrs(root);
    expect(adrs.map((a) => a.id)).toEqual(['ADR-0007', 'architecture-record']);

    const lines = createAdrUserPrompt(finding, adrs).split('\n');
    expect(lines).toContain('architecture-record — Architecture record');
    expect(lines).toContain('ADR-0007 — Plugin registry');

    expect(resolveAdrId('architecture-record', adrs)).toBe(
      'architecture-record',
    );
    // The answer the old ADR-nnnn format invited for this ADR never matches.
    expect(resolveAdrId('ADR-architecture-record', adrs)).toBeNull();
  });
});
