import { Mp4Encoder } from 'webcodecs-muxer';

async function encodeVideoToFile() {
  if (!Mp4Encoder.isSupported()) {
    console.error('WebCodecs or Workers not supported.');
    return;
  }

  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: 2_000_000, // 2 Mbps
    audioBitrate: 128_000,   // 128 kbps
    sampleRate: 48000,       // Recommended: 48000 for Opus
    channels: 2,
  };

  const encoder = new Mp4Encoder(config);

  try {
    await encoder.initialize({
      onProgress: (processedFrames, totalFrames) => {
        console.log(`Progress (File): ${processedFrames}/${totalFrames}`);
      },
      totalFrames: 300 // Optional: for progress calculation
    });

    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext('2d');

    // Example: Encode 300 frames
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${(i * 5) % 360}, 100%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '50px Arial';
      ctx.fillText(`Frame ${i + 1}`, 50, 100);

      await encoder.addCanvasFrame(canvas);
    }

    // Example: Create a silent audio track
    const audioContext = new AudioContext({ sampleRate: config.sampleRate });
    const silentAudioBuffer = audioContext.createBuffer(
      config.channels,
      audioContext.sampleRate * (300 / config.frameRate), // duration matching video
      audioContext.sampleRate
    );
    await encoder.addAudioBuffer(silentAudioBuffer);

    const uint8Array = await encoder.finalize();
    console.log('Encoding finished! MP4 size:', uint8Array.byteLength);

    // Download the MP4
    const blob = new Blob([uint8Array], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'encoded_video.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Encoding failed:', error);
  }
}

encodeVideoToFile();
