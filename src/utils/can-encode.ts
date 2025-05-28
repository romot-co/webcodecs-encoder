/**
 * エンコード可能性の検証
 */

import { EncodeOptions, VideoConfig, AudioConfig } from "../types";

/**
 * エンコード可能性の検証
 *
 * @param options エンコードオプション
 * @returns エンコード可能かどうか
 */
export async function canEncode(options?: EncodeOptions): Promise<boolean> {
  try {
    // WebCodecsの基本サポート確認
    if (!isWebCodecsSupported()) {
      return false;
    }

    // デフォルト設定でのテスト
    if (!options) {
      return await testDefaultConfiguration();
    }

    // ビデオ設定の確認（ビデオが指定されている場合のみ）
    const hasVideoConfig = options.video && typeof options.video === "object";
    const hasVideo = hasVideoConfig || !options.audio;
    if (hasVideo) {
      const videoCodec = hasVideoConfig
        ? (options.video as VideoConfig).codec || "avc"
        : "avc";
      const videoSupported = await testVideoCodecSupport(videoCodec, options);
      if (!videoSupported) {
        return false;
      }
    }

    // オーディオ設定の確認（オーディオが明示的に指定されている場合のみ）
    const hasAudioConfig = options.audio && typeof options.audio === "object";
    if (hasAudioConfig) {
      const audioCodec = (options.audio as AudioConfig).codec || "aac";
      const audioSupported = await testAudioCodecSupport(audioCodec, options);
      if (!audioSupported) {
        return false;
      }
    } else if (options.audio === undefined && !hasVideoConfig) {
      // デフォルト設定の場合のみオーディオもチェック
      const audioSupported = await testAudioCodecSupport("aac", options);
      if (!audioSupported) {
        return false;
      }
    }

    return true;
  } catch (error) {
    // エラーが発生した場合は対応していないと判断
    console.warn("canEncode error:", error);
    return false;
  }
}

/**
 * WebCodecsの基本サポートを確認
 */
function isWebCodecsSupported(): boolean {
  try {
    return (
      typeof VideoEncoder !== "undefined" &&
      typeof AudioEncoder !== "undefined" &&
      typeof VideoFrame !== "undefined" &&
      typeof AudioData !== "undefined"
    );
  } catch {
    return false;
  }
}

/**
 * デフォルト設定でのエンコード可能性を確認
 */
async function testDefaultConfiguration(): Promise<boolean> {
  try {
    const defaultWidth = 640;
    const defaultHeight = 480;
    const defaultFrameRate = 30;

    // H.264 (AVC) のテスト
    const videoConfig: VideoEncoderConfig = {
      codec: generateAvcCodecString(
        defaultWidth,
        defaultHeight,
        defaultFrameRate,
      ),
      width: defaultWidth,
      height: defaultHeight,
      bitrate: 1_000_000,
      framerate: defaultFrameRate,
    };

    const videoSupport = await VideoEncoder.isConfigSupported(videoConfig);
    if (!videoSupport.supported) {
      return false;
    }

    // AAC のテスト
    const audioConfig: AudioEncoderConfig = {
      codec: "mp4a.40.2", // AAC-LC
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    };

    const audioSupport = await AudioEncoder.isConfigSupported(audioConfig);
    return audioSupport.supported || false;
  } catch {
    return false;
  }
}

/**
 * ビデオコーデックのサポートを確認
 */
async function testVideoCodecSupport(
  codec: string,
  options?: EncodeOptions,
): Promise<boolean> {
  try {
    const codecString = getVideoCodecString(
      codec,
      options?.width || 640,
      options?.height || 480,
      options?.frameRate || 30,
    );
    const config: VideoEncoderConfig = {
      codec: codecString,
      width: options?.width || 640,
      height: options?.height || 480,
      bitrate: options?.video?.bitrate || 1_000_000,
      framerate: options?.frameRate || 30,
    };

    // オプションの詳細設定を追加
    if (options?.video?.hardwareAcceleration) {
      config.hardwareAcceleration = options.video.hardwareAcceleration;
    }

    if (options?.video?.latencyMode) {
      config.latencyMode = options.video.latencyMode;
    }

    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported || false;
  } catch {
    return false;
  }
}

/**
 * オーディオコーデックのサポートを確認
 */
async function testAudioCodecSupport(
  codec: string,
  options?: EncodeOptions,
): Promise<boolean> {
  try {
    const codecString = getAudioCodecString(codec);
    const audioOptions =
      typeof options?.audio === "object" ? options.audio : {};

    const config: AudioEncoderConfig = {
      codec: codecString,
      sampleRate: audioOptions.sampleRate || 48000,
      numberOfChannels: audioOptions.channels || 2,
      bitrate: audioOptions.bitrate || 128_000,
    };

    // AACの場合、bitrateMode設定を追加
    if (codec === "aac" && audioOptions.bitrateMode) {
      (config as any).bitrateMode = audioOptions.bitrateMode;
    }

    const support = await AudioEncoder.isConfigSupported(config);
    return support.supported || false;
  } catch {
    return false;
  }
}

/**
 * ビデオコーデック名をWebCodecs用の文字列に変換
 */
function getVideoCodecString(
  codec: string,
  width = 640,
  height = 480,
  frameRate = 30,
): string {
  switch (codec) {
    case "avc":
      return generateAvcCodecString(width, height, frameRate);
    case "hevc":
      return "hev1.1.6.L93.B0"; // H.265 Main Profile
    case "vp9":
      return "vp09.00.10.08"; // VP9 Profile 0
    case "vp8":
      return "vp8"; // VP8
    case "av1":
      return "av01.0.04M.08"; // AV1 Main Profile Level 4.0
    default:
      return codec; // そのまま返す（カスタムコーデック文字列の場合）
  }
}

/**
 * AVC (H.264) コーデック文字列を動的に生成
 * encoder-worker.tsと同じロジックを使用
 */
function generateAvcCodecString(
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

  const chosenProfile =
    profile ?? (width >= 1280 || height >= 720 ? "high" : "baseline");
  const profileHex =
    chosenProfile === "high" ? "64" : chosenProfile === "main" ? "4d" : "42";
  const levelHex = level.toString(16).padStart(2, "0");

  return `avc1.${profileHex}00${levelHex}`;
}

/**
 * オーディオコーデック名をWebCodecs用の文字列に変換
 */
function getAudioCodecString(codec: string): string {
  switch (codec) {
    case "aac":
      return "mp4a.40.2"; // AAC-LC
    case "opus":
      return "opus"; // Opus
    default:
      return codec; // そのまま返す（カスタムコーデック文字列の場合）
  }
}

/**
 * 特定のコーデックとプロファイルでのサポート確認（上級者向け）
 */
export async function canEncodeWithProfile(
  videoCodec: string,
  audioCodec?: string,
  profile?: {
    width: number;
    height: number;
    framerate: number;
    videoBitrate: number;
    audioBitrate?: number;
  },
): Promise<{ video: boolean; audio: boolean; overall: boolean }> {
  const result = { video: false, audio: false, overall: false };

  try {
    // ビデオの確認
    if (videoCodec) {
      const videoConfig: VideoEncoderConfig = {
        codec: getVideoCodecString(videoCodec),
        width: profile?.width || 1920,
        height: profile?.height || 1080,
        bitrate: profile?.videoBitrate || 2_000_000,
        framerate: profile?.framerate || 30,
      };

      const videoSupport = await VideoEncoder.isConfigSupported(videoConfig);
      result.video = videoSupport.supported || false;
    }

    // オーディオの確認
    if (audioCodec) {
      const audioConfig: AudioEncoderConfig = {
        codec: getAudioCodecString(audioCodec),
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: profile?.audioBitrate || 128_000,
      };

      const audioSupport = await AudioEncoder.isConfigSupported(audioConfig);
      result.audio = audioSupport.supported || false;
    } else {
      result.audio = true; // オーディオなしの場合は対応とみなす
    }

    result.overall = result.video && result.audio;
    return result;
  } catch (error) {
    console.warn("canEncodeWithProfile error:", error);
    return result;
  }
}
