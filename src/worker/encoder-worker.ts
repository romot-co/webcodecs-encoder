import { Mp4MuxerWrapper } from "../muxers/mp4muxer";
import { WebMMuxerWrapper } from "../muxers/webmmuxer";
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
  AudioCodec,
  AudioEncoderConstructor,
} from "../types";
import { EncoderErrorType } from "../types";

// グローバルなエラーハンドラ (主に同期的なエラーや、Promise外の非同期エラー用)
if (
  typeof self !== "undefined" &&
  typeof self.addEventListener === "function"
) {
  self.addEventListener("error", (event: ErrorEvent) => {
    console.error("Unhandled global error in worker. Event:", event);
    const message =
      event.message ||
      `Unhandled global error${event.filename ? ` at ${event.filename}` : ""}`;
    self.postMessage({
      type: "error",
      errorDetail: {
        message,
        type: EncoderErrorType.WorkerError,
        stack: event.error?.stack,
      },
    } as MainThreadMessage);
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
      const message =
        reason instanceof Error
          ? `Unhandled promise rejection: ${reason.message}`
          : `Unhandled promise rejection: ${String(reason)}`;
      self.postMessage({
        type: "error",
        errorDetail: {
          message,
          type: EncoderErrorType.WorkerError,
          stack: reason instanceof Error ? reason.stack : undefined,
        },
      } as MainThreadMessage);
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

  private getCodecString(
    codecType: "avc" | "hevc" | "vp9" | "vp8" | "av1",
    width: number,
    height: number,
    frameRate: number,
  ): string {
    switch (codecType) {
      case "avc":
        return this.defaultAvcCodecString(width, height, frameRate);
      case "vp9":
        return "vp09.00.50.08";
      case "vp8":
        return "vp8";
      case "hevc":
        return "hvc1";
      case "av1":
        return "av01.0.04M.08";
      default:
        return codecType;
    }
  }

  private async isConfigSupportedWithHwFallback<
    T extends VideoEncoderConfig | AudioEncoderConfig,
  >(
    Ctor: {
      isConfigSupported(
        config: T,
      ): Promise<{ supported?: boolean; config?: T }>;
    },
    config: T & {
      hardwareAcceleration?:
        | "prefer-hardware"
        | "prefer-software"
        | "no-preference";
    },
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

  private async prepareAudioCodec(
    container: ContainerType,
    audioDisabled: boolean,
  ): Promise<{
    audioDisabled: boolean;
    selectedCodec: AudioCodec | null;
    finalConfig: AudioEncoderConfig | null;
    encoderCtor: AudioEncoderConstructor | null;
  }> {
    if (audioDisabled) {
      return {
        audioDisabled: true,
        selectedCodec: null,
        finalConfig: null,
        encoderCtor: null,
      };
    }

    const AudioEncoderCtor = getAudioEncoder();
    if (!AudioEncoderCtor) {
      this.postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: AudioEncoder not available",
          type: EncoderErrorType.NotSupported,
        },
      });
      return {
        audioDisabled: true,
        selectedCodec: null,
        finalConfig: null,
        encoderCtor: null,
      };
    }

    const config = this.currentConfig;
    if (!config) {
      return {
        audioDisabled: true,
        selectedCodec: null,
        finalConfig: null,
        encoderCtor: AudioEncoderCtor,
      };
    }

    const requestedCodec = config.codec?.audio;
    const requestedCodecString = config.codecString?.audio;
    const preference = buildAudioCodecPreference(container, requestedCodec);
    let attemptedDefaultCodec = false;

    for (const candidate of preference) {
      if (candidate === "aac") {
        attemptedDefaultCodec = true;
      }
      const codecString =
        requestedCodec && requestedCodecString && candidate === requestedCodec
          ? requestedCodecString
          : getAudioEncoderCodecStringFromAudioCodec(candidate);
      const baseConfig: AudioEncoderConfig & {
        hardwareAcceleration?:
          | "prefer-hardware"
          | "prefer-software"
          | "no-preference";
      } = {
        codec: codecString,
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bitrate: config.audioBitrate,
        ...(config.audioBitrateMode && {
          bitrateMode: config.audioBitrateMode,
        }),
        ...(config.hardwareAcceleration && {
          hardwareAcceleration: config.hardwareAcceleration,
        }),
        ...(getAudioEncoderConfigOverridesForCodec(
          candidate,
          config.audioEncoderConfig,
        ) as any),
      };

      const support = await this.isConfigSupportedWithHwFallback(
        AudioEncoderCtor,
        baseConfig,
        "AudioEncoder",
      );

      if (!support) {
        if (candidate === "aac" && container === "mp4") {
          console.warn(
            "Worker: AAC audio codec is not supported. Falling back to MP3.",
          );
          const mp3AttemptConfig: AudioEncoderConfig & {
            hardwareAcceleration?:
              | "prefer-hardware"
              | "prefer-software"
              | "no-preference";
          } = {
            codec: getAudioEncoderCodecStringFromAudioCodec("mp3"),
            sampleRate: config.sampleRate,
            numberOfChannels: config.channels,
            bitrate: config.audioBitrate,
            ...(config.audioBitrateMode && {
              bitrateMode: config.audioBitrateMode,
            }),
            ...(config.hardwareAcceleration && {
              hardwareAcceleration: config.hardwareAcceleration,
            }),
            ...(getAudioEncoderConfigOverridesForCodec(
              "mp3",
              config.audioEncoderConfig,
            ) as any),
          };
          const mp3Support = await this.isConfigSupportedWithHwFallback(
            AudioEncoderCtor,
            mp3AttemptConfig,
            "AudioEncoder",
          );
          if (mp3Support) {
            const resolvedMp3Config = mp3Support as AudioEncoderConfig;
            if (
              resolvedMp3Config.numberOfChannels !== undefined &&
              resolvedMp3Config.numberOfChannels !== config.channels
            ) {
              this.postMessageToMainThread({
                type: "error",
                errorDetail: {
                  message: `AudioEncoder reported numberOfChannels (${resolvedMp3Config.numberOfChannels}) does not match configured channels (${config.channels}).`,
                  type: EncoderErrorType.ConfigurationError,
                },
              });
              return {
                audioDisabled: true,
                selectedCodec: null,
                finalConfig: null,
                encoderCtor: AudioEncoderCtor,
              };
            }
            if (
              resolvedMp3Config.sampleRate !== undefined &&
              resolvedMp3Config.sampleRate !== config.sampleRate
            ) {
              this.postMessageToMainThread({
                type: "error",
                errorDetail: {
                  message: `AudioEncoder reported sampleRate (${resolvedMp3Config.sampleRate}) does not match configured sampleRate (${config.sampleRate}).`,
                  type: EncoderErrorType.ConfigurationError,
                },
              });
              return {
                audioDisabled: true,
                selectedCodec: null,
                finalConfig: null,
                encoderCtor: AudioEncoderCtor,
              };
            }
            if (!isAudioCodecMuxerCompatible(container, "mp3")) {
              console.warn(
                "Worker: Audio codec mp3 is not compatible with MP4 muxer. Audio will be disabled.",
              );
            } else {
              console.warn("Worker: Falling back to MP3 for MP4 container.");
              return {
                audioDisabled: false,
                selectedCodec: "mp3",
                finalConfig: resolvedMp3Config,
                encoderCtor: AudioEncoderCtor,
              };
            }
          }
        } else {
          console.warn(
            `Worker: Audio codec ${candidate} not supported or config invalid.`,
          );
        }
        continue;
      }

      const resolvedConfig = support as AudioEncoderConfig;

      if (
        resolvedConfig.numberOfChannels !== undefined &&
        resolvedConfig.numberOfChannels !== config.channels
      ) {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `AudioEncoder reported numberOfChannels (${resolvedConfig.numberOfChannels}) does not match configured channels (${config.channels}).`,
            type: EncoderErrorType.ConfigurationError,
          },
        });
        return {
          audioDisabled: true,
          selectedCodec: null,
          finalConfig: null,
          encoderCtor: AudioEncoderCtor,
        };
      }

      if (
        resolvedConfig.sampleRate !== undefined &&
        resolvedConfig.sampleRate !== config.sampleRate
      ) {
        this.postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `AudioEncoder reported sampleRate (${resolvedConfig.sampleRate}) does not match configured sampleRate (${config.sampleRate}).`,
            type: EncoderErrorType.ConfigurationError,
          },
        });
        return {
          audioDisabled: true,
          selectedCodec: null,
          finalConfig: null,
          encoderCtor: AudioEncoderCtor,
        };
      }

      if (!isAudioCodecMuxerCompatible(container, candidate)) {
        console.warn(
          `Worker: Audio codec ${candidate} is not compatible with ${container.toUpperCase()} muxer. Trying fallback codec.`,
        );
        continue;
      }

      if (candidate === "aac") {
        attemptedDefaultCodec = true;
        if (container === "mp4" && requestedCodec && requestedCodec !== "aac") {
          console.warn("Worker: Falling back to AAC for MP4 container.");
        }
      }
      if (container === "mp4" && candidate === "mp3" && attemptedDefaultCodec) {
        console.warn("Worker: Falling back to MP3 for MP4 container.");
      }

      return {
        audioDisabled: false,
        selectedCodec: candidate,
        finalConfig: resolvedConfig,
        encoderCtor: AudioEncoderCtor,
      };
    }

    const defaultCodec = DEFAULT_AUDIO_CODEC_BY_CONTAINER[container];
    const noCodecMessage =
      container === "mp4"
        ? "Worker: No supported audio codec (AAC, MP3) found for MP4 container."
        : `Worker: No supported audio codec found. Requested: ${requestedCodec ?? "(auto)"}. Tried: ${preference.join(", ")}.`;
    this.postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: noCodecMessage,
        type: EncoderErrorType.NotSupported,
      },
    });
    console.warn(
      `Worker: Disabling audio. Consider using ${defaultCodec} for container ${container}.`,
    );
    return {
      audioDisabled: true,
      selectedCodec: null,
      finalConfig: null,
      encoderCtor: AudioEncoderCtor,
    };
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

    let audioDisabled =
      !this.currentConfig.audioBitrate ||
      this.currentConfig.audioBitrate <= 0 ||
      !this.currentConfig.channels ||
      this.currentConfig.channels <= 0 ||
      !this.currentConfig.sampleRate ||
      this.currentConfig.sampleRate <= 0 ||
      !this.currentConfig.codec?.audio;

    const containerType = getContainerType(this.currentConfig.container);
    const audioOriginallyDisabled = audioDisabled;

    const audioPlan = await this.prepareAudioCodec(
      containerType,
      audioDisabled,
    );
    audioDisabled = audioPlan.audioDisabled;
    let selectedAudioCodec = audioPlan.selectedCodec;
    let finalAudioEncoderConfig = audioPlan.finalConfig;
    const preparedAudioEncoderCtor = audioPlan.encoderCtor;

    if (audioDisabled) {
      selectedAudioCodec = null;
      finalAudioEncoderConfig = null;
    }

    if (!audioOriginallyDisabled && audioDisabled) {
      this.cleanup();
      return;
    }

    // Check if video is disabled (audio-only encoding)
    const videoDisabled =
      this.currentConfig.width === 0 ||
      this.currentConfig.height === 0 ||
      this.currentConfig.videoBitrate === 0;

    let videoCodec: "avc" | "hevc" | "vp9" | "vp8" | "av1" | undefined =
      this.currentConfig.codec?.video ??
      (this.currentConfig.container === "webm" ? "vp9" : "avc");
    const requestedVideoCodec = videoCodec;
    let finalVideoEncoderConfig: VideoEncoderConfig | null = null;
    let resolvedVideoCodecString: string | null = null;
    let VideoEncoderCtor: typeof VideoEncoder | undefined;

    if (!videoDisabled) {
      if (
        this.currentConfig.container === "webm" &&
        (videoCodec === "avc" || videoCodec === "hevc")
      ) {
        console.warn(
          `Worker: Video codec ${videoCodec} not compatible with WebM. Switching to VP9.`,
        );
        videoCodec = "vp9";
      }

      resolvedVideoCodecString =
        (this.currentConfig.codecString?.video &&
        videoCodec === requestedVideoCodec
          ? this.currentConfig.codecString.video
          : undefined) ??
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
                  : videoCodec!);

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
        ...(getVideoEncoderConfigOverridesForCodec(
          videoCodec,
          this.currentConfig.videoEncoderConfig,
        ) as any),
      };

      VideoEncoderCtor = getVideoEncoder();
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
              " not supported or config invalid. Looking for fallback...",
          );

          let fallbackSuccessful = false;

          // WebMコンテナの場合：VP9 → VP8 の順でフォールバック
          if (this.currentConfig.container === "webm") {
            const webmCodecs: ("vp9" | "vp8")[] = ["vp9", "vp8"];

            for (const fallbackCodec of webmCodecs) {
              if (fallbackCodec === videoCodec) continue; // 既に試したコーデックはスキップ

              console.warn(
                `Worker: Trying fallback to ${fallbackCodec} for WebM container.`,
              );

              const fallbackCodecString = this.getCodecString(
                fallbackCodec,
                this.currentConfig.width,
                this.currentConfig.height,
                this.currentConfig.frameRate,
              );

              const fallbackConfig: VideoEncoderConfig & {
                hardwareAcceleration?:
                  | "prefer-hardware"
                  | "prefer-software"
                  | "no-preference";
              } = {
                ...videoEncoderConfig,
                codec: fallbackCodecString,
                ...(getVideoEncoderConfigOverridesForCodec(
                  fallbackCodec,
                  this.currentConfig.videoEncoderConfig,
                ) as any),
              };

              const support = await this.isConfigSupportedWithHwFallback(
                VideoEncoderCtor,
                fallbackConfig,
                "VideoEncoder",
              );

              if (support) {
                console.warn(
                  `Worker: Successfully fell back to ${fallbackCodec} for WebM.`,
                );
                videoCodec = fallbackCodec;
                finalVideoEncoderConfig = support;
                fallbackSuccessful = true;
                break;
              }
            }

            if (!fallbackSuccessful) {
              this.postMessageToMainThread({
                type: "error",
                errorDetail: {
                  message:
                    "Worker: No compatible video codec (VP9, VP8) found for WebM container.",
                  type: EncoderErrorType.NotSupported,
                },
              });
              this.cleanup();
              return;
            }
          } else {
            // MP4コンテナの場合：AVC (H.264) にフォールバック
            console.warn("Worker: Falling back to AVC for MP4 container.");
            videoCodec = "avc";

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
              ...(getVideoEncoderConfigOverridesForCodec(
                "avc",
                this.currentConfig.videoEncoderConfig,
              ) as any),
            };

            const support = await this.isConfigSupportedWithHwFallback(
              VideoEncoderCtor,
              avcConfig,
              "VideoEncoder",
            );

            if (support) {
              finalVideoEncoderConfig = support;
              fallbackSuccessful = true;
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
    } else {
      videoCodec = undefined;
    }

    const codecConfigForMuxer: EncoderConfig["codec"] = {
      ...(this.currentConfig.codec ?? {}),
      video: videoDisabled ? undefined : videoCodec,
      audio:
        audioDisabled || !selectedAudioCodec ? undefined : selectedAudioCodec,
    };

    this.currentConfig.codec = codecConfigForMuxer;

    try {
      const MuxerCtor =
        containerType === "webm" ? WebMMuxerWrapper : Mp4MuxerWrapper;
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

    // Only initialize video encoder if video is enabled
    if (!videoDisabled) {
      try {
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
                message:
                  "Worker: VideoEncoder instance is null after creation.",
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
              message: `Worker: VideoEncoder: Failed to find a supported hardware acceleration configuration for codec ${resolvedVideoCodecString ?? "(unknown)"}`,
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
    } // End of video encoder initialization

    if (!audioDisabled) {
      if (
        !selectedAudioCodec ||
        !finalAudioEncoderConfig ||
        !preparedAudioEncoderCtor
      ) {
        // prepareAudioCodec already posted an error message
        this.cleanup();
        return;
      }

      try {
        this.audioEncoder = new preparedAudioEncoderCtor({
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

    console.warn("Worker: Initialized successfully");
  }

  async handleAddVideoFrame(data: AddVideoFrameMessage): Promise<void> {
    if (this.isCancelled || !this.videoEncoder || !this.currentConfig) return;

    try {
      const frame = data.frame;
      const currentQueueSize = this.videoEncoder.encodeQueueSize;
      const maxQueueSize = this.currentConfig.maxVideoQueueSize || 30;
      const strategy = this.currentConfig.backpressureStrategy || "drop";

      // Backpressure control
      if (currentQueueSize >= maxQueueSize) {
        if (strategy === "drop") {
          // Drop this frame
          console.warn(
            `Video queue full (${currentQueueSize}/${maxQueueSize}), dropping frame`,
          );
          try {
            frame.close();
          } catch (closeErr) {
            console.warn(
              "Worker: Ignored error closing dropped VideoFrame",
              closeErr,
            );
          }
          return;
        } else if (strategy === "wait") {
          // Wait for queue to drain with exponential backoff
          let waitTime = 10; // Start with 10ms
          const maxWaitTime = 100; // Cap at 100ms
          const maxRetries = 5; // Reduce number of retries
          let attempts = 0;

          while (
            this.videoEncoder.encodeQueueSize >= maxQueueSize &&
            attempts < maxRetries
          ) {
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            waitTime = Math.min(waitTime * 1.5, maxWaitTime); // Exponential backoff
            attempts++;
          }
          // If still full after waiting, drop the frame
          if (this.videoEncoder.encodeQueueSize >= maxQueueSize) {
            console.warn(
              `Video queue still full after waiting, dropping frame`,
            );
            try {
              frame.close();
            } catch (closeErr) {
              console.warn(
                "Worker: Ignored error closing waited VideoFrame",
                closeErr,
              );
            }
            return;
          }
        }
      }

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
        console.warn("Worker: Ignored error closing VideoFrame", closeErr);
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
      const audioData = data.audio;
      let audioClosed = false;
      const closeAudioData = (context: string) => {
        if (audioClosed) return;
        try {
          audioData.close();
          audioClosed = true;
        } catch (closeErr) {
          console.warn(`Worker: Ignored error closing ${context}`, closeErr);
        }
      };
      try {
        const currentQueueSize = this.audioEncoder.encodeQueueSize;
        const maxQueueSize = this.currentConfig.maxAudioQueueSize || 30;
        const strategy = this.currentConfig.backpressureStrategy || "drop";

        // Backpressure control
        if (currentQueueSize >= maxQueueSize) {
          if (strategy === "drop") {
            // Drop this audio data
            console.warn(
              `Audio queue full (${currentQueueSize}/${maxQueueSize}), dropping audio data`,
            );
            closeAudioData("dropped AudioData");
            return;
          } else if (strategy === "wait") {
            // Wait for queue to drain with exponential backoff
            let waitTime = 10; // Start with 10ms
            const maxWaitTime = 100; // Cap at 100ms
            const maxRetries = 5; // Reduce number of retries
            let attempts = 0;

            while (
              this.audioEncoder.encodeQueueSize >= maxQueueSize &&
              attempts < maxRetries
            ) {
              await new Promise((resolve) => setTimeout(resolve, waitTime));
              waitTime = Math.min(waitTime * 1.5, maxWaitTime); // Exponential backoff
              attempts++;
            }
            // If still full after waiting, drop the audio data
            if (this.audioEncoder.encodeQueueSize >= maxQueueSize) {
              console.warn(
                `Audio queue still full after waiting, dropping audio data`,
              );
              closeAudioData("waited AudioData");
              return;
            }
          }
        }

        this.audioEncoder.encode(audioData);
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
      } finally {
        closeAudioData("AudioData");
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
        const numFrames = Math.min(...planarArrays.map((arr) => arr.length));
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
    console.warn("Worker: Received cancel signal.");

    // Ensure the main thread is notified even if cleanup throws
    this.postMessageToMainThread({ type: "cancelled" } as MainThreadMessage);

    this.videoEncoder?.close();
    this.audioEncoder?.close();

    // Cleanup without resetting the cancelled state so that any queued
    // messages after this point are ignored.
    this.cleanup();
  }

  cleanup(): void {
    console.warn("Worker: Cleaning up resources.");
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
          type: EncoderErrorType.Unknown,
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
type ContainerType = "mp4" | "webm";

const DEFAULT_AUDIO_CODEC_BY_CONTAINER: Record<ContainerType, AudioCodec> = {
  mp4: "aac",
  webm: "opus",
};

const AUDIO_ENCODER_CODEC_MAP: Record<AudioCodec, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
  flac: "flac",
  mp3: "mp3",
  vorbis: "vorbis",
  pcm: "pcm",
  ulaw: "ulaw",
  alaw: "alaw",
};

const MUXER_COMPATIBLE_AUDIO: Record<ContainerType, Set<AudioCodec>> = {
  mp4: new Set<AudioCodec>(["aac", "mp3"]),
  webm: new Set<AudioCodec>(["opus", "vorbis", "flac"]),
};

function getAudioEncoderCodecStringFromAudioCodec(codec: AudioCodec): string {
  return AUDIO_ENCODER_CODEC_MAP[codec] ?? codec;
}

function getVideoEncoderConfigOverridesForCodec(
  codec: "avc" | "hevc" | "vp9" | "vp8" | "av1",
  overrides?: Partial<VideoEncoderConfig>,
): Partial<VideoEncoderConfig> {
  if (!overrides) {
    return {};
  }
  const sanitized = { ...(overrides as any) };
  if (codec !== "avc") {
    delete sanitized.avc;
  }
  if (codec !== "hevc") {
    delete sanitized.hevc;
  }
  return sanitized;
}

function getAudioEncoderConfigOverridesForCodec(
  codec: AudioCodec,
  overrides?: Partial<AudioEncoderConfig>,
): Partial<AudioEncoderConfig> {
  if (!overrides) {
    return {};
  }
  const sanitized = { ...(overrides as any) };
  if (codec !== "aac") {
    delete sanitized.aac;
  }
  return sanitized;
}

function getContainerType(container?: string): ContainerType {
  return container === "webm" ? "webm" : "mp4";
}

function buildAudioCodecPreference(
  container: ContainerType,
  requested?: AudioCodec,
): AudioCodec[] {
  const preference: AudioCodec[] = [];
  const addCodec = (codec: AudioCodec) => {
    if (!preference.includes(codec)) {
      preference.push(codec);
    }
  };

  if (requested) {
    addCodec(requested);
  }

  addCodec(DEFAULT_AUDIO_CODEC_BY_CONTAINER[container]);

  for (const codec of MUXER_COMPATIBLE_AUDIO[container]) {
    addCodec(codec);
  }

  if (container === "mp4") {
    addCodec("aac");
    addCodec("mp3");
  } else {
    addCodec("opus");
    addCodec("vorbis");
    addCodec("flac");
    addCodec("aac");
  }

  return preference;
}

function isAudioCodecMuxerCompatible(
  container: ContainerType,
  codec: AudioCodec,
): boolean {
  return MUXER_COMPATIBLE_AUDIO[container].has(codec);
}
