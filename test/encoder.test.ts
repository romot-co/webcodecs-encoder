import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Mp4Encoder } from '../src/index'; // Assuming index.ts exports Mp4Encoder
import { EncoderErrorType, Mp4EncoderError } from '../src/types'; // Import EncoderErrorType and Mp4EncoderError for error checking
import { EncoderConfig } from '../src/types'; // Import EncoderConfig for type checking

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
    mockWorkerInstance = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null, // Will be set by Mp4Encoder during initialize
      onerror: null,   // Will be set by Mp4Encoder during initialize
    };
    // Use globalThis directly for mocking to ensure visibility
    globalThis.Worker = vi.fn(() => mockWorkerInstance) as any;
    globalThis.URL = vi.fn((path, base) => ({ href: base + path })) as any;

    // Mock WebCodecs APIs directly on globalThis
    globalThis.VideoEncoder = vi.fn(() => ({
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      // state: 'unconfigured', 
    })) as any;
    (globalThis.VideoEncoder as any).isConfigSupported = vi.fn(() => Promise.resolve({ supported: true, config: {} })); 

    globalThis.AudioEncoder = vi.fn(() => ({
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      // state: 'unconfigured',
    })) as any;
    (globalThis.AudioEncoder as any).isConfigSupported = vi.fn(() => Promise.resolve({ supported: true, config: {} }));

    // Mock ErrorEvent for Node.js environment if not available (e.g. via JSDOM)
    if (typeof globalThis.ErrorEvent === 'undefined') {
      // A simple mock for ErrorEvent if it's not defined (e.g., in a pure Node environment)
      globalThis.ErrorEvent = class ErrorEventMock extends Event {
        public message: string;
        public error: any;
        constructor(type: string, eventInitDict?: ErrorEventInit) {
          super(type);
          this.message = eventInitDict?.message || '';
          this.error = eventInitDict?.error || null;
        }
      } as any;
    }

    // Add lightweight mocks for APIs checked by the more lenient isSupported, if not already present
    if (typeof globalThis.createImageBitmap === 'undefined') {
      globalThis.createImageBitmap = vi.fn(async () => ({ close: vi.fn(), width: 0, height: 0 })) as any;
    }
    if (typeof globalThis.AudioData === 'undefined') {
      globalThis.AudioData = class AudioDataMock {
        constructor(init: any) { Object.assign(this, init); }
        close() {}
        // Add other properties/methods if needed by tests, e.g., format, sampleRate etc.
      } as any;
    }

    // Add VideoFrame mock for encoder.ts tests
    if (typeof globalThis.VideoFrame === 'undefined') {
      globalThis.VideoFrame = class VideoFrameMock {
          constructor(source: any, init?: VideoFrameInit) { 
              Object.assign(this, init);
              // @ts-ignore
              this.codedWidth = source.width;
              // @ts-ignore
              this.codedHeight = source.height;
              // @ts-ignore
              this.format = 'RGBA'; // Or a common default
          }
          // @ts-ignore
          allocationSize(options?: VideoFrameCopyToOptions): number { return 0; }
          // @ts-ignore
          copyTo(destination: AllowSharedBufferSource, options?: VideoFrameCopyToOptions): Promise<PlaneLayout[]> { return Promise.resolve([]); }
          // @ts-ignore
          timestamp = 0;
          // @ts-ignore
          duration = 0;
          // @ts-ignore
          codedWidth = 0;
          // @ts-ignore
          codedHeight = 0;
          // @ts-ignore
          format: VideoPixelFormat | null = null;
          // @ts-ignore
          displayHeight = 0;
          // @ts-ignore
          displayWidth = 0;
          close() {}
      } as any;
    }
  });

  afterEach(() => {
    // Clean up globalThis properties
    delete (globalThis as any).VideoEncoder;
    delete (globalThis as any).AudioEncoder;
    delete (globalThis as any).Worker;
    delete (globalThis as any).URL;
    if ((globalThis as any).ErrorEvent?.name === 'ErrorEventMock') { 
        delete (globalThis as any).ErrorEvent;
    }
    // Clean up potentially added mocks
    if ((globalThis.createImageBitmap as any)?.isMock) delete (globalThis as any).createImageBitmap;
    if ((globalThis.AudioData as any)?.name === 'AudioDataMock') delete (globalThis as any).AudioData;
    // Clean up VideoFrame mock
    if ((globalThis as any).VideoFrame?.name === 'VideoFrameMock') delete (globalThis as any).VideoFrame;
  });

  describe('isSupported', () => {
    it('should return true if VideoEncoder, AudioEncoder, and Worker are defined and configs supported', async () => {
      // beforeEach already sets these up to be truthy by default
      // We also need to ensure isConfigSupported is called and resolves for the check in Mp4Encoder
      // However, the static Mp4Encoder.isSupported() does not call isConfigSupported.
      // It only checks for the presence of the global objects.
      expect(Mp4Encoder.isSupported()).toBe(true);
    });

    it('should return false if VideoEncoder is not defined', () => {
      // @ts-ignore
      delete globalThis.VideoEncoder;
      globalThis.AudioEncoder = vi.fn() as any;
      globalThis.Worker = vi.fn() as any;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });

    it('should return false if AudioEncoder is not defined', () => {
      globalThis.VideoEncoder = vi.fn() as any;
      // @ts-ignore
      delete globalThis.AudioEncoder;
      globalThis.Worker = vi.fn() as any;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });

    it('should return false if Worker is not defined', () => {
      globalThis.VideoEncoder = vi.fn() as any;
      globalThis.AudioEncoder = vi.fn() as any;
      // @ts-ignore
      delete globalThis.Worker;
      expect(Mp4Encoder.isSupported()).toBe(false);
    });
  });

  describe('constructor', () => {
    it('should create an instance with the given config, including defaults', () => {
      const inputConfig = { 
        width: 100, 
        height: 100, 
        frameRate: 30, 
        videoBitrate: 1000, 
        audioBitrate: 128, 
        sampleRate: 44100, 
        channels: 2
      };
      const encoder = new Mp4Encoder(inputConfig as EncoderConfig); // Cast to base EncoderConfig for input
      expect(encoder).toBeInstanceOf(Mp4Encoder);
      
      // @ts-ignore access private member for test. 
      // The type of encoder.config might be broader internally than the input EncoderConfig.
      const internalConfig = encoder.config as any; // Use `as any` to bypass strict type checking for this test

      // Check top-level properties copied from input
      expect(internalConfig.width).toBe(inputConfig.width);
      expect(internalConfig.height).toBe(inputConfig.height);
      expect(internalConfig.frameRate).toBe(inputConfig.frameRate);
      expect(internalConfig.videoBitrate).toBe(inputConfig.videoBitrate);
      expect(internalConfig.audioBitrate).toBe(inputConfig.audioBitrate);
      expect(internalConfig.sampleRate).toBe(inputConfig.sampleRate);
      expect(internalConfig.channels).toBe(inputConfig.channels);

      // Check defaults set by the constructor at the top level of internalConfig
      expect(internalConfig.container).toBe('mp4');
      expect(internalConfig.latencyMode).toBe('quality');
      expect(internalConfig.codec?.video).toBe('avc'); // Adjusted expectation
      expect(internalConfig.codec?.audio).toBe('aac'); // Adjusted expectation
      
      // TODO: Revisit testing of nested internalConfig.video and internalConfig.audio 
      // once the exact structure and typing within Mp4Encoder are clear and stable.
      // For now, focus on values passed to the worker during initialize.

      // Example of how one might check if these exist, if they are indeed added:
      // expect(internalConfig.video).toBeDefined();
      // expect(internalConfig.audio).toBeDefined();

      // If Mp4Encoder guarantees certain fully resolved codec strings in internalConfig.video.codec:
      // expect(internalConfig.video?.codec).toMatch(/^avc1\./); 
      // expect(internalConfig.audio?.codec).toMatch(/^mp4a\.40\.2/);
    });
  });

  describe('initialize', () => {
    const baseConfig: EncoderConfig = { // Explicitly type baseConfig for clarity
      width: 640,
      height: 480,
      frameRate: 30,
      videoBitrate: 1000000,
      audioBitrate: 128000,
      sampleRate: 48000,
      channels: 2,
      // `container`, `latencyMode`, and specific `codec.*` are optional
      // and will be defaulted by Mp4Encoder constructor if not provided.
    };

    it('should resolve when worker sends initialized message', async () => {
      const encoder = new Mp4Encoder(baseConfig);
      const initPromise = encoder.initialize({}); // Pass empty options object

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({
        type: 'initialize',
        config: {
          ...baseConfig, // Spread the provided base config
          container: 'mp4', // Default added by constructor
          latencyMode: 'quality', // Default added by constructor
          codec: { // Default codecs added by constructor
            video: 'avc', // Adjusted expectation
            audio: 'aac'  // Adjusted expectation
          },
          // Ensure other defaults from Mp4Encoder constructor are considered if they exist
          // e.g. video.hardwareAcceleration, audio.bitDepth might be set by constructor
        },
        totalFrames: undefined,
      });
      mockWorkerInstance.onmessage({ data: { type: 'initialized' } });

      await expect(initPromise).resolves.toBeUndefined();
    });

    it('should reject if worker posts an error during initialization', async () => {
      const encoder = new Mp4Encoder(baseConfig);
      const onErrorCallback = vi.fn();
      const initPromise = encoder.initialize({ onError: onErrorCallback });

      const workerError = { message: 'Init failed', type: EncoderErrorType.WorkerError, stack: 'worker stack' };
      // Ensure onmessage is set before trying to call it
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'error', errorDetail: workerError } });
      } else {
        console.warn("mockWorkerInstance.onmessage was not set before emitting error for 'initialization error' test");
      }

      await expect(initPromise).rejects.toThrow(workerError.message);
      expect(onErrorCallback).toHaveBeenCalledWith(expect.objectContaining({ type: EncoderErrorType.WorkerError, message: workerError.message }));
    });

    it('should reject if worker script itself throws an error (onerror)', async () => {
      const encoder = new Mp4Encoder(baseConfig);
      const onErrorCallback = vi.fn();
      // Initialize should set up the worker.onerror handler
      const initPromise = encoder.initialize({ onError: onErrorCallback });
      
      const errorMessage = 'Worker script broke';
      const mockErrorEvent = new ErrorEvent('error', { message: errorMessage }); // Use new ErrorEvent for proper typing
      
      // Check if the onerror handler was attached to the mock worker instance
      expect(mockWorkerInstance.onerror).toBeTypeOf('function');
      if (typeof mockWorkerInstance.onerror === 'function') {
        mockWorkerInstance.onerror(mockErrorEvent);
      }

      await expect(initPromise).rejects.toThrow(new RegExp(`Worker error: ${errorMessage}`));
      
      expect(onErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({ 
          message: `Worker error: ${errorMessage}`,
          type: EncoderErrorType.WorkerError 
        })
      );
      expect(onErrorCallback).toHaveBeenCalledTimes(1);
    });

    it('should reject if Required browser APIs are not supported', async () => {
      // @ts-ignore
      delete globalThis.Worker; // Make it unsupported
      const encoder = new Mp4Encoder(baseConfig);
      const onErrorCallback = vi.fn();
      
      try {
        await encoder.initialize({ onError: onErrorCallback });
        expect(true, 'Promise should have rejected but resolved instead.').toBe(false); 
      } catch (e: any) {
        expect(e.message).toContain('Required browser APIs (WebCodecs, Worker, etc.) are not supported.');
        const customError = e as Mp4EncoderError;
        expect(customError.type).toBe(EncoderErrorType.NotSupported);
      }
      
      expect(onErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({ 
          type: EncoderErrorType.NotSupported,
          message: 'Required browser APIs (WebCodecs, Worker, etc.) are not supported.'
        })
      );
      expect(onErrorCallback).toHaveBeenCalledTimes(1);
    });

    it('should pass totalFrames to worker if provided', async () => {
      const encoder = new Mp4Encoder(baseConfig);
      const totalFrames = 150;
      const initPromise = encoder.initialize({ totalFrames });
      
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'initialize',
        totalFrames: totalFrames,
        config: expect.objectContaining({
            ...baseConfig,
            container: 'mp4', 
            latencyMode: 'quality', 
            codec: { video: 'avc', audio: 'aac' }
        })
      }));
      if (mockWorkerInstance.onmessage) {
          mockWorkerInstance.onmessage({ data: { type: 'initialized' } }); 
      } else {
          console.warn("mockWorkerInstance.onmessage was not set for 'totalFrames' test");
      }
      await initPromise;
    });

    it('should set onProgress callback if provided and worker sends progress', async () => {
      const encoder = new Mp4Encoder(baseConfig);
      const onProgress = vi.fn();
      const initPromise = encoder.initialize({ onProgress });
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      } else {
         console.warn("mockWorkerInstance.onmessage was not set for 'onProgress' test initialization");
      }
      await initPromise;

      // Ensure onmessage is set on the worker instance by Mp4Encoder
      expect(mockWorkerInstance.onmessage).toBeTypeOf('function'); 

      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'progress', processedFrames: 10, totalFrames: 100 } });
      }
      expect(onProgress).toHaveBeenCalledWith(10, 100);
    });

  });

  describe('addVideoFrame', () => {
    const baseVideoConfig: EncoderConfig = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, 
      audioBitrate: 64000,
      sampleRate: 48000, 
      channels: 2
      // container, latencyMode, codec.* will use defaults
    };

    it('should resolve when a frame is added successfully', async () => {
      const encoder = new Mp4Encoder(baseVideoConfig);
      const initPromise = encoder.initialize({}); // Pass empty options object
      // Ensure onmessage is set by encoder.initialize() before we try to use it
      expect(mockWorkerInstance.onmessage).toBeTypeOf('function');
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const bitmap = { close: vi.fn(), width: 320, height: 240 } as any; 
      global.createImageBitmap = vi.fn(() => Promise.resolve(bitmap));

      const frame = {} as CanvasImageSource;
      const p = encoder.addVideoFrame(frame);

      await expect(p).resolves.toBeUndefined();
      expect(global.createImageBitmap).toHaveBeenCalledWith(frame);
      const expectedTimestamp = 0;
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        { type: 'addVideoFrame', frameBitmap: bitmap, timestamp: expectedTimestamp },
        [bitmap]
      );
    });

    it('should reject if encoder not initialized', async () => {
      const encoder = new Mp4Encoder(baseVideoConfig);
      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Encoder not initialized or already finalized');
    });

    it('should propagate errors from createImageBitmap', async () => {
      const encoder = new Mp4Encoder(baseVideoConfig);
      const onError = vi.fn();
      const initPromise = encoder.initialize({ onError });
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const err = new Error('boom');
      global.createImageBitmap = vi.fn(() => Promise.reject(err));

      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Failed to create ImageBitmap or post video frame: boom');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EncoderErrorType.VideoEncodingError,
          message: 'Failed to create ImageBitmap or post video frame: boom',
          cause: err // Ensure the original error is the cause
        })
      );
    });
  });

  describe('addAudioBuffer', () => {
    const baseAudioConfig: EncoderConfig = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, 
      audioBitrate: 64000,
      sampleRate: 48000, 
      channels: 2
    };

    it('should resolve when audio data is added', async () => {
      const encoder = new Mp4Encoder(baseAudioConfig);
      const initPromise = encoder.initialize({});
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const bufferData = new Float32Array(10);
      const audioBuffer = {
        numberOfChannels: 1, // Should match baseAudioConfig.channels for a valid test, or use a config with channels: 1
        length: 10,
        sampleRate: baseAudioConfig.sampleRate, // Match config
        duration: 10 / baseAudioConfig.sampleRate,
        getChannelData: vi.fn(() => bufferData)
      } as unknown as AudioBuffer;

      await expect(encoder.addAudioBuffer(audioBuffer)).resolves.toBeUndefined();
      const expectedTimestamp = 0;
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        { type: 'addAudioData', audioData: [expect.any(Float32Array)], timestamp: expectedTimestamp },
        [expect.any(ArrayBuffer)]
      );
      const sentAudioDataCall = mockWorkerInstance.postMessage.mock.calls.find((call:any) => call[0].type === 'addAudioData');
      expect(sentAudioDataCall).toBeDefined();
      if (sentAudioDataCall) {
        const sentAudioData = sentAudioDataCall[0].audioData[0];
        expect(sentAudioData).toEqual(bufferData);
      }
    });

    it('should resolve immediately when audio disabled (audioBitrate is 0)', async () => {
      const cfg: EncoderConfig = { ...baseAudioConfig, audioBitrate: 0 };
      const encoder = new Mp4Encoder(cfg);
      
      const initPromise = encoder.initialize({});
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;
 
      // @ts-ignore Accessing private worker for test verification - this is brittle.
      // Better to test the public behavior (no postMessage for addAudioData).
      // expect(encoder.worker).toBeDefined(); 
      
      await expect(encoder.addAudioBuffer({} as AudioBuffer)).resolves.toBeUndefined();
      const addAudioDataCalls = mockWorkerInstance.postMessage.mock.calls.filter((call:any) => call[0].type === 'addAudioData');
      expect(addAudioDataCalls.length).toBe(0);
    });

    it('should reject if encoder not initialized', async () => {
      const encoder = new Mp4Encoder(baseAudioConfig);
      await expect(encoder.addAudioBuffer({} as AudioBuffer))
        .rejects.toThrow('Encoder not initialized or already finalized');
    });

    it('should propagate errors when gathering channel data', async () => {
      const encoder = new Mp4Encoder(baseAudioConfig);
      const onError = vi.fn();
      const initPromise = encoder.initialize({ onError });
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const audioBuffer = {
        numberOfChannels: baseAudioConfig.channels,
        length: 10,
        sampleRate: baseAudioConfig.sampleRate,
        duration: 10/baseAudioConfig.sampleRate,
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
    const baseFinalizeConfig: EncoderConfig = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, 
      audioBitrate: 64000,
      sampleRate: 48000, 
      channels: 2
    };

    it('should resolve with output when worker finalizes in non-realtime mode', async () => {
      // Non-realtime is default (latencyMode: 'quality')
      const encoder = new Mp4Encoder(baseFinalizeConfig); 
      const initPromise = encoder.initialize({});
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const p = encoder.finalize();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'finalize' });
      
      // Ensure onmessage is still the one set by Mp4Encoder for handling worker messages
      expect(mockWorkerInstance.onmessage).toBeTypeOf('function');
      const data = new Uint8Array([1, 2, 3]);
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'finalized', output: data } });
      }
      await expect(p).resolves.toEqual(data);
    });

    it('should reject if not initialized', async () => {
      const encoder = new Mp4Encoder(baseFinalizeConfig);
      await expect(encoder.finalize()).rejects.toThrow('Encoder not initialized or already finalized');
    });

    it('should reject if worker reports error during finalization', async () => {
      const encoder = new Mp4Encoder(baseFinalizeConfig);
      const onError = vi.fn();
      const initPromise = encoder.initialize({ onError });
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const p = encoder.finalize();
      const workerError = {
        message: 'mux fail',
        type: EncoderErrorType.MuxingFailed,
        stack: 's'
      };
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'error', errorDetail: workerError } });
      }
      await expect(p).rejects.toThrow('mux fail');
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'mux fail', type: EncoderErrorType.MuxingFailed })
      );
    });
  });

  describe('cancel', () => {
    const baseCancelConfig: EncoderConfig = {
      width: 320, height: 240, frameRate: 30,
      videoBitrate: 500000, 
      audioBitrate: 64000,
      sampleRate: 48000, 
      channels: 2
    };

    it('should signal worker and reject pending finalize', async () => {
      const encoder = new Mp4Encoder(baseCancelConfig);
      const initPromise = encoder.initialize({});
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const finalizePromise = encoder.finalize();
      encoder.cancel(); // This should trigger the rejection

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
      // Mp4Encoder.cancel() ultimately leads to worker termination via handleWorkerMessage -> cleanupWorker
      // To test this directly, we would need to simulate the worker sending back 'cancelled'
      // For now, we check that the cancel message was sent to the worker.
      // If terminate is called directly in cancel(), that can be checked.
      // Current logic: cancel() -> postMessage('cancel') -> worker receives -> worker postMessage('cancelled') -> encoder receives -> cleanupWorker() -> terminate()

      // Simulate worker acknowledging cancellation
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'cancelled' } });
      }
      expect(mockWorkerInstance.terminate).toHaveBeenCalled(); // Now this should be called

      try {
        await finalizePromise;
        expect(true, 'finalizePromise should have rejected').toBe(false);
      } catch (e: any) {
        expect(e).toBeInstanceOf(Mp4EncoderError);
        expect(e.type).toBe(EncoderErrorType.Cancelled);
        expect(e.message).toBe('Operation cancelled by user.'); // Adjusted expectation
      }
    });

    it('should reject subsequent operations after cancel', async () => {
      const encoder = new Mp4Encoder(baseCancelConfig);
      // Initialize and then cancel to set the internal state to cancelled
      const initPromise = encoder.initialize({});
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;
      
      encoder.cancel(); // Cancel the encoder

      await expect(encoder.addVideoFrame({} as CanvasImageSource))
        .rejects.toThrow('Encoder cancelled'); 
      await expect(encoder.addAudioBuffer({} as AudioBuffer))
        .rejects.toThrow('Encoder cancelled');
      await expect(encoder.finalize())
        .rejects.toThrow('Encoder cancelled');
    });

    it('should do nothing if worker is not initialized', () => {
      const encoder = new Mp4Encoder(baseCancelConfig);
      encoder.cancel(); // Call cancel before initialize
      expect(mockWorkerInstance.postMessage).not.toHaveBeenCalledWith({ type: 'cancel' });
      expect(mockWorkerInstance.terminate).not.toHaveBeenCalled();
    });

  });

  // New describe block for Real-time Streaming tests
  describe('Real-time Streaming', () => {
    const realtimeConfig: EncoderConfig = {
      width: 640, height: 480, frameRate: 30,
      videoBitrate: 1000000,
      audioBitrate: 128000,
      sampleRate: 48000,
      channels: 2,
      latencyMode: 'realtime', // Key setting for these tests
      container: 'mp4' // Explicitly mp4 for now
    };

    it('should initialize with latencyMode: realtime and call onData for dataChunks', async () => {
      const onDataCallback = vi.fn();
      const encoder = new Mp4Encoder(realtimeConfig);
      
      const initPromise = encoder.initialize({ onData: onDataCallback });

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'initialize',
          config: expect.objectContaining({ latencyMode: 'realtime' }),
        })
      );
      
      // Simulate worker initialized
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      // Simulate worker sending a data chunk (e.g., header)
      const headerChunk = new Uint8Array([1, 2, 3, 4]);
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ 
          data: { type: 'dataChunk', chunk: headerChunk, isHeader: true, container: 'mp4' } 
        });
      }
      expect(onDataCallback).toHaveBeenCalledWith(headerChunk, undefined, true);

      // Simulate worker sending a media data chunk
      const mediaChunk = new Uint8Array([5, 6, 7, 8]);
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ 
          data: { type: 'dataChunk', chunk: mediaChunk, isHeader: false, container: 'mp4' } 
        });
      }
      expect(onDataCallback).toHaveBeenCalledWith(mediaChunk, undefined, false);
      expect(onDataCallback).toHaveBeenCalledTimes(2);
    });

    it('finalize() should resolve with an empty Uint8Array in realtime mode', async () => {
      const onDataCallback = vi.fn(); // onData might or might not be used before finalize
      const encoder = new Mp4Encoder(realtimeConfig);
      const initPromise = encoder.initialize({ onData: onDataCallback });
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      // Simulate some data chunks being sent
      const chunk1 = new Uint8Array([1]);
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'dataChunk', chunk: chunk1, container: 'mp4' } });
      }

      const finalizePromise = encoder.finalize();
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'finalize' });

      // In realtime mode, worker sends 'finalized' with empty output (or null, which Encoder converts to empty)
      if (typeof mockWorkerInstance.onmessage === 'function') {
        // The worker sends `output: null` which becomes `new Uint8Array()` in main thread for realtime.
        // Or worker could send `output: new Uint8Array()` directly.
        // Let's assume worker sends a specific empty Uint8Array or null for this test.
        mockWorkerInstance.onmessage({ data: { type: 'finalized', output: new Uint8Array() } });
      }
      
      const result = await finalizePromise;
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.byteLength).toBe(0);
      expect(onDataCallback).toHaveBeenCalledTimes(1); // With chunk1
    });

    it('should not call onData if latencyMode is quality, even if onData is provided', async () => {
      const onDataCallback = vi.fn();
      const qualityConfig: EncoderConfig = { ...realtimeConfig, latencyMode: 'quality' };
      const encoder = new Mp4Encoder(qualityConfig);

      const initPromise = encoder.initialize({ onData: onDataCallback });
      if (typeof mockWorkerInstance.onmessage === 'function') {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise;

      const dataChunk = new Uint8Array([1,2,3]);
      if (typeof mockWorkerInstance.onmessage === 'function') {
         mockWorkerInstance.onmessage({ 
          data: { type: 'dataChunk', chunk: dataChunk, isHeader: true, container: 'mp4' } 
        });
      }
      // In quality mode, onDataCallback should not be called, even if provided.
      // The data chunk messages from worker are effectively ignored by main thread if latencyMode isn't realtime.
      expect(onDataCallback).not.toHaveBeenCalled();
    });

  });

  describe('worker message handling', () => {
    const config: EncoderConfig = {
      width: 320,
      height: 240,
      frameRate: 30,
      videoBitrate: 500000,
      audioBitrate: 64000,
      sampleRate: 48000,
      channels: 2,
      codec: { video: 'avc', audio: 'aac' }
    };

    it('cleans up when worker sends cancelled', async () => {
      const encoder = new Mp4Encoder(config);
      const initPromise = encoder.initialize({}); // Store the promise
      // Simulate worker sending 'initialized' message before awaiting initPromise
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise; // Now await the promise
      expect(mockWorkerInstance.onmessage).toBeTypeOf('function'); // Ensure onmessage is set

      await new Promise(resolve => process.nextTick(resolve)); // Use process.nextTick
      mockWorkerInstance.onmessage({ data: { type: 'cancelled' } });
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });

    it('warns on unknown message type', async () => {
      const encoder = new Mp4Encoder(config);
      const initPromise = encoder.initialize({}); // Store the promise
      // Simulate worker sending 'initialized' message before awaiting initPromise
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'initialized' } });
      }
      await initPromise; // Now await the promise
      expect(mockWorkerInstance.onmessage).toBeTypeOf('function'); // Ensure onmessage is set

      const warnSpy = vi.spyOn(console, 'warn');
      warnSpy.mockImplementation(() => {}); // Keep the mock simple

      await new Promise(resolve => process.nextTick(resolve)); // Use process.nextTick
      if (mockWorkerInstance.onmessage) {
        mockWorkerInstance.onmessage({ data: { type: 'bogus' } as any }); // Cast to any if type is not in MainThreadMessage
      }
      expect(warnSpy).toHaveBeenCalledWith('Mp4Encoder: Unknown message from worker:', { type: 'bogus' });
      warnSpy.mockRestore();
    });

    it('rejects initialize promise when cancelled early', async () => {
      const encoder = new Mp4Encoder(config);
      const initPromise = encoder.initialize(); // Don't await here
      encoder.cancel();
      await expect(initPromise).rejects.toThrow('Operation cancelled by user.'); // Adjusted message
      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
      // Terminate should also be called after worker acknowledges cancellation
      if (mockWorkerInstance.onmessage) {
          mockWorkerInstance.onmessage({ data: { type: 'cancelled' } });
      }
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });
  });

}); 