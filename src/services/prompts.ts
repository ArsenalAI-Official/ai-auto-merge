import { ConflictedFile } from '../types';

/** All Claude prompts for the resolution pipeline live here. */

export const RESOLVER_SYSTEM = `You are an expert software engineer specializing in resolving git merge conflicts. Produce clean, correct merged code.

Rules:
1. Understand the intent of BOTH sides (HEAD = PR branch, MERGE_HEAD = base branch)
2. Preserve ALL meaningful changes from both sides when possible
3. Never silently drop code — if changes are incompatible, keep both with a brief comment
4. Match existing code style, formatting, and conventions
5. For delete/modify conflicts: decide whether to keep or delete based on context

Conflict markers:
<<<<<<< HEAD (PR branch)
...
=======
...
>>>>>>> MERGE_HEAD (base branch)

Return JSON only:
{
  "resolved_content": "complete file with conflicts resolved",
  "is_delete": false,
  "confidence": "high" | "medium" | "low",
  "explanation": "one sentence",
  "needs_review": boolean
}`;

export const JUDGE_SYSTEM = `You are a senior engineer reviewing two proposed resolutions to a merge conflict. Pick the better one or flag for human review.

Evaluate on:
1. Correctness — does it preserve the intent of both branches?
2. Completeness — does it lose any code from either side?
3. Code quality — is it clean and consistent with the surrounding style?

Return JSON only:
{
  "winner": "A" | "B" | "neither",
  "reason": "one sentence",
  "confidence": "high" | "medium" | "low"
}

Use "neither" only if both proposals are clearly wrong. In that case set confidence to "low".`;

export const REPAIR_SYSTEM = `You are an expert software engineer. You previously resolved a git merge conflict, but the resolved file fails a syntax check. Fix the syntax error while preserving the semantics of the resolution. Do not re-resolve the conflict — only repair the syntax.

Return JSON only:
{
  "resolved_content": "complete corrected file"
}`;

export const STRATEGIES = [
  {
    id: 'A' as const,
    label: 'conservative',
    instruction:
      'Strategy: CONSERVATIVE. Preserve ALL code from both sides. When in doubt, keep both implementations rather than merging them. Do not remove any functionality from either branch.',
  },
  {
    id: 'B' as const,
    label: 'synthesis',
    instruction:
      'Strategy: SYNTHESIS. Find the cleanest unified implementation. Merge the intent of both changes into the most elegant result, even if it means rewriting the conflicted section cleanly.',
  },
];

export interface ResolutionContext {
  prTitle: string;
  prBody: string | null;
  prBranch: string;
  baseBranch: string;
  prDiff?: string;
}

/**
 * Context shared by both strategy calls for one file. Kept byte-identical
 * across the two calls so a single cache breakpoint on this block lets the
 * second call read the first call's prompt cache.
 */
export function buildSharedContext(file: ConflictedFile, context: ResolutionContext): string {
  const lines: string[] = [
    `PR Title: ${context.prTitle}`,
    context.prBody ? `PR Description: ${context.prBody}` : null,
    `PR Branch: ${context.prBranch} → ${context.baseBranch}`,
  ].filter(Boolean) as string[];

  if (context.prDiff) {
    lines.push('', '## PR diff (full scope of changes for context)', '```diff',
      context.prDiff.slice(0, 12_000), '```');
  }

  if (file.isDeleteConflict) {
    lines.push('', '**Note:** Delete/modify conflict — one branch deleted this file, the other modified it.');
  }

  lines.push('', `## File with conflicts: \`${file.path}\``, '```', file.content, '```');

  return lines.join('\n');
}

export function buildJudgePrompt(
  file: ConflictedFile,
  prTitle: string,
  proposalAContent: string,
  proposalBContent: string
): string {
  return [
    `File: ${file.path}`,
    `PR: ${prTitle}`,
    ``,
    `## Original conflicted file`,
    '```',
    file.content,
    '```',
    ``,
    `## Proposal A (conservative — preserves both sides)`,
    '```',
    proposalAContent,
    '```',
    ``,
    `## Proposal B (synthesis — clean unified implementation)`,
    '```',
    proposalBContent,
    '```',
    ``,
    `Which proposal is better? Return JSON only.`,
  ].join('\n');
}

export function buildRepairPrompt(filePath: string, brokenContent: string, syntaxError: string): string {
  return [
    `File: \`${filePath}\``,
    ``,
    `## Syntax check error`,
    '```',
    syntaxError.slice(0, 1_000),
    '```',
    ``,
    `## File content (fails the check)`,
    '```',
    brokenContent,
    '```',
    ``,
    'Return JSON only.',
  ].join('\n');
}
