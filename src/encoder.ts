import { EncoderErrorType, Mp4EncoderError } from "./types";
import type { EncoderConfig, MainThreadMessage, WorkerMessage } from "./types";

// Define the onData callback type for real-time streaming
export type RealtimeDataCallback = (
  chunk: Uint8Array,
  offset?: number,
  isHeader?: boolean,
  // container?: 'mp4' | 'webm' // Provided via worker messages when streaming
) => void;

export interface Mp4EncoderInitializeOptions {
  onProgress?: (processedFrames: number, totalFrames?: number) => void;
  totalFrames?: number;
  onError?: (error: Mp4EncoderError) => void;
  onData?: RealtimeDataCallback;
}

export class Mp4Encoder {
  private config: EncoderConfig;
  private worker: Worker | null = null;
  private totalFrames: number | undefined;
  private processedFramesInternal: number = 0;
  private actualVideoCodec: string | null = null;
  private actualAudioCodec: string | null = null;

  // Callbacks for asynchronous operations
  private onInitialized: ((value: void | PromiseLike<void>) => void) | null =
    null;
  private onInitializeError: ((reason?: any) => void) | null = null;
  private onFinalizedPromise: {
    resolve: (data: Uint8Array) => void;
    reject: (reason?: any) => void;
  } | null = null;
  private onProgressCallback:
    | ((processedFrames: number, totalFrames?: number) => void)
    | null = null;
  private onErrorCallback: ((error: Mp4EncoderError) => void) | null = null;
  private onDataCallback: RealtimeDataCallback | null = null; // For real-time data

  private isCancelled: boolean = false;
  private nextVideoTimestamp: number = 0;
  private nextAudioTimestamp: number = 0;

  constructor(config: EncoderConfig) {
    this.config = {
      // Default values first
      container: "mp4",
      latencyMode: "quality",
      ...config, // User-provided config overrides defaults
      codec: {
        // Ensure codec object exists and has defaults
        video: config.codec?.video ?? "avc", // Use 'avc' as per type
        audio: config.codec?.audio ?? "aac", // Use 'aac' as per type
      },
    };

    if (this.config.container === "webm") {
      // Early warning, though worker will also send an error
      console.warn(
        "Mp4Encoder: WebM container is specified but not supported in this version. MP4 will be used or an error will occur in the worker.",
      );
      // Depending on strictness, could throw here or let worker handle container choice.
      // For now, let it pass to worker which will error out if it only supports mp4.
    }

    // Initialize worker later, only if supported and initialize() is called.
    // This avoids creating a worker if the class is just instantiated.
  }

  public static isSupported(): boolean {
    return (
      typeof VideoEncoder !== "undefined" &&
      typeof AudioEncoder !== "undefined" &&
      typeof Worker !== "undefined"
    );
  }

  public async initialize(
    options?: Mp4EncoderInitializeOptions,
  ): Promise<void> {
    this.onErrorCallback = options?.onError || null;
    this.onProgressCallback = options?.onProgress || null;
    this.onDataCallback = options?.onData || null; // Store onData callback
    this.totalFrames = options?.totalFrames;

    if (this.config.latencyMode === "realtime" && !this.onDataCallback) {
      const err = new Mp4EncoderError(
        EncoderErrorType.ConfigurationError,
        "onData callback must be provided when latencyMode is 'realtime'.",
      );
      // No need to call this.handleError as it will be caught by the promise reject or caller
      // and this.onErrorCallback will be called by the caller if they wish.
      // this.handleError(err);
      throw err; // Throw immediately
    }

    if (!Mp4Encoder.isSupported()) {
      const err = new Mp4EncoderError(
        EncoderErrorType.NotSupported,
        "Required browser APIs (WebCodecs, Worker, etc.) are not supported.",
      );
      this.handleError(err);
      throw err;
    }

    if (this.worker) {
      console.warn(
        "Mp4Encoder already initialized or in progress. Call cancel() before re-initializing.",
      );
      // Allow re-initialization if already cancelled and cleaned up.
      if (!this.isCancelled) {
        return Promise.resolve(); // Or throw an error indicating it's busy
      }
    }
    this.isCancelled = false;
    this.processedFramesInternal = 0;
    this.nextVideoTimestamp = 0;
    this.nextAudioTimestamp = 0;

    return new Promise<void>((resolve, reject) => {
      this.onInitialized = resolve;
      this.onInitializeError = reject;

      try {
        this.worker = new Worker(new URL("./worker.js", import.meta.url), {
          type: "module",
        });

        this.worker.onmessage = (event: MessageEvent<MainThreadMessage>) => {
          this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (event: ErrorEvent) => {
          const err = new Mp4EncoderError(
            EncoderErrorType.WorkerError,
            `Worker error: ${event.message || "Unknown worker error"}`,
            event,
          );
          this.handleError(err);
          this.onInitializeError?.(err);
          this.onFinalizedPromise?.reject(err);
          this.cleanupWorkerOnError();
        };

        const initMessage: WorkerMessage = {
          type: "initialize",
          config: this.config, // Pass updated config
          totalFrames: this.totalFrames,
        };
        this.worker.postMessage(initMessage);
      } catch (e: any) {
        const err = new Mp4EncoderError(
          EncoderErrorType.InitializationFailed,
          `Failed to initialize worker: ${e.message}`,
          e,
        );
        this.handleError(err);
        this.onInitializeError?.(err);
        this.cleanupWorkerOnError();
      }
    });
  }

  private handleWorkerMessage(message: MainThreadMessage): void {
    if (
      this.isCancelled &&
      message.type !== "cancelled" &&
      message.type !== "error"
    )
      return;

    switch (message.type) {
      case "initialized":
        this.actualVideoCodec = (message as any).actualVideoCodec ?? null;
        this.actualAudioCodec = (message as any).actualAudioCodec ?? null;
        this.onInitialized?.();
        this.onInitialized = null;
        this.onInitializeError = null;
        break;
      case "progress":
        this.processedFramesInternal = message.processedFrames;
        this.onProgressCallback?.(message.processedFrames, message.totalFrames);
        break;
      case "dataChunk": // Handle real-time data chunks
        if (this.config.latencyMode === "realtime" && this.onDataCallback) {
          const { chunk, isHeader } = message;
          // Pass only chunk and isHeader as offset is not reliably used/provided yet
          this.onDataCallback(chunk, undefined, isHeader);
        } else if (
          this.onDataCallback &&
          this.config.latencyMode !== "realtime"
        ) {
          // console.warn('Mp4Encoder: Received dataChunk, but not in real-time mode or no onData callback was provided.');
          // Do not call onDataCallback if not in real-time mode
        } else if (
          !this.onDataCallback &&
          this.config.latencyMode === "realtime"
        ) {
          console.warn(
            "Mp4Encoder: Received dataChunk in real-time mode, but no onData callback was provided.",
          );
        }
        break;
      case "finalized":
        if (message.output !== null) {
          // Non-realtime mode or final part of fragmented MP4 with full file
          this.onFinalizedPromise?.resolve(message.output);
        } else {
          // Realtime mode, stream finished, no single file output from worker in this message
          if (this.config.latencyMode === "realtime") {
            // Signal completion of streaming. The promise from finalize() can resolve with empty Uint8Array.
            this.onFinalizedPromise?.resolve(new Uint8Array(0));
          } else {
            // This case should ideally not happen: null output in non-realtime mode.
            const err = new Mp4EncoderError(
              EncoderErrorType.MuxingFailed,
              "Finalized with null output in non-realtime mode.",
            );
            this.onFinalizedPromise?.reject(err);
            this.handleError(err);
          }
        }
        this.onFinalizedPromise = null;
        this.cleanupWorker();
        break;
      case "error":
        const err = new Mp4EncoderError(
          message.errorDetail.type,
          message.errorDetail.message,
          message.errorDetail.stack,
        );
        this.handleError(err);
        this.onInitializeError?.(err);
        this.onFinalizedPromise?.reject(err);
        this.cleanupWorkerOnError(); // Cleanup on error from worker
        break;
      case "cancelled":
        console.log("Mp4Encoder: Cancelled by worker.");
        const cancelErrWorker = new Mp4EncoderError(
          EncoderErrorType.Cancelled,
          "Operation cancelled by worker.",
        );
        this.onInitializeError?.(cancelErrWorker);
        this.onFinalizedPromise?.reject(cancelErrWorker);
        this.cleanupWorker(); // Worker has already cleaned itself up, main thread cleans its ref.
        break;
      default:
        // Exhaustive check for MainThreadMessage types
        const _exhaustiveCheck: never = message;
        console.warn(
          "Mp4Encoder: Unknown message from worker:",
          _exhaustiveCheck,
        );
    }
  }

  private handleError(error: Mp4EncoderError): void {
    console.error(
      `Mp4Encoder Error (${error.type}):`,
      error.message,
      error.cause || "",
    );
    this.onErrorCallback?.(error);
  }

  public async addVideoFrame(frameSource: VideoFrame): Promise<void> {
    if (!this.worker || this.isCancelled) {
      const err = new Mp4EncoderError(
        this.isCancelled
          ? EncoderErrorType.Cancelled
          : EncoderErrorType.InternalError,
        this.isCancelled
          ? "Encoder cancelled"
          : "Encoder not initialized or already finalized",
      );
      this.handleError(err);
      return Promise.reject(err);
    }

    try {
      // VideoFrame is sent directly
      const transferList: Transferable[] = [frameSource];

      const timestamp = this.nextVideoTimestamp;
      this.nextVideoTimestamp += 1_000_000 / this.config.frameRate;

      const message: WorkerMessage = {
        type: "addVideoFrame",
        frame: frameSource, // Send VideoFrame directly
        timestamp: timestamp,
      };
      this.worker.postMessage(message, transferList);
      // frameSource is not closed here, it will be closed in the worker.
    } catch (e: any) {
      const err = new Mp4EncoderError(
        EncoderErrorType.VideoEncodingError,
        `Failed to post video frame: ${e.message}`,
        e,
      );
      this.handleError(err);
      throw err;
    }
  }

  public async addAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    if (!this.worker || this.isCancelled) {
      const err = new Mp4EncoderError(
        this.isCancelled
          ? EncoderErrorType.Cancelled
          : EncoderErrorType.InternalError,
        this.isCancelled
          ? "Encoder cancelled"
          : "Encoder not initialized or already finalized",
      );
      this.handleError(err);
      return Promise.reject(err);
    }
    if (
      !this.config.audioBitrate ||
      this.config.audioBitrate <= 0 ||
      this.config.channels <= 0 ||
      this.config.sampleRate <= 0
    ) {
      console.warn(
        "Audio encoding is disabled (audioBitrate, channels or sampleRate is zero/negative). Skipping addAudioBuffer.",
      );
      return Promise.resolve();
    }

    try {
      const numChannels = Math.min(
        audioBuffer.numberOfChannels,
        this.config.channels,
      );
      const planarData: Float32Array[] = [];
      const transferableBuffers: ArrayBuffer[] = [];

      for (let i = 0; i < numChannels; i++) {
        // Ensure we get a copy for transfer, as getChannelData might return a view into a larger buffer.
        const channelDataContent = audioBuffer.getChannelData(i);
        const channelDataCopy = new Float32Array(channelDataContent.length);
        channelDataCopy.set(channelDataContent);
        planarData.push(channelDataCopy);
        transferableBuffers.push(channelDataCopy.buffer);
      }

      const timestamp = this.nextAudioTimestamp;
      this.nextAudioTimestamp += audioBuffer.duration * 1_000_000; // duration is in seconds

      const message: WorkerMessage = {
        type: "addAudioData",
        audioData: planarData,
        timestamp: timestamp,
      };
      this.worker.postMessage(message, transferableBuffers);
    } catch (e: any) {
      const err = new Mp4EncoderError(
        EncoderErrorType.AudioEncodingError,
        `Failed to add audio buffer: ${e.message}`,
        e,
      );
      this.handleError(err);
      throw err;
    }
  }

  public finalize(): Promise<Uint8Array> {
    if (!this.worker || this.isCancelled) {
      const stateMsg = this.isCancelled
        ? "Encoder cancelled"
        : "Encoder not initialized or already finalized";
      const err = new Mp4EncoderError(
        this.isCancelled
          ? EncoderErrorType.Cancelled
          : EncoderErrorType.InternalError,
        stateMsg,
      );
      this.handleError(err);
      return Promise.reject(err);
    }
    if (this.onFinalizedPromise) {
      console.warn("Finalize already called.");
      // Or return the existing promise: return new Promise((res, rej) => { this.onFinalizedPromise = {resolve: res, reject: rej};});
      const err = new Mp4EncoderError(
        EncoderErrorType.InternalError,
        "Finalize called multiple times.",
      );
      this.handleError(err);
      return Promise.reject(err);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.onFinalizedPromise = { resolve, reject };
      const message: WorkerMessage = { type: "finalize" };
      this.worker!.postMessage(message); // worker is checked above
    });
  }

  public cancel(): void {
    if (this.isCancelled || !this.worker) {
      console.log("Mp4Encoder: Already cancelled or not initialized.");
      return;
    }
    this.isCancelled = true;
    console.log("Mp4Encoder: Sending cancel signal to worker.");

    const message: WorkerMessage = { type: "cancel" };
    this.worker.postMessage(message);

    // Reject pending promises
    const cancelError = new Mp4EncoderError(
      EncoderErrorType.Cancelled,
      "Operation cancelled by user.",
    );
    this.onInitializeError?.(cancelError);
    this.onFinalizedPromise?.reject(cancelError);

    this.onInitializeError = null;
    this.onInitialized = null;
    this.onFinalizedPromise = null;

    // Worker will send a 'cancelled' message, upon which cleanupWorker is called.
    // However, if the worker is stuck or fails to respond, a timeout might be needed here.
    // For now, rely on worker's confirmation or error.
  }

  private cleanupWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      console.log("Mp4Encoder: Worker terminated and cleaned up.");
    }
    this.isCancelled = true; // Ensure isCancelled is true after cleanup
  }

  // Specific cleanup for errors to avoid double-terminating if worker itself errored.
  private cleanupWorkerOnError(): void {
    if (this.worker) {
      // Don't terminate if it was a worker self-error, it might have already terminated or is in an unstable state.
      // Let the browser handle the errored worker instance.
      this.worker.onmessage = null; // Stop listening to messages
      this.worker.onerror = null; // Stop listening to errors
      this.worker = null;
      console.log(
        "Mp4Encoder: Worker references cleaned up after worker error.",
      );
    }
    this.isCancelled = true;
  }

  public getActualVideoCodec(): string | null {
    return this.actualVideoCodec;
  }

  public getActualAudioCodec(): string | null {
    return this.actualAudioCodec;
  }
}
