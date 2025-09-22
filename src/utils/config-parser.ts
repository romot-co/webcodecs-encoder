/**
 * 設定の推定・変換・マージ処理のユーティリティ
 */

import {
  EncodeOptions,
  VideoSource,
  Frame,
  QualityPreset,
  EncoderConfig,
  VideoFile,
} from "../types";

/**
 * VideoSourceから設定を推定し、EncodeOptionsとマージして最終的なEncoderConfigを生成
 */
export async function inferAndBuildConfig(
  source: VideoSource,
  options?: EncodeOptions,
): Promise<EncoderConfig> {
  // ソースから基本的な設定を推定
  const inferredConfig = await inferConfigFromSource(source);

  // ユーザー指定のオプションをマージ
  const mergedOptions = mergeWithUserOptions(inferredConfig, options);

  // 品質プリセットを適用
  const configWithPreset = applyQualityPreset(mergedOptions, options?.quality);

  // 最終的なEncoderConfigに変換
  return convertToEncoderConfig(configWithPreset);
}

/**
 * VideoSourceから基本設定を推定
 */
async function inferConfigFromSource(
  source: VideoSource,
): Promise<Partial<EncodeOptions>> {
  const config: Partial<EncodeOptions> = {
    frameRate: 30, // デフォルト値
    container: "mp4", // デフォルト値
  };

  try {
    // 最初のフレームを取得して解像度を推定
    const firstFrame = await getFirstFrame(source);
    if (firstFrame) {
      const dimensions = getFrameDimensions(firstFrame);
      config.width = dimensions.width;
      config.height = dimensions.height;
    }

    if (isVideoFileSource(source)) {
      await enrichConfigFromVideoFile(config, source);
    }

    // MediaStreamの場合はビデオ・オーディオトラックの有無も確認
    if (source instanceof MediaStream) {
      const videoTracks = source.getVideoTracks();
      const audioTracks = source.getAudioTracks();

      // ビデオトラックがない場合
      if (videoTracks.length === 0) {
        config.video = false; // ビデオなし
      }

      if (audioTracks.length === 0) {
        config.audio = false; // オーディオなし
      } else {
        // MediaStreamTrackからオーディオ設定を推定
        const audioTrack = audioTracks[0];
        const settings = audioTrack.getSettings();
        config.audio = {
          sampleRate: settings.sampleRate || 48000,
          channels: settings.channelCount || 2,
        };
      }
    }
  } catch (error) {
    // 推定に失敗した場合はデフォルト値を使用
    config.width = 640;
    config.height = 480;
  }

  return config;
}

/**
 * ユーザー指定のオプションをマージ
 */
function mergeWithUserOptions(
  inferredConfig: Partial<EncodeOptions>,
  userOptions?: EncodeOptions,
): EncodeOptions {
  const mergeNestedConfig = <T extends Record<string, any>>(
    inferredValue: T | false | undefined,
    userValue: T | false | undefined,
  ): T | false | undefined => {
    if (userValue === false) {
      return false;
    }

    if (userValue === undefined) {
      if (inferredValue === false) {
        return false;
      }
      if (inferredValue && typeof inferredValue === "object") {
        return { ...inferredValue };
      }
      return inferredValue;
    }

    if (inferredValue === false || inferredValue == null) {
      return { ...userValue } as T;
    }

    return {
      ...(inferredValue as T),
      ...(userValue as T),
    };
  };

  return {
    // 推定された設定をベースに
    ...inferredConfig,
    // ユーザー指定の設定で上書き
    ...userOptions,
    // ネストしたオブジェクトは個別にマージ
    video: mergeNestedConfig(
      inferredConfig.video as any,
      userOptions?.video as any,
    ) as any,
    audio: mergeNestedConfig(
      inferredConfig.audio as any,
      userOptions?.audio as any,
    ) as any,
  };
}

/**
 * 品質プリセットを適用
 */
function applyQualityPreset(
  config: EncodeOptions,
  quality?: QualityPreset,
): EncodeOptions {
  if (!quality) return config;

  const width = config.width || 640;
  const height = config.height || 480;
  const pixels = width * height;

  // 解像度とフレームレートに基づいてビットレートを計算
  const basePixelsPerSecond = pixels * (config.frameRate || 30);

  let videoBitrate: number;
  let audioBitrate: number;

  switch (quality) {
    case "low":
      videoBitrate = Math.max(500_000, basePixelsPerSecond * 0.1);
      audioBitrate = 64_000;
      break;
    case "medium":
      videoBitrate = Math.max(1_000_000, basePixelsPerSecond * 0.2);
      audioBitrate = 128_000;
      break;
    case "high":
      videoBitrate = Math.max(2_000_000, basePixelsPerSecond * 0.4);
      audioBitrate = 192_000;
      break;
    case "lossless":
      videoBitrate = Math.max(10_000_000, basePixelsPerSecond * 1.0);
      audioBitrate = 320_000;
      break;
    default:
      return config;
  }

  const mergedAudio =
    config.audio === false
      ? false
      : {
          ...(config.audio as any),
        };

  if (mergedAudio && typeof mergedAudio === "object") {
    const codec = (mergedAudio.codec || "aac") as any;
    if (
      codec !== "pcm" &&
      codec !== "ulaw" &&
      codec !== "alaw" &&
      mergedAudio.bitrate == null
    ) {
      mergedAudio.bitrate = audioBitrate;
    }
  }

  return {
    ...config,
    video:
      config.video === false
        ? false
        : {
            ...(config.video as any),
            bitrate: (config.video as any)?.bitrate || videoBitrate,
          },
    audio: mergedAudio,
  };
}

/**
 * EncodeOptionsから内部のEncoderConfigに変換
 */
function convertToEncoderConfig(options: EncodeOptions): EncoderConfig {
  const config: EncoderConfig = {
    width: options.video === false ? 0 : options.width || 640,
    height: options.video === false ? 0 : options.height || 480,
    frameRate: options.frameRate || 30,
    videoBitrate:
      options.video === false
        ? 0
        : (options.video as any)?.bitrate || 1_000_000,
    audioBitrate: 0,
    sampleRate: 0,
    channels: 0,
    container: options.container || "mp4",
    codec: {
      video:
        options.video === false
          ? undefined
          : (options.video as any)?.codec || "avc",
      audio: undefined,
    },
    latencyMode:
      options.video === false
        ? "quality"
        : options.latencyMode ||
          (options.video as any)?.latencyMode ||
          "quality",
    hardwareAcceleration:
      options.video === false
        ? "no-preference"
        : (options.video as any)?.hardwareAcceleration || "no-preference",
    keyFrameInterval:
      options.video === false
        ? undefined
        : (options.video as any)?.keyFrameInterval,
    audioBitrateMode: undefined,
    firstTimestampBehavior: options.firstTimestampBehavior || "offset",
    maxVideoQueueSize: options.maxVideoQueueSize || 30,
    maxAudioQueueSize: options.maxAudioQueueSize || 30,
    backpressureStrategy: options.backpressureStrategy || "drop",
  };

  if (options.audio !== false) {
    const audioOptions = (options.audio as any) || {};
    const requestedCodec = (audioOptions.codec || "aac") as any;
    const isTelephonyCodec =
      requestedCodec === "ulaw" || requestedCodec === "alaw";
    const isPcmCodec = requestedCodec === "pcm";

    const defaultSampleRate =
      audioOptions.sampleRate || (isTelephonyCodec ? 8000 : 48000);
    const defaultChannels = audioOptions.channels || (isTelephonyCodec ? 1 : 2);

    let defaultBitrate: number | undefined = audioOptions.bitrate;
    if (defaultBitrate == null) {
      if (isPcmCodec) {
        defaultBitrate = defaultSampleRate * defaultChannels * 16; // Approximate bits per second
      } else if (isTelephonyCodec) {
        defaultBitrate = 64_000;
      } else if (requestedCodec === "mp3") {
        defaultBitrate = 128_000;
      } else if (requestedCodec === "flac") {
        defaultBitrate = 512_000;
      } else if (requestedCodec === "vorbis") {
        defaultBitrate = 128_000;
      } else {
        defaultBitrate = 128_000;
      }
    }

    config.sampleRate = defaultSampleRate;
    config.channels = defaultChannels;
    config.audioBitrate = defaultBitrate;
    config.codec = {
      ...config.codec,
      audio: requestedCodec,
    };
    config.audioBitrateMode =
      audioOptions.bitrateMode ||
      (requestedCodec === "aac" ? "variable" : "constant");
  }

  if (options.audio === false) {
    config.codec = {
      ...config.codec,
      audio: undefined,
    };
  }

  return config;
}

/**
 * VideoSourceから最初のフレームを取得（AsyncIterableの場合、元のイテレータを消費しない）
 */
async function getFirstFrame(source: VideoSource): Promise<Frame | null> {
  if (Array.isArray(source)) {
    return source.length > 0 ? source[0] : null;
  }

  if (source instanceof MediaStream) {
    // MediaStreamから最初のフレームを取得するのは複雑なので、
    // VideoTrackの設定から解像度を推定
    const videoTracks = source.getVideoTracks();
    if (videoTracks.length > 0) {
      const settings = videoTracks[0].getSettings();
      if (settings.width && settings.height) {
        // 仮想的なフレームサイズ情報として返す
        return {
          displayWidth: settings.width,
          displayHeight: settings.height,
        } as any;
      }
    }
    return null;
  }

  if (source && typeof (source as any)[Symbol.asyncIterator] === "function") {
    // AsyncIterableは先頭フレームを安全にプレビューする手段がないため
    // ここでは推定を行わず、後続処理でデフォルト値にフォールバックする
    return null;
  }

  // VideoFileの場合は実装が必要（今回は簡略化）
  return null;
}

async function enrichConfigFromVideoFile(
  config: Partial<EncodeOptions>,
  videoFile: VideoFile,
): Promise<void> {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const file = videoFile.file;
  if (!(typeof Blob !== "undefined" && file instanceof Blob)) {
    return;
  }

  const video = document.createElement("video");
  video.preload = "metadata";

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
      };
      video.onloadedmetadata = () => {
        cleanup();
        resolve();
      };
      video.onerror = () => {
        cleanup();
        reject(new Error("Failed to load video metadata"));
      };
    });

    if (video.videoWidth && video.videoHeight) {
      config.width = video.videoWidth;
      config.height = video.videoHeight;
    }

    if (!config.container && typeof videoFile.type === "string") {
      if (videoFile.type.includes("webm")) {
        config.container = "webm";
      } else if (videoFile.type.includes("mp4")) {
        config.container = "mp4";
      }
    }
  } catch (error) {
    console.warn("Failed to infer metadata from VideoFile", error);
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    video.src = "";
    video.remove?.();
  }
}

function isVideoFileSource(source: VideoSource): source is VideoFile {
  if (!source || typeof source !== "object") {
    return false;
  }

  const maybeVideoFile = source as Partial<VideoFile> & { file?: unknown };
  if (!("file" in maybeVideoFile)) {
    return false;
  }

  const file = maybeVideoFile.file;
  if (typeof Blob !== "undefined" && file instanceof Blob) {
    return true;
  }
  return false;
}

/**
 * フレームから解像度を取得
 */
function getFrameDimensions(frame: Frame | null): {
  width: number;
  height: number;
} {
  if (!frame) {
    return { width: 640, height: 480 };
  }

  if (frame instanceof VideoFrame) {
    return {
      width: frame.displayWidth || frame.codedWidth,
      height: frame.displayHeight || frame.codedHeight,
    };
  }

  if (frame instanceof HTMLCanvasElement || frame instanceof OffscreenCanvas) {
    return { width: frame.width, height: frame.height };
  }

  if (frame instanceof ImageBitmap) {
    return { width: frame.width, height: frame.height };
  }

  if (frame instanceof ImageData) {
    return { width: frame.width, height: frame.height };
  }

  // 仮想的なフレーム情報の場合
  if ("displayWidth" in frame && "displayHeight" in frame) {
    return {
      width: (frame as any).displayWidth,
      height: (frame as any).displayHeight,
    };
  }

  return { width: 640, height: 480 };
}
