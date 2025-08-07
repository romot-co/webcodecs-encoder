import { encodeStream } from 'webcodecs-encoder';

/**
 * Real-time MediaStream encoding using the function-first API
 * This replaces the legacy MediaStreamRecorder class-based approach
 * 
 * Usage examples:
 * - recordCamera() - Basic camera recording
 * - streamToServer() - Real-time streaming to server
 * - recordWithCancel() - Cancellable recording
 */

/**
 * Basic camera recording example
 * Records camera and microphone for 5 seconds and downloads the result
 */
export async function recordCamera(): Promise<void> {
  try {
    // Get camera and microphone access
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: true
    });

    console.log('🎥 Camera stream obtained');

    // Collect all encoded chunks
    const chunks: Uint8Array[] = [];
    let startTime = Date.now();

    // Start encoding with progress tracking
    const encodingPromise = (async () => {
      for await (const chunk of encodeStream(stream, {
        quality: 'medium',
        container: 'mp4',
        onProgress: (progress) => {
          console.log(`📊 Progress: ${progress.percent.toFixed(1)}%`);
        }
      })) {
        chunks.push(chunk);
        console.log(`📦 Received chunk: ${chunk.byteLength} bytes`);
      }
    })();

    // Stop recording after 5 seconds
    setTimeout(() => {
      console.log('⏹️ Stopping recording...');
      stream.getTracks().forEach(track => track.stop());
    }, 5000);

    // Wait for encoding to complete
    await encodingPromise;

    // Combine all chunks
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const finalVideo = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of chunks) {
      finalVideo.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Create download
    const blob = new Blob([finalVideo], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `recording-${Date.now()}.mp4`;
    link.textContent = 'Download Recording';
    document.body.appendChild(link);
    link.click();

    console.log(`✅ Recording complete: ${finalVideo.byteLength} bytes in ${Date.now() - startTime}ms`);

  } catch (error) {
    console.error('❌ Recording failed:', error);
    throw error;
  }
}

/**
 * Real-time streaming to server example
 * Streams encoded chunks to a server endpoint as they're generated
 */
export async function streamToServer(serverEndpoint: string = '/upload-chunk'): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 30 },
      audio: true
    });

    console.log('🚀 Starting real-time stream to server...');

    let chunkCount = 0;
    const startTime = Date.now();

    for await (const chunk of encodeStream(stream, {
      quality: 'medium',
      container: 'webm', // WebM is better for streaming
      video: {
        codec: 'vp8',
        bitrate: 1_500_000,
        latencyMode: 'realtime'
      },
      audio: {
        codec: 'opus',
        bitrate: 128_000
      },
      onProgress: (progress) => {
        console.log(`📡 Streaming progress: ${progress.percent.toFixed(1)}%`);
      }
    })) {
      try {
        // Send chunk to server immediately
        const response = await fetch(serverEndpoint, {
          method: 'POST',
          body: chunk,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Index': chunkCount.toString(),
            'X-Chunk-Size': chunk.byteLength.toString(),
          }
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        chunkCount++;
        console.log(`📤 Chunk ${chunkCount} sent: ${chunk.byteLength} bytes`);

        // Stop after 10 seconds for demo
        if (Date.now() - startTime > 10000) {
          stream.getTracks().forEach(track => track.stop());
          break;
        }

      } catch (uploadError) {
        console.warn(`⚠️ Failed to upload chunk ${chunkCount}:`, uploadError);
        // Continue streaming even if one chunk fails
      }
    }

    console.log(`✅ Streaming complete: ${chunkCount} chunks sent`);

  } catch (error) {
    console.error('❌ Streaming failed:', error);
    throw error;
  }
}

/**
 * Cancellable recording example
 * Shows how to programmatically cancel an ongoing recording
 */
export async function recordWithCancel(): Promise<{ 
  startRecording: () => Promise<void>, 
  stopRecording: () => void,
  cancelRecording: () => void 
}> {
  let stream: MediaStream | null = null;
  let controller: AbortController | null = null;
  let isRecording = false;
  const chunks: Uint8Array[] = [];

  const startRecording = async (): Promise<void> => {
    if (isRecording) {
      throw new Error('Recording already in progress');
    }

    try {
      // Get media stream
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      // Create abort controller for cancellation
      controller = new AbortController();
      isRecording = true;

      console.log('🔴 Recording started (use stopRecording() or cancelRecording() to end)');

      // Start encoding with cancellation support
      for await (const chunk of encodeStream(stream, {
        quality: 'high',
        signal: controller.signal, // Support cancellation
        onProgress: (progress) => {
          console.log(`📊 Recording: ${progress.percent.toFixed(1)}%`);
        }
      })) {
        if (!isRecording) break; // Additional safety check
        
        chunks.push(chunk);
        console.log(`📦 Recorded chunk: ${chunk.byteLength} bytes (total: ${chunks.length})`);
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('🚫 Recording was cancelled');
      } else {
        console.error('❌ Recording error:', error);
        throw error;
      }
    } finally {
      isRecording = false;
      stream?.getTracks().forEach(track => track.stop());
    }
  };

  const stopRecording = (): void => {
    if (!isRecording) {
      console.warn('⚠️ No recording in progress');
      return;
    }

    console.log('⏹️ Stopping recording gracefully...');
    isRecording = false;
    
    // Stop media tracks (this will end the encoding stream)
    stream?.getTracks().forEach(track => track.stop());
    
    // Create download after a short delay to allow final chunks
    setTimeout(() => {
      if (chunks.length > 0) {
        const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const finalVideo = new Uint8Array(totalSize);
        let offset = 0;
        
        for (const chunk of chunks) {
          finalVideo.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const blob = new Blob([finalVideo], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `recording-${Date.now()}.mp4`;
        link.textContent = 'Download Stopped Recording';
        document.body.appendChild(link);
        link.click();

        console.log(`✅ Recording saved: ${finalVideo.byteLength} bytes`);
      }
    }, 1000);
  };

  const cancelRecording = (): void => {
    if (!isRecording) {
      console.warn('⚠️ No recording in progress');
      return;
    }

    console.log('🚫 Cancelling recording...');
    isRecording = false;
    
    // Abort the encoding process
    controller?.abort();
    
    // Stop and clean up media tracks
    stream?.getTracks().forEach(track => track.stop());
    
    // Clear chunks
    chunks.length = 0;
    
    console.log('🗑️ Recording cancelled and cleaned up');
  };

  return { startRecording, stopRecording, cancelRecording };
}

/**
 * Migration helper - shows the old vs new patterns
 */
export function showMigrationExample(): void {
  console.log(`
  📖 Migration Guide: MediaStreamRecorder → encodeStream()
  
  // ❌ Old way (removed in v0.3.0)
  // const recorder = new MediaStreamRecorder(stream, options);
  // await recorder.start();
  // const data = await recorder.stop();
  
  // ✅ New way (v0.3.0+)
  const chunks: Uint8Array[] = [];
  for await (const chunk of encodeStream(stream, options)) {
    chunks.push(chunk);
  }
  const data = concatenateChunks(chunks);
  
  🔧 Key differences:
  - Function-first API instead of class-based
  - Streaming chunks instead of single output
  - Built-in progress and error handling
  - Better tree-shaking and bundle size
  - More flexible cancellation with AbortController
  `);
}

/**
 * Helper function to concatenate chunks (commonly needed pattern)
 */
export function concatenateChunks(chunks: Uint8Array[]): Uint8Array {
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  return result;
}

// Demo usage when loaded directly
if (typeof window !== 'undefined') {
  // Add demo buttons to the page
  const demoContainer = document.createElement('div');
  demoContainer.innerHTML = `
    <h2>🎥 Real-time MediaStream Encoding Demo</h2>
    <p>This demonstrates the new function-first API for MediaStream encoding.</p>
    <button id="record-camera">📹 Record Camera (5s)</button>
    <button id="show-migration">📖 Show Migration Guide</button>
    <div id="output" style="margin-top: 20px; font-family: monospace;"></div>
  `;
  
  document.body.appendChild(demoContainer);
  
  // Set up event listeners
  document.getElementById('record-camera')?.addEventListener('click', async () => {
    try {
      await recordCamera();
    } catch (error) {
      console.error('Demo error:', error);
    }
  });
  
  document.getElementById('show-migration')?.addEventListener('click', () => {
    showMigrationExample();
  });
}