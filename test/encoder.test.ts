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

  describe('addVideoFrame', () => {
    const config = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, audioBitrate: 64000,
      sampleRate: 48000, channels: 2
    };

    it('should resolve when a frame is added successfully', async () => {
      const encoder = new Mp4Encoder(config);
      const init = encoder.initialize();
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const bitmap = { close: vi.fn() } as any;
      global.createImageBitmap = vi.fn(() => Promise.resolve(bitmap));

      const frame = {} as CanvasImageSource;
      const p = encoder.addVideoFrame(frame);

      await expect(p).resolves.toBeUndefined();
      expect(global.createImageBitmap).toHaveBeenCalledWith(frame);
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        { type: 'addVideoFrame', frameBitmap: bitmap, timestamp: 0 },
        [bitmap]
      );
    });

    it('should reject if encoder not initialized', async () => {
      const encoder = new Mp4Encoder(config);
      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Encoder not initialized');
    });

    it('should propagate errors from createImageBitmap', async () => {
      const encoder = new Mp4Encoder(config);
      const onError = vi.fn();
      const init = encoder.initialize(undefined, undefined, onError);
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const err = new Error('boom');
      global.createImageBitmap = vi.fn(() => Promise.reject(err));

      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Failed to add video frame: boom');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EncoderErrorType.VideoEncodingError,
          message: 'Failed to add video frame: boom'
        })
      );
    });
  });

  describe('addAudioBuffer', () => {
    const config = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, audioBitrate: 64000,
      sampleRate: 48000, channels: 2
    };

    it('should resolve when audio data is added', async () => {
      const encoder = new Mp4Encoder(config);
      const init = encoder.initialize();
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const bufferData = new Float32Array(10);
      const audioBuffer = {
        numberOfChannels: 1,
        length: 10,
        sampleRate: 48000,
        getChannelData: vi.fn(() => bufferData)
      } as unknown as AudioBuffer;

      await expect(encoder.addAudioBuffer(audioBuffer)).resolves.toBeUndefined();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        { type: 'addAudioData', audioData: [bufferData], timestamp: 0 },
        [bufferData.buffer]
      );
    });

    it('should resolve immediately when audio disabled', async () => {
      const cfg = { ...config, channels: 0 };
      const encoder = new Mp4Encoder(cfg);
      encoder['worker'] = mockWorkerInstance;
      await expect(encoder.addAudioBuffer({} as AudioBuffer)).resolves.toBeUndefined();
      expect(mockWorkerInstance.postMessage).not.toHaveBeenCalled();
    });

    it('should reject if encoder not initialized', async () => {
      const encoder = new Mp4Encoder(config);
      await expect(encoder.addAudioBuffer({} as AudioBuffer))
        .rejects.toThrow('Encoder not initialized');
    });

    it('should propagate errors when gathering channel data', async () => {
      const encoder = new Mp4Encoder(config);
      const onError = vi.fn();
      const init = encoder.initialize(undefined, undefined, onError);
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const audioBuffer = {
        numberOfChannels: 1,
        length: 10,
        sampleRate: 48000,
        getChannelData: vi.fn(() => { throw new Error('bad'); })
      } as unknown as AudioBuffer;

      await expect(encoder.addAudioBuffer(audioBuffer))
        .rejects.toThrow('Failed to add audio buffer: bad');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EncoderErrorType.AudioEncodingError,
          message: 'Failed to add audio buffer: bad'
        })
      );
    });
  });

  describe('finalize', () => {
    const config = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, audioBitrate: 64000,
      sampleRate: 48000, channels: 2
    };

    it('should resolve with output when worker finalizes', async () => {
      const encoder = new Mp4Encoder(config);
      const init = encoder.initialize();
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const p = encoder.finalize();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'finalize' });
      const data = new Uint8Array([1, 2, 3]);
      mockWorkerInstance.onmessage({ data: { type: 'finalized', output: data } });
      await expect(p).resolves.toEqual(data);
    });

    it('should reject if not initialized', async () => {
      const encoder = new Mp4Encoder(config);
      await expect(encoder.finalize()).rejects.toThrow('Encoder not initialized');
    });

    it('should reject if worker reports error', async () => {
      const encoder = new Mp4Encoder(config);
      const onError = vi.fn();
      const init = encoder.initialize(undefined, undefined, onError);
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const p = encoder.finalize();
      const workerError = {
        message: 'mux fail',
        type: EncoderErrorType.MuxingFailed,
        stack: 's'
      };
      mockWorkerInstance.onmessage({ data: { type: 'error', errorDetail: workerError } });
      await expect(p).rejects.toThrow('mux fail');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'mux fail', type: EncoderErrorType.MuxingFailed })
      );
    });
  });

  describe('cancel', () => {
    const config = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, audioBitrate: 64000,
      sampleRate: 48000, channels: 2
    };

    it('should signal worker and reject pending finalize', async () => {
      const encoder = new Mp4Encoder(config);
      const init = encoder.initialize();
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      await init;

      const finalizePromise = encoder.finalize();
      encoder.cancel();

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
      await expect(finalizePromise).rejects.toThrow('Encoding cancelled by user.');
    });

    it('should reject subsequent operations after cancel', async () => {
      const encoder = new Mp4Encoder(config);
      encoder['worker'] = mockWorkerInstance;
      encoder.cancel();
      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Encoder cancelled');
    });
  });

}); 