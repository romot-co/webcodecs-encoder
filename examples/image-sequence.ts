import { Mp4Encoder } from "webcodecs-muxer";

export async function encodeImageSequence(imageUrls: string[]) {
  if (!Mp4Encoder.isSupported()) {
    console.error("WebCodecs or Workers not supported.");
    return;
  }

  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: 2_000_000,
  };

  const encoder = new Mp4Encoder(config);
  await encoder.initialize({ totalFrames: imageUrls.length });

  for (const [index, url] of imageUrls.entries()) {
    const response = await fetch(url);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const decoder = new ImageDecoder({ data: buffer, type: blob.type });
    const { image } = await decoder.decode();
    const frame = new VideoFrame(image, {
      timestamp: (index * 1_000_000) / config.frameRate,
      duration: 1_000_000 / config.frameRate,
    });
    await encoder.addVideoFrame(frame);
    frame.close();
    image.close();
    decoder.close();
  }

  const result = await encoder.finalize();
  console.log("Encoding finished! MP4 size:", result.byteLength);
}
