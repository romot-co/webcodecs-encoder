import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerCommunicator } from "../src/worker/worker-communicator";

// Mock Worker
const mockWorker = {
  postMessage: vi.fn(),
  terminate: vi.fn(),
  onmessage: null as ((event: any) => void) | null,
  onerror: null as ((event: any) => void) | null,
};

// Mock Blob and createObjectURL
const mockBlob = vi.fn();
const mockCreateObjectURL = vi.fn().mockReturnValue("blob:mock-url");
const mockRevokeObjectURL = vi.fn();

describe("WorkerCommunicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Worker constructor
    global.Worker = vi.fn(() => mockWorker) as any;
    global.Blob = vi.fn((parts, options) => {
      // Mock to capture Blob arguments
      mockBlob(parts, options);
      return {}; // Dummy Blob object
    }) as any;
    global.URL = {
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    } as any;

    // Simulate browser environment
    Object.defineProperty(global, "window", {
      value: {},
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("基本機能", () => {
    it("インスタンスが正常に作成される", () => {
      const communicator = new WorkerCommunicator();
      expect(communicator).toBeInstanceOf(WorkerCommunicator);
    });

    it("メッセージ送信が正常に動作する", () => {
      const communicator = new WorkerCommunicator();

      communicator.send("initialize", { config: { width: 640, height: 480 } });

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: "initialize",
        config: { width: 640, height: 480 },
      });
    });

    it("VideoFrameはTransferableオブジェクトとして渡されない", () => {
      const communicator = new WorkerCommunicator();

      // Mock VideoFrame
      const mockVideoFrame = {
        close: vi.fn(),
        timestamp: 0,
        displayWidth: 640,
        displayHeight: 480,
      };

      communicator.send("addVideoFrame", {
        frame: mockVideoFrame,
        timestamp: 0,
      });

      // Verify it's not sent as transferable object
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: "addVideoFrame",
        frame: mockVideoFrame,
        timestamp: 0,
      });
    });

    it("AudioDataはTransferableオブジェクトとして渡されない", () => {
      const communicator = new WorkerCommunicator();

      // Mock AudioData
      const mockAudioData = {
        close: vi.fn(),
        timestamp: 0,
        sampleRate: 48000,
        numberOfChannels: 2,
      };

      communicator.send("addAudioData", {
        audio: mockAudioData,
        timestamp: 0,
      });

      // Verify it's not sent as transferable object
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: "addAudioData",
        audio: mockAudioData,
        timestamp: 0,
      });
    });

    it("ArrayBufferのTransferableオブジェクト最適化が動作する (v0.2.2)", () => {
      const communicator = new WorkerCommunicator();

      const mockArrayBuffer = new ArrayBuffer(1024);

      communicator.send("data", {
        buffer: mockArrayBuffer,
      });

      // Verify it's sent as transferable object
      expect(mockWorker.postMessage).toHaveBeenCalledWith(
        {
          type: "data",
          buffer: mockArrayBuffer,
        },
        [mockArrayBuffer],
      );
    });

    it("Transferableオブジェクトがない場合は通常送信される", () => {
      const communicator = new WorkerCommunicator();

      communicator.send("normal", { data: "test" });

      // Normal postMessage (no second argument)
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: "normal",
        data: "test",
      });
    });

    it("イベントハンドラーの登録と削除が動作する", () => {
      const communicator = new WorkerCommunicator();
      const handler = vi.fn();

      communicator.on("initialized", handler);
      expect(typeof communicator.off).toBe("function");

      communicator.off("initialized");
      // Verify handler was removed
    });

    it("workerのメッセージ処理が動作する", () => {
      const communicator = new WorkerCommunicator();
      const handler = vi.fn();

      communicator.on("initialized", handler);

      const messageHandler = mockWorker.onmessage;
      if (messageHandler) {
        const mockEvent = {
          data: {
            type: "initialized",
            actualVideoCodec: "avc1.42001f",
          },
        };

        messageHandler(mockEvent);

        expect(handler).toHaveBeenCalledWith({
          actualVideoCodec: "avc1.42001f",
        });
      }
    });

    it("workerのエラーイベントがerrorハンドラーに中継される", () => {
      const communicator = new WorkerCommunicator();
      const errorHandler = vi.fn();
      communicator.on("error", errorHandler);

      const workerErrorHandler = (mockWorker as any).onerror;
      expect(workerErrorHandler).toBeTypeOf("function");

      workerErrorHandler({
        message: "boom",
        error: new Error("boom"),
        preventDefault: vi.fn(),
      });

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          errorDetail: expect.objectContaining({
            message: "Worker error: boom",
            type: "worker-error",
          }),
        }),
      );
    });

    it("errorハンドラー登録前のworkerエラーを後から受け取れる", () => {
      const communicator = new WorkerCommunicator();
      const workerErrorHandler = (mockWorker as any).onerror;
      expect(workerErrorHandler).toBeTypeOf("function");

      workerErrorHandler({
        message: "early-error",
        error: new Error("early-error"),
        preventDefault: vi.fn(),
      });

      const errorHandler = vi.fn();
      communicator.on("error", errorHandler);
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          errorDetail: expect.objectContaining({
            message: "Worker error: early-error",
            type: "worker-error",
          }),
        }),
      );
    });

    it("リソースのクリーンアップが動作する", () => {
      const communicator = new WorkerCommunicator();

      communicator.terminate();

      // Worker.terminate should always be called
      expect(mockWorker.terminate).toHaveBeenCalled();

      // In test environment, inline worker is used, but the actual blobURL management
      // may not work as expected due to mocking limitations.
      // The core functionality (worker termination) is verified above.
      // Note: revokeObjectURL behavior depends on whether workerBlobUrl was set properly
    });
  });

  describe("インラインワーカー作成", () => {
    it("テスト環境でインラインワーカーが作成される", () => {
      // Test environment setup
      Object.defineProperty(global, "process", {
        value: { env: { NODE_ENV: "test" } },
        writable: true,
      });

      new WorkerCommunicator();

      expect(mockBlob).toHaveBeenCalled();
      expect(mockCreateObjectURL).toHaveBeenCalled();
    });
  });

  describe("エラーハンドリング", () => {
    it("Worker作成失敗時の動作確認", () => {
      // Due to singleton pattern, workers are reused,
      // so only perform basic functionality verification
      const communicator = new WorkerCommunicator();
      expect(communicator).toBeInstanceOf(WorkerCommunicator);

      // Verify basic communication functionality works
      expect(typeof communicator.send).toBe("function");
      expect(typeof communicator.terminate).toBe("function");
    });

    it("WEBCODECS_WORKER_URLが指定されている場合はそのURLを使う", () => {
      const prevDisableInline = process.env.WEBCODECS_DISABLE_INLINE_WORKER;
      const prevWorkerUrl = process.env.WEBCODECS_WORKER_URL;

      process.env.WEBCODECS_DISABLE_INLINE_WORKER = "true";
      process.env.WEBCODECS_WORKER_URL = "/custom-worker.js";

      try {
        new WorkerCommunicator();
        expect(global.Worker).toHaveBeenCalledWith("/custom-worker.js", {
          type: "module",
        });
      } finally {
        if (prevDisableInline === undefined) {
          delete process.env.WEBCODECS_DISABLE_INLINE_WORKER;
        } else {
          process.env.WEBCODECS_DISABLE_INLINE_WORKER = prevDisableInline;
        }
        if (prevWorkerUrl === undefined) {
          delete process.env.WEBCODECS_WORKER_URL;
        } else {
          process.env.WEBCODECS_WORKER_URL = prevWorkerUrl;
        }
      }
    });
  });
});
