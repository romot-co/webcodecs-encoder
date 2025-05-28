import { encode, encodeStream, canEncode } from 'webcodecs-encoder';

// 最もシンプルな例
async function simpleEncode() {
  console.log('=== シンプルエンコード例 ===');
  
  // Canvasフレームを作成
  const frames = [];
  const canvas = new OffscreenCanvas(1280, 720);
  const ctx = canvas.getContext('2d')!;
  
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `hsl(${(i * 6) % 360}, 100%, 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'white';
    ctx.font = '48px Arial';
    ctx.fillText(`Frame ${i + 1}`, 50, 100);
    
    // フレームをコピーして配列に追加
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    frames.push(imageData);
  }

  try {
    // 自動設定でエンコード
    const mp4 = await encode(frames);
    console.log(`エンコード完了: ${mp4.byteLength} bytes`);
    
    // ダウンロード用のBlob作成
    const blob = new Blob([mp4], { type: 'video/mp4' });
    console.log('Blob URL:', URL.createObjectURL(blob));
  } catch (error) {
    console.error('エンコード失敗:', error);
  }
}

// プリセットを使用した例
async function presetEncode() {
  console.log('=== プリセットエンコード例 ===');
  
  const frames = [];
  const canvas = new OffscreenCanvas(1920, 1080);
  const ctx = canvas.getContext('2d')!;
  
  // より多くのフレームを作成
  for (let i = 0; i < 120; i++) {
    // グラデーション背景
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${(i * 3) % 360}, 70%, 50%)`);
    gradient.addColorStop(1, `hsl(${(i * 3 + 180) % 360}, 70%, 30%)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // テキスト描画
    ctx.fillStyle = 'white';
    ctx.font = 'bold 64px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`高品質フレーム ${i + 1}`, canvas.width / 2, canvas.height / 2);
    
    frames.push(canvas);
  }

  try {
    // 高品質プリセットでエンコード
    const mp4 = await encode(frames, { 
      quality: 'high',
      frameRate: 60,
      onProgress: (progress) => {
        console.log(`進捗: ${progress.percent.toFixed(1)}% (${progress.processedFrames}/${progress.totalFrames || '?'} フレーム)`);
      }
    });
    
    console.log(`高品質エンコード完了: ${mp4.byteLength} bytes`);
  } catch (error) {
    console.error('エンコード失敗:', error);
  }
}

// カスタム設定例
async function customEncode() {
  console.log('=== カスタム設定例 ===');
  
  const frames = [];
  const canvas = new OffscreenCanvas(1280, 720);
  const ctx = canvas.getContext('2d')!;
  
  for (let i = 0; i < 90; i++) {
    // アニメーション効果
    const t = i / 89;
    const x = Math.sin(t * Math.PI * 4) * 200 + canvas.width / 2;
    const y = Math.cos(t * Math.PI * 2) * 100 + canvas.height / 2;
    
    ctx.fillStyle = '#001122';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = `hsl(${(i * 4) % 360}, 100%, 50%)`;
    ctx.beginPath();
    ctx.arc(x, y, 50, 0, Math.PI * 2);
    ctx.fill();
    
    frames.push(canvas);
  }

  try {
    // 詳細設定でエンコード
    const mp4 = await encode(frames, {
      width: 1280,
      height: 720,
      frameRate: 30,
      container: 'mp4',
      video: {
        codec: 'avc',
        bitrate: 3_000_000,
        hardwareAcceleration: 'prefer-hardware'
      },
      audio: false, // オーディオなし
      onProgress: (progress) => {
        console.log(`カスタムエンコード進捗: ${progress.percent.toFixed(1)}%`);
      },
      onError: (error) => {
        console.error('カスタムエンコードエラー:', error);
      }
    });
    
    console.log(`カスタムエンコード完了: ${mp4.byteLength} bytes`);
  } catch (error) {
    console.error('エンコード失敗:', error);
  }
}

// ストリーミング例
async function streamingEncode() {
  console.log('=== ストリーミングエンコード例 ===');
  
  // フレーム生成AsyncGenerator
  async function* generateFrames() {
    const canvas = new OffscreenCanvas(640, 480);
    const ctx = canvas.getContext('2d')!;
    
    for (let i = 0; i < 150; i++) {
      // 波形アニメーション
      ctx.fillStyle = '#000033';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 3;
      ctx.beginPath();
      
      for (let x = 0; x < canvas.width; x += 2) {
        const y = Math.sin((x + i * 5) * 0.02) * 50 + canvas.height / 2;
        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      
      // フレームタイム表示
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Arial';
      ctx.fillText(`Time: ${(i / 30).toFixed(1)}s`, 10, 30);
      
      yield canvas;
      
      // フレーム間隔をシミュレート
      await new Promise(resolve => setTimeout(resolve, 16)); // ~60fps
    }
  }

  try {
    let chunkCount = 0;
    
    // ストリーミングエンコード
    for await (const chunk of encodeStream(generateFrames(), {
      quality: 'medium',
      frameRate: 30,
      onProgress: (progress) => {
        console.log(`ストリーミング進捗: ${progress.percent.toFixed(1)}%`);
      }
    })) {
      chunkCount++;
      console.log(`チャンク ${chunkCount} 受信: ${chunk.byteLength} bytes`);
      
      // 実際のアプリケーションでは、ここでチャンクをMediaSourceに送信するなど
    }
    
    console.log(`ストリーミング完了: ${chunkCount} チャンク受信`);
  } catch (error) {
    console.error('ストリーミングエンコード失敗:', error);
  }
}

// エンコード可能性チェック例
async function checkSupport() {
  console.log('=== エンコード可能性チェック ===');
  
  const tests = [
    { name: 'デフォルト設定', options: undefined },
    { name: 'H.264', options: { video: { codec: 'avc' } } },
    { name: 'VP9', options: { video: { codec: 'vp9' } } },
    { name: 'AV1', options: { video: { codec: 'av1' } } },
    { name: 'WebM', options: { container: 'webm', video: { codec: 'vp9' } } },
    { name: 'オーディオなし', options: { audio: false } },
  ];
  
  for (const test of tests) {
    try {
      const supported = await canEncode(test.options);
      console.log(`${test.name}: ${supported ? '✅ サポート' : '❌ 非サポート'}`);
    } catch (error) {
      console.log(`${test.name}: ❌ エラー - ${error}`);
    }
  }
}

// 実行例
async function runExamples() {
  try {
    await checkSupport();
    await simpleEncode();
    await presetEncode();
    await customEncode();
    await streamingEncode();
  } catch (error) {
    console.error('例の実行中にエラーが発生:', error);
  }
}

// ページ読み込み時に実行
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    console.log('新しい関数ファーストAPI の例を実行中...');
    runExamples();
  });
}

export { 
  simpleEncode, 
  presetEncode, 
  customEncode, 
  streamingEncode, 
  checkSupport, 
  runExamples 
}; 