/**
 * Worker creation and management
 */

import { EncodeError } from "../types";

function resolveWorkerUrl(): string {
  const processUrl =
    typeof process !== "undefined"
      ? process.env?.WEBCODECS_WORKER_URL
      : undefined;
  const windowUrl =
    typeof window !== "undefined"
      ? (window as any).__WEBCODECS_WORKER_URL__
      : undefined;

  const configuredUrl =
    (typeof windowUrl === "string" && windowUrl.trim()) ||
    (typeof processUrl === "string" && processUrl.trim());
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof document !== "undefined" && document.baseURI) {
    return new URL("webcodecs-worker.js", document.baseURI).toString();
  }

  return "/webcodecs-worker.js";
}

/**
 * Create external worker
 */
function createExternalWorker(): Worker {
  try {
    return new Worker(resolveWorkerUrl(), { type: "module" });
  } catch (error) {
    throw new EncodeError(
      "initialization-failed",
      "Failed to create external worker. Make sure webcodecs-worker.js is available and WEBCODECS_WORKER_URL is configured when needed.",
      error,
    );
  }
}

/**
 * Create inline worker (for test environments)
 */
function createInlineWorker(): { worker: Worker; blobUrl: string } {
  try {
    const workerSource = getWorkerSource();
    const blob = new Blob([workerSource], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    const worker = new Worker(blobUrl, { type: "module" });

    return { worker, blobUrl };
  } catch (error) {
    throw new EncodeError(
      "initialization-failed",
      "Failed to create inline worker",
      error,
    );
  }
}

/**
 * Create appropriate worker
 */
export function createWorker(): Worker | { worker: Worker; blobUrl: string } {
  const isTestEnvironment = detectTestEnvironment();
  const isProductionEnvironment = detectProductionEnvironment();
  const inlineOverride = hasInlineWorkerOverride();
  const inlineDisabled = isInlineWorkerDisabled();

  if (inlineOverride) {
    if (isProductionEnvironment && !allowInlineOverrideInProduction()) {
      throw new Error(
        "[WorkerCommunicator] Inline worker override is disabled in production environments.",
      );
    }
    console.warn("[WorkerCommunicator] Using inline worker (override).");
    return createInlineWorker();
  }

  if (isTestEnvironment && !inlineDisabled) {
    console.warn(
      "[WorkerCommunicator] Using inline worker (test environment).",
    );
    return createInlineWorker();
  }

  try {
    return createExternalWorker();
  } catch (error) {
    if (!inlineDisabled && !isProductionEnvironment) {
      console.warn(
        "[WorkerCommunicator] Failed to create external worker. Falling back to inline worker.",
        error,
      );
      return createInlineWorker();
    }

    if (!inlineDisabled) {
      console.error(
        "[WorkerCommunicator] Failed to create external worker in a production-like environment.",
        error,
      );
    }

    throw error;
  }
}

function detectTestEnvironment(): boolean {
  if (typeof process !== "undefined") {
    if (process.env?.VITEST === "true") return true;
    if (process.env?.JEST_WORKER_ID !== undefined) return true;
    if (process.env?.NODE_ENV === "test") return true;
    if (process.env?.npm_lifecycle_event?.includes("test")) return true;
  }

  if (typeof globalThis !== "undefined" && (globalThis as any).vi) return true;

  if (typeof global !== "undefined") {
    const nodeEnv = (global as any).process?.env?.NODE_ENV;
    if (nodeEnv === "test") return true;
  }

  if (typeof window !== "undefined") {
    if (window.navigator?.userAgent?.includes("jsdom")) return true;
  }

  return false;
}

function detectProductionEnvironment(): boolean {
  if (typeof process !== "undefined") {
    const nodeEnv = process.env?.NODE_ENV;
    if (!nodeEnv) {
      const lifecycle = process.env?.npm_lifecycle_event ?? "";
      return /build|start|serve|preview/i.test(lifecycle);
    }
    return ["production", "prod", "staging", "preview"].includes(nodeEnv);
  }

  if (typeof window !== "undefined") {
    const protocol = window.location?.protocol;
    const hostname = window.location?.hostname ?? "";
    const isLocalHost =
      hostname === "" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".localhost");

    return protocol === "https:" && !isLocalHost;
  }

  return false;
}

function hasInlineWorkerOverride(): boolean {
  return (
    (typeof process !== "undefined" &&
      process.env?.WEBCODECS_USE_INLINE_WORKER === "true") ||
    (typeof window !== "undefined" &&
      (window as any).__WEBCODECS_USE_INLINE_WORKER__ === true)
  );
}

function allowInlineOverrideInProduction(): boolean {
  return (
    (typeof process !== "undefined" &&
      process.env?.WEBCODECS_ALLOW_INLINE_IN_PROD === "true") ||
    (typeof window !== "undefined" &&
      (window as any).__WEBCODECS_ALLOW_INLINE_IN_PROD__ === true)
  );
}

function isInlineWorkerDisabled(): boolean {
  return (
    (typeof process !== "undefined" &&
      process.env?.WEBCODECS_DISABLE_INLINE_WORKER === "true") ||
    (typeof window !== "undefined" &&
      (window as any).__WEBCODECS_DISABLE_INLINE_WORKER__ === true)
  );
}

/**
 * Generate inline worker source code (testing only)
 */
function getWorkerSource(): string {
  return `
    // ⚠️  TESTING ONLY - DO NOT USE IN PRODUCTION ⚠️
    // WebCodecs Encoder Worker (Inline Mock Implementation)
    // This is a minimal mock for testing purposes only.
    // Real encoding should use the external webcodecs-worker.js file.
    
    console.warn('⚠️  Using inline mock worker - FOR TESTING ONLY');
    
    let config = null;
    let processedFrames = 0;
    
    self.onmessage = async function(event) {
      const { type, ...data } = event.data;
      
      try {
        switch (type) {
          case 'initialize':
            config = data.config;
            processedFrames = 0;
            // Wait a bit before sending success response
            setTimeout(() => {
              self.postMessage({ type: 'initialized' });
            }, 50);
            break;
            
          case 'addVideoFrame':
            processedFrames++;
            // Progress update
            self.postMessage({ 
              type: 'progress', 
              processedFrames,
              totalFrames: data.totalFrames 
            });
            break;
            
          case 'addAudioData':
            // Audio data processing (placeholder)
            break;
            
          case 'finalize':
            // Wait a bit before returning result
            setTimeout(() => {
              const result = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // MP4 magic number
              self.postMessage({ type: 'finalized', output: result });
            }, 100);
            break;
            
          case 'cancel':
            self.postMessage({ type: 'cancelled' });
            break;
            
          default:
            console.warn('Unknown message type:', type);
        }
      } catch (error) {
        self.postMessage({ 
          type: 'error', 
          errorDetail: {
            message: error.message,
            type: 'encoding-failed',
            stack: error.stack
          }
        });
      }
    };
  `;
}

/**
 * Worker communication helper
 */
export class WorkerCommunicator {
  private worker: Worker;
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  private workerBlobUrl: string | null = null;
  private pendingWorkerError: { errorDetail: any } | null = null;

  constructor() {
    const workerResult = createWorker();
    if (typeof workerResult === "object" && "worker" in workerResult) {
      // Inline worker case
      this.worker = workerResult.worker;
      this.workerBlobUrl = workerResult.blobUrl;
    } else {
      // External worker case
      this.worker = workerResult;
    }
    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleWorkerError.bind(this);
  }

  private handleMessage(event: MessageEvent): void {
    const { type, ...data } = event.data;
    const handler = this.messageHandlers.get(type);
    if (handler) {
      handler(data);
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    const payload = {
      errorDetail: {
        message: event.message
          ? `Worker error: ${event.message}`
          : "Worker error",
        type: "worker-error",
        stack: (event as any).error?.stack,
      },
    };

    const handler = this.messageHandlers.get("error");
    if (handler) {
      handler(payload);
      return;
    }

    this.pendingWorkerError = payload;
    console.error("Worker error before error handler registration:", event);
  }

  /**
   * Register message handler
   */
  on(type: string, handler: (data: any) => void): void {
    this.messageHandlers.set(type, handler);
    if (type === "error" && this.pendingWorkerError) {
      const pending = this.pendingWorkerError;
      this.pendingWorkerError = null;
      handler(pending);
    }
  }

  /**
   * Unregister message handler
   */
  off(type: string): void {
    this.messageHandlers.delete(type);
  }

  /**
   * Send message to worker
   */
  send(type: string, data: any = {}): void {
    // Detect transferable objects for optimization
    const transferables: Transferable[] = [];

    // Safari compatibility: VideoFrame and AudioData should NOT be transferred
    // as they cause issues in Safari when used as transferable objects
    const isSafari =
      typeof navigator !== "undefined" &&
      /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Optimize transfer only if ArrayBuffer is included
    if (data.buffer instanceof ArrayBuffer) {
      transferables.push(data.buffer);
    }

    // Deep scan for nested ArrayBuffers, but skip VideoFrame/AudioData
    this.collectTransferables(data, transferables, isSafari);

    // Use optimized transfer if transferable objects exist
    if (transferables.length > 0) {
      try {
        this.worker.postMessage({ type, ...data }, transferables);
      } catch (error) {
        // Safari fallback: if transferable fails, send without transferables
        console.warn(
          "Transferable object transfer failed, falling back to clone:",
          error,
        );
        this.worker.postMessage({ type, ...data });
      }
    } else {
      this.worker.postMessage({ type, ...data });
    }
  }

  /**
   * Recursively collect transferable objects while avoiding problematic types
   */
  private collectTransferables(
    obj: any,
    transferables: Transferable[],
    isSafari: boolean,
  ): void {
    if (!obj || typeof obj !== "object") return;

    // Skip VideoFrame and AudioData objects as they cause Safari issues
    if (typeof VideoFrame !== "undefined" && obj instanceof VideoFrame) return;
    if (typeof AudioData !== "undefined" && obj instanceof AudioData) return;

    // Safari-specific: avoid transferring certain objects
    if (isSafari) {
      // Be more conservative with Safari - only transfer obvious ArrayBuffers
      if (obj instanceof ArrayBuffer && !transferables.includes(obj)) {
        transferables.push(obj);
      }
      return;
    }

    // For other browsers, collect more transferable types
    if (obj instanceof ArrayBuffer && !transferables.includes(obj)) {
      transferables.push(obj);
    } else if (obj instanceof MessagePort && !transferables.includes(obj)) {
      transferables.push(obj);
    } else if (
      typeof ImageBitmap !== "undefined" &&
      obj instanceof ImageBitmap &&
      !transferables.includes(obj)
    ) {
      transferables.push(obj);
    }

    // Recursively check object properties
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        this.collectTransferables(obj[key], transferables, isSafari);
      }
    }
  }

  /**
   * Terminate communication
   */
  terminate(): void {
    this.messageHandlers.clear();
    if (this.worker) {
      this.worker.terminate();
    }
    if (this.workerBlobUrl) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }
}
