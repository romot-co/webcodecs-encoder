import { encodeStream, canEncode } from 'webcodecs-encoder';

// WebCodecs対応チェック
const isSupported = await canEncode();
if (!isSupported) {
  console.error('WebCodecs not supported');
  throw new Error('WebCodecs not supported');
}

// 画面を録画してリアルタイムエンコード
const stream = await navigator.mediaDevices.getDisplayMedia({ 
  video: { width: 1280, height: 720 },
  audio: true 
});

// ストリーミングエンコード開始
const encodedChunks: Uint8Array[] = [];

for await (const chunk of encodeStream(stream, {
  quality: 'medium',
  container: 'webm',
  video: { latencyMode: 'realtime' },
  onProgress: (progress) => {
    console.log(`リアルタイム進捗: ${progress.percent.toFixed(1)}%`);
    console.log(`FPS: ${progress.fps.toFixed(1)}`);
  }
})) {
  // チャンクをリアルタイムで処理
  encodedChunks.push(chunk);
  
  // 必要に応じてサーバーに送信
  // await sendToServer(chunk);
  
  console.log(`チャンク受信: ${chunk.length} バイト`);
}

// 最終ファイルとして保存
const finalVideo = new Uint8Array(
  encodedChunks.reduce((total, chunk) => total + chunk.length, 0)
);
let offset = 0;
for (const chunk of encodedChunks) {
  finalVideo.set(chunk, offset);
  offset += chunk.length;
}

const blob = new Blob([finalVideo], { type: 'video/webm' });
const url = URL.createObjectURL(blob);

// ダウンロード
const a = document.createElement('a');
a.href = url;
a.download = 'realtime-recording.webm';
a.click();

console.log('リアルタイムエンコード完了!');
