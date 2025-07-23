/**
 * VideoFrame変換ユーティリティ
 */

import { EncodeError, Frame } from "../types";

/**
 * FrameをVideoFrameに変換
 */
export async function convertToVideoFrame(
  frame: Frame,
  timestamp: number,
): Promise<VideoFrame> {
  if (frame instanceof VideoFrame) {
    // Always create a new VideoFrame to ensure clear ownership
    // The caller owns the returned VideoFrame and must close it
    return new VideoFrame(frame, { timestamp });
  }

  // 他のFrame型をVideoFrameに変換
  if (frame instanceof HTMLCanvasElement) {
    return new VideoFrame(frame, { timestamp });
  }

  if (frame instanceof OffscreenCanvas) {
    return new VideoFrame(frame, { timestamp });
  }

  if (frame instanceof ImageBitmap) {
    return new VideoFrame(frame, { timestamp });
  }

  if (frame instanceof ImageData) {
    // ImageDataの場合、BufferInitを使用
    return new VideoFrame(frame.data, {
      format: "RGBA",
      codedWidth: frame.width,
      codedHeight: frame.height,
      timestamp,
    });
  }

  // テスト環境でのモックオブジェクトの場合、プロパティベースで判定
  if (frame && typeof frame === "object") {
    // ImageDataに似たオブジェクト
    if ("width" in frame && "height" in frame && "data" in frame) {
      const imageDataLike = frame as {
        width: number;
        height: number;
        data: Uint8ClampedArray;
      };
      return new VideoFrame(imageDataLike.data, {
        format: "RGBA",
        codedWidth: imageDataLike.width,
        codedHeight: imageDataLike.height,
        timestamp,
      });
    }

    // Canvasに似たオブジェクト
    if (
      "width" in frame &&
      "height" in frame &&
      ("getContext" in frame || "transferToImageBitmap" in frame)
    ) {
      return new VideoFrame(frame as any, { timestamp });
    }

    // ImageBitmapに似たオブジェクト
    if (
      "width" in frame &&
      "height" in frame &&
      "close" in frame &&
      typeof (frame as any).close === "function"
    ) {
      return new VideoFrame(frame as any, { timestamp });
    }
  }

  throw new EncodeError(
    "invalid-input",
    `Unsupported frame type: ${typeof frame}. Frame must be VideoFrame, HTMLCanvasElement, OffscreenCanvas, ImageBitmap, or ImageData.`,
  );
}
