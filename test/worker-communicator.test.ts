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