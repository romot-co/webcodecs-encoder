import { Mp4MuxerWrapper } from "./mp4muxer";
import { WebMMuxerWrapper } from "./webmmuxer";
import type {
  EncoderConfig,
  WorkerMessage,
  InitializeWorkerMessage,
  AddVideoFrameMessage,
  AddAudioDataMessage,
  FinalizeWorkerMessage,
  CancelWorkerMessage,
  MainThreadMessage,
  VideoEncoderGetter,
  AudioEncoderGetter,
  AudioDataGetter,
} from "./types";
import { EncoderErrorType } from "./types";
import logger from "./logger";

// グローバルなエラーハンドラ (主に同期的なエラーや、Promise外の非同期エラー用)
if (
  typeof self !== "undefined" &&
  typeof self.addEventListener === "function"
) {
  self.addEventListener("error", (event: ErrorEvent) => {
    console.error("Unhandled global error in worker. Event:", event);
    // エラーオブジェクトから詳細情報を取得
    const errorDetails = {
      message: event.message || "Unknown global error",
      name: event.error?.name || "Error",
      stack: event.error?.stack || undefined,
      filename: event.filename || undefined,
      lineno: event.lineno || undefined,
      colno: event.colno || undefined,
    };
    self.postMessage({
      type: "worker-error",
      error: {
        message: `Unhandled global error: ${errorDetails.message} (at ${errorDetails.filename}:${errorDetails.lineno}:${errorDetails.colno})`,
        name: errorDetails.name,
        stack: errorDetails.stack,
        // cause: event.error?.cause // event.errorがErrorインスタンスであればcauseも取得可能
      },
    });
  });
}

// Promiseの unhandledrejection イベントハンドラ
if (
  typeof self !== "undefined" &&
  typeof self.addEventListener === "function"
) {
  self.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      console.error(
        "Unhandled promise rejection in worker. Reason:",
        event.reason,
      );
      const reason = event.reason;
      let errorDetails;
      if (reason instanceof Error) {
        errorDetails = {
          message: reason.message,
          name: reason.name,
          stack: reason.stack,
          // cause: reason.cause,
        };
      } else {
        errorDetails = {
          message: String(reason),
          name: "UnhandledRejection",
          stack: undefined,
        };
      }
      self.postMessage({
        type: "worker-error",
        error: {
          message: `Unhandled promise rejection: ${errorDetails.message}`,
          name: errorDetails.name,
          stack: errorDetails.stack,
          // cause: errorDetails.cause,
        },
      });
    },
  );
}

const getVideoEncoder: VideoEncoderGetter = () =>
  (self as unknown as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder ??
  (globalThis as unknown as { VideoEncoder?: typeof VideoEncoder })
    .VideoEncoder;
const getAudioEncoder: AudioEncoderGetter = () =>
  (self as unknown as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder ??
  (globalThis as unknown as { AudioEncoder?: typeof AudioEncoder })
    .AudioEncoder;
const getAudioData: AudioDataGetter = () =>
  (self as unknown as { AudioData?: typeof AudioData }).AudioData ??
  (globalThis as unknown as { AudioData?: typeof AudioData }).AudioData;

class EncoderWorker {
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private muxer: Mp4MuxerWrapper | WebMMuxerWrapper | null = null;
  private currentConfig: EncoderConfig | null = null;
  private totalFramesToProcess: number | undefined;
  private processedFrames: number = 0;
  private videoFrameCount: number = 0;
  private isCancelled: boolean = false;
  private audioWorkletPort: MessagePort | null = null;

  constructor() {
    // コンストラクタで依存性を注入することも可能
  }

  private postMessageToMainThread(
    message: MainThreadMessage,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      self.postMessage(message, transfer);
    } else {
      self.postMessage(message);
    }
  }

  private defaultAvcCodecString(
    width: number,
    height: number,
    frameRate: number,
    profile?: "high" | "main" | "baseline",
  ): string {
    const mbPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * frameRate;
    let level: number;
    if (mbPerSec <= 108000) level = 31;
    else if (mbPerSec <= 216000) level = 32;
    else if (mbPerSec <= 245760) level = 40;
    else if (mbPerSec <= 589824) level = 50;
    else if (mbPerSec <= 983040) level = 51;
    else level = 52;
    const chosenProfile: ("high" | "main" | "baseline") | undefined =
      profile ?? (width >= 1280 || height >= 720 ? "high" : "baseline");
    const profileHex =
      chosenProfile === "high" ? "64" : chosenProfile === "main" ? "4d" : "42";
    const levelHex = level.toString(16).padStart(2, "0");
    return `avc1.${profileHex}00${levelHex}`;
  }

  private avcProfileFromCodecString(
    codec: string,
  ): ("high" | "main" | "baseline") | null {
    if (codec.startsWith("avc1.64")) return "high";
    if (codec.startsWith("avc1.4d")) return "main";
    if (codec.startsWith("avc1.42")) return "baseline";
    return null;
  }

  private async isConfigSupportedWithHwFallback<
    T extends (VideoEncoderConfig | AudioEncoderConfig) & {
      hardwareAcceleration?:
        | "prefer-hardware"
        | "prefer-software"
        | "no-preference";
    },
  >(
    Ctor: {
      isConfigSupported(
        config: T,
      ): Promise<{ supported?: boolean; config?: T }>;
    },
    config: T,
    label: string,
  ): Promise<T | null> {
    // オリジナルの設定で試行
    let support = await Ctor.isConfigSupported(config);
    if (support?.supported && support.config) return support.config;

    // ハードウェアアクセラレーション設定がある場合のフォールバック処理
    const pref = config.hardwareAcceleration;
    if (pref) {
      // 反対の設定を試す（prefer-hardware → prefer-software、または逆）
      let altPref: string | undefined;
      if (pref === "prefer-hardware") altPref = "prefer-software";
      else if (pref === "prefer-software") altPref = "prefer-hardware";

      if (altPref) {
        const opposite = { ...config, hardwareAcceleration: altPref };
        support = await Ctor.isConfigSupported(opposite);
        if (support?.supported && support.config) {
          console.warn(
            `${label}: hardwareAcceleration preference '${pref}' not supported. Using '${altPref}'.`,
          );
          return support.config;
        }
      }

      // 設定なしを試す
      const noPref = { ...config } as T & { hardwareAcceleration?: undefined };
      delete noPref.hardwareAcceleration;
      support = await Ctor.isConfigSupported(noPref);
      if (support?.supported && support.config) {
        console.warn(
          `${label}: hardwareAcceleration preference '${pref}' not supported. Using no preference.`,
        );
        return support.config;
      }

      // すべてのオプションが失敗した場合
      console.warn(
        `${label}: Failed to find a supported hardware acceleration configuration for codec ${config.codec}.`,
      );
    }
    return null;
  }

  private postQueueSize(): void {
    this.postMessageToMainThread({
      type: "queueSize",
      videoQueueSize: this.videoEncoder?.encodeQueueSize ?? 0,
      audioQueueSize: this.audioEncoder?.encodeQueueSize ?? 0,
    } as MainThreadMessage);
  }

  async initializeEncoders(data: InitializeWorkerMessage): Promise<void> {
    // throw new Error("Intentional test error from worker initializeEncoders"); // ★テスト用エラーいったんコメントアウト

    this.currentConfig = data.config;
    this.totalFramesToProcess = data.totalFrames;
    this.processedFrames = 0;
    this.videoFrameCount = 0;
    this.isCancelled = false;

    if (!this.currentConfig) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: Configuration is missing.",
          type: EncoderErrorType.InitializationFailed,
        },
      });
      return;
    }

    const audioDisabled =
      !this.currentConfig.audioBitrate ||
      this.currentConfig.audioBitrate <= 0 ||
      !this.currentConfig.channels ||
      this.currentConfig.channels <= 0 ||
      !this.currentConfig.sampleRate ||
      this.currentConfig.sampleRate <= 0 ||
      !this.currentConfig.codec?.audio;

    try {
      const MuxerCtor =
        this.currentConfig.container === "webm"
          ? WebMMuxerWrapper
          : Mp4MuxerWrapper;
      this.muxer = new MuxerCtor(
        this.currentConfig,
        this.postMessageToMainThread.bind(this),
        {
          disableAudio: audioDisabled,
        },
      );
    } catch (e: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Worker: Failed to initialize Muxer: ${e.message}`,
          type: EncoderErrorType.InitializationFailed,
          stack: e.stack,
        },
      });
      this.cleanup();
      return;
    }

    let videoCodec =
      this.currentConfig.codec?.video ??
      (this.currentConfig.container === "webm" ? "vp9" : "avc");
    if (
      this.currentConfig.container === "webm" &&
      (videoCodec === "avc" || videoCodec === "hevc")
    ) {
      console.warn(
        `Worker: Video codec ${videoCodec} not compatible with WebM. Switching to VP9.`,
      );
      videoCodec = "vp9";
    }
    let finalVideoEncoderConfig: VideoEncoderConfig | null = null;

    const resolvedVideoCodecString =
      this.currentConfig.codecString?.video ??
      (videoCodec === "avc"
        ? this.defaultAvcCodecString(
            this.currentConfig.width,
            this.currentConfig.height,
            this.currentConfig.frameRate,
          )
        : videoCodec === "vp9"
          ? "vp09.00.50.08"
          : videoCodec === "vp8"
            ? "vp8"
            : videoCodec === "hevc"
              ? "hvc1"
              : videoCodec === "av1"
                ? "av01.0.04M.08"
                : videoCodec);

    const videoEncoderConfig: VideoEncoderConfig = {
      codec: resolvedVideoCodecString,
      width: this.currentConfig.width,
      height: this.currentConfig.height,
      bitrate: this.currentConfig.videoBitrate,
      framerate: this.currentConfig.frameRate,
      ...(this.currentConfig.container === "mp4" && videoCodec === "avc"
        ? { avc: { format: "avc" } }
        : {}),
      ...(this.currentConfig.hardwareAcceleration
        ? { hardwareAcceleration: this.currentConfig.hardwareAcceleration }
        : {}),
    };

    const VideoEncoderCtor = getVideoEncoder();
    if (!VideoEncoderCtor) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: VideoEncoder not available",
          type: EncoderErrorType.NotSupported,
        },
      });
      this.cleanup();
      return;
    }

    // まず明示的に指定されたコーデックを試す
    const initialSupport =
      await VideoEncoderCtor.isConfigSupported(videoEncoderConfig);

    if (initialSupport?.supported && initialSupport.config) {
      finalVideoEncoderConfig = initialSupport.config;
    } else {
      // 明示的な指定がされていないか、サポートされていない場合
      if (
        videoCodec === "vp9" ||
        videoCodec === "vp8" ||
        videoCodec === "av1"
      ) {
        console.warn(
          "Worker: Video codec " +
            videoCodec +
            " not supported or config invalid. Falling back to AVC.",
        );
        videoCodec = "avc";

        // ここでAVCコーデック設定を作成し直す
        const avcCodecString = this.defaultAvcCodecString(
          this.currentConfig.width,
          this.currentConfig.height,
          this.currentConfig.frameRate,
        );

        const avcConfig: VideoEncoderConfig & {
          hardwareAcceleration?:
            | "prefer-hardware"
            | "prefer-software"
            | "no-preference";
        } = {
          ...videoEncoderConfig,
          codec: avcCodecString,
          ...(this.currentConfig.container === "mp4"
            ? { avc: { format: "avc" as const } }
            : {}),
        };

        const support = await this.isConfigSupportedWithHwFallback(
          VideoEncoderCtor,
          avcConfig,
          "VideoEncoder",
        );

        if (support) {
          finalVideoEncoderConfig = support;
        } else {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message:
                "Worker: AVC (H.264) video codec is not supported after fallback.",
              type: EncoderErrorType.NotSupported,
            },
          });
          this.cleanup();
          return;
        }
      } else {
        // フォールバックの必要のない他のコーデックでテスト
        const result = await this.isConfigSupportedWithHwFallback(
          VideoEncoderCtor,
          videoEncoderConfig,
          "VideoEncoder",
        );

        if (result) {
          finalVideoEncoderConfig = result;
        } else {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: `Worker: Video codec ${videoCodec} config not supported.`,
              type: EncoderErrorType.NotSupported,
            },
          });
          this.cleanup();
          return;
        }
      }
    }

    try {
      this.videoEncoder = new VideoEncoderCtor({
        output: (chunk: any, meta: any) => {
          if (this.isCancelled || !this.muxer) return;
          this.muxer.addVideoChunk(chunk, meta);
        },
        error: (error: any) => {
          if (this.isCancelled) return;
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: `VideoEncoder error: ${error.message}`,
              type: EncoderErrorType.VideoEncodingError,
              stack: error.stack,
            },
          });
          this.cleanup();
        },
      });
      if (finalVideoEncoderConfig) {
        if (this.videoEncoder) {
          this.videoEncoder.configure(finalVideoEncoderConfig);
        } else {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: "Worker: VideoEncoder instance is null after creation.",
              type: EncoderErrorType.InitializationFailed,
            },
          });
          this.cleanup();
          return;
        }
      } else {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `Worker: VideoEncoder: Failed to find a supported hardware acceleration configuration for codec ${resolvedVideoCodecString}`,
            type: EncoderErrorType.NotSupported,
          },
        });
        this.cleanup();
        return;
      }
    } catch (e: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Worker: Failed to initialize VideoEncoder: ${e.message}`,
          type: EncoderErrorType.InitializationFailed,
          stack: e.stack,
        },
      });
      this.cleanup();
      return;
    }

    let finalAudioEncoderConfig: AudioEncoderConfig | null = null;
    let audioCodec =
      this.currentConfig.codec?.audio ??
      (this.currentConfig.container === "webm" ? "opus" : "aac");
    if (this.currentConfig.container === "webm" && audioCodec === "aac") {
      console.warn(
        "Worker: AAC audio codec is not compatible with WebM. Switching to Opus.",
      );
      audioCodec = "opus";
    }

    if (!audioDisabled) {
      const resolvedAudioCodecString =
        this.currentConfig.codecString?.audio ??
        (audioCodec === "opus" ? "opus" : "mp4a.40.2");

      const baseAudioConfig = {
        sampleRate: this.currentConfig.sampleRate,
        numberOfChannels: this.currentConfig.channels,
        bitrate: this.currentConfig.audioBitrate,
        codec: resolvedAudioCodecString,
        ...(this.currentConfig.audioBitrateMode && {
          bitrateMode: this.currentConfig.audioBitrateMode,
        }),
        ...(this.currentConfig.latencyMode && {
          latencyMode: this.currentConfig.latencyMode,
        }),
        ...(this.currentConfig.hardwareAcceleration && {
          hardwareAcceleration: this.currentConfig.hardwareAcceleration,
        }),
        ...(this.currentConfig.audioEncoderConfig ?? {}),
      };

      const AudioEncoderCtor: any = getAudioEncoder();
      if (!AudioEncoderCtor) {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: "Worker: AudioEncoder not available",
            type: EncoderErrorType.NotSupported,
          },
        });
        this.cleanup();
        return;
      }

      let audioSupportConfig = await this.isConfigSupportedWithHwFallback(
        AudioEncoderCtor,
        baseAudioConfig,
        "AudioEncoder",
      );
      if (audioSupportConfig) {
        if (
          audioSupportConfig.numberOfChannels !== this.currentConfig.channels
        ) {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: `AudioEncoder reported numberOfChannels (${audioSupportConfig.numberOfChannels}) does not match configured channels (${this.currentConfig.channels}).`,
              type: EncoderErrorType.ConfigurationError,
            },
          });
          this.cleanup();
          return;
        }
        finalAudioEncoderConfig = audioSupportConfig as AudioEncoderConfig;
      } else if (audioCodec === "opus") {
        console.warn(
          `Worker: Audio codec ${audioCodec} not supported or config invalid. Falling back to AAC.`,
        );
        if (this.currentConfig.container === "webm") {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message:
                "Worker: Opus audio codec not supported for WebM container.",
              type: EncoderErrorType.NotSupported,
            },
          });
          this.cleanup();
          return;
        }
        audioCodec = "aac";
        const fallbackAudioConfig = {
          ...baseAudioConfig,
          codec: this.currentConfig.codecString?.audio ?? "mp4a.40.2",
        };
        audioSupportConfig = await this.isConfigSupportedWithHwFallback(
          AudioEncoderCtor,
          fallbackAudioConfig,
          "AudioEncoder",
        );
        if (audioSupportConfig) {
          if (
            audioSupportConfig.numberOfChannels !== this.currentConfig.channels
          ) {
            this.postMessageToMainThread({
              type: "error",
              errorDetail: {
                message: `AudioEncoder reported numberOfChannels (${audioSupportConfig.numberOfChannels}) does not match configured channels (${this.currentConfig.channels}).`,
                type: EncoderErrorType.ConfigurationError,
              },
            });
            this.cleanup();
            return;
          }
          finalAudioEncoderConfig = audioSupportConfig as AudioEncoderConfig;
        } else {
          console.warn(
            "Worker: AAC audio codec is not supported. Falling back to Opus.",
          );
          audioCodec = "opus";
          const opusFallback = { ...baseAudioConfig, codec: "opus" };
          audioSupportConfig = await this.isConfigSupportedWithHwFallback(
            AudioEncoderCtor,
            opusFallback,
            "AudioEncoder",
          );
          if (audioSupportConfig) {
            if (
              audioSupportConfig.numberOfChannels !==
              this.currentConfig.channels
            ) {
              this.postMessageToMainThread({
                type: "error",
                errorDetail: {
                  message: `AudioEncoder reported numberOfChannels (${audioSupportConfig.numberOfChannels}) does not match configured channels (${this.currentConfig.channels}).`,
                  type: EncoderErrorType.ConfigurationError,
                },
              });
              this.cleanup();
              return;
            }
            finalAudioEncoderConfig = audioSupportConfig as AudioEncoderConfig;
          } else {
            this.postMessageToMainThread({
              type: "error",
              errorDetail: {
                message:
                  "Worker: Opus audio codec is not supported after fallback.",
                type: EncoderErrorType.NotSupported,
              },
            });
            this.cleanup();
            return;
          }
        }
      } else {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `Worker: Audio codec ${audioCodec} config not supported.`,
            type: EncoderErrorType.NotSupported,
          },
        });
        this.cleanup();
        return;
      }

      try {
        this.audioEncoder = new AudioEncoderCtor({
          output: (chunk: any, meta: any) => {
            if (this.isCancelled || !this.muxer) return;
            this.muxer.addAudioChunk(chunk, meta);
          },
          error: (error: any) => {
            if (this.isCancelled) return;
            this.postMessageToMainThread({
              type: "error",
              errorDetail: {
                message: `AudioEncoder error: ${error.message}`,
                type: EncoderErrorType.AudioEncodingError,
                stack: error.stack,
              },
            });
            this.cleanup();
          },
        });
        if (this.audioEncoder) {
          this.audioEncoder.configure(finalAudioEncoderConfig);
        } else {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: "Worker: AudioEncoder instance is null after creation.",
              type: EncoderErrorType.InitializationFailed,
            },
          });
          this.cleanup();
          return;
        }
      } catch (e: any) {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `Worker: Failed to initialize AudioEncoder: ${e.message}`,
            type: EncoderErrorType.InitializationFailed,
            stack: e.stack,
          },
        });
        this.cleanup();
        return;
      }
    }

    this.postMessageToMainThread({
      type: "initialized",
      actualVideoCodec: finalVideoEncoderConfig?.codec,
      actualAudioCodec: audioDisabled ? null : finalAudioEncoderConfig?.codec,
    } as MainThreadMessage);

    logger.log("Worker: Initialized successfully");
  }

  async handleAddVideoFrame(data: AddVideoFrameMessage): Promise<void> {
    if (this.isCancelled || !this.videoEncoder || !this.currentConfig) return;
    try {
      const frame = data.frame;
      const interval = this.currentConfig.keyFrameInterval;
      const opts =
        interval && this.videoFrameCount % interval === 0
          ? ({ keyFrame: true } as VideoEncoderEncodeOptions)
          : undefined;
      this.videoEncoder.encode(frame, opts as any);
      // Some implementations may automatically close the transferred frame
      // when passed to `encode`. Guard against potential errors from calling
      // `close()` on an already-consumed frame.
      try {
        frame.close();
      } catch (closeErr) {
        logger.warn("Worker: Ignored error closing VideoFrame", closeErr);
      }
      this.videoFrameCount++;
      this.processedFrames++;
      const progressMessage: any = {
        type: "progress",
        processedFrames: this.processedFrames,
      };
      if (typeof this.totalFramesToProcess !== "undefined") {
        progressMessage.totalFrames = this.totalFramesToProcess;
      }
      this.postMessageToMainThread(progressMessage as MainThreadMessage);
      this.postQueueSize();
    } catch (error: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Error encoding video frame: ${error.message}`,
          type: EncoderErrorType.VideoEncodingError,
          stack: error.stack,
        },
      } as MainThreadMessage);
      this.cleanup();
    }
  }

  async handleAddAudioData(data: AddAudioDataMessage): Promise<void> {
    if (this.isCancelled || !this.audioEncoder || !this.currentConfig) return;

    if (data.audio) {
      try {
        this.audioEncoder.encode(data.audio);
        this.postQueueSize();
      } catch (error: any) {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `Error encoding audio data: ${error.message}`,
            type: EncoderErrorType.AudioEncodingError,
            stack: error.stack,
          },
        } as MainThreadMessage);
        this.cleanup();
      }
      return;
    }

    if (!data.audioData || data.audioData.length === 0) return;

    if (data.audioData.length !== this.currentConfig.channels) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Audio data channel count (${data.audioData.length}) does not match configured channels (${this.currentConfig.channels}).`,
          type: EncoderErrorType.ConfigurationError,
        },
      } as MainThreadMessage);
      return;
    }

    const AudioDataCtor: any = getAudioData();
    if (!AudioDataCtor) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: AudioData not available",
          type: EncoderErrorType.NotSupported,
        },
      });
      this.cleanup();
      return;
    }

    try {
      const interleaveFloat32Arrays = (
        planarArrays: Float32Array[],
      ): Float32Array => {
        if (!planarArrays || planarArrays.length === 0) {
          return new Float32Array(0);
        }
        const numChannels = planarArrays.length;
        const numFrames = planarArrays[0].length;
        const interleaved = new Float32Array(numFrames * numChannels);
        for (let i = 0; i < numFrames; i++) {
          for (let ch = 0; ch < numChannels; ch++) {
            interleaved[i * numChannels + ch] = planarArrays[ch][i];
          }
        }
        return interleaved;
      };

      const interleavedData = interleaveFloat32Arrays(data.audioData);

      const audioData: AudioData = new AudioDataCtor({
        format: "f32",
        sampleRate: data.sampleRate,
        numberOfFrames: data.numberOfFrames,
        numberOfChannels: data.numberOfChannels,
        timestamp: data.timestamp,
        data: interleavedData.buffer,
      });
      try {
        this.audioEncoder.encode(audioData);
        this.postQueueSize();
      } finally {
        audioData.close();
      }
    } catch (error: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Error encoding audio data: ${error.message}`,
          type: EncoderErrorType.AudioEncodingError,
          stack: error.stack,
        },
      } as MainThreadMessage);
      this.cleanup();
    }
  }

  async handleFinalize(_message: FinalizeWorkerMessage): Promise<void> {
    if (this.isCancelled) return;

    try {
      if (this.videoEncoder) await this.videoEncoder.flush();
      if (this.audioEncoder) await this.audioEncoder.flush();

      if (this.muxer) {
        const uint8ArrayOrNullOutput = this.muxer.finalize();
        if (uint8ArrayOrNullOutput) {
          this.postMessageToMainThread(
            { type: "finalized", output: uint8ArrayOrNullOutput },
            [uint8ArrayOrNullOutput.buffer],
          );
        } else if (this.currentConfig?.latencyMode === "realtime") {
          this.postMessageToMainThread({ type: "finalized", output: null });
        } else {
          this.postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: "Muxer finalized without output in non-realtime mode.",
              type: EncoderErrorType.MuxingFailed,
            },
          });
        }
      } else {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: "Muxer not initialized during finalize.",
            type: EncoderErrorType.MuxingFailed,
          },
        });
      }
    } catch (error: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Error during finalization: ${error.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: error.stack,
        },
      } as MainThreadMessage);
    } finally {
      this.cleanup();
    }
  }

  handleCancel(_message: CancelWorkerMessage): void {
    if (this.isCancelled) return;
    this.isCancelled = true;
    logger.log("Worker: Received cancel signal.");

    // Ensure the main thread is notified even if cleanup throws
    this.postMessageToMainThread({ type: "cancelled" } as MainThreadMessage);

    this.videoEncoder?.close();
    this.audioEncoder?.close();

    // Cleanup without resetting the cancelled state so that any queued
    // messages after this point are ignored.
    this.cleanup(false);
  }

  cleanup(resetCancelled: boolean = true): void {
    logger.log("Worker: Cleaning up resources.");
    if (this.videoEncoder && this.videoEncoder.state !== "closed")
      this.videoEncoder.close();
    if (this.audioEncoder && this.audioEncoder.state !== "closed")
      this.audioEncoder.close();
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.muxer = null;
    this.currentConfig = null;
    this.totalFramesToProcess = undefined;
    this.processedFrames = 0;
    this.videoFrameCount = 0;
    if (this.audioWorkletPort) {
      this.audioWorkletPort.onmessage = null;
      this.audioWorkletPort.close();
      this.audioWorkletPort = null;
    }
    if (resetCancelled) {
      this.isCancelled = false;
    }
  }

  async handleMessage(eventData: WorkerMessage): Promise<void> {
    if (
      this.isCancelled &&
      eventData.type !== "initialize" &&
      eventData.type !== "cancel"
    ) {
      console.warn(
        `Worker: Ignoring message type '${eventData.type}' because worker is cancelled.`,
      );
      return;
    }

    try {
      switch (eventData.type) {
        case "initialize":
          this.isCancelled = false;
          this.cleanup();
          await this.initializeEncoders(eventData);
          break;
        case "connectAudioPort":
          this.audioWorkletPort = eventData.port;
          this.audioWorkletPort.onmessage = async (
            e: MessageEvent<AddAudioDataMessage>,
          ) => {
            if (this.isCancelled) return;
            await this.handleAddAudioData(e.data);
          };
          break;
        case "addVideoFrame":
          await this.handleAddVideoFrame(eventData);
          break;
        case "addAudioData":
          await this.handleAddAudioData(eventData);
          break;
        case "finalize":
          await this.handleFinalize(eventData);
          break;
        case "cancel":
          this.handleCancel(eventData);
          break;
        default:
          console.warn(
            "Worker received unknown message type:",
            (eventData as { type?: unknown }).type,
          );
      }
    } catch (error: any) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Unhandled error in worker onmessage: ${error.message}`,
          type: EncoderErrorType.InternalError,
          stack: error.stack,
        },
      } as MainThreadMessage);
      this.cleanup();
    }
  }
}

const encoder = new EncoderWorker();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  await encoder.handleMessage(event.data);
};
