import { ConflictedFile } from '../types';

export type ConflictType = 'additive' | 'import_only' | 'delete_modify' | 'complex_modify' | 'lockfile';

// ─── Lockfile detection ────────────────────────────────────────────────────────
// Generated lockfiles should never be AI-merged: they have internal integrity
// hashes, and the correct resolution is always to regenerate from the merged
// manifest. Detecting them here skips the API call entirely.

const LOCKFILE_HINTS: Record<string, string> = {
  'package-lock.json': 'npm install --package-lock-only',
  'npm-shrinkwrap.json': 'npm install --package-lock-only',
  'yarn.lock': 'yarn install --mode update-lockfile',
  'pnpm-lock.yaml': 'pnpm install --lockfile-only',
  'bun.lockb': 'bun install',
  'bun.lock': 'bun install',
  'cargo.lock': 'cargo update --workspace',
  'poetry.lock': 'poetry lock --no-update',
  'uv.lock': 'uv lock',
  'pipfile.lock': 'pipenv lock',
  'composer.lock': 'composer update --lock',
  'gemfile.lock': 'bundle install',
  'go.sum': 'go mod tidy',
  'gradle.lockfile': 'gradle dependencies --write-locks',
  'packages.lock.json': 'dotnet restore --force-evaluate',
  'mix.lock': 'mix deps.get',
  'flake.lock': 'nix flake update',
};

export function isLockfile(filePath: string): boolean {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  return base in LOCKFILE_HINTS;
}

export function lockfileHint(filePath: string): string {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  const cmd = LOCKFILE_HINTS[base];
  return cmd
    ? `Checkout this branch, merge the base branch, then regenerate it with \`${cmd}\` and commit.`
    : 'Regenerate it from the merged manifest with your package manager instead of merging by hand.';
}

export interface ClassifiedConflict {
  file: ConflictedFile;
  type: ConflictType;
  blocks: ConflictBlock[];
}

export interface ConflictBlock {
  head: string[];
  base: string[];
}

// ─── Import line detection ─────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  /^import\s/,
  /^from\s+\S+\s+import/,
  /^const\s+\S+\s*=\s*require\s*\(/,
  /^use\s+[\w:]+/,
  /^#include\s/,
  /^using\s+\w+/,
  /^import\s+"[^"]+"/,
];

function isImportLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && IMPORT_PATTERNS.some((p) => p.test(t));
}

// ─── Named-entity extraction ───────────────────────────────────────────────────
// Returns the declared name if the line is a new top-level entity declaration,
// null otherwise.

const DECLARATION_PATTERNS: Array<RegExp> = [
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|abstract\s+class)\s+(\w+)/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:[:,=<(])/,
  /^def\s+(\w+)/,        // Python
  /^func\s+(\w+)/,       // Go
  /^fn\s+(\w+)/,         // Rust
  /^pub\s+fn\s+(\w+)/,   // Rust pub fn
  /^fun\s+(\w+)/,        // Kotlin
  /^sub\s+(\w+)/,        // Perl/VB
];

function extractDeclaredName(line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of DECLARATION_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) return m[1];
  }
  return null;
}

// ─── Conflict block parser ─────────────────────────────────────────────────────

function parseConflictBlocks(content: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  const lines = content.split('\n');

  let inHead = false;
  let inBase = false;
  let headLines: string[] = [];
  let baseLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('<<<<<<< ')) {
      inHead = true;
      headLines = [];
    } else if (line.startsWith('=======') && inHead) {
      inHead = false;
      inBase = true;
      baseLines = [];
    } else if (line.startsWith('>>>>>>> ') && inBase) {
      inBase = false;
      blocks.push({ head: headLines, base: baseLines });
    } else if (inHead) {
      headLines.push(line);
    } else if (inBase) {
      baseLines.push(line);
    }
  }

  return blocks;
}

// ─── Conflict type classification ──────────────────────────────────────────────

function classifyBlocks(blocks: ConflictBlock[], isDeleteConflict: boolean): ConflictType {
  if (isDeleteConflict) return 'delete_modify';
  if (blocks.length === 0) return 'complex_modify';

  // Check: all conflict lines are import statements
  const allLines = blocks.flatMap((b) => [...b.head, ...b.base]).filter((l) => l.trim());
  if (allLines.length > 0 && allLines.every(isImportLine)) {
    return 'import_only';
  }

  // Check: every block looks like two different named entity declarations
  // (both sides adding new named things to the same spot → additive)
  const allAdditive = blocks.every((b) => {
    const headFirstLine = b.head.find((l) => l.trim());
    const baseFirstLine = b.base.find((l) => l.trim());
    if (!headFirstLine || !baseFirstLine) return false;

    const headName = extractDeclaredName(headFirstLine);
    const baseName = extractDeclaredName(baseFirstLine);

    // Both sides declare a new named entity, and the names are different
    return headName !== null && baseName !== null && headName !== baseName;
  });

  if (allAdditive) return 'additive';

  return 'complex_modify';
}

export function classify(file: ConflictedFile): ClassifiedConflict {
  const blocks = parseConflictBlocks(file.content);
  // Lockfiles take precedence over everything — even delete/modify conflicts
  // on a lockfile should be regenerated, not merged.
  const type = isLockfile(file.path) ? 'lockfile' : classifyBlocks(blocks, file.isDeleteConflict ?? false);
  return { file, type, blocks };
}

// ─── Deterministic resolvers ───────────────────────────────────────────────────

export function resolveAdditive(classified: ClassifiedConflict): string {
  return classified.file.content.replace(
    /<<<<<<< [^\n]+\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]+\n?/g,
    (_match, head, base) => head + base
  );
}

export function resolveImports(classified: ClassifiedConflict): string {
  return classified.file.content.replace(
    /<<<<<<< [^\n]+\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]+\n?/g,
    (_match, head, base) => {
      const headLines = head.split('\n').filter((l: string) => l.trim());
      const baseLines = base.split('\n').filter((l: string) => l.trim());
      const merged = mergeImportLines([...headLines, ...baseLines]);
      return merged.join('\n') + '\n';
    }
  );
}

// Merge JS/TS named imports from the same module; fall back to line-level dedup
// for other languages or import styles.
function mergeImportLines(lines: string[]): string[] {
  const namedByPath = new Map<string, Set<string>>();
  const others: string[] = [];

  for (const line of lines) {
    const m = line.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/);
    if (m) {
      const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const modulePath = m[2];
      const existing = namedByPath.get(modulePath) ?? new Set();
      specifiers.forEach((s) => existing.add(s));
      namedByPath.set(modulePath, existing);
    } else {
      // Non-named import (default, namespace, non-JS) — deduplicate by exact line
      if (!others.includes(line)) others.push(line);
    }
  }

  const mergedNamed = [...namedByPath.entries()].map(
    ([modulePath, specifiers]) =>
      `import { ${[...specifiers].sort().join(', ')} } from '${modulePath}';`
  );

  return [...mergedNamed, ...others];
}
