import { encode, encodeStream, canEncode } from 'webcodecs-encoder';

// 1. 静的フレーム配列のエンコード例
async function staticFramesExample() {
  console.log('=== 静的フレーム配列のエンコード ===');
  
  const frames = [];
  const canvas = new OffscreenCanvas(640, 480);
  const ctx = canvas.getContext('2d')!;
  
  // 30フレームのアニメーション作成
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `hsl(${(i * 12) % 360}, 70%, 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';
    ctx.font = '32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`フレーム ${i + 1}`, canvas.width / 2, canvas.height / 2);
    
    // フレームをコピー
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    frames.push(imageData);
  }

  try {
    const mp4 = await encode(frames, {
      quality: 'medium',
      frameRate: 30,
      onProgress: (progress) => {
        console.log(`進捗: ${progress.percent.toFixed(1)}%`);
      }
    });
    
    console.log(`静的フレームエンコード完了: ${mp4.byteLength} bytes`);
    return mp4;
  } catch (error) {
    console.error('静的フレームエンコード失敗:', error);
    throw error;
  }
}

// 2. AsyncIterableのエンコード例
async function asyncIterableExample() {
  console.log('=== AsyncIterableエンコード ===');
  
  // フレーム生成AsyncGenerator
  async function* generateFrames() {
    const canvas = new OffscreenCanvas(800, 600);
    const ctx = canvas.getContext('2d')!;
    
    for (let i = 0; i < 60; i++) {
      // 動的なアニメーション
      const time = i / 60;
      
      // 背景
      ctx.fillStyle = '#001122';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // 動く円
      const x = Math.sin(time * Math.PI * 2) * 200 + canvas.width / 2;
      const y = Math.cos(time * Math.PI) * 100 + canvas.height / 2;
      
      ctx.fillStyle = `hsl(${(i * 6) % 360}, 100%, 50%)`;
      ctx.beginPath();
      ctx.arc(x, y, 40, 0, Math.PI * 2);
      ctx.fill();
      
      // 時間表示
      ctx.fillStyle = 'white';
      ctx.font = '20px Arial';
      ctx.fillText(`Time: ${time.toFixed(2)}s`, 20, 30);
      
      yield canvas;
      
      // フレーム間隔をシミュレート（実際の時間制御）
      await new Promise(resolve => setTimeout(resolve, 33)); // ~30fps
    }
  }

  try {
    const mp4 = await encode(generateFrames(), {
      quality: 'high',
      frameRate: 30,
      video: {
        codec: 'avc',
        bitrate: 2_000_000
      },
      audio: false,
      onProgress: (progress) => {
        console.log(`AsyncIterable進捗: ${progress.percent.toFixed(1)}% (${progress.stage})`);
      }
    });
    
    console.log(`AsyncIterableエンコード完了: ${mp4.byteLength} bytes`);
    return mp4;
  } catch (error) {
    console.error('AsyncIterableエンコード失敗:', error);
    throw error;
  }
}

// 3. MediaStreamエンコード例（カメラアクセス）
async function mediaStreamExample() {
  console.log('=== MediaStreamエンコード ===');
  
  try {
    // カメラアクセスを取得
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { 
        width: 1280, 
        height: 720, 
        frameRate: 30 
      },
      audio: true
    });

    console.log('カメラストリーム取得完了');

    // 5秒間録画
    const recordingDuration = 5000; // 5秒
    
    // ストリームを一定時間で停止する Promise
    const stopRecording = new Promise<void>((resolve) => {
      setTimeout(() => {
        stream.getTracks().forEach(track => track.stop());
        resolve();
      }, recordingDuration);
    });

    // エンコード実行
    const encodePromise = encode(stream, {
      quality: 'medium',
      frameRate: 30,
      video: {
        codec: 'avc',
        bitrate: 3_000_000
      },
      audio: {
        codec: 'aac',
        bitrate: 128_000
      },
      onProgress: (progress) => {
        console.log(`MediaStream進捗: ${progress.percent.toFixed(1)}%`);
      }
    });

    // 停止とエンコード完了を待つ
    await stopRecording;
    const mp4 = await encodePromise;
    
    console.log(`MediaStreamエンコード完了: ${mp4.byteLength} bytes`);
    return mp4;

  } catch (error) {
    console.error('MediaStreamエンコード失敗:', error);
    throw error;
  }
}

// 4. VideoFileエンコード例（既存の動画ファイル処理）
async function videoFileExample() {
  console.log('=== VideoFileエンコード ===');
  
  try {
    // ファイル入力要素を作成（実際のファイル選択）
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    
    return new Promise<Uint8Array>((resolve, reject) => {
      input.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          reject(new Error('ファイルが選択されませんでした'));
          return;
        }

        try {
          const videoFile = {
            file: file,
            type: file.type
          };

          const mp4 = await encode(videoFile, {
            quality: 'medium',
            width: 1280,
            height: 720,
            frameRate: 30,
            video: {
              codec: 'avc',
              bitrate: 2_000_000
            },
            audio: {
              codec: 'aac',
              bitrate: 128_000
            },
            onProgress: (progress) => {
              console.log(`VideoFile進捗: ${progress.percent.toFixed(1)}%`);
            }
          });
          
          console.log(`VideoFileエンコード完了: ${mp4.byteLength} bytes`);
          resolve(mp4);
        } catch (error) {
          reject(error);
        }
      };

      // ファイル選択ダイアログを表示
      input.click();
    });

  } catch (error) {
    console.error('VideoFileエンコード失敗:', error);
    throw error;
  }
}

// 5. ストリーミングエンコード例
async function streamingExample() {
  console.log('=== ストリーミングエンコード ===');
  
  // リアルタイムフレーム生成
  async function* generateLiveFrames() {
    const canvas = new OffscreenCanvas(640, 480);
    const ctx = canvas.getContext('2d')!;
    let frameCount = 0;
    
    while (frameCount < 100) {
      const time = Date.now() / 1000;
      
      // ライブ感のあるアニメーション
      ctx.fillStyle = '#002244';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // リアルタイム波形
      ctx.strokeStyle = '#00ff44';
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      for (let x = 0; x < canvas.width; x += 4) {
        const frequency = 0.1 + (frameCount * 0.01);
        const y = Math.sin((x * frequency + time * 10)) * 80 + canvas.height / 2;
        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      
      // ライブ情報表示
      ctx.fillStyle = 'white';
      ctx.font = '16px Arial';
      ctx.fillText(`LIVE - Frame: ${frameCount}`, 10, 25);
      ctx.fillText(`Time: ${time.toFixed(1)}s`, 10, 45);
      
      yield canvas;
      frameCount++;
      
      // 実際のフレームレートに合わせて待機
      await new Promise(resolve => setTimeout(resolve, 33)); // ~30fps
    }
  }

  try {
    let chunkCount = 0;
    const chunks: Uint8Array[] = [];

    // ストリーミングエンコード
    for await (const chunk of encodeStream(generateLiveFrames(), {
      quality: 'medium',
      frameRate: 30,
      video: {
        codec: 'avc',
        bitrate: 1_500_000,
        latencyMode: 'realtime'
      },
      audio: false,
      onProgress: (progress) => {
        console.log(`ストリーミング進捗: ${progress.percent.toFixed(1)}%`);
      }
    })) {
      chunkCount++;
      chunks.push(chunk);
      console.log(`チャンク ${chunkCount}: ${chunk.byteLength} bytes`);
      
      // 実際のアプリケーションではここでMediaSourceに送信
      // sourceBuffer.appendBuffer(chunk);
    }
    
    // 最終的な結合データ
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    console.log(`ストリーミング完了: ${chunkCount} チャンク, 合計 ${totalSize} bytes`);
    
    return chunks;
  } catch (error) {
    console.error('ストリーミングエンコード失敗:', error);
    throw error;
  }
}

// 6. エンコード可能性の詳細チェック
async function comprehensiveCompatibilityCheck() {
  console.log('=== 包括的互換性チェック ===');
  
  const testCases = [
    { name: 'デフォルト設定', options: undefined },
    { name: 'H.264 + AAC (MP4)', options: { video: { codec: 'avc' }, audio: { codec: 'aac' }, container: 'mp4' } },
    { name: 'VP9 + Opus (WebM)', options: { video: { codec: 'vp9' }, audio: { codec: 'opus' }, container: 'webm' } },
    { name: 'AV1 + Opus', options: { video: { codec: 'av1' }, audio: { codec: 'opus' } } },
    { name: 'HEVC + AAC', options: { video: { codec: 'hevc' }, audio: { codec: 'aac' } } },
    { name: 'ハードウェア優先', options: { video: { hardwareAcceleration: 'prefer-hardware' } } },
    { name: 'ソフトウェア優先', options: { video: { hardwareAcceleration: 'prefer-software' } } },
    { name: 'リアルタイムモード', options: { video: { latencyMode: 'realtime' } } },
    { name: '高品質設定', options: { quality: 'high' } },
    { name: 'ビデオのみ', options: { audio: false } },
  ];
  
  const results: { name: string; supported: boolean; error?: string }[] = [];
  
  for (const testCase of testCases) {
    try {
      const supported = await canEncode(testCase.options);
      results.push({ name: testCase.name, supported });
      console.log(`${testCase.name}: ${supported ? '✅ サポート' : '❌ 非サポート'}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({ name: testCase.name, supported: false, error: errorMsg });
      console.log(`${testCase.name}: ❌ エラー - ${errorMsg}`);
    }
  }
  
  const supportedCount = results.filter(r => r.supported).length;
  console.log(`\n互換性サマリー: ${supportedCount}/${results.length} 設定がサポートされています`);
  
  return results;
}

// 7. パフォーマンス測定付きエンコード
async function performanceExample() {
  console.log('=== パフォーマンス測定 ===');
  
  const frames = [];
  const canvas = new OffscreenCanvas(1920, 1080); // Full HD
  const ctx = canvas.getContext('2d')!;
  
  // 重い処理のフレーム生成
  for (let i = 0; i < 60; i++) {
    // 複雑なグラデーション
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2
    );
    gradient.addColorStop(0, `hsl(${(i * 6) % 360}, 100%, 50%)`);
    gradient.addColorStop(0.5, `hsl(${(i * 6 + 60) % 360}, 70%, 40%)`);
    gradient.addColorStop(1, `hsl(${(i * 6 + 120) % 360}, 50%, 20%)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 複雑な図形描画
    for (let j = 0; j < 10; j++) {
      const x = (canvas.width / 11) * (j + 1);
      const y = canvas.height / 2 + Math.sin((i + j) * 0.2) * 200;
      
      ctx.fillStyle = `hsla(${(i * 6 + j * 36) % 360}, 80%, 60%, 0.8)`;
      ctx.beginPath();
      ctx.arc(x, y, 30, 0, Math.PI * 2);
      ctx.fill();
    }
    
    frames.push(canvas);
  }

  const startTime = performance.now();
  let progressCount = 0;

  try {
    const mp4 = await encode(frames, {
      quality: 'high',
      frameRate: 60,
      video: {
        codec: 'avc',
        bitrate: 10_000_000, // 10 Mbps
        hardwareAcceleration: 'prefer-hardware'
      },
      audio: false,
      onProgress: (progress) => {
        progressCount++;
        if (progressCount % 10 === 0) { // 10回に1回ログ出力
          const elapsed = performance.now() - startTime;
          console.log(`パフォーマンス: ${progress.percent.toFixed(1)}% (${elapsed.toFixed(0)}ms経過)`);
        }
      }
    });
    
    const endTime = performance.now();
    const totalTime = endTime - startTime;
    const fps = frames.length / (totalTime / 1000);
    
    console.log(`パフォーマンス結果:`);
    console.log(`- 総処理時間: ${totalTime.toFixed(0)}ms`);
    console.log(`- 平均処理速度: ${fps.toFixed(2)} fps`);
    console.log(`- 出力サイズ: ${mp4.byteLength} bytes`);
    console.log(`- 圧縮率: ${((frames.length * canvas.width * canvas.height * 4) / mp4.byteLength).toFixed(2)}:1`);
    
    return mp4;
  } catch (error) {
    console.error('パフォーマンステスト失敗:', error);
    throw error;
  }
}

// 実行制御
async function runAllExamples() {
  console.log('🚀 包括的な関数ファーストAPI テストを開始します\n');
  
  try {
    // 互換性チェック
    await comprehensiveCompatibilityCheck();
    console.log('\n');
    
    // 基本機能テスト
    await staticFramesExample();
    console.log('\n');
    
    await asyncIterableExample();
    console.log('\n');
    
    await streamingExample();
    console.log('\n');
    
    await performanceExample();
    console.log('\n');
    
    // MediaStreamテスト（ユーザーの許可が必要）
    console.log('MediaStreamテストを実行しますか？ (カメラアクセスが必要)');
    // 実際のアプリでは確認ダイアログを表示
    
    console.log('✅ すべてのテストが完了しました！');
    
  } catch (error) {
    console.error('❌ テストエラー:', error);
  }
}

// エクスポート
export {
  staticFramesExample,
  asyncIterableExample,
  mediaStreamExample,
  videoFileExample,
  streamingExample,
  comprehensiveCompatibilityCheck,
  performanceExample,
  runAllExamples
};

// 自動実行（ブラウザ環境）
if (typeof window !== 'undefined') {
  // ページ読み込み完了後に基本テストを実行
  window.addEventListener('DOMContentLoaded', () => {
    console.log('🎬 関数ファーストAPI の包括テスト準備完了');
    // runAllExamples(); // 必要に応じてコメントアウトを外す
  });
} 