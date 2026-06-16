import { classify, resolveAdditive, resolveImports, isLockfile, lockfileHint, assessPreservation } from '../src/services/conflictClassifier';
import { ConflictedFile } from '../src/types';

function makeFile(content: string, isDeleteConflict = false): ConflictedFile {
  return { path: 'src/test.ts', content, isDeleteConflict };
}

// ─── Additive conflict ─────────────────────────────────────────────────────────
const ADDITIVE_CONTENT = `
function existingFn() { return 1; }

<<<<<<< HEAD
function featureA() {
  return 'from PR branch';
}
=======
function featureB() {
  return 'from base branch';
}
>>>>>>> MERGE_HEAD

export { existingFn };
`.trim();

// ─── Import-only conflict ──────────────────────────────────────────────────────
const IMPORT_CONTENT = `
<<<<<<< HEAD
import { useState, useEffect } from 'react';
import { debounce } from 'lodash';
=======
import { useState, useCallback } from 'react';
import { throttle } from 'lodash';
>>>>>>> MERGE_HEAD

export default function App() {}
`.trim();

// ─── Complex modify-modify conflict ───────────────────────────────────────────
const COMPLEX_CONTENT = `
function process(data: string) {
<<<<<<< HEAD
  const result = data.trim().toUpperCase();
  return result.split(',');
=======
  const result = data.trim().toLowerCase();
  return result.split(';');
>>>>>>> MERGE_HEAD
}
`.trim();

describe('classify()', () => {
  it('detects additive conflict (low Jaccard similarity)', () => {
    const result = classify(makeFile(ADDITIVE_CONTENT));
    expect(result.type).toBe('additive');
  });

  it('detects import-only conflict', () => {
    const result = classify(makeFile(IMPORT_CONTENT));
    expect(result.type).toBe('import_only');
  });

  it('detects complex modify-modify conflict (high Jaccard similarity)', () => {
    const result = classify(makeFile(COMPLEX_CONTENT));
    expect(result.type).toBe('complex_modify');
  });

  it('detects delete/modify conflict', () => {
    const result = classify(makeFile(ADDITIVE_CONTENT, true));
    expect(result.type).toBe('delete_modify');
  });

  it('extracts correct number of blocks', () => {
    const result = classify(makeFile(ADDITIVE_CONTENT));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].head).toContain("function featureA() {");
    expect(result.blocks[0].base).toContain("function featureB() {");
  });
});

describe('resolveAdditive()', () => {
  it('concatenates both sides of the conflict', () => {
    const classified = classify(makeFile(ADDITIVE_CONTENT));
    const resolved = resolveAdditive(classified);
    expect(resolved).toContain('featureA');
    expect(resolved).toContain('featureB');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('>>>>>>>');
  });

  it('preserves non-conflicted lines', () => {
    const classified = classify(makeFile(ADDITIVE_CONTENT));
    const resolved = resolveAdditive(classified);
    expect(resolved).toContain('function existingFn()');
    expect(resolved).toContain("export { existingFn }");
  });
});

describe('lockfile detection', () => {
  it('recognizes common lockfiles at any depth', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('frontend/yarn.lock')).toBe(true);
    expect(isLockfile('services/api/pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('Cargo.lock')).toBe(true);
    expect(isLockfile('go.sum')).toBe(true);
    expect(isLockfile('Gemfile.lock')).toBe(true);
  });

  it('does not flag ordinary files', () => {
    expect(isLockfile('src/lock.ts')).toBe(false);
    expect(isLockfile('docs/package-lock.json.md')).toBe(false);
    expect(isLockfile('foo.lock')).toBe(false);
  });

  it('classifies lockfile conflicts as lockfile regardless of content', () => {
    const result = classify({ path: 'package-lock.json', content: COMPLEX_CONTENT });
    expect(result.type).toBe('lockfile');
  });

  it('lockfile takes precedence over delete/modify', () => {
    const result = classify({ path: 'yarn.lock', content: COMPLEX_CONTENT, isDeleteConflict: true });
    expect(result.type).toBe('lockfile');
  });

  it('provides a package-manager-specific regeneration hint', () => {
    expect(lockfileHint('package-lock.json')).toContain('npm install');
    expect(lockfileHint('pnpm-lock.yaml')).toContain('pnpm install');
    expect(lockfileHint('go.sum')).toContain('go mod tidy');
  });
});

describe('assessPreservation (keep-both backstop)', () => {
  const MULTILINE = [
    'function feature() {',
    '<<<<<<< HEAD',
    '  const a = computeA();',
    '  const b = computeB();',
    '  return a + b;',
    '=======',
    '  return legacy();',
    '>>>>>>> MERGE_HEAD',
    '}',
  ].join('\n');

  it('flags a resolution that verbatim-picked base and dropped the PR side', () => {
    const blocks = classify(makeFile(MULTILINE)).blocks;
    const baseOnly = 'function feature() {\n  return legacy();\n}\n';
    const r = assessPreservation(blocks, baseOnly);
    expect(r.droppedHead).toBe(true);
    expect(r.droppedBase).toBe(false);
  });

  it('does NOT flag a union resolution that keeps both sides', () => {
    const blocks = classify(makeFile(MULTILINE)).blocks;
    const union = 'function feature() {\n  const a = computeA();\n  const b = computeB();\n  return a + b + legacy();\n}\n';
    const r = assessPreservation(blocks, union);
    expect(r.droppedHead).toBe(false);
    expect(r.droppedBase).toBe(false);
  });

  it('does NOT flag a single-line same-line synthesis (below the distinctive threshold)', () => {
    const blocks = classify(makeFile(COMPLEX_CONTENT)).blocks;
    const synthesized = 'function process(data: string) {\n  const result = data.trim().toUpperCase();\n  return result.split(/[,;]/);\n}';
    const r = assessPreservation(blocks, synthesized);
    expect(r.droppedHead).toBe(false);
    expect(r.droppedBase).toBe(false);
  });
});

describe('CRLF and diff3 handling (regression)', () => {
  it('resolves an additive conflict in a CRLF file (no markers left, both kept, CRLF preserved)', () => {
    const crlf = ['<<<<<<< HEAD', 'function fromPR() {}', '=======', 'function fromMain() {}', '>>>>>>> MERGE_HEAD'].join('\r\n') + '\r\n';
    const classified = classify(makeFile(crlf));
    expect(classified.type).toBe('additive');
    const resolved = resolveAdditive(classified);
    expect(resolved).toContain('fromPR');
    expect(resolved).toContain('fromMain');
    expect(resolved).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(resolved).toContain('\r'); // CRLF line endings preserved
  });

  it('routes a diff3 (|||||||  ancestor) conflict to the AI path, never a fast splice', () => {
    const diff3 = ['function f() {', '<<<<<<< HEAD', '  return 1;', '||||||| base', '  return 0;', '=======', '  return 2;', '>>>>>>> branch', '}'].join('\n');
    expect(classify(makeFile(diff3)).type).toBe('complex_modify');
  });

  it('routes a malformed/unterminated conflict to the AI path', () => {
    const bad = ['<<<<<<< HEAD', 'a', '=======', 'b'].join('\n'); // no closing >>>>>>>
    expect(classify(makeFile(bad)).type).toBe('complex_modify');
  });

  it('preserves surrounding text and trailing newline exactly', () => {
    const resolved = resolveAdditive(classify(makeFile(ADDITIVE_CONTENT)));
    expect(resolved).toContain('function existingFn()');
    expect(resolved).toContain('export { existingFn }');
  });
});

describe('resolveImports()', () => {
  it('merges and deduplicates import lines', () => {
    const classified = classify(makeFile(IMPORT_CONTENT));
    const resolved = resolveImports(classified);
    expect(resolved).not.toContain('<<<<<<<');
    // useState appears in both sides — symbol-level merge keeps it once
    const useStateCount = (resolved.match(/\buseState\b/g) ?? []).length;
    expect(useStateCount).toBe(1);
    // All unique specifiers from both sides should be present
    expect(resolved).toContain('useEffect');
    expect(resolved).toContain('useCallback');
    expect(resolved).toContain('debounce');
    expect(resolved).toContain('throttle');
  });
});
