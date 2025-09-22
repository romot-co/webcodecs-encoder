/**
 * Encode capability verification
 */

import { EncodeOptions, VideoConfig, AudioConfig } from "../types";

/**
 * Verify encode capability
 *
 * @param options Encode options
 * @returns Whether encoding is possible
 */
export async function canEncode(options?: EncodeOptions): Promise<boolean> {
  try {
    // Check basic WebCodecs support
    if (!isWebCodecsSupported()) {
      return false;
    }

    // Test with default configuration
    if (!options) {
      return await testDefaultConfiguration();
    }

    // Check video configuration unless explicitly disabled
    const hasVideoConfig = options.video && typeof options.video === "object";
    const videoEnabled = options.video !== false;
    if (videoEnabled) {
      const videoConfig = hasVideoConfig
        ? (options.video as VideoConfig)
        : undefined;
      const videoCodec = videoConfig?.codec ?? "avc";
      const videoSupported = await testVideoCodecSupport(videoCodec, options);
      if (!videoSupported) {
        return false;
      }
    }

    // Check audio configuration (only if audio is explicitly specified)
    const hasAudioConfig = options.audio && typeof options.audio === "object";
    if (hasAudioConfig) {
      const audioCodec = (options.audio as AudioConfig).codec || "aac";
      const audioSupported = await testAudioCodecSupport(audioCodec, options);
      if (!audioSupported) {
        return false;
      }
    } else if (options.audio === undefined && !hasVideoConfig) {
      // Only check audio for default configuration
      const audioSupported = await testAudioCodecSupport("aac", options);
      if (!audioSupported) {
        return false;
      }
    }

    return true;
  } catch (error) {
    // If error occurs, assume not supported
    console.warn("canEncode error:", error);
    return false;
  }
}

/**
 * Check basic WebCodecs support
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
 * Check encode capability with default configuration
 */
async function testDefaultConfiguration(): Promise<boolean> {
  try {
    const defaultWidth = 640;
    const defaultHeight = 480;
    const defaultFrameRate = 30;

    // Test H.264 (AVC)
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

    // Test AAC
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
 * Check video codec support
 */
async function testVideoCodecSupport(
  codec: string,
  options?: EncodeOptions,
): Promise<boolean> {
  try {
    const videoOptions =
      options?.video && typeof options.video === "object" ? options.video : {};
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
      bitrate: videoOptions.bitrate || 1_000_000,
      framerate: options?.frameRate || 30,
    };

    // Add optional detailed settings
    if (videoOptions.hardwareAcceleration) {
      config.hardwareAcceleration = videoOptions.hardwareAcceleration;
    }

    if (videoOptions.latencyMode) {
      config.latencyMode = videoOptions.latencyMode;
    }

    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported || false;
  } catch {
    return false;
  }
}

/**
 * Check audio codec support
 */
async function testAudioCodecSupport(
  codec: string,
  options?: EncodeOptions,
): Promise<boolean> {
  try {
    const codecString = getAudioCodecString(codec);
    const audioOptions =
      typeof options?.audio === "object" ? options.audio : {};

    const isTelephonyCodec = codec === "ulaw" || codec === "alaw";
    const isPcmCodec = codec === "pcm";
    const defaultSampleRate =
      audioOptions.sampleRate || (isTelephonyCodec ? 8000 : 48000);
    const defaultChannels = audioOptions.channels || (isTelephonyCodec ? 1 : 2);

    let defaultBitrate = audioOptions.bitrate;
    if (defaultBitrate == null) {
      if (codec === "flac") {
        defaultBitrate = 512_000;
      } else if (codec === "mp3") {
        defaultBitrate = 128_000;
      } else if (codec === "vorbis") {
        defaultBitrate = 128_000;
      } else if (isTelephonyCodec) {
        defaultBitrate = 64_000;
      } else if (isPcmCodec) {
        defaultBitrate = defaultSampleRate * defaultChannels * 16;
      } else {
        defaultBitrate = 128_000;
      }
    }

    const config: AudioEncoderConfig = {
      codec: codecString,
      sampleRate: defaultSampleRate,
      numberOfChannels: defaultChannels,
      bitrate: defaultBitrate,
    };

    // Add bitrateMode setting for AAC
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
 * Convert video codec name to WebCodecs string
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
      return "hvc1"; // Align with worker default
    case "vp9":
      return "vp09.00.50.08"; // Align with worker fallback string
    case "vp8":
      return "vp8"; // VP8
    case "av1":
      return "av01.0.04M.08"; // AV1 Main Profile Level 4.0
    default:
      return codec; // Return as is (for custom codec strings)
  }
}

/**
 * Dynamically generate AVC (H.264) codec string
 * Uses same logic as encoder-worker.ts
 */
export function generateAvcCodecString(
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
 * Try multiple AVC profiles and return the first supported one
 */
export async function generateSupportedAvcCodecString(
  width: number,
  height: number,
  frameRate: number,
  bitrate: number,
  preferredProfile?: "high" | "main" | "baseline",
): Promise<string | null> {
  // Define profile order based on preference
  const profiles: ("high" | "main" | "baseline")[] = preferredProfile
    ? (([preferredProfile, "main", "baseline", "high"] as const).filter(
        (p, i, arr) => arr.indexOf(p) === i, // remove duplicates
      ) as ("high" | "main" | "baseline")[])
    : ["high", "main", "baseline"];

  // Try each profile in order
  for (const profile of profiles) {
    const codecString = generateAvcCodecString(
      width,
      height,
      frameRate,
      profile,
    );

    try {
      const config: VideoEncoderConfig = {
        codec: codecString,
        width,
        height,
        bitrate,
        framerate: frameRate,
      };

      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) {
        return codecString;
      }
    } catch (error) {
      console.warn(
        `Failed to check support for AVC profile ${profile}:`,
        error,
      );
    }
  }

  return null;
}

/**
 * Convert audio codec name to WebCodecs string
 */
function getAudioCodecString(codec: string): string {
  switch (codec) {
    case "aac":
      return "mp4a.40.2"; // AAC-LC
    case "opus":
      return "opus"; // Opus
    case "flac":
      return "flac";
    case "mp3":
      return "mp3";
    case "vorbis":
      return "vorbis";
    case "pcm":
      return "pcm";
    case "ulaw":
      return "ulaw";
    case "alaw":
      return "alaw";
    default:
      return codec; // Return as is (for custom codec strings)
  }
}

/**
 * Check support for specific codec and profile (for advanced users)
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
    // Check video
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

    // Check audio
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
      result.audio = true; // Consider supported if no audio
    }

    result.overall = result.video && result.audio;
    return result;
  } catch (error) {
    console.warn("canEncodeWithProfile error:", error);
    return result;
  }
}
