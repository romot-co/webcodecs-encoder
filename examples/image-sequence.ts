import { encode, canEncode } from 'webcodecs-encoder';

// WebCodecs対応チェック
const isSupported = await canEncode();
if (!isSupported) {
  console.error('WebCodecs not supported');
  throw new Error('WebCodecs not supported');
}

// 画像シーケンスをエンコード
async function encodeImageSequence() {
  // 画像ファイルのURL配列（実際のアプリケーションでは適切なパスを設定）
  const imageUrls = [
    'frame001.jpg',
    'frame002.jpg', 
    'frame003.jpg',
    // ... 他の画像
  ];

  // 画像をImageBitmapに変換
  const frames: ImageBitmap[] = [];
  
  for (const url of imageUrls) {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      frames.push(imageBitmap);
    } catch (error) {
      console.error(`画像の読み込みに失敗: ${url}`, error);
    }
  }

  console.log(`${frames.length}フレームを読み込みました`);

  // エンコード実行
  const mp4Data = await encode(frames, {
    width: 1920,
    height: 1080,
    frameRate: 24,
    quality: 'high',
    container: 'mp4',
    onProgress: (progress) => {
      console.log(`進捗: ${progress.percent.toFixed(1)}%`);
      console.log(`処理済み: ${progress.processedFrames}/${progress.totalFrames} フレーム`);
    }
  });

  // ファイルとして保存
  const blob = new Blob([mp4Data], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = 'image-sequence.mp4';
  a.click();
  
  URL.revokeObjectURL(url);
  
  // リソースをクリーンアップ
  frames.forEach(frame => frame.close());

  console.log('画像シーケンスのエンコード完了!');
}

// 実行
encodeImageSequence().catch(console.error);
