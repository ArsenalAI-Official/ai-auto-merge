// Shared mock state. `finalMessage` backs the Opus stream (proposals/repair);
// `create` backs the Haiku verifier and judge; `stream` is shared so tests can
// inspect the request args (e.g. max_tokens). Tests set responses per-case.
const mockFinalMessage = jest.fn();
const mockCreate = jest.fn();
const mockStream = jest.fn((_args?: { max_tokens?: number }) => ({ finalMessage: mockFinalMessage }));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: mockStream,
      create: mockCreate,
    },
  })),
}));

// Verifier approval / rejection and judge verdict helpers.
function verifyOk() {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, confidence: 'high', reason: 'looks correct' }) }] };
}
function verifyDoubt() {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, confidence: 'low', reason: 'unsure' }) }] };
}
function judgeWinnerA() {
  return { content: [{ type: 'text', text: JSON.stringify({ winner: 'A', reason: 'A is better', confidence: 'high' }) }] };
}

import { resolveConflicts, repairResolution } from '../src/services/conflictResolver';
import { ConflictedFile } from '../src/types';
import { config } from '../src/utils/config';

// Hunk-level is the default. The whole-file pipeline tests below force 'file'
// granularity in their beforeEach; this resets to the default after each test so
// forcing never leaks between describes.
afterEach(() => {
  config.llm.granularity = 'auto';
});

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

// ─── Complex conflicts: adaptive pipeline (default mode) ──────────────────────

describe('complex modify-modify conflict (adaptive, whole-file mode)', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
    config.llm.granularity = 'file'; // exercise the whole-file pipeline explicitly
  });

  it('ships a single verified proposal with ONE Opus call (the efficiency win)', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'clean merge' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(1); // one proposal, not two
    expect(mockCreate).toHaveBeenCalledTimes(1); // one cheap verify
    expect(results[0].method).toBe('ai_verified');
    expect(results[0].needsReview).toBe(false);
    expect(results[0].content).toBe('clean merge');
  });

  it('escalates to the second strategy when the verifier has doubts', async () => {
    mockFinalMessage
      .mockResolvedValueOnce(makeClaudeResponse({ resolved_content: 'A result' }))
      .mockResolvedValueOnce(makeClaudeResponse({ resolved_content: 'B result' }));
    mockCreate
      .mockResolvedValueOnce(verifyDoubt()) // verify A → escalate
      .mockResolvedValueOnce(judgeWinnerA()); // judge picks A

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(2); // escalated to dual-strategy
    expect(results[0].method).toBe('ai_judged');
    expect(results[0].content).toBe('A result');
  });

  it('skips the judge when escalated proposals converge', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'identical result' }));
    mockCreate.mockResolvedValue(verifyDoubt()); // force escalation; A and B then converge

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(results[0].confidence).toBe('high');
    expect(results[0].method).toBe('ai_converged');
    expect(results[0].content).toBe('identical result');
  });

  it('caps output tokens to the file size rather than the 64k ceiling', async () => {
    mockStream.mockClear();
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    mockCreate.mockResolvedValue(verifyOk());

    await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    const maxTokens = mockStream.mock.calls[0][0]?.max_tokens ?? 0;
    expect(maxTokens).toBeLessThan(64_000);
    expect(maxTokens).toBeGreaterThanOrEqual(4_096);
  });

  it('falls back to needs_review on SDK error', async () => {
    mockFinalMessage.mockRejectedValue(new Error('API timeout'));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].confidence).toBe('low');
    expect(results[0].method).toBe('ai_failed');
  });
});

describe('edge-case guards (whole-file mode)', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
    config.llm.granularity = 'file'; // delete/truncation/empty are whole-file concerns
  });

  it('flags binary/non-text files and never calls the model', async () => {
    const binary: ConflictedFile = { path: 'logo.png', content: 'PNG\u0000\u0000binary\u0000data here' };
    const results = await resolveConflicts([binary], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].method).toBe('binary');
    expect(results[0].needsReview).toBe(true);
  });

  it('flags GitHub Actions workflow files for review and never calls the model', async () => {
    const wf: ConflictedFile = {
      path: '.github/workflows/lint.yml',
      content: ['jobs:', '<<<<<<< HEAD', '  a: 1', '=======', '  a: 2', '>>>>>>> MERGE_HEAD'].join('\n'),
    };
    const results = await resolveConflicts([wf], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].method).toBe('workflow');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].explanation).toMatch(/workflows.*permission/i);
  });

  it('rejects a truncated resolution rather than applying a partial file', async () => {
    // Proposal A truncated, then escalates; B also truncated → ai_failed.
    mockFinalMessage.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: JSON.stringify({ resolved_content: 'half a fi', confidence: 'high', explanation: 'x', needs_review: false }) }],
    });
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('ai_failed');
    expect(results[0].content).not.toBe('half a fi'); // truncated content never applied
  });

  it('rejects an empty resolved_content for a non-delete', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: '   ', is_delete: false }));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('ai_failed');
  });

  it('never auto-applies a deletion from a single verified proposal (escalates instead)', async () => {
    // A says delete; even with a passing verifier it must escalate to dual-strategy.
    mockFinalMessage
      .mockResolvedValueOnce(makeClaudeResponse({ is_delete: true, resolved_content: '' }))
      .mockResolvedValueOnce(makeClaudeResponse({ is_delete: false, resolved_content: 'kept code' }));
    mockCreate.mockResolvedValue(verifyOk());
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).toHaveBeenCalledTimes(2); // escalated, did not ship the delete
    // A wants delete, B wants keep → disagreement → needs review, NOT deleted
    expect(results[0].needsReview).toBe(true);
    expect(results[0].isDelete).not.toBe(true);
  });

  it('only deletes when BOTH strategies independently agree to delete', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ is_delete: true, resolved_content: '' }));
    mockCreate.mockResolvedValue(verifyOk());
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].isDelete).toBe(true);
    expect(results[0].needsReview).toBe(false);
    expect(results[0].method).toBe('ai_converged');
  });

  it('keep-both guard: flags a resolution that drops the PR side instead of pushing it', async () => {
    const MULTILINE: ConflictedFile = {
      path: 'src/feature.ts',
      content: [
        'function feature() {',
        '<<<<<<< HEAD',
        '  const a = computeA();',
        '  const b = computeB();',
        '  return a + b;',
        '=======',
        '  return legacy();',
        '>>>>>>> MERGE_HEAD',
        '}',
      ].join('\n'),
    };
    // Model (wrongly) returns the base-only version, dropping the PR's lines.
    mockFinalMessage.mockResolvedValue(
      makeClaudeResponse({ resolved_content: 'function feature() {\n  return legacy();\n}\n' })
    );
    mockCreate.mockResolvedValue(verifyOk()); // even if the verifier is fooled, the deterministic guard catches it
    const results = await resolveConflicts([MULTILINE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].explanation).toMatch(/keep-both guard/);
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

describe('oversized files (whole-file mode)', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    config.llm.granularity = 'file'; // the output-ceiling gate only applies to whole-file
  });

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

  it('flags a file too large to regenerate within the model output ceiling (under the byte cap)', async () => {
    // ~210 KB: under MAX_FILE_BYTES (256 KB) but needs > 64k output tokens to
    // regenerate, so no model can emit it whole → flagged up front, no AI call.
    const body = 'const x = 1;\n'.repeat(16_500); // ~210 KB
    const big: ConflictedFile = { path: 'src/huge2.ts', content: body + COMPLEX_FILE.content };
    const results = await resolveConflicts([big], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].method).toBe('oversize');
    expect(results[0].explanation).toMatch(/regenerate|output tokens/i);
  });
});

// ─── Hunk-level resolution (default granularity = 'auto') ─────────────────────
// Resolve only the conflict region(s) and splice into the verbatim rest of the
// file — the edit-not-rewrite approach. No whole-file output ceiling, far fewer
// output tokens, and large files with small conflicts now resolve.

const TWO_HUNK_FILE: ConflictedFile = {
  path: 'src/two.ts',
  content: [
    'const top = 1;',
    '<<<<<<< HEAD',
    'const a = "pr";',
    '=======',
    'const a = "base";',
    '>>>>>>> MERGE_HEAD',
    'const middle = 2;',
    '<<<<<<< HEAD',
    'const b = "pr2";',
    '=======',
    'const b = "base2";',
    '>>>>>>> MERGE_HEAD',
    'const bottom = 3;',
  ].join('\n'),
};

describe('hunk-level resolution (default mode)', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
    mockStream.mockClear();
    config.llm.granularity = 'auto';
  });

  it('splices a single resolved hunk into the verbatim surrounding code', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'X' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(1); // one tiny proposal for the one hunk
    expect(mockCreate).toHaveBeenCalledTimes(1); // one cheap verify
    expect(results[0].method).toBe('ai_hunk');
    expect(results[0].needsReview).toBe(false);
    // surrounding lines verbatim, conflict region replaced by the resolved hunk
    expect(results[0].content).toBe('function process(x: string) {\nX\n}');
    expect(results[0].content).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
  });

  it('resolves every hunk in a multi-conflict file and splices them all', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'const merged = "ok";' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([TWO_HUNK_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(2); // one proposal per hunk
    expect(results[0].method).toBe('ai_hunk');
    expect(results[0].needsReview).toBe(false);
    expect(results[0].content).toBe(
      'const top = 1;\nconst merged = "ok";\nconst middle = 2;\nconst merged = "ok";\nconst bottom = 3;'
    );
    expect(results[0].content).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
  });

  it('resolves a large file that whole-file mode would reject as oversize (the big-file fix)', async () => {
    // ~210 KB: under MAX_FILE_BYTES but FAR over any whole-file output ceiling.
    // Whole-file mode flags it 'oversize'; hunk mode resolves the small conflict.
    const body = 'const x = 1;\n'.repeat(16_500);
    const big: ConflictedFile = { path: 'src/huge2.ts', content: body + COMPLEX_FILE.content };
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'RESOLVED_HUNK' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([big], 'feat', null, 'feat', 'main');

    expect(results[0].method).toBe('ai_hunk'); // resolved, NOT 'oversize'
    expect(results[0].needsReview).toBe(false);
    expect(results[0].content).toContain('RESOLVED_HUNK');
    expect(results[0].content).not.toMatch(/<<<<<<<|>>>>>>>/);
    // the token win: a tiny request despite a 210 KB file
    const maxTokens = mockStream.mock.calls[0][0]?.max_tokens ?? Infinity;
    expect(maxTokens).toBeLessThanOrEqual(8_192);
  });

  it('keep-both guard still catches a hunk that drops the PR side', async () => {
    const MULTILINE: ConflictedFile = {
      path: 'src/feature.ts',
      content: [
        'function feature() {',
        '<<<<<<< HEAD',
        '  const a = computeA();',
        '  const b = computeB();',
        '  return a + b;',
        '=======',
        '  return legacy();',
        '>>>>>>> MERGE_HEAD',
        '}',
      ].join('\n'),
    };
    // Model returns the base-only hunk, dropping the PR's distinctive lines.
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: '  return legacy();' }));
    mockCreate.mockResolvedValue(verifyOk()); // even a fooled verifier can't get past the deterministic guard

    const results = await resolveConflicts([MULTILINE], 'feat', null, 'feat', 'main');

    expect(results[0].needsReview).toBe(true);
    expect(results[0].explanation).toMatch(/keep-both guard/);
  });

  it('flags the file for review when a hunk itself needs review', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'partial', needs_review: true }));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].method).toBe('ai_hunk_review');
    expect(results[0].needsReview).toBe(true);
  });

  it('rejects a hunk whose replacement still contains a conflict marker', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'foo\n<<<<<<< HEAD\nbar' }));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('ai_hunk_review');
    expect(results[0].content).not.toContain('foo'); // the bad hunk is never spliced in
  });

  it('falls back to whole-file resolution when markers cannot be cleanly parsed', async () => {
    // Unterminated conflict (no closing >>>>>>>) → unsafe to splice → whole-file.
    const malformed: ConflictedFile = {
      path: 'src/bad.ts',
      content: ['function f() {', '<<<<<<< HEAD', '  return 1;', '=======', '  return 2;'].join('\n'),
    };
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'function f() {\n  return 1 + 2;\n}' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([malformed], 'feat', null, 'feat', 'main');

    expect(results[0].method).toBe('ai_verified'); // whole-file path ran, not hunk
    expect(results[0].content).toBe('function f() {\n  return 1 + 2;\n}');
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
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
  });

  it('resolves all files and returns one result per file', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    mockCreate.mockResolvedValue(verifyOk());
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
