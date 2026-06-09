import { logger } from '../src/utils/logger';

describe('logger', () => {
  it('exports a winston logger with the standard log methods', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('logs without throwing at every level', () => {
    expect(() => {
      logger.info('info-message');
      logger.warn('warn-message');
      logger.error('error-message');
      logger.debug('debug-message');
    }).not.toThrow();
  });

  it('serializes Error objects with stack', () => {
    const err = new Error('boom');
    expect(() => logger.error('caught', err)).not.toThrow();
  });
});
