// Shared mock state — tests mutate finalMessage per-case
const mockFinalMessage = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: jest.fn().mockReturnValue({ finalMessage: mockFinalMessage }),
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ winner: 'A', reason: 'A is better', confidence: 'high' }) }],
      }),
    },
  })),
}));

import { resolveConflicts, repairResolution } from '../src/services/conflictResolver';
import { ConflictedFile } from '../src/types';

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const ADDITIVE_FILE: ConflictedFile = {
  path: 'src/utils.ts',
  content: [
    '<<<<<<< HEAD',
    'function featureA() { return 1; }',
    '=======',
    'function featureB() { return 2; }',
    '>>>>>>> MERGE_HEAD',
  ].join('\n') + '\n',
};

const IMPORT_FILE: ConflictedFile = {
  path: 'src/app.ts',
  content: [
    '<<<<<<< HEAD',
    "import { useState } from 'react';",
    '=======',
    "import { useEffect } from 'react';",
    '>>>>>>> MERGE_HEAD',
  ].join('\n') + '\n',
};

const COMPLEX_FILE: ConflictedFile = {
  path: 'src/process.ts',
  content: [
    'function process(x: string) {',
    '<<<<<<< HEAD',
    '  return x.trim().toUpperCase();',
    '=======',
    '  return x.trim().toLowerCase();',
    '>>>>>>> MERGE_HEAD',
    '}',
  ].join('\n'),
};

function makeClaudeResponse(overrides: object) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        resolved_content: 'resolved content',
        is_delete: false,
        confidence: 'high',
        explanation: 'Resolved cleanly.',
        needs_review: false,
        ...overrides,
      }),
    }],
  };
}

// ─── Fast-path: no Claude calls ───────────────────────────────────────────────

describe('additive conflict fast-path', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('resolves without calling Claude', async () => {
    const results = await resolveConflicts([ADDITIVE_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].confidence).toBe('high');
    expect(results[0].content).toContain('featureA');
    expect(results[0].content).toContain('featureB');
  });

  it('result has no conflict markers', async () => {
    const results = await resolveConflicts([ADDITIVE_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });
});

describe('import-only conflict fast-path', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('resolves without calling Claude', async () => {
    const results = await resolveConflicts([IMPORT_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].confidence).toBe('high');
  });

  it('merges imports and deduplicates', async () => {
    const results = await resolveConflicts([IMPORT_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].content).toContain('useState');
    expect(results[0].content).toContain('useEffect');
    expect(results[0].content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });
});

// ─── Complex conflicts: multi-proposal pipeline ───────────────────────────────

describe('complex modify-modify conflict', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('calls Claude for each proposal', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    // Two proposals (conservative + synthesis)
    expect(mockFinalMessage).toHaveBeenCalledTimes(2);
  });

  it('returns high confidence when both proposals converge', async () => {
    // Both proposals return identical content
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'identical result' }));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].confidence).toBe('high');
    expect(results[0].content).toBe('identical result');
  });

  it('falls back to needs_review on SDK error', async () => {
    mockFinalMessage.mockRejectedValue(new Error('API timeout'));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].confidence).toBe('low');
  });
});

describe('lockfile conflicts', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('never sends lockfiles to Claude and flags them for regeneration', async () => {
    const lockfile: ConflictedFile = { path: 'package-lock.json', content: COMPLEX_FILE.content };
    const results = await resolveConflicts([lockfile], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('lockfile');
    expect(results[0].explanation).toContain('npm install');
  });
});

describe('oversized files', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('skips AI resolution above MAX_FILE_BYTES and flags for review', async () => {
    const bigBody = 'const filler = 1;\n'.repeat(20_000); // ~360 KB > 256 KB default cap
    const oversize: ConflictedFile = {
      path: 'src/huge.ts',
      content: bigBody + COMPLEX_FILE.content,
    };
    const results = await resolveConflicts([oversize], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('oversize');
    expect(results[0].explanation).toMatch(/too large/i);
  });
});

describe('repairResolution', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('returns the repaired content when Claude fixes the syntax', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ resolved_content: 'const fixed = true;' }) }],
    });
    const result = await repairResolution('src/x.ts', 'const broken = ;', 'Unexpected token');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('const fixed = true;');
  });

  it('returns ok=false with original content when the repair call fails', async () => {
    mockFinalMessage.mockRejectedValue(new Error('API down'));
    const result = await repairResolution('src/x.ts', 'const broken = ;', 'Unexpected token');
    expect(result.ok).toBe(false);
    expect(result.content).toBe('const broken = ;');
  });
});

describe('multiple files in one call', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('resolves all files and returns one result per file', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    const results = await resolveConflicts(
      [ADDITIVE_FILE, IMPORT_FILE, COMPLEX_FILE],
      'feat', null, 'feat', 'main'
    );
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.path)).toEqual([
      'src/utils.ts',
      'src/app.ts',
      'src/process.ts',
    ]);
  });
});
