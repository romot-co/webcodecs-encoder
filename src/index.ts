// メイン関数ファーストAPI
export { encode } from "./core/encode";
export { encodeStream } from "./stream/encode-stream";
export { canEncode } from "./utils/can-encode";

// 高度な使用向け：カスタムエンコーダーファクトリ
export { createEncoder, encoders, examples } from "./factory/encoder";
export type { EncoderFactory } from "./factory/encoder";

// レガシーサポート：既存のクラスベースAPI（非推奨）
export { MediaStreamRecorder } from "./mediastream-recorder";

// 型定義
export type {
  VideoSource,
  Frame,
  EncodeOptions,
  QualityPreset,
  VideoConfig,
  AudioConfig,
  ProgressInfo,
  EncodeErrorType,
  VideoFile,
} from "./types";

export { EncodeError } from './types';

// 内部実装用（高度な使用のみ）
export type {
  EncoderConfig,
  ProcessingStage,
  EncoderErrorType,
  WorkerMessage,
  MainThreadMessage,
  VideoEncoderGetter,
  AudioEncoderGetter,
  AudioDataGetter,
} from './types';
