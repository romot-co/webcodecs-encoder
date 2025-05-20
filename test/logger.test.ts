import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { logger } from '../src/logger'; // Adjust path as necessary

describe('logger', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    // Clear mocks before each test to ensure a clean state
    consoleLogSpy.mockClear();
    consoleWarnSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    // Restore all mocks created in this file scope after all tests are done
    vi.restoreAllMocks();
  });

  it('logger.log should call console.log with the given arguments', () => {
    const message = 'Test log message';
    const arg1 = 123;
    const arg2 = { data: 'test' };
    logger.log(message, arg1, arg2);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(message, arg1, arg2);
  });

  it('logger.warn should call console.warn with the given arguments', () => {
    const message = 'Test warning message';
    const arg1 = 'warn_arg';
    logger.warn(message, arg1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(message, arg1);
  });

  it('logger.error should call console.error with the given arguments', () => {
    const message = 'Test error message';
    const errorObj = new Error('Something went wrong');
    logger.error(message, errorObj);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(message, errorObj);
  });
}); 