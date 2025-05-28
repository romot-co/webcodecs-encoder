export { WebCodecsEncoder } from "./encoder";
export { MediaStreamRecorder } from "./mediastream-recorder";

// 新しい関数ファーストAPI
export { encode, encodeStream, canEncode } from "./functional-api";

export type {
  EncoderConfig,
  ProgressCallback,
  WebCodecsEncoderError,
  EncoderErrorType,
} from "./types";
export type {
  RealtimeDataCallback,
  WebCodecsEncoderInitializeOptions,
} from "./encoder";

// 新しいAPI用の型定義
export type {
  VideoSource,
  Frame,
  EncodeOptions,
  QualityPreset,
  VideoConfig,
  AudioConfig,
} from "./functional-types";
