// Mock the upstream modules pulled in by `queue.ts` so this test does not need
// to resolve @octokit/app / bullmq / ioredis transitively.
jest.mock('../src/services/github', () => ({}));
jest.mock('../src/services/prProcessor', () => ({ processMergedPR: jest.fn() }));
jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(),
  Job: jest.fn(),
}));
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn(),
  }));
});

describe('isQueueEnabled', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('returns false when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    jest.isolateModules(() => {
      const { isQueueEnabled } = require('../src/services/queue');
      expect(isQueueEnabled()).toBe(false);
    });
  });

  it('returns true when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    jest.isolateModules(() => {
      const { isQueueEnabled } = require('../src/services/queue');
      expect(isQueueEnabled()).toBe(true);
    });
  });

  it('returns false when REDIS_URL is an empty string', () => {
    process.env.REDIS_URL = '';
    jest.isolateModules(() => {
      const { isQueueEnabled } = require('../src/services/queue');
      expect(isQueueEnabled()).toBe(false);
    });
  });
});
