/**
 * ストリーミングエンコード関数の実装
 */

import {
  VideoSource,
  EncodeOptions,
  EncodeError,
  ProgressInfo,
} from "../types";
import { inferAndBuildConfig } from "../utils/config-parser";
import { WorkerCommunicator } from "../worker/worker-communicator";

/**
 * ストリーミングエンコード関数
 *
 * @param source エンコードするビデオソース
 * @param options エンコードオプション
 * @returns エンコードされたチャンクのAsyncGenerator
 */
export async function* encodeStream(
  source: VideoSource,
  options?: EncodeOptions,
): AsyncGenerator<Uint8Array> {
  let communicator: WorkerCommunicator | null = null;
  const chunks: Uint8Array[] = [];
  let isFinalized = false;
  let streamError: EncodeError | null = null;
  let processedFrames = 0;
  let totalFrames: number | undefined;
  const startTime = Date.now();

  try {
    // 設定の推定と正規化（リアルタイムモード優先）
    const config = await inferAndBuildConfig(source, options);
    config.latencyMode = "realtime"; // ストリーミング用に強制設定

    // ワーカーとの通信を開始
    communicator = new WorkerCommunicator();

    // プログレス情報の更新
    const updateProgress = (stage: string) => {
      if (options?.onProgress) {
        const elapsed = Date.now() - startTime;
        const fps =
          processedFrames > 0 ? (processedFrames / elapsed) * 1000 : 0;
        const percent = totalFrames ? (processedFrames / totalFrames) * 100 : 0;
        const estimatedRemainingMs =
          totalFrames && fps > 0
            ? ((totalFrames - processedFrames) / fps) * 1000
            : undefined;

        const progressInfo: ProgressInfo = {
          percent,
          processedFrames,
          totalFrames,
          fps,
          stage,
          estimatedRemainingMs,
        };

        options.onProgress(progressInfo);
      }
    };

    // エンコード処理の開始をPromiseで管理
    const encodingPromise = new Promise<void>((resolve, reject) => {
      // ワーカーからのメッセージを処理
      communicator!.on("initialized", () => {
        updateProgress("streaming");
        // フレーム処理を開始
        processVideoSource(communicator!, source, config)
          .then(() => {
            updateProgress("finalizing");
            communicator!.send("finalize");
          })
          .catch(reject);
      });

      communicator!.on(
        "progress",
        (data: { processedFrames: number; totalFrames?: number }) => {
          processedFrames = data.processedFrames;
          if (data.totalFrames !== undefined) {
            totalFrames = data.totalFrames;
          }
          updateProgress("streaming");
        },
      );

      communicator!.on("dataChunk", (data: { chunk: Uint8Array }) => {
        chunks.push(data.chunk);
      });

      communicator!.on("finalized", () => {
        isFinalized = true;
        updateProgress("finalizing");
        resolve();
      });

      communicator!.on("error", (data: { errorDetail: any }) => {
        streamError = new EncodeError(
          data.errorDetail.type || "encoding-failed",
          data.errorDetail.message || "Worker error",
          data.errorDetail,
        );
        reject(streamError);
      });

      // エンコード開始
      communicator!.send("initialize", { config });
    });

    // バックグラウンドでエンコード処理を実行
    encodingPromise.catch((error) => {
      streamError =
        error instanceof EncodeError
          ? error
          : new EncodeError(
              "encoding-failed",
              `Streaming failed: ${error.message}`,
              error,
            );

      if (options?.onError) {
        options.onError(streamError);
      }
    });

    // チャンクを順次yield
    while (!isFinalized && !streamError) {
      if (chunks.length > 0) {
        const chunk = chunks.shift()!;
        yield chunk;
      } else {
        // 少し待ってから再チェック
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // 残りのチャンクをyield
    while (chunks.length > 0) {
      const chunk = chunks.shift()!;
      yield chunk;
    }

    // エラーが発生した場合は例外をthrow
    if (streamError) {
      throw streamError;
    }

    // エンコード処理の完了を待機
    await encodingPromise;
  } catch (error) {
    // エラーの統一的な処理
    const encodeError =
      error instanceof EncodeError
        ? error
        : new EncodeError(
            "encoding-failed",
            `Stream encoding failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );

    if (options?.onError) {
      options.onError(encodeError);
    }

    throw encodeError;
  } finally {
    // リソースのクリーンアップ
    if (communicator) {
      communicator.terminate();
    }
  }
}

/**
 * VideoSourceを処理してワーカーに送信（ストリーミング向け）
 */
async function processVideoSource(
  communicator: WorkerCommunicator,
  source: VideoSource,
  config: any,
): Promise<void> {
  if (Array.isArray(source)) {
    // 静的フレーム配列の処理
    await processFrameArray(communicator, source);
  } else if (source instanceof MediaStream) {
    // MediaStreamの処理（リアルタイム）
    await processMediaStreamRealtime(communicator, source, config);
  } else if (Symbol.asyncIterator in source) {
    // AsyncIterableの処理
    await processAsyncIterable(communicator, source);
  } else {
    // VideoFileの処理（今回は基本実装）
    throw new EncodeError(
      "invalid-input",
      "VideoFile processing not yet implemented",
    );
  }
}

/**
 * フレーム配列を処理（ストリーミング向け）
 */
async function processFrameArray(
  communicator: WorkerCommunicator,
  frames: import("../types").Frame[],
): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const timestamp = (i * 1000000) / 30; // 30fpsを仮定してマイクロ秒で計算

    await addFrameToWorker(communicator, frame, timestamp);

    // ストリーミングのため、少し間隔を空ける
    await new Promise((resolve) => setTimeout(resolve, 33)); // ~30fps
  }
}

/**
 * AsyncIterableを処理（ストリーミング向け）
 */
async function processAsyncIterable(
  communicator: WorkerCommunicator,
  source: AsyncIterable<import("../types").Frame>,
): Promise<void> {
  let frameIndex = 0;

  for await (const frame of source) {
    const timestamp = (frameIndex * 1000000) / 30; // 30fpsを仮定
    await addFrameToWorker(communicator, frame, timestamp);
    frameIndex++;
  }
}

/**
 * MediaStreamをリアルタイム処理
 */
async function processMediaStreamRealtime(
  _communicator: WorkerCommunicator,
  _stream: MediaStream,
  _config: any,
): Promise<void> {
  // MediaStreamRecorderの機能を活用したリアルタイム処理
  // 実装の詳細は複雑なため、プレースホルダー
  throw new EncodeError(
    "invalid-input",
    "Real-time MediaStream processing requires more complex implementation",
  );
}

/**
 * フレームをワーカーに送信
 */
async function addFrameToWorker(
  communicator: WorkerCommunicator,
  frame: import("../types").Frame,
  timestamp: number,
): Promise<void> {
  // フレームをVideoFrameに変換
  const videoFrame = await convertToVideoFrame(frame, timestamp);

  try {
    communicator.send("addVideoFrame", {
      frame: videoFrame,
      timestamp,
    });
  } finally {
    // VideoFrameのリソースを解放
    if (videoFrame !== frame) {
      videoFrame.close();
    }
  }
}

/**
 * FrameをVideoFrameに変換
 */
async function convertToVideoFrame(
  frame: import("../types").Frame,
  timestamp: number,
): Promise<VideoFrame> {
  if (frame instanceof VideoFrame) {
    return frame;
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
