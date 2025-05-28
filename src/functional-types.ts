/**
 * 新しい関数ファーストAPI用の型定義
 */

// 基本的なフレーム型
export type Frame = VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData;

// ビデオファイル型
export interface VideoFile {
  file: File | Blob;
  type: string;
}

// ビデオソース型（すべての入力形式）
export type VideoSource = 
  | Frame[]                    // 静的フレーム配列
  | AsyncIterable<Frame>       // ストリーミングフレーム
  | MediaStream               // カメラ/画面共有
  | VideoFile;                // 既存の動画ファイル

// 品質プリセット
export type QualityPreset = 'low' | 'medium' | 'high' | 'lossless';

// ビデオ設定
export interface VideoConfig {
  codec?: 'avc' | 'hevc' | 'vp9' | 'vp8' | 'av1';
  bitrate?: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  latencyMode?: 'quality' | 'realtime';
  keyFrameInterval?: number;
}

// オーディオ設定
export interface AudioConfig {
  codec?: 'aac' | 'opus';
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  bitrateMode?: 'constant' | 'variable';
}

// プログレス情報
export interface ProgressInfo {
  percent: number;
  processedFrames: number;
  totalFrames: number;
  fps: number;
  stage: 'encoding' | 'streaming' | 'finalizing';
  estimatedRemainingMs?: number;
}

// エンコードオプション
export interface EncodeOptions {
  // 基本設定
  width?: number;
  height?: number;
  frameRate?: number;
  quality?: QualityPreset;
  container?: 'mp4' | 'webm';
  
  // 詳細設定
  video?: VideoConfig;
  audio?: AudioConfig | false;
  
  // コールバック
  onProgress?: (progress: ProgressInfo) => void;
  onError?: (error: Error) => void;
}

// プリセット定義
export interface PresetConfig extends EncodeOptions {
  readonly name: string;
  readonly description: string;
}

// よく使われるプリセット
export const PRESETS: Record<string, PresetConfig> = {
  youtube: {
    name: 'YouTube',
    description: 'High quality for YouTube uploads',
    quality: 'high',
    frameRate: 60,
    video: { codec: 'avc' },
    audio: { codec: 'aac', bitrate: 192_000 }
  },
  twitter: {
    name: 'Twitter',
    description: 'Optimized for Twitter video',
    quality: 'medium',
    width: 1280,
    height: 720,
    video: { bitrate: 2_000_000 }
  },
  discord: {
    name: 'Discord',
    description: 'Optimized for Discord sharing',
    quality: 'medium',
    video: { bitrate: 2_000_000 },
    audio: { bitrate: 128_000 }
  },
  web: {
    name: 'Web',
    description: 'Balanced quality for web playback',
    quality: 'medium',
    container: 'mp4',
    video: { codec: 'avc' }
  }
}; 