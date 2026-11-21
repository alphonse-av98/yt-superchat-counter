import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { createApiRouter } from './routes/api.js';
import { getExchangeRateMeta, getExchangeRates, refreshExchangeRates } from './services/currencyService.js';
import { StoreService } from './services/storeService.js';
import { WsHub } from './services/wsHub.js';
import { YoutubeListenerService } from './services/youtubeListener.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
app.use(express.json());

// 静的ファイル（HTML / CSS / JS）を配信
app.use(express.static(PUBLIC_DIR));

// 明示的な画面ルーティング（管理ダッシュボード / OBSオーバーレイ）
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/overlay', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'overlay.html'));
});

const server = http.createServer(app);
const store = new StoreService(config.dataDir);

// WebSocketハブとYouTubeリスナーを相互連携させる
let wsHub: WsHub;

const listener = new YoutubeListenerService({
  onDonation: (record) => {
    const { added, goalJustAchieved } = store.addDonation(record);
    if (!added) {
      return;
    }
    const snapshot = store.getSnapshot(listener.getState());
    console.log(
      `[集計] ${record.typeLabel} | ${record.authorName} | ${record.rawAmountText} -> ¥${record.jpyAmount.toLocaleString('ja-JP')}`
    );
    wsHub.broadcast({
      type: 'donation',
      payload: {
        event: record,
        snapshot,
      },
    });

    if (goalJustAchieved) {
      console.log(
        `[目標達成] 目標金額 ¥${snapshot.goal.targetJpy.toLocaleString('ja-JP')} を達成しました！（現在 ¥${snapshot.totalJpy.toLocaleString('ja-JP')}）`
      );
      wsHub.broadcast({
        type: 'celebrate',
        payload: {
          reason: 'goal_achieved',
          targetJpy: snapshot.goal.targetJpy,
          totalJpy: snapshot.totalJpy,
          timestamp: new Date().toISOString(),
        },
      });
    }
  },
  onExcludedMembership: (info) => {
    const excludedCount = store.recordExcludedMembership();
    console.log(
      `[除外] メンバーシップ関連イベントをスキップ (${info.rawType} / ${info.authorName})`
    );
    wsHub.broadcast({
      type: 'excluded',
      payload: {
        reason: info.reason,
        rawType: info.rawType,
        authorName: info.authorName,
        excludedMembershipCount: excludedCount,
        timestamp: info.timestamp,
      },
    });
  },
  onStatusChange: (monitorState) => {
    if (wsHub) {
      wsHub.broadcast({
        type: 'status',
        payload: monitorState,
      });
    }
  },
});

wsHub = new WsHub(server, () => store.getSnapshot(listener.getState()));

// REST API をマウント
app.use('/api', createApiRouter({ store, listener, wsHub }));

// 起動処理（為替レートの自動取得後にサーバー待ち受けを開始）
async function bootstrap(): Promise<void> {
  if (config.autoFetchExchangeRates) {
    await refreshExchangeRates();
  } else {
    console.log('[為替レート] 自動取得は無効です（.env / 内蔵概算レートを使用）');
  }

  const rateMeta = getExchangeRateMeta();
  const rates = getExchangeRates();

  server.listen(config.port, config.host, () => {
    const baseUrl = `http://${config.host}:${config.port}`;
    console.log('==========================================================');
    console.log(' YouTube Live 課金リアルタイム集計ツール 起動完了');
    console.log('==========================================================');
    console.log(` 管理ダッシュボード : ${baseUrl}/`);
    console.log(` OBSオーバーレイ    : ${baseUrl}/overlay`);
    console.log(` テストモード       : ${config.enableTestMode ? '有効' : '無効'}`);
    console.log(
      ` 為替レート         : ${rateMeta.provider}（USD=¥${rates.USD?.toFixed(2) ?? '-'}, EUR=¥${rates.EUR?.toFixed(2) ?? '-'}, TWD=¥${rates.TWD?.toFixed(2) ?? '-'}）`
    );
    console.log(` データ保存先       : ${config.dataDir}`);
    console.log('==========================================================');
  });
}

void bootstrap();

// 終了シグナル受信時の安全なシャットダウン
function shutdown(): void {
  console.log('\n[サーバー] 終了処理を実行しています...');
  listener.stopMonitoring(false);
  wsHub.close();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
