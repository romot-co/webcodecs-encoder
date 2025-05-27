import {
  EncoderErrorType,
  WebCodecsEncoderError,
  EncoderState,
  ProcessingStage,
} from "./types";
import type {
  EncoderConfig,
  MainThreadMessage,
  WorkerMessage,
  ConnectAudioPortMessage,
  DetailedProgressInfo,
  DetailedProgressCallback,
} from "./types";
import logger from "./logger";

// Define the onData callback type for real-time streaming
export type RealtimeDataCallback = (
  chunk: Uint8Array,
  offset?: number,
  isHeader?: boolean,
  container?: "mp4" | "webm",
) => void;

export interface WebCodecsEncoderInitializeOptions {
  onProgress?: (processedFrames: number, totalFrames?: number) => void;
  onDetailedProgress?: DetailedProgressCallback;
  totalFrames?: number;
  onError?: (error: WebCodecsEncoderError) => void;
  onData?: RealtimeDataCallback;
  worker?: Worker;
  workerScriptUrl?: string | URL;
  useAudioWorklet?: boolean;
}

/**
 * 設定値のバリデーション関数
 */
function validateEncoderConfig(config: EncoderConfig): void {
  // 解像度の検証
  if (config.width <= 0 || config.width > 7680) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.ValidationError,
      `Invalid width: ${config.width}. Must be between 1 and 7680 pixels.`,
    );
  }
  if (config.height <= 0 || config.height > 4320) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.ValidationError,
      `Invalid height: ${config.height}. Must be between 1 and 4320 pixels.`,
    );
  }

  // フレームレートの検証
  if (config.frameRate <= 0 || config.frameRate > 120) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.ValidationError,
      `Invalid frameRate: ${config.frameRate}. Must be between 0.1 and 120 fps.`,
    );
  }

  // ビットレートの検証
  if (config.videoBitrate < 100_000 || config.videoBitrate > 100_000_000) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.ValidationError,
      `Invalid videoBitrate: ${config.videoBitrate}. Must be between 100kbps and 100Mbps.`,
    );
  }

  // オーディオ設定の検証（オーディオが有効な場合）
  if (config.audioBitrate > 0) {
    if (config.channels <= 0 || config.channels > 8) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Invalid channels: ${config.channels}. Must be between 1 and 8.`,
      );
    }

    if (config.sampleRate < 8000 || config.sampleRate > 192000) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Invalid sampleRate: ${config.sampleRate}. Must be between 8kHz and 192kHz.`,
      );
    }

    if (config.audioBitrate < 32_000 || config.audioBitrate > 320_000) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Invalid audioBitrate: ${config.audioBitrate}. Must be between 32kbps and 320kbps.`,
      );
    }
  }

  // コーデックとコンテナの組み合わせ検証
  const container = config.container ?? "mp4";
  const videoCodec =
    config.codec?.video ?? (container === "webm" ? "vp9" : "avc");
  const audioCodec =
    config.codec?.audio ?? (container === "webm" ? "opus" : "aac");

  if (container === "webm") {
    if (!["vp8", "vp9", "av1"].includes(videoCodec)) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Video codec '${videoCodec}' is not compatible with WebM container. Use vp8, vp9, or av1.`,
      );
    }
    if (audioCodec === "aac") {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Audio codec 'aac' is not compatible with WebM container. Use opus.`,
      );
    }
  } else if (container === "mp4") {
    if (!["avc", "hevc", "av1"].includes(videoCodec)) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ValidationError,
        `Video codec '${videoCodec}' is not compatible with MP4 container. Use avc, hevc, or av1.`,
      );
    }
  }
}

export class WebCodecsEncoder {
  private config: EncoderConfig;
  private worker: Worker | null = null;
  private totalFrames: number | undefined;
  private processedFramesInternal: number = 0;
  private submittedFramesInternal: number = 0;
  private droppedFramesInternal: number = 0;
  private videoQueueSizeInternal: number = 0;
  private audioQueueSizeInternal: number = 0;
  private actualVideoCodec: string | null = null;
  private actualAudioCodec: string | null = null;

  // 状態管理
  private currentState: EncoderState = EncoderState.Idle;
  private currentStage: ProcessingStage = ProcessingStage.Initializing;

  // 詳細プログレス追跡
  private processingStartTime: number = 0;
  private lastProgressTime: number = 0;
  private lastProcessedFrames: number = 0;
  private processedDataSize: number = 0;
  private processingFpsHistory: number[] = [];
  private readonly maxFpsHistoryLength = 10;

  // Callbacks for asynchronous operations
  private onInitialized: ((value: void | PromiseLike<void>) => void) | null =
    null;
  private onInitializeError: ((reason?: any) => void) | null = null;
  private onFinalizedPromise: {
    resolve: (data: Uint8Array | null) => void;
    reject: (reason?: any) => void;
  } | null = null;
  private onProgressCallback:
    | ((processedFrames: number, totalFrames?: number) => void)
    | null = null;
  private onDetailedProgressCallback: DetailedProgressCallback | null = null;
  private onErrorCallback: ((error: WebCodecsEncoderError) => void) | null =
    null;
  private onDataCallback: RealtimeDataCallback | null = null; // For real-time data

  private isCancelled: boolean = false;
  private nextVideoTimestamp: number = 0;
  private nextAudioTimestamp: number = 0;
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private cancelTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // メソッドチェーン用の設定保持
  private configuredWorker?: Worker;
  private configuredWorkerScriptUrl?: string | URL;
  private configuredUseAudioWorklet?: boolean;

  constructor(config?: EncoderConfig) {
    if (config) {
      // 従来の使用方法: new WebCodecsEncoder(config)
      validateEncoderConfig(config);

      this.config = {
        // Default values first
        container: "mp4",
        latencyMode: "quality",
        dropFrames: false,
        maxQueueDepth: Infinity,
        ...config, // User-provided config overrides defaults
        codec: {
          // Ensure codec object exists and has defaults
          video: config.codec?.video ?? "avc", // Use 'avc' as per type
          audio: config.codec?.audio ?? "aac", // Use 'avc' as per type
        },
      };
    } else {
      // メソッドチェーン用: new WebCodecsEncoder().configure()
      // 初期化は後で行う
      this.config = {} as EncoderConfig;
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

  /**
   * メソッドチェーン用のファクトリーメソッド
   */
  public static create(): WebCodecsEncoder {
    return new WebCodecsEncoder();
  }

  /**
   * 現在の状態を取得
   */
  public getState(): EncoderState {
    return this.currentState;
  }

  /**
   * 現在の処理ステージを取得
   */
  public getCurrentStage(): ProcessingStage {
    return this.currentStage;
  }

  /**
   * 指定された状態でのAPI呼び出しが許可されているかチェック
   */
  private checkStateForOperation(
    operation: string,
    allowedStates: EncoderState[],
  ): void {
    if (!allowedStates.includes(this.currentState)) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.InternalError,
        `Cannot ${operation} in state '${this.currentState}'. Allowed states: ${allowedStates.join(", ")}`,
      );
    }
  }

  /**
   * 状態を変更
   */
  private setState(newState: EncoderState): void {
    logger.log(
      `WebCodecsEncoder: State transition: ${this.currentState} -> ${newState}`,
    );
    this.currentState = newState;
  }

  /**
   * 処理ステージを変更
   */
  private setStage(newStage: ProcessingStage): void {
    logger.log(
      `WebCodecsEncoder: Stage transition: ${this.currentStage} -> ${newStage}`,
    );
    this.currentStage = newStage;
  }

  // === メソッドチェーン用API ===

  /**
   * エンコーダーの設定を行う（メソッドチェーン用）
   */
  public configure(config: EncoderConfig): this {
    this.checkStateForOperation("configure", [EncoderState.Idle]);

    // 設定値のバリデーション
    validateEncoderConfig(config);

    this.config = {
      // Default values first
      container: "mp4",
      latencyMode: "quality",
      dropFrames: false,
      maxQueueDepth: Infinity,
      ...config, // User-provided config overrides defaults
      codec: {
        // Ensure codec object exists and has defaults
        video: config.codec?.video ?? "avc", // Use 'avc' as per type
        audio: config.codec?.audio ?? "aac", // Use 'aac' as per type
      },
    };

    return this;
  }

  /**
   * プログレスコールバックを設定（メソッドチェーン用）
   */
  public onProgress(
    callback: (processedFrames: number, totalFrames?: number) => void,
  ): this {
    this.onProgressCallback = callback;
    return this;
  }

  /**
   * 詳細プログレスコールバックを設定（メソッドチェーン用）
   */
  public onDetailedProgress(callback: DetailedProgressCallback): this {
    this.onDetailedProgressCallback = callback;
    return this;
  }

  /**
   * エラーコールバックを設定（メソッドチェーン用）
   */
  public onError(callback: (error: WebCodecsEncoderError) => void): this {
    this.onErrorCallback = callback;
    return this;
  }

  /**
   * リアルタイムデータコールバックを設定（メソッドチェーン用）
   */
  public onData(callback: RealtimeDataCallback): this {
    this.onDataCallback = callback;
    return this;
  }

  /**
   * 総フレーム数を設定（メソッドチェーン用）
   */
  public withTotalFrames(totalFrames: number): this {
    this.totalFrames = totalFrames;
    return this;
  }

  /**
   * ワーカーを設定（メソッドチェーン用）
   */
  public withWorker(worker: Worker): this {
    this.configuredWorker = worker;
    return this;
  }

  /**
   * ワーカースクリプトURLを設定（メソッドチェーン用）
   */
  public withWorkerScript(url: string | URL): this {
    this.configuredWorkerScriptUrl = url;
    return this;
  }

  /**
   * AudioWorkletの使用を設定（メソッドチェーン用）
   */
  public withAudioWorklet(useAudioWorklet: boolean = true): this {
    this.configuredUseAudioWorklet = useAudioWorklet;
    return this;
  }

  /**
   * エンコーダーを開始（メソッドチェーン用のinitialize）
   */
  public async start(): Promise<this> {
    if (Object.keys(this.config).length === 0) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.ConfigurationError,
        "Configuration not set. Call configure() before start().",
      );
    }

    const options: WebCodecsEncoderInitializeOptions = {
      onProgress: this.onProgressCallback || undefined,
      onDetailedProgress: this.onDetailedProgressCallback || undefined,
      totalFrames: this.totalFrames,
      onError: this.onErrorCallback || undefined,
      onData: this.onDataCallback || undefined,
      worker: this.configuredWorker,
      workerScriptUrl: this.configuredWorkerScriptUrl,
      useAudioWorklet: this.configuredUseAudioWorklet,
    };

    await this.initialize(options);
    return this;
  }

  /**
   * エンコーダーを終了（メソッドチェーン用のfinalize）
   */
  public async finish(): Promise<Uint8Array | null> {
    return this.finalize();
  }

  /**
   * 詳細プログレス情報を計算
   */
  private calculateDetailedProgress(): DetailedProgressInfo {
    const currentTime = Date.now();
    const elapsedTimeMs = currentTime - this.processingStartTime;

    // 現在の処理速度を計算
    let processingFps = 0;
    if (this.lastProgressTime > 0) {
      const timeDiff = currentTime - this.lastProgressTime;
      const framesDiff =
        this.processedFramesInternal - this.lastProcessedFrames;
      if (timeDiff > 0) {
        processingFps = (framesDiff / timeDiff) * 1000;
      }
    }

    // FPS履歴を更新
    if (processingFps > 0) {
      this.processingFpsHistory.push(processingFps);
      if (this.processingFpsHistory.length > this.maxFpsHistoryLength) {
        this.processingFpsHistory.shift();
      }
    }

    // 平均処理速度を計算
    const averageProcessingFps =
      this.processingFpsHistory.length > 0
        ? this.processingFpsHistory.reduce((a, b) => a + b, 0) /
          this.processingFpsHistory.length
        : 0;

    // 推定残り時間を計算
    let estimatedRemainingMs: number | undefined;
    if (this.totalFrames && averageProcessingFps > 0) {
      const remainingFrames = this.totalFrames - this.processedFramesInternal;
      estimatedRemainingMs = (remainingFrames / averageProcessingFps) * 1000;
    }

    // 進捗情報を更新
    this.lastProgressTime = currentTime;
    this.lastProcessedFrames = this.processedFramesInternal;

    return {
      processedFrames: this.processedFramesInternal,
      totalFrames: this.totalFrames,
      stage: this.currentStage,
      elapsedTimeMs,
      estimatedRemainingMs,
      processingFps,
      averageProcessingFps,
      droppedFrames: this.droppedFramesInternal,
      videoQueueSize: this.videoQueueSizeInternal,
      audioQueueSize: this.audioQueueSizeInternal,
      processedDataSize: this.processedDataSize,
    };
  }

  public async initialize(
    options?: WebCodecsEncoderInitializeOptions,
  ): Promise<void> {
    this.checkStateForOperation("initialize", [
      EncoderState.Idle,
      EncoderState.Error,
    ]);
    this.setState(EncoderState.Initializing);
    this.setStage(ProcessingStage.Initializing);

    this.onErrorCallback = options?.onError || null;
    this.onProgressCallback = options?.onProgress || null;
    this.onDetailedProgressCallback = options?.onDetailedProgress || null;
    this.onDataCallback = options?.onData || null; // Store onData callback
    this.totalFrames = options?.totalFrames;

    // 処理開始時間を記録
    this.processingStartTime = Date.now();

    if (this.config.latencyMode === "realtime" && !this.onDataCallback) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.ConfigurationError,
        "onData callback must be provided when latencyMode is 'realtime'.",
      );
      // No need to call this.handleError as it will be caught by the promise reject or caller
      // and this.onErrorCallback will be called by the caller if they wish.
      // this.handleError(err);
      throw err; // Throw immediately
    }

    if (!WebCodecsEncoder.isSupported()) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.NotSupported,
        "Required browser APIs (WebCodecs, Worker, etc.) are not supported.",
      );
      this.handleError(err);
      throw err;
    }

    if (this.worker) {
      logger.warn(
        "WebCodecsEncoder already initialized or in progress. Call cancel() before re-initializing.",
      );
      // Allow re-initialization if already cancelled and cleaned up.
      if (!this.isCancelled) {
        return Promise.resolve(); // Or throw an error indicating it's busy
      }
    }
    this.isCancelled = false;
    this.processedFramesInternal = 0;
    this.submittedFramesInternal = 0;
    this.droppedFramesInternal = 0;
    this.videoQueueSizeInternal = 0;
    this.audioQueueSizeInternal = 0;
    this.nextVideoTimestamp = 0;
    this.nextAudioTimestamp = 0;

    return new Promise<void>((resolve, reject) => {
      this.onInitialized = resolve;
      this.onInitializeError = reject;
      const start = async () => {
        try {
          if (options?.worker) {
            this.worker = options.worker;
          } else if (
            typeof process !== "undefined" &&
            process.env?.NODE_ENV === "test"
          ) {
            // In test environment, use a dummy worker that won't try to load actual files
            this.worker = new Worker("data:application/javascript,", {
              type: "module",
            });
          } else {
            const script: string | URL =
              await WebCodecsEncoder.findWorkerScript(options?.workerScriptUrl);

            this.worker = new Worker(script, { type: "module" });
          }

          this.worker.onmessage = (event: MessageEvent<MainThreadMessage>) => {
            this.handleWorkerMessage(event.data);
          };

          this.worker.onerror = (event: ErrorEvent) => {
            logger.error("MainThread: worker.onerror triggered. Event:", event);
            logger.error(
              "MainThread: worker.onerror event.message:",
              event.message,
            );
            logger.error(
              "MainThread: worker.onerror event.filename:",
              event.filename,
            );
            logger.error(
              "MainThread: worker.onerror event.lineno:",
              event.lineno,
            );
            logger.error(
              "MainThread: worker.onerror event.colno:",
              event.colno,
            );
            logger.error(
              "MainThread: worker.onerror event.error:",
              event.error,
            );

            const err = new WebCodecsEncoderError(
              EncoderErrorType.WorkerError,
              `Worker error: ${event.message || "Unknown worker error"}`,
              event,
            );
            this.handleError(err);
            this.onInitializeError?.(err);
            this.onFinalizedPromise?.reject(err);
            this.cleanupWorkerOnError();
          };

          if (options?.useAudioWorklet) {
            await this.setupAudioWorklet();
          }

          const initMessage: WorkerMessage = {
            type: "initialize",
            config: this.config, // Pass updated config
            totalFrames: this.totalFrames,
          };
          this.worker.postMessage(initMessage);
        } catch (e: any) {
          const err = new WebCodecsEncoderError(
            EncoderErrorType.InitializationFailed,
            `Failed to initialize worker: ${e.message}`,
            e,
          );
          this.handleError(err);
          this.onInitializeError?.(err);
          this.cleanupWorkerOnError();
        }
      };
      void start();
    });
  }

  private static async findWorkerScript(
    customUrl?: string | URL,
  ): Promise<string | URL> {
    if (customUrl) {
      return customUrl;
    }

    // Detect development environment
    const isDev = WebCodecsEncoder.isDevEnvironment();

    // Try common public paths with multiple strategies
    const publicPaths = [
      "/webcodecs-worker.js", // postinstall file (priority)
      "/worker.js", // common name
    ];

    for (const path of publicPaths) {
      // Try both HEAD and GET requests for better compatibility
      const methods = isDev ? ["GET", "HEAD"] : ["HEAD"];

      for (const method of methods) {
        try {
          const response = await fetch(path, {
            method,
            // In dev, try with mode: 'no-cors' as fallback
            ...(isDev && method === "GET" ? { mode: "no-cors" } : {}),
          });

          if (response.ok || (isDev && response.type === "opaque")) {
            logger.log(
              `WebCodecsEncoder: Found worker at public path: ${path} (method: ${method})`,
            );
            return path;
          }
        } catch (e) {
          // Continue to next method/path
        }
      }
    }

    // For Vite development, try a direct file check approach
    if (isDev) {
      const devPaths = [
        "/webcodecs-worker.js",
        "/public/webcodecs-worker.js", // Sometimes Vite exposes public files this way
      ];

      for (const path of devPaths) {
        try {
          // Create a temporary worker to test if the script loads
          const testWorker = new Worker(path, { type: "module" });
          testWorker.terminate();
          logger.log(
            `WebCodecsEncoder: Found worker in dev environment: ${path}`,
          );
          return path;
        } catch (e) {
          // Continue to next path
        }
      }
    }

    // Try to use package worker file
    try {
      const packageWorkerUrl = new URL("./worker.js", import.meta.url);
      // Test if it's accessible
      const response = await fetch(packageWorkerUrl, { method: "HEAD" });
      if (response.ok) {
        logger.log("WebCodecsEncoder: Using package worker file");
        return packageWorkerUrl;
      }
    } catch (e) {
      // Package worker not accessible, fall back to inline worker
    }

    // Create inline worker as fallback
    logger.log(
      "WebCodecsEncoder: Creating inline worker (package worker not accessible)",
    );
    return WebCodecsEncoder.createInlineWorker();
  }

  private static isDevEnvironment(): boolean {
    // Multiple checks for development environment
    return (
      // Node.js development
      (typeof process !== "undefined" &&
        process.env?.NODE_ENV === "development") ||
      // Vite development (with type safety)
      (typeof import.meta !== "undefined" &&
        (import.meta as any).env?.DEV === true) ||
      // Development server indicators
      (typeof location !== "undefined" &&
        (location.hostname === "localhost" ||
          location.hostname === "127.0.0.1" ||
          location.hostname.startsWith("192.168.") ||
          location.port === "3000" ||
          location.port === "5173" || // Vite default
          location.port === "4173")) // Vite preview
    );
  }

  private static createInlineWorker(): string {
    // Helper text for setup instructions
    const setupInstructions = `
WebCodecs Encoder Worker Setup Required:

The worker file could not be loaded automatically. This is common in Vite/PWA projects.

Quick Setup:
1. Copy worker file to public directory:
   cp node_modules/webcodecs-encoder/dist/worker.js public/

2. Initialize with custom worker URL:
   const encoder = new WebCodecsEncoder(config);
   await encoder.initialize({
     workerScriptUrl: '/worker.js'
   });

For more setup options: https://github.com/romot-co/webcodecs-encoder#setup-for-vitepwa-projects
`;

    // Simple error-only inline worker
    const inlineWorkerCode = `
// WebCodecs Encoder - Setup Required
self.postMessage({
  type: 'error',
  errorDetail: {
    type: 'WorkerError',
    message: ${JSON.stringify(setupInstructions)},
    stack: null
  }
});
`;

    const blob = new Blob([inlineWorkerCode], {
      type: "application/javascript",
    });
    return URL.createObjectURL(blob);
  }

  private async findAudioWorkletScript(): Promise<string> {
    const isDev = WebCodecsEncoder.isDevEnvironment();

    // Try common public paths with enhanced detection
    const publicPaths = [
      "/webcodecs-audio-worklet.js", // postinstall file (priority)
      "/audio-worklet-processor.js", // alternative name
    ];

    for (const path of publicPaths) {
      // Try both HEAD and GET requests for better compatibility
      const methods = isDev ? ["GET", "HEAD"] : ["HEAD"];

      for (const method of methods) {
        try {
          const response = await fetch(path, {
            method,
            ...(isDev && method === "GET" ? { mode: "no-cors" } : {}),
          });

          if (response.ok || (isDev && response.type === "opaque")) {
            logger.log(
              `WebCodecsEncoder: Found AudioWorklet processor at: ${path} (method: ${method})`,
            );
            return path;
          }
        } catch (e) {
          // Continue to next method/path
        }
      }
    }

    // Try to use package AudioWorklet file as fallback
    try {
      const packageUrl = new URL(
        "./audio-worklet-processor.js",
        import.meta.url,
      );
      return packageUrl.href;
    } catch (e) {
      // If all else fails, use a fallback path
      logger.warn(
        "WebCodecsEncoder: AudioWorklet processor not found, using fallback",
      );
      return "/webcodecs-audio-worklet.js";
    }
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
        this.setState(EncoderState.Encoding);
        this.setStage(ProcessingStage.VideoEncoding);
        this.actualVideoCodec = message.actualVideoCodec ?? null;
        this.actualAudioCodec = message.actualAudioCodec ?? null;
        this.onInitialized?.();
        this.onInitialized = null;
        this.onInitializeError = null;
        break;
      case "progress":
        this.processedFramesInternal =
          message.processedFrames + this.droppedFramesInternal;
        this.onProgressCallback?.(
          this.processedFramesInternal,
          message.totalFrames,
        );

        // 詳細プログレス情報も送信
        if (this.onDetailedProgressCallback) {
          const detailedProgress = this.calculateDetailedProgress();
          this.onDetailedProgressCallback(detailedProgress);
        }
        break;
      case "detailedProgress":
        // ワーカーから直接詳細プログレス情報を受信した場合
        if (this.onDetailedProgressCallback) {
          this.onDetailedProgressCallback(message.progress);
        }
        break;
      case "queueSize":
        this.videoQueueSizeInternal = message.videoQueueSize;
        this.audioQueueSizeInternal = message.audioQueueSize;
        break;
      case "dataChunk": // Handle real-time data chunks
        if (this.config.latencyMode === "realtime" && this.onDataCallback) {
          const { chunk, isHeader, container } = message;
          this.processedDataSize += chunk.byteLength;
          this.onDataCallback(chunk, undefined, isHeader, container);
        } else if (
          this.onDataCallback &&
          this.config.latencyMode !== "realtime"
        ) {
          // console.warn('WebCodecsEncoder: Received dataChunk, but not in real-time mode or no onData callback was provided.');
          // Do not call onDataCallback if not in real-time mode
        } else if (
          !this.onDataCallback &&
          this.config.latencyMode === "realtime"
        ) {
          logger.warn(
            "WebCodecsEncoder: Received dataChunk in real-time mode, but no onData callback was provided.",
          );
        }
        break;
      case "finalized":
        this.clearCancelTimeout();
        this.setState(EncoderState.Disposed);
        if (this.config.latencyMode === "realtime") {
          // Realtime mode: finalize() resolves with null if worker sends null,
          // or with an empty Uint8Array if worker sends empty (e.g. for header-only)
          // The actual data chunks are sent via onData callback.
          this.onFinalizedPromise?.resolve(
            message.output === null ? null : new Uint8Array(0),
          );
        } else {
          // Non-realtime mode
          if (message.output !== null) {
            this.processedDataSize = message.output.byteLength;
            this.onFinalizedPromise?.resolve(message.output);
          } else {
            // This case should ideally not happen: null output in non-realtime mode.
            const err = new WebCodecsEncoderError(
              EncoderErrorType.MuxingFailed,
              "Finalized with null output in non-realtime mode.",
            );
            if (this.onFinalizedPromise) {
              this.onFinalizedPromise.reject(err);
            } else {
              this.onInitializeError?.(err);
            }
            this.handleError(err); // Ensure onErrorCallback is called
          }
        }
        this.onFinalizedPromise = null;
        this.cleanupWorker();
        break;
      case "error":
        this.clearCancelTimeout();
        this.setState(EncoderState.Error);
        const err = new WebCodecsEncoderError(
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
        this.clearCancelTimeout();
        this.setState(EncoderState.Disposed);
        logger.log("WebCodecsEncoder: Cancelled by worker.");
        const cancelErrWorker = new WebCodecsEncoderError(
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
        logger.warn(
          "WebCodecsEncoder: Unknown message from worker:",
          _exhaustiveCheck,
        );
    }
  }

  private handleError(error: WebCodecsEncoderError): void {
    console.error(
      `WebCodecsEncoder Error (${error.type}):`,
      error.message,
      error.cause || "",
    );
    this.onErrorCallback?.(error);
  }

  public async addVideoFrame(
    frameSource: VideoFrame,
    timestampOverride?: number,
  ): Promise<void> {
    this.checkStateForOperation("add video frame", [EncoderState.Encoding]);

    if (!this.worker || this.isCancelled) {
      const err = new WebCodecsEncoderError(
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
      const queueDepth = this.videoQueueSizeInternal;
      const maxDepth = this.config.maxQueueDepth ?? Infinity;
      if (this.config.dropFrames && queueDepth >= maxDepth) {
        frameSource.close();
        this.nextVideoTimestamp += 1_000_000 / this.config.frameRate;
        this.submittedFramesInternal++;
        this.droppedFramesInternal++;
        this.processedFramesInternal++;
        this.onProgressCallback?.(
          this.processedFramesInternal,
          this.totalFrames,
        );
        return;
      }

      const timestamp = timestampOverride ?? this.nextVideoTimestamp;
      this.nextVideoTimestamp = timestamp + 1_000_000 / this.config.frameRate;

      this.submittedFramesInternal++;

      const message: WorkerMessage = {
        type: "addVideoFrame",
        frame: frameSource, // Send VideoFrame directly
        timestamp: timestamp,
      };
      this.worker.postMessage(message, [frameSource]);
      // frameSource is not closed here, it will be closed in the worker.
    } catch (e: any) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.VideoEncodingError,
        `Failed to post video frame: ${e.message}`,
        e,
      );
      this.handleError(err);
      throw err;
    }
  }

  public async addCanvasFrame(
    canvas: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<void> {
    const queueDepth = this.videoQueueSizeInternal;
    const maxDepth = this.config.maxQueueDepth ?? Infinity;
    if (this.config.dropFrames && queueDepth >= maxDepth) {
      this.nextVideoTimestamp += 1_000_000 / this.config.frameRate;
      this.submittedFramesInternal++;
      this.droppedFramesInternal++;
      this.processedFramesInternal++;
      this.onProgressCallback?.(this.processedFramesInternal, this.totalFrames);
      return;
    }

    const timestamp = this.nextVideoTimestamp;
    const frame = new VideoFrame(canvas, {
      timestamp,
      duration: 1_000_000 / this.config.frameRate,
    });
    try {
      await this.addVideoFrame(frame);
    } catch (err) {
      frame.close();
      throw err;
    }
  }

  public async addAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    this.checkStateForOperation("add audio buffer", [EncoderState.Encoding]);

    if (!this.worker || this.isCancelled) {
      const err = new WebCodecsEncoderError(
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
      logger.warn(
        "Audio encoding is disabled (audioBitrate, channels or sampleRate is zero/negative). Skipping addAudioBuffer.",
      );
      return Promise.resolve();
    }

    try {
      if (audioBuffer.numberOfChannels !== this.config.channels) {
        const err = new WebCodecsEncoderError(
          EncoderErrorType.ConfigurationError,
          `AudioBuffer channel count (${audioBuffer.numberOfChannels}) does not match configured channels (${this.config.channels}).`,
        );
        this.handleError(err);
        return Promise.reject(err);
      }

      const numChannels = audioBuffer.numberOfChannels;
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
        format: "f32-planar", // AudioBuffer.getChannelData は Float32Array を返すので planar f32
        sampleRate: audioBuffer.sampleRate,
        numberOfFrames: audioBuffer.length, // audioBuffer.length はフレーム数を返す
        numberOfChannels: numChannels, // 使用するチャンネル数
      };
      this.worker.postMessage(message, transferableBuffers);
    } catch (e: any) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.AudioEncodingError,
        `Failed to add audio buffer: ${e.message}`,
        e,
      );
      this.handleError(err);
      throw err;
    }
  }

  public async addAudioData(audioData: AudioData): Promise<void> {
    this.checkStateForOperation("add audio data", [EncoderState.Encoding]);

    if (!this.worker || this.isCancelled) {
      const err = new WebCodecsEncoderError(
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
      logger.warn(
        "Audio encoding is disabled (audioBitrate, channels or sampleRate is zero/negative). Skipping addAudioData.",
      );
      return Promise.resolve();
    }

    try {
      if (audioData.numberOfChannels !== this.config.channels) {
        const err = new WebCodecsEncoderError(
          EncoderErrorType.ConfigurationError,
          `AudioData channel count (${audioData.numberOfChannels}) does not match configured channels (${this.config.channels}).`,
        );
        this.handleError(err);
        return Promise.reject(err);
      }

      const numChannels = audioData.numberOfChannels;
      const planarData: Float32Array[] = [];
      const transferableBuffers: ArrayBuffer[] = [];

      for (let i = 0; i < numChannels; i++) {
        const plane = new Float32Array(audioData.numberOfFrames);
        await audioData.copyTo(plane, { planeIndex: i });
        planarData.push(plane);
        transferableBuffers.push(plane.buffer);
      }

      const timestamp = audioData.timestamp ?? this.nextAudioTimestamp;
      if (audioData.timestamp == null) {
        this.nextAudioTimestamp +=
          (audioData.numberOfFrames / this.config.sampleRate) * 1_000_000;
      }

      const message: WorkerMessage = {
        type: "addAudioData",
        audioData: planarData,
        timestamp,
        format: "f32-planar",
        sampleRate: audioData.sampleRate,
        numberOfFrames: audioData.numberOfFrames,
        numberOfChannels: numChannels,
      };

      this.worker.postMessage(message, transferableBuffers);
    } catch (e: any) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.AudioEncodingError,
        `Failed to add audio data: ${e.message}`,
        e,
      );
      this.handleError(err);
      throw err;
    }
  }

  public finalize(): Promise<Uint8Array | null> {
    this.checkStateForOperation("finalize", [EncoderState.Encoding]);
    this.setState(EncoderState.Finalizing);
    this.setStage(ProcessingStage.Finalizing);

    if (this.isCancelled) {
      // isCancelled を先にチェック
      const err = new WebCodecsEncoderError(
        EncoderErrorType.Cancelled,
        "Encoder cancelled",
      );
      this.handleError(err);
      return Promise.reject(err);
    }
    if (!this.worker) {
      // worker がない場合 (初期化前など)
      const err = new WebCodecsEncoderError(
        EncoderErrorType.InternalError,
        "Encoder not initialized or already finalized",
      );
      this.handleError(err);
      return Promise.reject(err);
    }
    if (this.onFinalizedPromise) {
      logger.warn("Finalize already called.");
      const err = new WebCodecsEncoderError(
        EncoderErrorType.InternalError,
        "Finalize called multiple times.",
      );
      this.handleError(err); // handleErrorを呼ぶ
      return Promise.reject(err);
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.onFinalizedPromise = { resolve, reject };
      const message: WorkerMessage = { type: "finalize" };
      this.worker!.postMessage(message); // worker is checked above
    });
  }

  public cancel(): void {
    if (this.isCancelled || !this.worker) {
      logger.log("WebCodecsEncoder: Already cancelled or not initialized.");
      return;
    }
    this.isCancelled = true;
    logger.log("WebCodecsEncoder: Sending cancel signal to worker.");

    const message: WorkerMessage = { type: "cancel" };
    this.worker.postMessage(message);

    // Ignore any further messages except the worker's acknowledgement
    this.worker.onmessage = (event: MessageEvent<MainThreadMessage>) => {
      if (event.data.type === "cancelled" || event.data.type === "error") {
        this.handleWorkerMessage(event.data);
      }
    };

    // Reject pending promises
    const cancelError = new WebCodecsEncoderError(
      EncoderErrorType.Cancelled,
      "Operation cancelled by user.",
    );
    this.handleError(cancelError);
    this.onInitializeError?.(cancelError);
    this.onFinalizedPromise?.reject(cancelError);

    this.onInitializeError = null;
    this.onInitialized = null;
    this.onFinalizedPromise = null;

    // Worker should send a 'cancelled' message. If it doesn't arrive within
    // a reasonable time, force cleanup.
    this.clearCancelTimeout();
    this.cancelTimeoutId = setTimeout(() => {
      logger.warn(
        "WebCodecsEncoder: No 'cancelled' message received, terminating worker.",
      );
      this.cleanupWorker();
    }, 5000);
  }

  private clearCancelTimeout(): void {
    if (this.cancelTimeoutId !== null) {
      clearTimeout(this.cancelTimeoutId);
      this.cancelTimeoutId = null;
    }
  }

  private cleanupWorker(): void {
    this.clearCancelTimeout();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      logger.log("WebCodecsEncoder: Worker terminated and cleaned up.");
    }
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ close: true });
      this.audioWorkletNode.disconnect();
      this.audioWorkletNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.videoQueueSizeInternal = 0;
    this.audioQueueSizeInternal = 0;
    this.isCancelled = true; // Ensure isCancelled is true after cleanup

    // 状態をDisposedに設定（エラー状態でない場合のみ）
    if (this.currentState !== EncoderState.Error) {
      this.setState(EncoderState.Disposed);
    }
  }

  // Specific cleanup for errors to avoid double-terminating if worker itself errored.
  private cleanupWorkerOnError(): void {
    // Reuse the normal cleanup logic to ensure all resources are released.
    // This will terminate the worker if it is still running and close any
    // audio-related resources.
    this.cleanupWorker();
  }

  private async setupAudioWorklet(): Promise<void> {
    const AudioContextCtor = (
      globalThis as unknown as { AudioContext?: typeof AudioContext }
    ).AudioContext;
    if (!AudioContextCtor) {
      const err = new WebCodecsEncoderError(
        EncoderErrorType.NotSupported,
        "AudioContext not available for AudioWorklet.",
      );
      this.handleError(err);
      throw err;
    }

    this.audioContext = new AudioContextCtor({
      sampleRate: this.config.sampleRate,
    });

    // AudioWorkletプロセッサファイルを見つける
    const audioWorkletUrl = await this.findAudioWorkletScript();

    await this.audioContext!.audioWorklet.addModule(audioWorkletUrl);
    this.audioWorkletNode = new AudioWorkletNode(
      this.audioContext!,
      "encoder-audio-worklet",
      { numberOfInputs: 1, numberOfOutputs: 0 },
    );

    const { port1, port2 } = new MessageChannel();
    const connectMessage: ConnectAudioPortMessage = {
      type: "connectAudioPort",
      port: port1,
    };
    this.worker!.postMessage(connectMessage, [port1]);
    this.audioWorkletNode.port.postMessage(
      { port: port2, sampleRate: this.config.sampleRate },
      [port2],
    );
  }

  public getActualVideoCodec(): string | null {
    return this.actualVideoCodec;
  }

  public getActualAudioCodec(): string | null {
    return this.actualAudioCodec;
  }

  public getVideoQueueSize(): number {
    return this.videoQueueSizeInternal;
  }

  public getAudioQueueSize(): number {
    return this.audioQueueSizeInternal;
  }

  public getAudioWorkletNode(): AudioWorkletNode | null {
    return this.audioWorkletNode;
  }
}
