/**
 * Tests for the /ai-merge slash-command parser.
 */

// Keep the module graph import-safe without real credentials/network
jest.mock('../src/services/github', () => ({
  getGithubApp: jest.fn(),
  getInstallationOctokit: jest.fn(),
  getPRByNumber: jest.fn(),
  postComment: jest.fn(),
  addCommentReaction: jest.fn(),
  getCollaboratorPermission: jest.fn(),
}));
jest.mock('../src/services/queue', () => ({
  enqueueConflictResolution: jest.fn(),
  enqueueManualResolve: jest.fn(),
  getQueueStats: jest.fn(),
  isQueueEnabled: jest.fn().mockReturnValue(false),
}));

import { parseCommand } from '../src/handlers/webhook';

describe('parseCommand', () => {
  it('returns null for comments that are not commands', () => {
    expect(parseCommand('Looks good to me!')).toBeNull();
    expect(parseCommand('You should run /ai-merge sometime')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('parses a bare /ai-merge as resolve', () => {
    expect(parseCommand('/ai-merge')?.cmd).toBe('resolve');
  });

  it('parses explicit subcommands', () => {
    expect(parseCommand('/ai-merge resolve')?.cmd).toBe('resolve');
    expect(parseCommand('/ai-merge retry')?.cmd).toBe('resolve');
    expect(parseCommand('/ai-merge dry-run')?.cmd).toBe('dry-run');
    expect(parseCommand('/ai-merge preview')?.cmd).toBe('dry-run');
    expect(parseCommand('/ai-merge status')?.cmd).toBe('status');
    expect(parseCommand('/ai-merge help')?.cmd).toBe('help');
  });

  it('accepts the long alias /ai-auto-merge', () => {
    expect(parseCommand('/ai-auto-merge dry-run')?.cmd).toBe('dry-run');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseCommand('  /AI-MERGE Status  ')?.cmd).toBe('status');
  });

  it('matches when the command is on its own line in a longer comment', () => {
    const body = 'Conflicts again after the rebase.\n\n/ai-merge resolve\n';
    expect(parseCommand(body)?.cmd).toBe('resolve');
  });

  it('maps unknown subcommands to help', () => {
    const parsed = parseCommand('/ai-merge frobnicate');
    expect(parsed?.cmd).toBe('help');
    expect(parsed?.raw).toBe('frobnicate');
  });

  it('does not match commands with trailing arguments beyond the subcommand', () => {
    expect(parseCommand('/ai-merge resolve --force now')).toBeNull();
  });
});
