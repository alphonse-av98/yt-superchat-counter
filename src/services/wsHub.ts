import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionSnapshot, WsServerMessage } from '../types.js';

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

/**
 * 管理ダッシュボードおよびOBSオーバーレイへのリアルタイム配信を管理するWebSocketハブ
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(server: HttpServer, getInitialSnapshot: () => SessionSnapshot) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (socket: AliveWebSocket) => {
      socket.isAlive = true;

      socket.on('pong', () => {
        socket.isAlive = true;
      });

      socket.on('error', (error) => {
        console.warn('[WebSocket] クライアント通信エラー:', error.message);
      });

      // 接続直後に現在の最新集計スナップショットを送信
      const initialMessage: WsServerMessage = {
        type: 'state',
        payload: getInitialSnapshot(),
      };
      this.sendToClient(socket, initialMessage);
    });

    // 死活監視（切断されたOBSブラウザソース等を定期クリーンアップ）
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.wss.clients as Set<AliveWebSocket>) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 30_000);
  }

  /**
   * 接続中の全クライアントへメッセージをブロードキャストする
   */
  public broadcast(message: WsServerMessage): void {
    const serialized = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  /**
   * 特定のクライアントへメッセージを送信する
   */
  private sendToClient(client: WebSocket, message: WsServerMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  /**
   * サーバー終了時にWebSocketとタイマーを閉じる
   */
  public close(): void {
    clearInterval(this.heartbeatTimer);
    this.wss.close();
  }
}
