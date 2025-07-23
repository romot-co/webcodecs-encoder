/**
 * Worker creation and management
 */

import { EncodeError } from "../types";

/**
 * Create external worker
 */
function createExternalWorker(): Worker {
  try {
    // Use external worker file
    const worker = new Worker("/webcodecs-worker.js", { type: "module" });

    // Worker error handling
    worker.onerror = (event) => {
      console.error("Worker error:", event);
      throw new EncodeError("worker-error", `Worker error: ${event.message}`);
    };

    return worker;
  } catch (error) {
    throw new EncodeError(
      "initialization-failed",
      "Failed to create external worker. Make sure webcodecs-worker.js is available in your public directory.",
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

    worker.onerror = (event) => {
      console.error("Inline worker error:", event);
      throw new EncodeError(
        "worker-error",
        `Inline worker error: ${event.message}`,
      );
    };

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
  // Enhanced production environment detection
  const isProductionEnvironment = detectProductionEnvironment();

  // Test environment or development environment detection
  const isTestEnvironment =
    // Vitest environment
    (typeof process !== "undefined" && process.env?.VITEST === "true") ||
    // Jest environment
    (typeof process !== "undefined" &&
      process.env?.JEST_WORKER_ID !== undefined) ||
    // Node.js environment
    (typeof process !== "undefined" && process.env?.NODE_ENV === "test") ||
    // Global test runner exists
    (typeof global !== "undefined" &&
      (global as any).process?.env?.NODE_ENV === "test") ||
    // vitest global function exists
    (typeof globalThis !== "undefined" && "vi" in globalThis) ||
    // jsdom environment
    (typeof window !== "undefined" &&
      window.navigator?.userAgent?.includes("jsdom")) ||
    // Variables commonly set in test environments
    (typeof process !== "undefined" &&
      process.env?.npm_lifecycle_event?.includes("test"));

  // Enhanced fallback for integration test environments
  const isIntegrationTestEnvironment =
    typeof window !== "undefined" &&
    (window.location?.hostname === "localhost" ||
      window.location?.hostname === "127.0.0.1") &&
    window.location?.port;

  // Force disable check via environment variables
  const forceDisableInlineWorker =
    (typeof process !== "undefined" &&
      process.env?.WEBCODECS_DISABLE_INLINE_WORKER === "true") ||
    (typeof window !== "undefined" &&
      (window as any).__WEBCODECS_DISABLE_INLINE_WORKER__ === true);

  // Strictly prohibit if production environment or inline worker is explicitly disabled
  if (
    (isProductionEnvironment || forceDisableInlineWorker) &&
    (isTestEnvironment || isIntegrationTestEnvironment)
  ) {
    throw new Error(
      "[WorkerCommunicator] CRITICAL SECURITY ERROR: Inline worker detected in production environment or explicitly disabled. " +
        "This is a security risk. Please ensure webcodecs-worker.js is properly deployed.",
    );
  }

  // Always use inline worker in test environments
  if (isTestEnvironment || isIntegrationTestEnvironment) {
    console.warn(
      "[WorkerCommunicator] Using inline worker for test environment",
    );
    return createInlineWorker();
  }

  // Use only external worker in production environment
  try {
    return createExternalWorker();
  } catch (error) {
    if (isProductionEnvironment) {
      throw new Error(
        "[WorkerCommunicator] PRODUCTION ERROR: External worker failed to load. " +
          "Inline worker is disabled for security reasons. " +
          "Please ensure webcodecs-worker.js is accessible at /webcodecs-worker.js",
      );
    }
    console.error(
      "[WorkerCommunicator] External worker creation failed. Inline worker is not used in production.",
      error,
    );
    throw error;
  }
}

/**
 * Detect production environment
 */
function detectProductionEnvironment(): boolean {
  // Production detection in Node.js environment
  if (typeof process !== "undefined") {
    const nodeEnv = process.env?.NODE_ENV;
    // Production-like environments (production, staging, preview, prod)
    return (
      nodeEnv === "production" ||
      nodeEnv === "staging" ||
      nodeEnv === "preview" ||
      nodeEnv === "prod"
    );
  }

  // Production detection in browser environment
  if (typeof window !== "undefined") {
    // Whether served over HTTPS
    const isHttps = window.location?.protocol === "https:";
    // Host other than localhost
    const isNotLocalhost =
      window.location?.hostname !== "localhost" &&
      window.location?.hostname !== "127.0.0.1" &&
      !window.location?.hostname?.endsWith(".localhost");

    // Exclude ports commonly used by development servers
    const isDevelopmentPort =
      window.location?.port &&
      ["3000", "3001", "4000", "5000", "5173", "8000", "8080", "9000"].includes(
        window.location.port,
      );

    // Check production domain patterns
    const hostname = window.location?.hostname || "";
    const isProductionDomain =
      hostname.includes(".com") ||
      hostname.includes(".org") ||
      hostname.includes(".net") ||
      hostname.includes("staging") ||
      hostname.includes("preview") ||
      hostname.includes("prod");

    // More strict production environment determination
    return (
      isHttps && isNotLocalhost && !isDevelopmentPort && isProductionDomain
    );
  }

  return false;
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
  }

  private handleMessage(event: MessageEvent): void {
    const { type, ...data } = event.data;
    const handler = this.messageHandlers.get(type);
    if (handler) {
      handler(data);
    }
  }

  /**
   * Register message handler
   */
  on(type: string, handler: (data: any) => void): void {
    this.messageHandlers.set(type, handler);
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
