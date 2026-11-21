import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { refreshExchangeRates } from '../services/currencyService.js';
import type { StoreService } from '../services/storeService.js';
import type { WsHub } from '../services/wsHub.js';
import type { YoutubeListenerService } from '../services/youtubeListener.js';

interface ApiDependencies {
  store: StoreService;
  listener: YoutubeListenerService;
  wsHub: WsHub;
}

/**
 * テスト用ダミーイベントのプリセット定義
 * ※ 実際のチャット判定パイプライン（classifyChatItem）を通過させることで
 *    抽出ロジックおよびメンバーシップ除外ロジックをそのまま検証できる
 */
type SimulatePreset =
  | 'super_chat_jpy'
  | 'super_chat_usd'
  | 'super_chat_twd'
  | 'super_sticker'
  | 'gift_jewel'
  | 'membership_new'
  | 'membership_milestone'
  | 'membership_gift';

function buildSimulatedRawItem(preset: SimulatePreset): Record<string, unknown> {
  const id = `sim_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const timestamp = Date.now();

  switch (preset) {
    case 'super_chat_jpy':
      return {
        id,
        timestamp,
        type: 'LiveChatPaidMessage',
        author: { name: 'テスト視聴者A' },
        purchase_amount: '¥1,000',
        message: '配信お疲れ様です！（テスト用Super Chat・円）',
      };
    case 'super_chat_usd':
      return {
        id,
        timestamp,
        type: 'LiveChatPaidMessage',
        author: { name: 'TestViewer_US' },
        purchase_amount: '$10.00',
        message: 'Great stream! (Test Super Chat USD)',
      };
    case 'super_chat_twd':
      return {
        id,
        timestamp,
        type: 'LiveChatPaidMessage',
        author: { name: 'テスト視聴者TW' },
        purchase_amount: 'NT$150.00',
        message: '応援しています！（テスト用Super Chat・台湾ドル）',
      };
    case 'super_sticker':
      return {
        id,
        timestamp,
        type: 'LiveChatPaidSticker',
        author: { name: 'ステッカー応援隊' },
        purchase_amount: '¥500',
        sticker_accessibility_label: 'おめでとうステッカー',
      };
    case 'gift_jewel':
      return {
        id,
        timestamp,
        type: 'GiftMessageViewModel',
        author: { name: 'ギフト視聴者' },
        jewel_count: 200,
        gift_name: 'クラウンギフト',
        message: 'クラウンギフトを贈りました（200 ジュエル）',
      };
    case 'membership_new':
      return {
        id,
        timestamp,
        type: 'LiveChatMembershipItem',
        author: { name: '新規メンバーさん' },
        header_subtext: 'メンバーシップへようこそ！',
      };
    case 'membership_milestone':
      return {
        id,
        timestamp,
        type: 'LiveChatMembershipItem',
        author: { name: '古参メンバーさん' },
        header_subtext: 'メンバー歴 12 か月',
        message: '1周年おめでとうございます！',
      };
    case 'membership_gift':
      return {
        id,
        timestamp,
        type: 'LiveChatSponsorshipsGiftPurchaseAnnouncement',
        author: { name: 'メンギフ贈呈者さん' },
        header_subtext: '5 件のメンバーシップギフトを贈りました',
      };
  }
}

/**
 * 管理ダッシュボードおよび外部操作向けのREST APIルーターを生成する
 */
export function createApiRouter({ store, listener, wsHub }: ApiDependencies): Router {
  const router = Router();

  /**
   * 現在の集計スナップショット・監視状態を取得
   */
  router.get('/state', (_req: Request, res: Response) => {
    res.json(store.getSnapshot(listener.getState()));
  });

  /**
   * YouTube Live 配信のチャット監視を開始
   */
  router.post('/monitor/start', async (req: Request, res: Response) => {
    const urlOrId = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!urlOrId.trim()) {
      res.status(400).json({ error: 'YouTube配信URL または 動画ID を入力してください。' });
      return;
    }

    try {
      const monitorState = await listener.startMonitoring(urlOrId);
      res.json({
        ok: true,
        monitor: monitorState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '監視の開始に失敗しました。';
      res.status(400).json({ error: message, monitor: listener.getState() });
    }
  });

  /**
   * 現在のチャット監視を停止
   */
  router.post('/monitor/stop', (_req: Request, res: Response) => {
    const monitorState = listener.stopMonitoring(true);
    res.json({
      ok: true,
      monitor: monitorState,
    });
  });

  /**
   * 集計金額・履歴をリセット（監視状態はそのまま維持）
   */
  router.post('/session/reset', (_req: Request, res: Response) => {
    store.reset();
    const snapshot = store.getSnapshot(listener.getState());
    wsHub.broadcast({ type: 'reset', payload: snapshot });
    res.json({
      ok: true,
      snapshot,
    });
  });

  /**
   * 目標金額・表示ON/OFF設定を更新する
   */
  router.post('/goal', (req: Request, res: Response) => {
    const patch: { targetJpy?: number; visible?: boolean } = {};

    if (req.body?.targetJpy !== undefined) {
      const parsed = Number(req.body.targetJpy);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({ error: '目標金額は 0 以上の数値で指定してください。' });
        return;
      }
      patch.targetJpy = Math.round(parsed);
    }

    if (req.body?.visible !== undefined) {
      patch.visible = Boolean(req.body.visible);
    }

    const goal = store.updateGoal(patch);
    const snapshot = store.getSnapshot(listener.getState());
    wsHub.broadcast({ type: 'state', payload: snapshot });

    res.json({
      ok: true,
      goal,
      snapshot,
    });
  });

  /**
   * 外部APIから最新の為替レートを手動再取得する
   */
  router.post('/rates/refresh', async (_req: Request, res: Response) => {
    const meta = await refreshExchangeRates();
    const snapshot = store.getSnapshot(listener.getState());
    wsHub.broadcast({ type: 'state', payload: snapshot });

    if (meta.lastError) {
      res.status(502).json({
        ok: false,
        error: meta.lastError,
        snapshot,
      });
      return;
    }

    res.json({
      ok: true,
      meta,
      snapshot,
    });
  });

  /**
   * UTF-8（BOM付き）CSVファイルのダウンロード
   */
  router.get('/export/csv', (_req: Request, res: Response) => {
    const csvContent = store.generateCsv();
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const filename = `superchat-log_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  });

  /**
   * 開発モード用：ダミーのスパチャ・ステッカー・ギフト・メンバーシップを擬似発生させる
   */
  router.post('/test/simulate', (req: Request, res: Response) => {
    if (!config.enableTestMode) {
      res.status(403).json({
        error: 'テストモードは無効になっています（.env の ENABLE_TEST_MODE=true で有効化できます）。',
      });
      return;
    }

    const preset = String(req.body?.preset ?? '') as SimulatePreset;
    const validPresets: SimulatePreset[] = [
      'super_chat_jpy',
      'super_chat_usd',
      'super_chat_twd',
      'super_sticker',
      'gift_jewel',
      'membership_new',
      'membership_milestone',
      'membership_gift',
    ];

    if (!validPresets.includes(preset)) {
      res.status(400).json({ error: '不正なテストイベント種別が指定されました。' });
      return;
    }

    const rawItem = buildSimulatedRawItem(preset);
    const result = listener.processRawChatItem(rawItem, true);

    res.json({
      ok: true,
      resultKind: result.kind,
      detail:
        result.kind === 'donation'
          ? `${result.record.typeLabel}（${result.record.rawAmountText} → ¥${result.record.jpyAmount.toLocaleString('ja-JP')}）を集計しました。`
          : result.kind === 'excluded_membership'
            ? `メンバーシップ関連イベント（${result.rawType}）を正常に除外しました。`
            : '集計対象外のイベントとして無視されました。',
    });
  });

  /**
   * 開発モード用：目標達成時の紙吹雪エフェクトをテスト発火する
   */
  router.post('/test/confetti', (_req: Request, res: Response) => {
    if (!config.enableTestMode) {
      res.status(403).json({
        error: 'テストモードは無効になっています（.env の ENABLE_TEST_MODE=true で有効化できます）。',
      });
      return;
    }

    const snapshot = store.getSnapshot(listener.getState());
    wsHub.broadcast({
      type: 'celebrate',
      payload: {
        reason: 'test',
        targetJpy: snapshot.goal.targetJpy,
        totalJpy: snapshot.totalJpy,
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      ok: true,
      detail: '紙吹雪エフェクトをテスト発火しました（OBSオーバーレイにも反映されます）。',
    });
  });

  return router;
}
