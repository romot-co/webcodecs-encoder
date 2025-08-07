/**
 * 設定の推定・変換・マージ処理のユーティリティ
 */

import {
  EncodeOptions,
  VideoSource,
  Frame,
  QualityPreset,
  EncoderConfig,
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
  return {
    // 推定された設定をベースに
    ...inferredConfig,
    // ユーザー指定の設定で上書き
    ...userOptions,
    // ネストしたオブジェクトは個別にマージ
    video: {
      ...inferredConfig.video,
      ...userOptions?.video,
    },
    audio:
      userOptions?.audio === false
        ? false
        : {
            ...(inferredConfig.audio as any),
            ...userOptions?.audio,
          },
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

  return {
    ...config,
    video:
      config.video === false
        ? false
        : {
            ...(config.video as any),
            bitrate: (config.video as any)?.bitrate || videoBitrate,
          },
    audio:
      config.audio === false
        ? false
        : {
            ...(config.audio as any),
            bitrate: (config.audio as any)?.bitrate || audioBitrate,
          },
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
    audioBitrate:
      options.audio === false ? 0 : (options.audio as any)?.bitrate || 128_000,
    sampleRate:
      options.audio === false ? 0 : (options.audio as any)?.sampleRate || 48000,
    channels:
      options.audio === false ? 0 : (options.audio as any)?.channels || 2,
    container: options.container || "mp4",
    codec: {
      video:
        options.video === false
          ? undefined
          : (options.video as any)?.codec || "avc",
      audio:
        options.audio === false
          ? undefined
          : (options.audio as any)?.codec || "aac",
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
    audioBitrateMode:
      options.audio === false
        ? undefined
        : (options.audio as any)?.bitrateMode || "variable",
    firstTimestampBehavior: options.firstTimestampBehavior || "offset",
    maxVideoQueueSize: options.maxVideoQueueSize || 30,
    maxAudioQueueSize: options.maxAudioQueueSize || 30,
    backpressureStrategy: options.backpressureStrategy || "drop",
  };

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

  if (Symbol.asyncIterator in source) {
    // AsyncIterableの場合は最初の要素を取得するが、元のイテレータは保持
    const iterator = source[Symbol.asyncIterator]();
    const { value, done } = await iterator.next();
    
    if (!done && value) {
      // イテレータを閉じる（リソース解放）
      if (typeof iterator.return === 'function') {
        await iterator.return();
      }
      return value;
    }
    
    return null;
  }

  // VideoFileの場合は実装が必要（今回は簡略化）
  return null;
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
