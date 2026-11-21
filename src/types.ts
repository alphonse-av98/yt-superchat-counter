/**
 * 集計対象となる課金イベントの種別
 * ※ メンバーシップ関連（新規加入・継続・ギフト）はここには含めず完全除外する
 */
export type DonationType = 'super_chat' | 'super_sticker' | 'gift';

/**
 * 課金種別の日本語表示ラベル
 */
export const DONATION_TYPE_LABELS: Record<DonationType, string> = {
  super_chat: 'Super Chat',
  super_sticker: 'Super Sticker',
  gift: 'ギフト課金（ジュエル等）',
};

/**
 * 個別の課金イベント記録
 */
export interface DonationRecord {
  /** 重複排除用の一意ID */
  id: string;
  /** 受信日時（ISO 8601形式） */
  timestamp: string;
  /** 送信者名 */
  authorName: string;
  /** 課金種別 */
  type: DonationType;
  /** 課金種別の日本語表示名 */
  typeLabel: string;
  /** YouTubeから取得した元の金額表記（例: "¥1,000", "$5.00", "100 ジュエル"） */
  rawAmountText: string;
  /** 正規化された通貨コード（例: "JPY", "USD", "JEWEL", "UNKNOWN"） */
  currency: string;
  /** 元通貨での金額（数値） */
  amount: number;
  /** 日本円換算額（整数円） */
  jpyAmount: number;
  /** 換算に使用した為替レート（未対応通貨の場合は 0） */
  rateUsed: number;
  /** 未対応通貨で換算できなかった場合 true */
  isUnknownCurrency: boolean;
  /** チャットメッセージ本文（ステッカー・ギフト等で本文がない場合は空文字） */
  message: string;
  /** 開発モードのテストボタンで生成されたイベントかどうか */
  isSimulated?: boolean;
}

/**
 * 通貨別の集計内訳
 */
export interface CurrencyBreakdown {
  currency: string;
  originalTotal: number;
  jpyTotal: number;
  count: number;
  isUnknown: boolean;
}

/**
 * 課金種別ごとの集計内訳
 */
export interface TypeBreakdown {
  type: DonationType;
  label: string;
  jpyTotal: number;
  count: number;
}

/**
 * YouTube Live 監視ステータス
 */
export type MonitorStatus = 'idle' | 'connecting' | 'monitoring' | 'error';

/**
 * 監視セッションの現在状態
 */
export interface MonitorState {
  status: MonitorStatus;
  videoId: string | null;
  videoUrl: string | null;
  streamTitle: string | null;
  channelName: string | null;
  lastError: string | null;
  startedAt: string | null;
}

/**
 * 為替レートの取得元・更新状態メタデータ
 */
export interface ExchangeRateMeta {
  /** 現在のレート取得元（api: 外部APIから自動取得, fallback: 内蔵デフォルト/.envのみ） */
  source: 'api' | 'fallback';
  /** 取得先プロバイダ名 */
  provider: string;
  /** ツール側が取得した日時（ISO 8601、未取得時は null） */
  fetchedAt: string | null;
  /** 取得先APIが公表しているレート更新日時文字列（ある場合） */
  apiUpdatedAt: string | null;
  /** .env で手動固定（上書き）されている通貨コード一覧 */
  overriddenCurrencies: string[];
  /** 直近の取得エラーメッセージ（成功時は null） */
  lastError: string | null;
}

/**
 * 目標金額の設定・達成状態
 */
export interface GoalState {
  /** 目標金額（日本円・0の場合は未設定） */
  targetJpy: number;
  /** 目標額の表示 ON / OFF（管理画面およびOBSオーバーレイへ反映） */
  visible: boolean;
  /** 現在の目標額を達成済みか（紙吹雪の重複発火防止） */
  achieved: boolean;
  /** 目標達成日時（ISO 8601、未達成時は null） */
  achievedAt: string | null;
}

/**
 * 画面（管理ダッシュボード・OBSオーバーレイ）へ配信する集計スナップショット
 */
export interface SessionSnapshot {
  /** 日本円換算の総合計金額（整数円） */
  totalJpy: number;
  /** 集計対象の課金件数合計 */
  totalCount: number;
  /** フィルタで除外したメンバーシップ関連イベントの参考件数（金額・課金件数には非加算） */
  excludedMembershipCount: number;
  /** 通貨別内訳 */
  byCurrency: CurrencyBreakdown[];
  /** 種別ごとの内訳 */
  byType: TypeBreakdown[];
  /** 課金履歴（新しい順） */
  events: DonationRecord[];
  /** 監視ステータス情報 */
  monitor: MonitorState;
  /** 目標金額の設定・達成状態 */
  goal: GoalState;
  /** 最終更新日時（ISO 8601） */
  updatedAt: string;
  /** 開発テストモードの有効/無効 */
  testModeEnabled: boolean;
  /** 現在適用されている為替レート一覧 */
  exchangeRates: Record<string, number>;
  /** 為替レートの取得元・更新ステータス */
  exchangeRateMeta: ExchangeRateMeta;
}

/**
 * JSONファイルへ永続化するデータ構造
 */
export interface PersistedSessionData {
  version: number;
  updatedAt: string;
  excludedMembershipCount: number;
  goal?: GoalState;
  events: DonationRecord[];
}

/**
 * WebSocket でサーバーからクライアントへ送信するメッセージ型
 */
export type WsServerMessage =
  | { type: 'state'; payload: SessionSnapshot }
  | { type: 'donation'; payload: { event: DonationRecord; snapshot: SessionSnapshot } }
  | { type: 'status'; payload: MonitorState }
  | {
      type: 'excluded';
      payload: {
        reason: string;
        rawType: string;
        authorName: string;
        excludedMembershipCount: number;
        timestamp: string;
      };
    }
  | {
      type: 'celebrate';
      payload: {
        reason: 'goal_achieved' | 'test';
        targetJpy: number;
        totalJpy: number;
        timestamp: string;
      };
    }
  | { type: 'reset'; payload: SessionSnapshot };
