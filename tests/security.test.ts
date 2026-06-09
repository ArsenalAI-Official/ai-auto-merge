/**
 * Security regression tests: git input validation, path containment,
 * and prompt input caps. These encode the threat model in SECURITY.md.
 */

import { isSafeRefName, isSafeOwnerOrRepo, isSafeRepoPath } from '../src/services/gitOps';
import { buildSharedContext } from '../src/services/prompts';

describe('git ref name validation', () => {
  it('accepts ordinary branch names', () => {
    expect(isSafeRefName('main')).toBe(true);
    expect(isSafeRefName('feature/add-widgets')).toBe(true);
    expect(isSafeRefName('release-1.2.3')).toBe(true);
    expect(isSafeRefName('user/JIRA-123_fix')).toBe(true);
  });

  it('rejects names that could become git options or revision syntax', () => {
    expect(isSafeRefName('--upload-pack=/bin/sh')).toBe(false);
    expect(isSafeRefName('-b')).toBe(false);
    expect(isSafeRefName('branch@{upstream}')).toBe(false);
    expect(isSafeRefName('a..b')).toBe(false);
    expect(isSafeRefName('refs/../escape')).toBe(false);
    expect(isSafeRefName('branch.lock')).toBe(false);
    expect(isSafeRefName('/leading-slash')).toBe(false);
    expect(isSafeRefName('trailing/')).toBe(false);
    expect(isSafeRefName('')).toBe(false);
    expect(isSafeRefName('a'.repeat(300))).toBe(false);
    expect(isSafeRefName('has space')).toBe(false);
    expect(isSafeRefName('semi;colon')).toBe(false);
  });
});

describe('owner/repo validation', () => {
  it('accepts GitHub-style names', () => {
    expect(isSafeOwnerOrRepo('manikyashetty-arch')).toBe(true);
    expect(isSafeOwnerOrRepo('ai-auto-merge')).toBe(true);
    expect(isSafeOwnerOrRepo('repo.name_2')).toBe(true);
  });

  it('rejects anything that is not a plain name', () => {
    expect(isSafeOwnerOrRepo('-leading-dash')).toBe(false);
    expect(isSafeOwnerOrRepo('a/b')).toBe(false);
    expect(isSafeOwnerOrRepo('a b')).toBe(false);
    expect(isSafeOwnerOrRepo('')).toBe(false);
    expect(isSafeOwnerOrRepo('x'.repeat(101))).toBe(false);
  });
});

describe('repo path containment', () => {
  it('accepts normal repo-relative paths', () => {
    expect(isSafeRepoPath('src/index.ts')).toBe(true);
    expect(isSafeRepoPath('deep/nested/dir/file.py')).toBe(true);
    expect(isSafeRepoPath('README.md')).toBe(true);
  });

  it('rejects traversal, absolute paths, and .git internals', () => {
    expect(isSafeRepoPath('../outside')).toBe(false);
    expect(isSafeRepoPath('src/../../etc/passwd')).toBe(false);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('.git/hooks/post-checkout')).toBe(false);
    expect(isSafeRepoPath('nested/.git/config')).toBe(false);
    expect(isSafeRepoPath('.GIT/config')).toBe(false);
    expect(isSafeRepoPath('a//b')).toBe(false);
    expect(isSafeRepoPath('')).toBe(false);
    expect(isSafeRepoPath('file\0name')).toBe(false);
  });
});

describe('prompt input caps', () => {
  it('truncates oversized PR titles and bodies before they reach Claude', () => {
    const prompt = buildSharedContext(
      { path: 'a.ts', content: 'x' },
      {
        prTitle: 'T'.repeat(10_000),
        prBody: 'B'.repeat(100_000),
        prBranch: 'feat',
        baseBranch: 'main',
      }
    );
    const titleLine = prompt.split('\n').find((l) => l.startsWith('PR Title:'))!;
    const bodyLine = prompt.split('\n').find((l) => l.startsWith('PR Description:'))!;
    expect(titleLine.length).toBeLessThanOrEqual(320);
    expect(bodyLine.length).toBeLessThanOrEqual(4_050);
  });
});
