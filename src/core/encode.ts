/**
 * コアエンコード関数の実装
 */

import {
  VideoSource,
  EncodeOptions,
  EncodeError,
  Frame,
  ProgressInfo,
  VideoFile,
} from "../types";
import { inferAndBuildConfig } from "../utils/config-parser";
import { WorkerCommunicator } from "../worker/worker-communicator";

/**
 * ビデオエンコードのメイン関数
 *
 * @param source エンコードするビデオソース
 * @param options エンコードオプション
 * @returns エンコードされたバイナリデータ
 */
export async function encode(
  source: VideoSource,
  options?: EncodeOptions,
): Promise<Uint8Array> {
  let communicator: WorkerCommunicator | null = null;

  try {
    // 設定の推定と正規化
    const config = await inferAndBuildConfig(source, options);

    // ワーカーとの通信を開始
    communicator = new WorkerCommunicator();

    // エンコード処理の実行
    const result = await performEncoding(communicator, source, config, options);

    return result;
  } catch (error) {
    // エラーの統一的な処理
    const encodeError =
      error instanceof EncodeError
        ? error
        : new EncodeError(
            "encoding-failed",
            `Encoding failed: ${error instanceof Error ? error.message : String(error)}`,
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
 * 実際のエンコード処理を実行
 */
async function performEncoding(
  communicator: WorkerCommunicator,
  source: VideoSource,
  config: any,
  options?: EncodeOptions,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let processedFrames = 0;
    let totalFrames: number | undefined;
    const startTime = Date.now();

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

    // ワーカーからのメッセージを処理
    communicator.on("initialized", () => {
      updateProgress("encoding");
      // フレーム処理を開始
      processVideoSource(communicator, source, config)
        .then(() => {
          updateProgress("finalizing");
          communicator.send("finalize");
        })
        .catch(reject);
    });

    communicator.on(
      "progress",
      (data: { processedFrames: number; totalFrames?: number }) => {
        processedFrames = data.processedFrames;
        if (data.totalFrames !== undefined) {
          totalFrames = data.totalFrames;
        }
        updateProgress("encoding");
      },
    );

    communicator.on("finalized", (data: { output: Uint8Array | null }) => {
      if (data.output) {
        updateProgress("finalizing");
        resolve(data.output);
      } else {
        reject(new EncodeError("encoding-failed", "No output produced"));
      }
    });

    communicator.on("error", (data: { errorDetail: any }) => {
      const error = new EncodeError(
        data.errorDetail.type || "encoding-failed",
        data.errorDetail.message || "Worker error",
        data.errorDetail,
      );
      reject(error);
    });

    // エンコード開始
    communicator.send("initialize", { config });
  });
}

/**
 * VideoSourceを処理してワーカーに送信
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
    // MediaStreamの処理
    await processMediaStream(communicator, source, config);
  } else if (Symbol.asyncIterator in source) {
    // AsyncIterableの処理
    await processAsyncIterable(communicator, source);
  } else {
    // VideoFileの処理
    await processVideoFile(communicator, source as VideoFile, config);
  }
}

/**
 * フレーム配列を処理
 */
async function processFrameArray(
  communicator: WorkerCommunicator,
  frames: Frame[],
): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const timestamp = (i * 1000000) / 30; // 30fpsを仮定してマイクロ秒で計算

    await addFrameToWorker(communicator, frame, timestamp);
  }
}

/**
 * AsyncIterableを処理
 */
async function processAsyncIterable(
  communicator: WorkerCommunicator,
  source: AsyncIterable<Frame>,
): Promise<void> {
  let frameIndex = 0;

  for await (const frame of source) {
    const timestamp = (frameIndex * 1000000) / 30; // 30fpsを仮定
    await addFrameToWorker(communicator, frame, timestamp);
    frameIndex++;
  }
}

/**
 * MediaStreamを処理
 */
async function processMediaStream(
  communicator: WorkerCommunicator,
  stream: MediaStream,
  _config: any,
): Promise<void> {
  // MediaStreamの処理は複雑なため、MediaStreamTrackProcessorを使用
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  const readers: ReadableStreamDefaultReader<any>[] = [];
  const processingPromises: Promise<void>[] = [];

  try {
    // ビデオトラックの処理
    if (videoTracks.length > 0) {
      const videoTrack = videoTracks[0];
      const processor = new MediaStreamTrackProcessor({ track: videoTrack });
      const reader =
        processor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
      readers.push(reader);

      processingPromises.push(processVideoReader(communicator, reader));
    }

    // オーディオトラックの処理
    if (audioTracks.length > 0) {
      const audioTrack = audioTracks[0];
      const processor = new MediaStreamTrackProcessor({ track: audioTrack });
      const reader =
        processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
      readers.push(reader);

      processingPromises.push(processAudioReader(communicator, reader));
    }

    // すべての処理が完了するまで待機
    await Promise.all(processingPromises);
  } finally {
    // リーダーをクリーンアップ
    for (const reader of readers) {
      try {
        reader.cancel();
      } catch (e) {
        // エラーは無視（既にキャンセル済みの可能性）
      }
    }

    // トラックを停止
    for (const track of [...videoTracks, ...audioTracks]) {
      track.stop();
    }
  }
}

/**
 * VideoFrameリーダーを処理
 */
async function processVideoReader(
  communicator: WorkerCommunicator,
  reader: ReadableStreamDefaultReader<VideoFrame>,
): Promise<void> {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      try {
        await addFrameToWorker(communicator, value, value.timestamp || 0);
      } finally {
        value.close();
      }
    }
  } catch (error) {
    throw new EncodeError(
      "video-encoding-error",
      `Video stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * AudioDataリーダーを処理
 */
async function processAudioReader(
  communicator: WorkerCommunicator,
  reader: ReadableStreamDefaultReader<AudioData>,
): Promise<void> {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      try {
        communicator.send("addAudioData", {
          audio: value,
          timestamp: value.timestamp || 0,
          format: "f32",
          sampleRate: value.sampleRate,
          numberOfFrames: value.numberOfFrames,
          numberOfChannels: value.numberOfChannels,
        });
      } finally {
        value.close();
      }
    }
  } catch (error) {
    throw new EncodeError(
      "audio-encoding-error",
      `Audio stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * フレームをワーカーに送信
 */
async function addFrameToWorker(
  communicator: WorkerCommunicator,
  frame: Frame,
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
  frame: Frame,
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

/**
 * VideoFileを処理してフレームを抽出
 */
async function processVideoFile(
  communicator: WorkerCommunicator,
  videoFile: VideoFile,
  config: any,
): Promise<void> {
  try {
    // HTML5 Video要素を作成してファイルを読み込み
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";

    // ファイルをオブジェクトURLとして設定
    const objectUrl = URL.createObjectURL(videoFile.file);
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video file"));
    });

    // 動画の情報を取得
    const { duration, videoWidth, videoHeight } = video;
    const frameRate = config.frameRate || 30;
    const totalFrames = Math.floor(duration * frameRate);

    // Canvasを作成してフレームを抽出
    const canvas = document.createElement("canvas");
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new EncodeError(
        "initialization-failed",
        "Failed to get canvas context",
      );
    }

    // 動画の各フレームを処理
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const timestamp = frameIndex / frameRate;

      // 動画の指定時間にシーク
      video.currentTime = timestamp;

      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        // タイムアウト処理を追加してデッドロックを防止
        setTimeout(() => resolve(), 100);
      });

      // Canvasに現在のフレームを描画
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

      // VideoFrameを作成
      const videoFrame = new VideoFrame(canvas, {
        timestamp: frameIndex * (1000000 / frameRate), // マイクロ秒
      });

      // ワーカーに送信
      await addFrameToWorker(
        communicator,
        videoFrame,
        frameIndex * (1000000 / frameRate),
      );

      // フレームをクローズしてメモリリークを防止
      videoFrame.close();
    }

    // リソースをクリーンアップ
    URL.revokeObjectURL(objectUrl);
    video.remove();
  } catch (error) {
    throw new EncodeError(
      "invalid-input",
      `VideoFile processing failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
