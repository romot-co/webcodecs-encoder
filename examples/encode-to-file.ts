import { encode, canEncode } from 'webcodecs-encoder';

// WebCodecs対応チェック
const isSupported = await canEncode();
if (!isSupported) {
  console.error('WebCodecs not supported');
  throw new Error('WebCodecs not supported in this browser');
}

// Canvas要素でフレームを生成
async function generateFrames() {
  const frames: ImageBitmap[] = [];
  const canvas = new OffscreenCanvas(1280, 720);
  const ctx = canvas.getContext('2d')!;

  // サンプルアニメーション（120フレーム = 4秒間）
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `hsl(${(i * 3) % 360}, 70%, 50%)`;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = 'white';
    ctx.font = '48px Arial';
    ctx.fillText(`Frame ${i + 1}`, 50, 100);
    
    frames.push(canvas.transferToImageBitmap());
  }

  return frames;
}

// フレーム生成
const frames = await generateFrames();

// エンコード実行
const mp4Data = await encode(frames, {
  width: 1280,
  height: 720,
  frameRate: 30,
  quality: 'medium',
  container: 'mp4',
  onProgress: (progress) => {
    console.log(`エンコード進捗: ${progress.percent.toFixed(1)}%`);
  }
});

// ブラウザでファイルをダウンロード
const blob = new Blob([mp4Data], { type: 'video/mp4' });
const url = URL.createObjectURL(blob);

const a = document.createElement('a');
a.href = url;
a.download = 'encoded-video.mp4';
document.body.appendChild(a);
a.click();
document.body.removeChild(a);

URL.revokeObjectURL(url);

console.log('エンコード完了: encoded-video.mp4 をダウンロードしました');
