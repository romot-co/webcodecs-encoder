import { MediaStreamRecorder } from 'webcodecs-encoder';

/**
 * Record the user's camera and microphone for a few seconds and
 * download the resulting MP4 file.
 *
 * Usage: simply call `recordFromCamera()` in the browser.
 */
export async function recordFromCamera() {
  if (!MediaStreamRecorder.isSupported()) {
    console.error('MediaStreamRecorder not supported.');
    return;
  }

  // Basic encoding settings
  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    sampleRate: 48_000,
    channels: 2,
  };

  // Request access to camera and microphone
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: config.width, height: config.height },
    audio: true,
  });

  const recorder = new MediaStreamRecorder(config);

  // Start capturing the MediaStream
  await recorder.startRecording(stream);

  // Record for 5 seconds
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Stop and get the encoded data
  const result = await recorder.stopRecording();
  console.log('Recording finished! MP4 size:', result?.byteLength);

  // Download the file
  if (result && result.byteLength) {
    const blob = new Blob([result], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recorded_stream.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// recordFromCamera(); // Uncomment to run
