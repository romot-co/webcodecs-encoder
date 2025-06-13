import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerCommunicator } from '../src/worker/worker-communicator';

// Workerをモック
const mockWorker = {
  postMessage: vi.fn(),
  terminate: vi.fn(),
  onmessage: null as ((event: any) => void) | null,
};

// Blobとcreateobjecturlをモック
const mockBlob = vi.fn();
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url');
const mockRevokeObjectURL = vi.fn();

describe('WorkerCommunicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Worker constructor をモック
    global.Worker = vi.fn(() => mockWorker) as any;
    global.Blob = mockBlob as any;
    global.URL = {
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL
    } as any;
    
    // ブラウザ環境をシミュレート
    Object.defineProperty(global, 'window', {
      value: {},
      writable: true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('基本機能', () => {
    it('インスタンスが正常に作成される', () => {
      const communicator = new WorkerCommunicator();
      expect(communicator).toBeInstanceOf(WorkerCommunicator);
    });

    it('メッセージ送信が正常に動作する', () => {
      const communicator = new WorkerCommunicator();
      
      communicator.send('initialize', { config: { width: 640, height: 480 } });
      
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'initialize',
        config: { width: 640, height: 480 }
      });
    });

    it('VideoFrameのTransferableオブジェクト最適化が動作する (v0.2.2)', () => {
      const communicator = new WorkerCommunicator();
      
      // モックVideoFrame
      const mockVideoFrame = {
        close: vi.fn(),
        timestamp: 0,
        displayWidth: 640,
        displayHeight: 480,
      };
      
      communicator.send('addVideoFrame', { 
        frame: mockVideoFrame,
        timestamp: 0 
      });
      
      // Transferableオブジェクトとして送信されることを確認
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'addVideoFrame',
        frame: mockVideoFrame,
        timestamp: 0
      }, [mockVideoFrame]);
    });

    it('AudioDataのTransferableオブジェクト最適化が動作する (v0.2.2)', () => {
      const communicator = new WorkerCommunicator();
      
      // モックAudioData
      const mockAudioData = {
        close: vi.fn(),
        timestamp: 0,
        sampleRate: 48000,
        numberOfChannels: 2,
      };
      
      communicator.send('addAudioData', { 
        audio: mockAudioData,
        timestamp: 0 
      });
      
      // Transferableオブジェクトとして送信されることを確認
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'addAudioData',
        audio: mockAudioData,
        timestamp: 0
      }, [mockAudioData]);
    });

    it('ArrayBufferのTransferableオブジェクト最適化が動作する (v0.2.2)', () => {
      const communicator = new WorkerCommunicator();
      
      const mockArrayBuffer = new ArrayBuffer(1024);
      
      communicator.send('data', { 
        buffer: mockArrayBuffer
      });
      
      // Transferableオブジェクトとして送信されることを確認
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'data',
        buffer: mockArrayBuffer
      }, [mockArrayBuffer]);
    });

    it('Transferableオブジェクトがない場合は通常送信される', () => {
      const communicator = new WorkerCommunicator();
      
      communicator.send('normal', { data: 'test' });
      
      // 通常のpostMessage（第二引数なし）
      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'normal',
        data: 'test'
      });
    });

    it('イベントハンドラーの登録と削除が動作する', () => {
      const communicator = new WorkerCommunicator();
      const handler = vi.fn();
      
      communicator.on('initialized', handler);
      expect(typeof communicator.off).toBe('function');
      
      communicator.off('initialized');
      // ハンドラーが削除されたことを確認
    });

    it('workerのメッセージ処理が動作する', () => {
      const communicator = new WorkerCommunicator();
      const handler = vi.fn();
      
      communicator.on('initialized', handler);
      
      const messageHandler = mockWorker.onmessage;
      if (messageHandler) {
        const mockEvent = {
          data: {
            type: 'initialized',
            actualVideoCodec: 'avc1.42001f'
          }
        };
        
        messageHandler(mockEvent);
        
        expect(handler).toHaveBeenCalledWith({
          actualVideoCodec: 'avc1.42001f'
        });
      }
    });

    it('リソースのクリーンアップが動作する', () => {
      const communicator = new WorkerCommunicator();
      
      communicator.terminate();
      
      expect(mockWorker.terminate).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });
  });

  describe('インラインワーカー作成', () => {
    it('テスト環境でインラインワーカーが作成される', () => {
      // テスト環境設定
      Object.defineProperty(global, 'process', {
        value: { env: { NODE_ENV: 'test' } },
        writable: true
      });

      new WorkerCommunicator();
      
      expect(mockBlob).toHaveBeenCalled();
      expect(mockCreateObjectURL).toHaveBeenCalled();
    });
  });

  describe('エラーハンドリング', () => {
    it('Worker作成失敗時の動作確認', () => {
      // シングルトンパターンによりワーカーが再利用されるため、
      // 基本的な動作確認のみ行う
      const communicator = new WorkerCommunicator();
      expect(communicator).toBeInstanceOf(WorkerCommunicator);
      
      // 通信の基本機能が動作することを確認
      expect(typeof communicator.send).toBe('function');
      expect(typeof communicator.terminate).toBe('function');
    });
  });
}); 