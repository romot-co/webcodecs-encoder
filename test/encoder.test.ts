import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Mp4Encoder } from '../src/index'; // Assuming index.ts exports Mp4Encoder
import { EncoderErrorType, Mp4EncoderError } from '../src/types'; // Import EncoderErrorType and Mp4EncoderError for error checking

// Mock the Worker class
vi.mock('../src/worker', () => {
  // This is a basic mock. It might need to be more sophisticated for comprehensive tests.
  // For now, we assume worker.js path resolution works via new URL.
  // If tsup bundles worker.js correctly, this mock might not even be hit for `new URL` calls.
  // However, if `new Worker(string)` is used, this mock would be more relevant.
  const WorkerMock = vi.fn(() => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  }));
  return { Worker: WorkerMock }; // This might not be how Worker is typically mocked with `new URL`
});

// Mock global URL constructor for worker path
// This is tricky because import.meta.url is hard to mock directly in Vitest/Node environment.
// A common strategy is to mock the entire Worker constructor or specific URL resolutions.
// For now, we'll assume `new URL('./worker.js', import.meta.url)` works or is handled by the test environment.
// If direct mocking of `new URL` is needed, `vi.stubGlobal` could be used for `URL` if careful.

describe('Mp4Encoder', () => {
  let mockWorkerInstance: any;

  beforeEach(() => {
    // Reset mocks and global state before each test
    vi.clearAllMocks();
    // Re-mock global.Worker for each test to get a fresh instance if needed
    mockWorkerInstance = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    };
    global.Worker = vi.fn(() => mockWorkerInstance) as any;
    global.URL = vi.fn((path, base) => ({ href: base + path })) as any; // Basic mock for URL

    // Ensure WebCodecs APIs are mocked for tests that don't focus on isSupported
    global.VideoEncoder = vi.fn(() => ({ configure: vi.fn(), encode: vi.fn(), flush: vi.fn(), close: vi.fn() })) as any;
    global.AudioEncoder = vi.fn(() => ({ configure: vi.fn(), encode: vi.fn(), flush: vi.fn(), close: vi.fn() })) as any;
  });

  afterEach(() => {
    // @ts-ignore
    delete global.VideoEncoder;
    // @ts-ignore
    delete global.AudioEncoder;
    // @ts-ignore
    delete global.Worker;
    // @ts-ignore
    delete global.URL;
  });

  describe('isSupported', () => {
    it('should return true if VideoEncoder, AudioEncoder, and Worker are defined', () => {
      global.VideoEncoder = vi.fn() as any;
      global.AudioEncoder = vi.fn() as any;
      global.Worker = vi.fn() as any;
      expect(Mp4Encoder.isSupported()).toBe(true);
    });

    it('should return false if VideoEncoder is not defined', () => {
      // @ts-ignore
      delete global.VideoEncoder;
      global.AudioEncoder = vi.fn() as any;
      global.Worker = vi.fn() as any;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });

    it('should return false if AudioEncoder is not defined', () => {
      global.VideoEncoder = vi.fn() as any;
      // @ts-ignore
      delete global.AudioEncoder;
      global.Worker = vi.fn() as any;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });

    it('should return false if Worker is not defined', () => {
      global.VideoEncoder = vi.fn() as any;
      global.AudioEncoder = vi.fn() as any;
      // @ts-ignore
      delete global.Worker;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });
  });

  describe('constructor', () => {
    it('should create an instance with the given config', () => {
      const config = { width: 100, height: 100, frameRate: 30, videoBitrate: 1000, audioBitrate: 128, sampleRate: 44100, channels: 2 };
      const encoder = new Mp4Encoder(config);
      expect(encoder).toBeInstanceOf(Mp4Encoder);
      // @ts-ignore access private member for test
      expect(encoder.config).toEqual(config);
    });
  });

  describe('initialize', () => {
    const config = {
      width: 640, height: 480, frameRate: 30, 
      videoBitrate: 1000000, audioBitrate: 128000, 
      sampleRate: 48000, channels: 2
    };

    it('should resolve when worker sends initialized message', async () => {
      const encoder = new Mp4Encoder(config);
      const initPromise = encoder.initialize();

      // Simulate worker sending initialized message
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({
        type: 'initialize',
        config: config,
        totalFrames: undefined, 
      });
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });

      await expect(initPromise).resolves.toBeUndefined();
    });

    it('should reject if worker posts an error during initialization', async () => {
      const encoder = new Mp4Encoder(config);
      const onErrorCallback = vi.fn();
      const initPromise = encoder.initialize(undefined, undefined, onErrorCallback);

      const workerError = { message: 'Init failed', type: EncoderErrorType.WorkerError, stack: 'worker stack' };
      mockWorkerInstance.onmessage({ data: { type: 'error', errorDetail: workerError } });

      await expect(initPromise).rejects.toThrow(workerError.message);
      expect(onErrorCallback).toHaveBeenCalledWith(expect.objectContaining({ type: EncoderErrorType.WorkerError, message: workerError.message }));
    });

    it('should reject if worker script itself throws an error (onerror)', async () => {
      const encoder = new Mp4Encoder(config);
      const onErrorCallback = vi.fn();
      const initPromise = encoder.initialize(undefined, undefined, onErrorCallback);
      
      const errorMessage = 'Worker script broke';
      // ErrorEvent の代わりにプレーンオブジェクトを使用
      const mockErrorEvent = { message: errorMessage, type: 'error' }; // type を追加して ErrorEvent に近づける
      mockWorkerInstance.onerror(mockErrorEvent as ErrorEvent); // 型キャストで合わせる

      // Expect the promise to reject with an error message containing the original worker error message
      await expect(initPromise).rejects.toThrow(new RegExp(`Worker error: ${errorMessage}`));
      
      // Ensure the onErrorCallback was called with an error of the correct type
      expect(onErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({ 
          message: `Worker error: ${errorMessage}`, // Check the exact message
          type: EncoderErrorType.WorkerError 
        })
      );
      expect(onErrorCallback).toHaveBeenCalledTimes(1); // Ensure it's called exactly once
    });

    it('should reject if WebCodecs or Worker are not supported', async () => {
      // @ts-ignore
      delete global.Worker; // Make it unsupported
      const encoder = new Mp4Encoder(config);
      const onErrorCallback = vi.fn();
      
      try {
        await encoder.initialize(undefined, undefined, onErrorCallback);
        // Should not reach here, force failure if it does
        expect(true, 'Promise should have rejected').toBe(false); 
      } catch (e: any) {
        expect(e.message).toContain('WebCodecs API or Web Workers are not supported');
        // Assuming Mp4EncoderError has a type property as defined
        const customError = e as Mp4EncoderError;
        expect(customError.type).toBe(EncoderErrorType.NotSupported);
      }
      
      // Check onErrorCallback after the try-catch block
      expect(onErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({ 
          type: EncoderErrorType.NotSupported,
          message: 'WebCodecs API or Web Workers are not supported in this browser.'
        })
      );
      expect(onErrorCallback).toHaveBeenCalledTimes(1);
    });

    it('should pass totalFrames to worker if provided', async () => {
      const encoder = new Mp4Encoder(config);
      const totalFrames = 150;
      const initPromise = encoder.initialize(undefined, totalFrames);
      
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({
        type: 'initialize',
        config: config,
        totalFrames: totalFrames, 
      });
      // Simulate worker init to resolve promise
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } }); 
      await initPromise;
    });

    it('should set onProgress callback if provided', async () => {
      const encoder = new Mp4Encoder(config);
      const onProgress = vi.fn();
      const initPromise = encoder.initialize(onProgress);
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await initPromise;

      // Simulate progress message from worker
      mockWorkerInstance.onmessage({ data: { type: 'progress', processedFrames: 10, totalFrames: 100 } });
      expect(onProgress).toHaveBeenCalledWith(10, 100);
       // @ts-ignore access private member for test
      expect(encoder.onProgressCallback).toBe(onProgress);
    });

  });

  // More tests for initialize, addVideoFrame, addAudioBuffer, finalize, cancel will go here
}); 