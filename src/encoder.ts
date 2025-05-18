import { EncoderErrorType, Mp4EncoderError } from './types';
import type {
  EncoderConfig,
  MainThreadMessage,
  WorkerMessage,
} from './types';

export class Mp4Encoder {
  private config: EncoderConfig;
  private worker: Worker | null = null;
  private totalFrames: number | undefined;
  private processedFramesInternal: number = 0;

  // Callbacks for asynchronous operations
  private onInitialized: ((value: void | PromiseLike<void>) => void) | null = null;
  private onInitializeError: ((reason?: any) => void) | null = null;
  private onFinalized: ((data: Uint8Array) => void) | null = null;
  private onFinalizeError: ((reason?: any) => void) | null = null;
  private onProgressCallback: ((processedFrames: number, totalFrames: number) => void) | null = null;
  private onErrorCallback: ((error: Mp4EncoderError) => void) | null = null;

  private isCancelled: boolean = false;
  private nextVideoTimestamp: number = 0;
  private nextAudioTimestamp: number = 0; // Basic audio timestamp tracking

  constructor(config: EncoderConfig) {
    this.config = config;
    // Validate config if necessary
  }

  public static isSupported(): boolean {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof Worker !== 'undefined';
  }

  public async initialize(
    onProgress?: (processedFrames: number, totalFrames: number) => void,
    totalFrames?: number,
    onError?: (error: Mp4EncoderError) => void
  ): Promise<void> {
    this.onErrorCallback = onError || null;
    this.onProgressCallback = onProgress || null;

    if (!Mp4Encoder.isSupported()) {
      const err = new Mp4EncoderError(
        EncoderErrorType.NotSupported,
        'WebCodecs API or Web Workers are not supported in this browser.'
      );
      this.handleError(err);
      throw err;
    }

    if (this.worker) {
      console.warn('Mp4Encoder already initialized. Call cancel() before re-initializing.');
      // Potentially terminate existing worker and restart, or throw an error
      // For now, let's assume it should throw or be a no-op if already initialized and not cancelled.
      return Promise.resolve(); 
    }
    this.isCancelled = false;
    this.processedFramesInternal = 0;
    this.nextVideoTimestamp = 0;
    this.nextAudioTimestamp = 0;

    this.totalFrames = totalFrames;

    return new Promise<void>((resolve, reject) => {
      this.onInitialized = resolve;
      this.onInitializeError = reject;

      try {
        // The path to worker.js will be relative to the output directory (e.g., dist/)
        // tsup should place worker.js alongside index.js/index.mjs
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

        this.worker.onmessage = (event: MessageEvent<MainThreadMessage>) => {
          this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (event: ErrorEvent) => {
          console.error('Worker error:', event.message);
          const err = new Mp4EncoderError(
            EncoderErrorType.WorkerError,
            `Worker error: ${event.message}`,
            event
          );
          this.handleError(err);
          if (this.onInitializeError) this.onInitializeError(err);
          if (this.onFinalizeError) this.onFinalizeError(err);
          this.cleanupWorker();
        };

        const initMessage: WorkerMessage = {
          type: 'initialize',
          config: this.config,
          totalFrames: this.totalFrames,
        };
        this.worker.postMessage(initMessage);
      } catch (e: any) {
        const err = new Mp4EncoderError(
          EncoderErrorType.InitializationFailed,
          `Failed to initialize worker: ${e.message}`,
          e
        );
        this.handleError(err);
        this.onInitializeError?.(err);
        this.cleanupWorker();
      }
    });
  }

  private handleWorkerMessage(message: MainThreadMessage): void {
    if (this.isCancelled && message.type !== 'cancelled') return;

    switch (message.type) {
      case 'initialized':
        this.onInitialized?.();
        this.onInitialized = null;
        this.onInitializeError = null;
        break;
      case 'progress':
        this.processedFramesInternal = message.processedFrames;
        this.onProgressCallback?.(message.processedFrames, message.totalFrames);
        break;
      case 'finalized':
        this.onFinalized?.(message.output);
        this.onFinalized = null;
        this.onFinalizeError = null;
        this.cleanupWorker();
        break;
      case 'error':
        console.error('Error from worker:', message.errorDetail);
        const err = new Mp4EncoderError(
          message.errorDetail.type,
          message.errorDetail.message,
          message.errorDetail
        );
        this.handleError(err);
        this.onInitializeError?.(err);
        this.onFinalizeError?.(err);
        this.cleanupWorker();
        break;
      case 'cancelled':
        console.log('Encoder successfully cancelled by worker.');
        // Potentially reject pending promises if any are still around, though cancel() should handle this.
        this.cleanupWorker();
        break;
      // VideoChunkMessage and AudioChunkMessage are handled by the muxer within the worker
      // So they are not expected here.
      default:
        console.warn('Mp4Encoder: Unknown message from worker:', message);
    }
  }

  private handleError(error: Mp4EncoderError): void {
    this.onErrorCallback?.(error);
    // Future: could use an event emitter pattern here if more complex error handling is needed.
  }

  public async addVideoFrame(frameSource: CanvasImageSource): Promise<void> {
    if (!this.worker || this.isCancelled) {
      // Consider throwing an error or returning a rejected promise
      const err = new Mp4EncoderError(
        this.isCancelled ? EncoderErrorType.Cancelled : EncoderErrorType.InternalError,
        this.isCancelled ? 'Encoder cancelled' : 'Encoder not initialized'
      );
      return Promise.reject(err);
    }

    try {
      const frameBitmap = await createImageBitmap(frameSource);
      const timestamp = this.nextVideoTimestamp;
      this.nextVideoTimestamp += 1_000_000 / this.config.frameRate; // Increment by frame duration in microseconds

      const message: WorkerMessage = {
        type: 'addVideoFrame',
        frameBitmap: frameBitmap,
        timestamp: timestamp,
      };
      this.worker.postMessage(message, [frameBitmap]);
    } catch (e: any) {
      const err = new Mp4EncoderError(
        EncoderErrorType.VideoEncodingError,
        `Failed to add video frame: ${e.message}`,
        e
      );
      this.handleError(err);
      throw err; // Re-throw to reject the promise from this method
    }
  }

  public async addAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    if (!this.worker || this.isCancelled) {
      const err = new Mp4EncoderError(
        this.isCancelled ? EncoderErrorType.Cancelled : EncoderErrorType.InternalError,
        this.isCancelled ? 'Encoder cancelled' : 'Encoder not initialized'
      );
      return Promise.reject(err);
    }
    if (this.config.channels === 0 || this.config.sampleRate === 0) {
        console.warn('Audio encoding is disabled (channels or sampleRate is 0). Skipping addAudioBuffer.');
        return Promise.resolve();
    }

    try {
      // This is a simplified way to handle audio. A real implementation would chunk the AudioBuffer
      // into smaller pieces corresponding to video frame durations or a fixed sample count.
      // For now, we send the whole buffer (or a representation of it).
      // The worker side will need to handle this potentially large buffer.

      const numChannels = Math.min(audioBuffer.numberOfChannels, this.config.channels);
      const planarData: Float32Array[] = [];
      const transferableBuffers: ArrayBuffer[] = [];

      for (let i = 0; i < numChannels; i++) {
        const channelData = audioBuffer.getChannelData(i);
        planarData.push(channelData);
        transferableBuffers.push(channelData.buffer);
      }
      
      // The timestamp here is a placeholder. Ideally, audio is added in chunks
      // aligned with video frames or with its own timing logic.
      const timestamp = this.nextAudioTimestamp;
      // Crude way to advance audio timestamp, assuming the whole buffer is one segment.
      this.nextAudioTimestamp += (audioBuffer.length / audioBuffer.sampleRate) * 1_000_000;

      const message: WorkerMessage = {
        type: 'addAudioData',
        audioData: planarData, // Worker will receive Float32Arrays, their buffers are transferred.
        timestamp: timestamp, 
      };
      this.worker.postMessage(message, transferableBuffers);
    } catch (e: any) {
      const err = new Mp4EncoderError(
        EncoderErrorType.AudioEncodingError,
        `Failed to add audio buffer: ${e.message}`,
        e
      );
      this.handleError(err);
      throw err;
    }
  }

  public finalize(): Promise<Uint8Array> {
    if (!this.worker || this.isCancelled) {
      const err = new Mp4EncoderError(
        this.isCancelled ? EncoderErrorType.Cancelled : EncoderErrorType.InternalError,
        this.isCancelled ? 'Encoder cancelled' : 'Encoder not initialized or already finalized'
      );
      return Promise.reject(err);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.onFinalized = resolve;
      this.onFinalizeError = reject;

      const message: WorkerMessage = { type: 'finalize' };
      this.worker?.postMessage(message);
      // Note: Worker will be cleaned up by handleWorkerMessage on 'finalized' or 'error'
    });
  }

  public cancel(): void {
    if (this.isCancelled) return;
    this.isCancelled = true;
    console.log('Mp4Encoder: Sending cancel signal to worker.');

    if (this.worker) {
      const message: WorkerMessage = { type: 'cancel' };
      this.worker.postMessage(message);
    }

    // Reject any pending promises
    const cancelError = new Mp4EncoderError(
      EncoderErrorType.Cancelled,
      'Encoding cancelled by user.'
    );

    if (this.onInitializeError) {
        this.onInitializeError(cancelError);
        this.onInitializeError = null; 
        this.onInitialized = null;
    }
    if (this.onFinalizeError) {
        this.onFinalizeError(cancelError);
        this.onFinalizeError = null;
        this.onFinalized = null;
    }
    this.handleError(cancelError); // Notify via general onError if set
    this.cleanupWorker(); // Ensure worker is terminated
  }

  private cleanupWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.onInitialized = null;
    this.onInitializeError = null;
    this.onFinalized = null;
    this.onFinalizeError = null;
    // Keep onProgressCallback and onErrorCallback as they might be used across re-initializations if allowed
    // or should be cleared if instance is strictly one-time use.
    // For now, let's assume they persist for the lifetime of the Mp4Encoder instance.
  }
} 