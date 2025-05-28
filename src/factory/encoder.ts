/**
 * カスタムエンコーダーファクトリ
 */

import { encode } from "../core/encode";
import { encodeStream } from "../stream/encode-stream";
import { EncodeOptions, VideoSource } from "../types";

/**
 * エンコーダー関数のファクトリ
 * 設定を事前に部分適用した専用エンコーダー関数を作成
 */
export interface EncoderFactory {
  /**
   * ワンショットエンコード
   */
  encode(
    source: VideoSource,
    additionalOptions?: Partial<EncodeOptions>,
  ): Promise<Uint8Array>;

  /**
   * ストリーミングエンコード
   */
  encodeStream(
    source: VideoSource,
    additionalOptions?: Partial<EncodeOptions>,
  ): AsyncGenerator<Uint8Array>;

  /**
   * 設定された設定を取得
   */
  getConfig(): EncodeOptions;

  /**
   * 新しい設定でファクトリを拡張
   */
  extend(newOptions: Partial<EncodeOptions>): EncoderFactory;
}

/**
 * カスタムエンコーダーファクトリを作成
 *
 * @param baseOptions 基本エンコードオプション
 * @returns 設定済みエンコーダーファクトリ
 */
export function createEncoder(baseOptions: EncodeOptions = {}): EncoderFactory {
  const factory: EncoderFactory = {
    async encode(
      source: VideoSource,
      additionalOptions?: Partial<EncodeOptions>,
    ): Promise<Uint8Array> {
      const mergedOptions = mergeOptions(baseOptions, additionalOptions);
      return encode(source, mergedOptions);
    },

    async *encodeStream(
      source: VideoSource,
      additionalOptions?: Partial<EncodeOptions>,
    ): AsyncGenerator<Uint8Array> {
      const mergedOptions = mergeOptions(baseOptions, additionalOptions);
      yield* encodeStream(source, mergedOptions);
    },

    getConfig(): EncodeOptions {
      return { ...baseOptions };
    },

    extend(newOptions: Partial<EncodeOptions>): EncoderFactory {
      const extendedOptions = mergeOptions(baseOptions, newOptions);
      return createEncoder(extendedOptions);
    },
  };

  return factory;
}

/**
 * オプションをマージ
 */
function mergeOptions(
  base: EncodeOptions,
  additional?: Partial<EncodeOptions>,
): EncodeOptions {
  if (!additional) {
    return { ...base };
  }

  return {
    ...base,
    ...additional,
    // ネストしたオブジェクトは個別にマージ
    video: {
      ...base.video,
      ...additional.video,
    },
    audio:
      additional.audio === false
        ? false
        : {
            ...(base.audio as any),
            ...(additional.audio as any),
          },
  };
}

/**
 * 事前定義されたエンコーダーファクトリ
 */
export const encoders = {
  /**
   * YouTube向け高品質エンコーダー
   */
  youtube: createEncoder({
    quality: "high",
    frameRate: 60,
    video: { codec: "avc" },
    audio: { codec: "aac", bitrate: 192_000 },
    container: "mp4",
  }),

  /**
   * Twitter向け最適化エンコーダー
   */
  twitter: createEncoder({
    quality: "medium",
    width: 1280,
    height: 720,
    video: { bitrate: 2_000_000 },
    audio: { bitrate: 128_000 },
    container: "mp4",
  }),

  /**
   * Discord向け最適化エンコーダー
   */
  discord: createEncoder({
    quality: "medium",
    video: { bitrate: 2_000_000 },
    audio: { bitrate: 128_000 },
    container: "mp4",
  }),

  /**
   * Web再生向けバランス型エンコーダー
   */
  web: createEncoder({
    quality: "medium",
    container: "mp4",
    video: { codec: "avc" },
    audio: { codec: "aac" },
  }),

  /**
   * 軽量・高速エンコーダー
   */
  fast: createEncoder({
    quality: "low",
    video: {
      codec: "avc",
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    },
    audio: {
      codec: "aac",
      bitrate: 64_000,
    },
  }),

  /**
   * 高品質・低圧縮エンコーダー
   */
  lossless: createEncoder({
    quality: "lossless",
    video: {
      codec: "hevc",
      latencyMode: "quality",
    },
    audio: {
      codec: "aac",
      bitrate: 320_000,
    },
  }),

  /**
   * VP9ストリーミング用エンコーダー
   */
  vp9Stream: createEncoder({
    quality: "medium",
    container: "webm",
    video: {
      codec: "vp9",
      latencyMode: "realtime",
    },
    audio: { codec: "opus" },
  }),
};

/**
 * 使用例とヘルパー関数
 */
export const examples = {
  /**
   * プラットフォーム別のエンコーダーを取得
   */
  getEncoderForPlatform(
    platform: "youtube" | "twitter" | "discord" | "web",
  ): EncoderFactory {
    return encoders[platform];
  },

  /**
   * 解像度ベースのエンコーダーを作成
   */
  createByResolution(width: number, height: number): EncoderFactory {
    // 解像度に基づいて品質を自動選択
    const pixels = width * height;
    let quality: "low" | "medium" | "high";

    if (pixels <= 640 * 480) {
      quality = "low";
    } else if (pixels <= 1920 * 1080) {
      quality = "medium";
    } else {
      quality = "high";
    }

    return createEncoder({
      width,
      height,
      quality,
    });
  },

  /**
   * ファイルサイズ制約ベースのエンコーダーを作成
   */
  createForFileSize(
    targetSizeMB: number,
    durationSeconds: number,
  ): EncoderFactory {
    // ファイルサイズからビットレートを逆算
    const targetBits = targetSizeMB * 8 * 1024 * 1024;
    const totalBitrate = Math.floor(targetBits / durationSeconds);
    const videoBitrate = Math.floor(totalBitrate * 0.8); // 80%をビデオに
    const audioBitrate = Math.floor(totalBitrate * 0.2); // 20%をオーディオに

    return createEncoder({
      video: { bitrate: videoBitrate },
      audio: { bitrate: Math.min(audioBitrate, 320_000) }, // 上限320kbps
    });
  },
};
