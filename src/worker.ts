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
} from "./types";
import { EncoderErrorType } from "./types";
import logger from "./logger";

let videoEncoder: VideoEncoder | null = null;
let audioEncoder: AudioEncoder | null = null;
let muxer: Mp4MuxerWrapper | WebMMuxerWrapper | null = null;
let currentConfig: EncoderConfig | null = null;
let totalFramesToProcess: number | undefined;
let processedFrames: number = 0;
let videoFrameCount: number = 0;
let isCancelled: boolean = false;
let audioWorkletPort: MessagePort | null = null;

function defaultAvcCodecString(
  width: number,
  height: number,
  frameRate: number,
): string {
  const mbPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * frameRate;
  let level: number;
  if (mbPerSec <= 108000)
    level = 31; // up to 1080p30
  else if (mbPerSec <= 216000)
    level = 32; // up to 1080p60
  else if (mbPerSec <= 245760)
    level = 40; // 1080p60
  else if (mbPerSec <= 589824)
    level = 50; // 4k30
  else if (mbPerSec <= 983040)
    level = 51; // 4k60
  else level = 52;
  const profileHex = width >= 1280 || height >= 720 ? "64" : "42";
  const levelHex = level.toString(16).padStart(2, "0");
  return `avc1.${profileHex}00${levelHex}`;
}

// --- 追加: グローバル API を安全に取るヘルパ ---
const getVideoEncoder = () =>
  (self as any).VideoEncoder ?? (globalThis as any).VideoEncoder;
const getAudioEncoder = () =>
  (self as any).AudioEncoder ?? (globalThis as any).AudioEncoder;
const getAudioData = () =>
  (self as any).AudioData ?? (globalThis as any).AudioData;

function postMessageToMainThread(
  message: MainThreadMessage,
  transfer?: Transferable[],
): void {
  self.postMessage(message, transfer as any);
}

function postQueueSize(): void {
  postMessageToMainThread({
    type: "queueSize",
    videoQueueSize: videoEncoder?.encodeQueueSize ?? 0,
    audioQueueSize: audioEncoder?.encodeQueueSize ?? 0,
  } as MainThreadMessage);
}

async function initializeEncoders(
  data: InitializeWorkerMessage,
): Promise<void> {
  currentConfig = data.config;
  totalFramesToProcess = data.totalFrames;
  processedFrames = 0;
  videoFrameCount = 0;
  isCancelled = false;

  if (!currentConfig) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: "Worker: Configuration is missing.",
        type: EncoderErrorType.InitializationFailed,
      },
    });
    return;
  }

  const audioDisabled =
    currentConfig.audioBitrate <= 0 ||
    currentConfig.channels <= 0 ||
    currentConfig.sampleRate <= 0;

  try {
    const MuxerCtor =
      currentConfig.container === "webm" ? WebMMuxerWrapper : Mp4MuxerWrapper;
    muxer = new MuxerCtor(currentConfig, postMessageToMainThread, {
      disableAudio: audioDisabled,
    });
  } catch (e: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Worker: Failed to initialize Muxer: ${e.message}`,
        type: EncoderErrorType.InitializationFailed,
        stack: e.stack,
      },
    });
    cleanup();
    return;
  }

  let videoCodec =
    currentConfig.codec?.video ??
    (currentConfig.container === "webm" ? "vp9" : "avc");
  if (
    currentConfig.container === "webm" &&
    (videoCodec === "avc" || videoCodec === "hevc")
  ) {
    console.warn(
      `Worker: Video codec ${videoCodec} not compatible with WebM. Switching to VP9.`,
    );
    videoCodec = "vp9";
  }
  let finalVideoEncoderConfig: VideoEncoderConfig | null = null;

  const resolvedVideoCodecString =
    currentConfig.codecString?.video ??
    (videoCodec === "avc"
      ? defaultAvcCodecString(
          currentConfig.width,
          currentConfig.height,
          currentConfig.frameRate,
        )
      : videoCodec === "vp9"
        ? "vp09.00.50.08"
        : videoCodec === "vp8"
          ? "vp8"
          : videoCodec === "hevc"
            ? "hvc1"
            : videoCodec === "av1"
              ? "av01"
              : "");

  const baseVideoConfig = {
    width: currentConfig.width,
    height: currentConfig.height,
    framerate: currentConfig.frameRate,
    bitrate: currentConfig.videoBitrate,
    codec: resolvedVideoCodecString,
    ...(currentConfig.latencyMode && {
      latencyMode: currentConfig.latencyMode,
    }),
    ...(currentConfig.hardwareAcceleration && {
      hardwareAcceleration: currentConfig.hardwareAcceleration,
    }),
    ...(videoCodec === "vp9" && {
      scalabilityMode: "L1T2",
    }),
    ...(videoCodec === "avc" && {
      avc: { format: "avcc" },
    }),
    ...(currentConfig.videoEncoderConfig ?? {}),
  };

  const VideoEncoderCtor: any = getVideoEncoder();
  if (!VideoEncoderCtor) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: "Worker: VideoEncoder not available",
        type: EncoderErrorType.NotSupported,
      },
    });
    cleanup();
    return;
  }

  let videoSupport = await VideoEncoderCtor.isConfigSupported(
    baseVideoConfig as any,
  );
  if (videoSupport?.supported) {
    finalVideoEncoderConfig = videoSupport.config as VideoEncoderConfig;
  } else if (
    videoCodec === "vp9" ||
    videoCodec === "av1" ||
    videoCodec === "hevc"
  ) {
    console.warn(
      `Worker: Video codec ${videoCodec} not supported or config invalid. Falling back to AVC.`,
    );
    videoCodec = "avc";
    const fallbackVideoConfig = {
      ...baseVideoConfig,
      codec:
        currentConfig.codecString?.video ??
        defaultAvcCodecString(
          currentConfig.width,
          currentConfig.height,
          currentConfig.frameRate,
        ),
      avc: { format: "avcc" },
    };
    delete (fallbackVideoConfig as any).scalabilityMode;
    if (currentConfig.container === "webm") {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: VP9/VP8/AV1 not supported for WebM container.",
          type: EncoderErrorType.NotSupported,
        },
      });
      cleanup();
      return;
    }
    videoSupport = await VideoEncoderCtor.isConfigSupported(
      fallbackVideoConfig as any,
    );
    if (videoSupport?.supported) {
      finalVideoEncoderConfig = videoSupport.config as VideoEncoderConfig;
    } else {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message:
            "Worker: AVC (H.264) video codec is not supported after fallback.",
          type: EncoderErrorType.NotSupported,
        },
      });
      cleanup();
      return;
    }
  } else {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Worker: Video codec ${videoCodec} config not supported.`,
        type: EncoderErrorType.NotSupported,
      },
    });
    cleanup();
    return;
  }

  try {
    videoEncoder = new VideoEncoderCtor({
      output: (chunk: any, meta: any) => {
        if (isCancelled || !muxer) return;
        muxer.addVideoChunk(chunk, meta);
      },
      error: (error: any) => {
        if (isCancelled) return;
        postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: `VideoEncoder error: ${error.message}`,
            type: EncoderErrorType.VideoEncodingError,
            stack: error.stack,
          },
        });
        cleanup();
      },
    });
    if (videoEncoder) {
      videoEncoder.configure(finalVideoEncoderConfig as any);
    } else {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: VideoEncoder instance is null after creation.",
          type: EncoderErrorType.InitializationFailed,
        },
      });
      cleanup();
      return;
    }
  } catch (e: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Worker: Failed to initialize VideoEncoder: ${e.message}`,
        type: EncoderErrorType.InitializationFailed,
        stack: e.stack,
      },
    });
    cleanup();
    return;
  }

  let finalAudioEncoderConfig: AudioEncoderConfig | null = null;
  let audioCodec =
    currentConfig.codec?.audio ??
    (currentConfig.container === "webm" ? "opus" : "aac");
  if (currentConfig.container === "webm" && audioCodec === "aac") {
    console.warn(
      "Worker: AAC audio codec is not compatible with WebM. Switching to Opus.",
    );
    audioCodec = "opus";
  }

  if (!audioDisabled) {
    const resolvedAudioCodecString =
      currentConfig.codecString?.audio ??
      (audioCodec === "opus" ? "opus" : "mp4a.40.2");

    const baseAudioConfig = {
      sampleRate: currentConfig.sampleRate,
      numberOfChannels: currentConfig.channels,
      bitrate: currentConfig.audioBitrate,
      codec: resolvedAudioCodecString,
      ...(currentConfig.audioBitrateMode && {
        bitrateMode: currentConfig.audioBitrateMode,
      }),
      ...(currentConfig.latencyMode && {
        latencyMode: currentConfig.latencyMode,
      }),
      ...(currentConfig.hardwareAcceleration && {
        hardwareAcceleration: currentConfig.hardwareAcceleration,
      }),
      ...(currentConfig.audioEncoderConfig ?? {}),
    };

    const AudioEncoderCtor: any = getAudioEncoder();
    if (!AudioEncoderCtor) {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Worker: AudioEncoder not available",
          type: EncoderErrorType.NotSupported,
        },
      });
      cleanup();
      return;
    }

    let audioSupport = await AudioEncoderCtor.isConfigSupported(
      baseAudioConfig as any,
    );
    if (audioSupport?.supported) {
      finalAudioEncoderConfig = audioSupport.config as AudioEncoderConfig;
    } else if (audioCodec === "opus") {
      console.warn(
        `Worker: Audio codec ${audioCodec} not supported or config invalid. Falling back to AAC.`,
      );
      if (currentConfig.container === "webm") {
        postMessageToMainThread({
          type: "error",
          errorDetail: {
            message:
              "Worker: Opus audio codec not supported for WebM container.",
            type: EncoderErrorType.NotSupported,
          },
        });
        cleanup();
        return;
      }
      audioCodec = "aac";
      const fallbackAudioConfig = {
        ...baseAudioConfig,
        codec: currentConfig.codecString?.audio ?? "mp4a.40.2",
      };
      audioSupport = await AudioEncoderCtor.isConfigSupported(
        fallbackAudioConfig as any,
      );
      if (audioSupport?.supported) {
        finalAudioEncoderConfig = audioSupport.config as AudioEncoderConfig;
      } else {
        postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: "Worker: AAC audio codec is not supported after fallback.",
            type: EncoderErrorType.NotSupported,
          },
        });
        cleanup();
        return;
      }
    } else {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Worker: Audio codec ${audioCodec} config not supported.`,
          type: EncoderErrorType.NotSupported,
        },
      });
      cleanup();
      return;
    }

    try {
      audioEncoder = new AudioEncoderCtor({
        output: (chunk: any, meta: any) => {
          if (isCancelled || !muxer) return;
          muxer.addAudioChunk(chunk, meta);
        },
        error: (error: any) => {
          if (isCancelled) return;
          postMessageToMainThread({
            type: "error",
            errorDetail: {
              message: `AudioEncoder error: ${error.message}`,
              type: EncoderErrorType.AudioEncodingError,
              stack: error.stack,
            },
          });
          cleanup();
        },
      });
      if (audioEncoder) {
        audioEncoder.configure(finalAudioEncoderConfig as any);
      } else {
        postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: "Worker: AudioEncoder instance is null after creation.",
            type: EncoderErrorType.InitializationFailed,
          },
        });
        cleanup();
        return;
      }
    } catch (e: any) {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Worker: Failed to initialize AudioEncoder: ${e.message}`,
          type: EncoderErrorType.InitializationFailed,
          stack: e.stack,
        },
      });
      cleanup();
      return;
    }
  }

  postMessageToMainThread({
    type: "initialized",
    actualVideoCodec: finalVideoEncoderConfig?.codec,
    actualAudioCodec: audioDisabled ? null : finalAudioEncoderConfig?.codec,
  } as MainThreadMessage);
}

async function handleAddVideoFrame(data: AddVideoFrameMessage): Promise<void> {
  if (isCancelled || !videoEncoder || !currentConfig) return;
  try {
    const frame = data.frame;
    const interval = currentConfig.keyFrameInterval;
    const opts =
      interval && videoFrameCount % interval === 0
        ? ({ keyFrame: true } as VideoEncoderEncodeOptions)
        : undefined;
    videoEncoder.encode(frame, opts as any);
    frame.close();
    videoFrameCount++;
    processedFrames++;
    const progressMessage: any = {
      type: "progress",
      processedFrames,
    };
    if (typeof totalFramesToProcess !== "undefined") {
      progressMessage.totalFrames = totalFramesToProcess;
    }
    postMessageToMainThread(progressMessage as MainThreadMessage);
    postQueueSize();
  } catch (error: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Error encoding video frame: ${error.message}`,
        type: EncoderErrorType.VideoEncodingError,
        stack: error.stack,
      },
    } as MainThreadMessage);
    cleanup();
  }
}

async function handleAddAudioData(data: AddAudioDataMessage): Promise<void> {
  if (isCancelled || !audioEncoder || !currentConfig) return;

  if (data.audio) {
    try {
      audioEncoder.encode(data.audio);
      postQueueSize();
    } catch (error: any) {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: `Error encoding audio data: ${error.message}`,
          type: EncoderErrorType.AudioEncodingError,
          stack: error.stack,
        },
      } as MainThreadMessage);
      cleanup();
    }
    return;
  }

  if (!data.audioData || data.audioData.length === 0) return;

  if (data.audioData.length !== currentConfig.channels) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Audio data channel count (${data.audioData.length}) does not match configured channels (${currentConfig.channels}).`,
        type: EncoderErrorType.ConfigurationError,
      },
    } as MainThreadMessage);
    return;
  }

  const AudioDataCtor: any = getAudioData();
  if (!AudioDataCtor) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: "Worker: AudioData not available",
        type: EncoderErrorType.NotSupported,
      },
    });
    cleanup();
    return;
  }

  try {
    // data.audioData (Float32Array[]) をインターリーブして単一の Float32Array にするヘルパー関数
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
      format: "f32", // インターリーブしたので 'f32'
      sampleRate: data.sampleRate,
      numberOfFrames: data.numberOfFrames,
      numberOfChannels: data.numberOfChannels,
      timestamp: data.timestamp,
      data: interleavedData.buffer, // インターリーブされたデータの ArrayBuffer を渡す
    });
    try {
      audioEncoder.encode(audioData);
      postQueueSize();
    } finally {
      audioData.close();
    }
  } catch (error: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Error encoding audio data: ${error.message}`,
        type: EncoderErrorType.AudioEncodingError,
        stack: error.stack,
      },
    } as MainThreadMessage);
    cleanup();
  }
}

async function handleFinalize(_message: FinalizeWorkerMessage): Promise<void> {
  if (isCancelled) return;

  try {
    if (videoEncoder) await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();

    if (muxer) {
      const uint8ArrayOrNullOutput = muxer.finalize();
      if (uint8ArrayOrNullOutput) {
        postMessageToMainThread(
          { type: "finalized", output: uint8ArrayOrNullOutput },
          [uint8ArrayOrNullOutput.buffer],
        );
      } else if (currentConfig?.latencyMode === "realtime") {
        postMessageToMainThread({ type: "finalized", output: null });
      } else {
        postMessageToMainThread({
          type: "error",
          errorDetail: {
            message: "Muxer finalized without output in non-realtime mode.",
            type: EncoderErrorType.MuxingFailed,
          },
        });
      }
    } else {
      postMessageToMainThread({
        type: "error",
        errorDetail: {
          message: "Muxer not initialized during finalize.",
          type: EncoderErrorType.MuxingFailed,
        },
      });
    }
  } catch (error: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Error during finalization: ${error.message}`,
        type: EncoderErrorType.MuxingFailed,
        stack: error.stack,
      },
    } as MainThreadMessage);
  } finally {
    cleanup();
  }
}

function handleCancel(_message: CancelWorkerMessage): void {
  if (isCancelled) return;
  isCancelled = true;
  logger.log("Worker: Received cancel signal.");
  videoEncoder?.close();
  audioEncoder?.close();
  cleanup(false);
  postMessageToMainThread({ type: "cancelled" } as MainThreadMessage);
}

function cleanup(resetCancelled: boolean = true): void {
  logger.log("Worker: Cleaning up resources.");
  if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
  if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
  videoEncoder = null;
  audioEncoder = null;
  muxer = null;
  currentConfig = null;
  totalFramesToProcess = undefined;
  processedFrames = 0;
  videoFrameCount = 0;
  if (audioWorkletPort) {
    audioWorkletPort.onmessage = null;
    audioWorkletPort.close();
    audioWorkletPort = null;
  }
  if (resetCancelled) {
    isCancelled = false;
  }
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (
    isCancelled &&
    event.data.type !== "initialize" &&
    event.data.type !== "cancel"
  ) {
    console.warn(
      `Worker: Ignoring message type '${event.data.type}' because worker is cancelled.`,
    );
    return;
  }

  try {
    switch (event.data.type) {
      case "initialize":
        isCancelled = false;
        cleanup();
        await initializeEncoders(event.data);
        break;
      case "connectAudioPort":
        audioWorkletPort = event.data.port;
        audioWorkletPort.onmessage = async (
          e: MessageEvent<AddAudioDataMessage>,
        ) => {
          if (isCancelled) return;
          await handleAddAudioData(e.data);
        };
        break;
      case "addVideoFrame":
        if (isCancelled) break;
        await handleAddVideoFrame(event.data);
        break;
      case "addAudioData":
        if (isCancelled) break;
        await handleAddAudioData(event.data);
        break;
      case "finalize":
        if (isCancelled) break;
        await handleFinalize(event.data);
        break;
      case "cancel":
        handleCancel(event.data);
        break;
      default:
        console.warn(
          "Worker received unknown message type:",
          (event.data as any)?.type,
        );
    }
  } catch (error: any) {
    postMessageToMainThread({
      type: "error",
      errorDetail: {
        message: `Unhandled error in worker onmessage: ${error.message}`,
        type: EncoderErrorType.InternalError,
        stack: error.stack,
      },
    } as MainThreadMessage);
    cleanup();
  }
};

logger.log("Worker script loaded.");
