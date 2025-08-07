/**
 * VideoFile Streaming Example
 * Demonstrates how to use VideoFile with the streaming API for real-time processing
 */

import { encodeStream } from 'webcodecs-encoder';
import type { VideoFile } from 'webcodecs-encoder';

async function streamVideoFile() {
  // Create VideoFile from File input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  
  fileInput.onchange = async (event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    
    if (!file) {
      console.error('No file selected');
      return;
    }

    // Create VideoFile object
    const videoFile: VideoFile = {
      file,
      type: file.type,
    };

    console.log('Starting VideoFile streaming...');

    try {
      // Use streaming API with VideoFile
      const stream = encodeStream(videoFile, {
        // Streaming configuration
        latencyMode: 'realtime',
        container: 'webm', // WebM works better for streaming
        
        // Video settings
        video: {
          codec: 'vp8',
          bitrate: 1_000_000,
        },
        
        // Audio settings
        audio: {
          codec: 'opus',
          bitrate: 128_000,
        },
        
        // Progress callback
        onProgress: (progress) => {
          console.log(`Streaming progress: ${progress.percent.toFixed(1)}%`);
          console.log(`Processed frames: ${progress.processedFrames}/${progress.totalFrames || '?'}`);
        },
        
        // Error handling
        onError: (error) => {
          console.error('Streaming error:', error);
        },
      });

      // Collect chunks as they're generated
      const chunks: Uint8Array[] = [];
      
      for await (const chunk of stream) {
        chunks.push(chunk);
        console.log(`Received chunk: ${chunk.byteLength} bytes`);
        
        // Optional: Process chunk immediately
        // e.g., send to server, save to IndexedDB, etc.
      }

      // Combine all chunks
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const finalOutput = new Uint8Array(totalLength);
      let offset = 0;
      
      for (const chunk of chunks) {
        finalOutput.set(chunk, offset);
        offset += chunk.byteLength;
      }

      console.log(`VideoFile streaming completed: ${finalOutput.byteLength} bytes`);
      
      // Create download link
      const blob = new Blob([finalOutput], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      
      const downloadLink = document.createElement('a');
      downloadLink.href = url;
      downloadLink.download = 'streamed-video.webm';
      downloadLink.textContent = 'Download Streamed Video';
      document.body.appendChild(downloadLink);

    } catch (error) {
      console.error('VideoFile streaming failed:', error);
    }
  };

  // Add file input to page
  document.body.appendChild(fileInput);
}

// Real-time chunk processing example
async function streamVideoFileRealtime() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  
  fileInput.onchange = async (event) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    
    if (!file) return;

    const videoFile: VideoFile = { file, type: file.type };

    try {
      // Stream with real-time processing
      const stream = encodeStream(videoFile, {
        latencyMode: 'realtime',
        container: 'webm',
        
        onProgress: (progress) => {
          // Update UI with progress
          updateProgressBar(progress.percent);
        },
      });

      // Process chunks in real-time
      for await (const chunk of stream) {
        // Send chunk to server immediately
        await sendChunkToServer(chunk);
        
        // Or append to MediaSource for real-time playback
        // appendToMediaSource(chunk);
        
        console.log(`Processed chunk: ${chunk.byteLength} bytes`);
      }

      console.log('Real-time streaming completed');

    } catch (error) {
      console.error('Real-time streaming failed:', error);
    }
  };

  document.body.appendChild(fileInput);
}

// Helper functions
function updateProgressBar(percent: number) {
  const progressBar = document.getElementById('progress') as HTMLProgressElement;
  if (progressBar) {
    progressBar.value = percent;
  }
}

async function sendChunkToServer(chunk: Uint8Array) {
  // Example: Send chunk to server
  try {
    await fetch('/upload-chunk', {
      method: 'POST',
      body: chunk,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    console.warn('Failed to send chunk to server:', error);
  }
}

// Export examples
export {
  streamVideoFile,
  streamVideoFileRealtime,
};

// Run example if this file is executed directly
if (typeof window !== 'undefined') {
  streamVideoFile();
}