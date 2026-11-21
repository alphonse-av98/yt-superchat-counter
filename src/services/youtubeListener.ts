import crypto from 'node:crypto';
import { Innertube } from 'youtubei.js';
import { config } from '../config.js';
import {
  DONATION_TYPE_LABELS,
  DonationRecord,
  DonationType,
  MonitorState,
} from '../types.js';
import { convertToJpy, parseAmountText } from './currencyService.js';

/**
 * メンバーシップ関連として完全除外するアイテム型一覧
 */
const EXCLUDED_MEMBERSHIP_TYPES = new Set<string>([
  'LiveChatMembershipItem',
  'LiveChatSponsorshipsGiftPurchaseAnnouncement',
  'LiveChatSponsorshipsGiftRedemptionAnnouncement',
  'LiveChatSponsorshipsHeader',
  // API表記ゆれ・シミュレーション互換用
  'newSponsor',
  'memberMilestoneChat',
  'membershipGifting',
  'giftMembershipReceived',
]);

/**
 * 通常メッセージ・システム通知など課金以外の除外型一覧
 */
const IGNORED_NON_PAID_TYPES = new Set<string>([
  'LiveChatTextMessage',
  'LiveChatViewerEngagementMessage',
  'LiveChatModeChangeMessage',
  'LiveChatPlaceholderItem',
  'LiveChatBanner',
  'LiveChatBannerHeader',
  'LiveChatBannerRedirect',
]);

/**
 * メンバーシップ関連イベントを検出する正規表現（型名の安全側ガード）
 */
const MEMBERSHIP_TYPE_PATTERN =
  /membership|sponsorship|newsponsor|membermilestone|giftmembership/i;

/**
 * チャットアイテム分類結果
 */
export type ClassificationResult =
  | { kind: 'donation'; record: DonationRecord }
  | { kind: 'excluded_membership'; rawType: string; reason: string; authorName: string }
  | { kind: 'ignored' };

/**
 * YouTubeListener が外部（Store / WebSocket）へ通知するためのコールバック群
 */
export interface ListenerCallbacks {
  onDonation: (record: DonationRecord) => void;
  onExcludedMembership: (info: {
    rawType: string;
    reason: string;
    authorName: string;
    timestamp: string;
  }) => void;
  onStatusChange: (state: MonitorState) => void;
}

/**
 * youtubei.js の Text クラスや任意の値から安全に文字列を取り出すヘルパー
 */
function extractText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      return obj.text.trim();
    }
    if (Array.isArray(obj.runs)) {
      return obj.runs
        .map((run) => {
          if (run && typeof run === 'object' && 'text' in run) {
            return String((run as { text?: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim();
    }
    if (typeof obj.toString === 'function') {
      const str = obj.toString();
      if (str && str !== '[object Object]') {
        return str.trim();
      }
    }
  }
  return '';
}

/**
 * アイテム内のタイムスタンプを ISO 8601 形式に正規化する
 */
function extractTimestampIso(rawItem: Record<string, unknown>): string {
  const rawTs = rawItem.timestamp ?? rawItem.timestamp_usec ?? rawItem.timestampUsec;
  if (typeof rawTs === 'string' && rawTs.includes('T')) {
    const parsed = new Date(rawTs);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const numeric = Number(rawTs);
  if (Number.isFinite(numeric) && numeric > 0) {
    // マイクロ秒（16桁程度）の場合はミリ秒へ変換
    const ms = numeric > 1e14 ? Math.floor(numeric / 1000) : numeric;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * 送信者名を抽出する
 */
function extractAuthorName(rawItem: Record<string, unknown>): string {
  const authorObj = rawItem.author as Record<string, unknown> | undefined;
  const candidates = [
    authorObj?.name,
    rawItem.author_name,
    rawItem.authorName,
    rawItem.sender_name,
    (rawItem.header as Record<string, unknown> | undefined)?.author_name,
    ((rawItem.header as Record<string, unknown> | undefined)?.author as Record<string, unknown> | undefined)
      ?.name,
  ];
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) {
      return text;
    }
  }
  return '不明なユーザー';
}

/**
 * YouTube の各種URLまたは11文字の動画IDから動画IDを抽出する
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // そのまま11文字の動画IDが入力された場合
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'youtu.be') {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (hostname.endsWith('youtube.com')) {
      // https://www.youtube.com/watch?v=XXXXXXXXXXX
      const vParam = url.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
        return vParam;
      }

      // /live/ID, /shorts/ID, /embed/ID, /video/ID/livestreaming
      const pathMatch = url.pathname.match(/\/(?:live|shorts|embed|video)\/([a-zA-Z0-9_-]{11})/);
      if (pathMatch) {
        return pathMatch[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * チャットアイテム1件を判定し、課金イベント・メンバーシップ除外・無視のいずれかに分類する
 * ※ 実配信チャットとテスト用シミュレーションの両方で共通利用する
 */
export function classifyChatItem(
  rawItem: Record<string, unknown>,
  options: { isSimulated?: boolean } = {}
): ClassificationResult {
  const rawType = String(rawItem.type ?? '').trim();
  const headerType = String((rawItem.header as Record<string, unknown> | undefined)?.type ?? '').trim();
  const authorName = extractAuthorName(rawItem);

  // 1. メンバーシップ関連イベントは金額・件数とも最優先で完全除外する
  if (
    EXCLUDED_MEMBERSHIP_TYPES.has(rawType) ||
    EXCLUDED_MEMBERSHIP_TYPES.has(headerType) ||
    MEMBERSHIP_TYPE_PATTERN.test(rawType) ||
    MEMBERSHIP_TYPE_PATTERN.test(headerType)
  ) {
    return {
      kind: 'excluded_membership',
      rawType: rawType || headerType || 'MembershipEvent',
      reason: 'メンバーシップ関連イベントのため集計対象外',
      authorName,
    };
  }

  // 2. 通常のチャット・システム通知は無視
  if (IGNORED_NON_PAID_TYPES.has(rawType)) {
    return { kind: 'ignored' };
  }

  const id =
    extractText(rawItem.id) ||
    `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = extractTimestampIso(rawItem);

  // 3. Super Chat（LiveChatPaidMessage）
  if (rawType === 'LiveChatPaidMessage') {
    const rawAmountText = extractText(rawItem.purchase_amount ?? rawItem.purchaseAmount);
    const parsed = parseAmountText(rawAmountText);
    if (!parsed) {
      return { kind: 'ignored' };
    }

    const message = extractText(rawItem.message);
    return {
      kind: 'donation',
      record: buildDonationRecord({
        id,
        timestamp,
        authorName,
        type: 'super_chat',
        rawAmountText,
        parsed,
        message,
        isSimulated: options.isSimulated,
      }),
    };
  }

  // 4. Super Sticker（LiveChatPaidSticker）
  if (rawType === 'LiveChatPaidSticker') {
    const rawAmountText = extractText(rawItem.purchase_amount ?? rawItem.purchaseAmount);
    const parsed = parseAmountText(rawAmountText);
    if (!parsed) {
      return { kind: 'ignored' };
    }

    const stickerLabel =
      extractText(rawItem.sticker_accessibility_label) ||
      extractText((rawItem.sticker as Record<string, unknown> | undefined)?.accessibility_label) ||
      extractText(rawItem.message);

    return {
      kind: 'donation',
      record: buildDonationRecord({
        id,
        timestamp,
        authorName,
        type: 'super_sticker',
        rawAmountText,
        parsed,
        message: stickerLabel,
        isSimulated: options.isSimulated,
      }),
    };
  }

  // 5. その他ギフト課金（ジュエル・プレゼント・Super Thanks 等）
  const isGiftLikeType =
    /gift|jewel|superthanks|thanks/i.test(rawType) ||
    Boolean(rawItem.jewel_count ?? rawItem.jewels ?? rawItem.gift_name);

  if (isGiftLikeType || Boolean(rawItem.purchase_amount ?? rawItem.purchaseAmount)) {
    // 念のため、メッセージ・サブテキストにメンバーシップギフト文言が含まれる場合は誤集計を防ぐ
    const textForGuard = `${extractText(rawItem.header_subtext)} ${extractText(rawItem.subtext)} ${extractText(rawItem.text)}`;
    if (/メンバーシップ.*ギフト|gifted.*membership|member\s*for/i.test(textForGuard)) {
      return {
        kind: 'excluded_membership',
        rawType: rawType || 'MembershipGiftGuard',
        reason: 'メンバーシップギフト文言を検出したため集計対象外',
        authorName,
      };
    }

    // 金額文字列（通貨表記）を優先確認
    const rawAmountText = extractText(
      rawItem.purchase_amount ??
        rawItem.purchaseAmount ??
        rawItem.amount ??
        rawItem.price ??
        rawItem.gift_amount
    );

    let parsed = rawAmountText ? parseAmountText(rawAmountText) : null;
    let displayAmountText = rawAmountText;

    // ジュエル数（数値）が直接渡されている場合
    if (!parsed) {
      const jewelNumeric = Number(rawItem.jewel_count ?? rawItem.jewels ?? rawItem.coins);
      if (Number.isFinite(jewelNumeric) && jewelNumeric > 0) {
        parsed = convertToJpy('JEWEL', jewelNumeric);
        displayAmountText = `${jewelNumeric} ジュエル`;
      }
    }

    // 本文テキスト内に金額やジュエル数が埋め込まれている場合のフォールバック
    if (!parsed) {
      const combinedText = `${extractText(rawItem.text)} ${extractText(rawItem.subtext)} ${extractText(rawItem.message)}`;
      parsed = parseAmountText(combinedText);
      if (parsed) {
        displayAmountText =
          parsed.currency === 'JEWEL'
            ? `${parsed.amount} ジュエル`
            : `${parsed.currency} ${parsed.amount}`;
      }
    }

    if (!parsed) {
      return { kind: 'ignored' };
    }

    const giftName = extractText(rawItem.gift_name ?? rawItem.giftName);
    const bodyMessage = extractText(rawItem.message ?? rawItem.text);
    const message =
      giftName && bodyMessage && !bodyMessage.includes(giftName)
        ? `[${giftName}] ${bodyMessage}`
        : bodyMessage || giftName;

    return {
      kind: 'donation',
      record: buildDonationRecord({
        id,
        timestamp,
        authorName,
        type: 'gift',
        rawAmountText: displayAmountText || `${parsed.currency} ${parsed.amount}`,
        parsed,
        message,
        isSimulated: options.isSimulated,
      }),
    };
  }

  return { kind: 'ignored' };
}

function buildDonationRecord(params: {
  id: string;
  timestamp: string;
  authorName: string;
  type: DonationType;
  rawAmountText: string;
  parsed: ReturnType<typeof convertToJpy>;
  message: string;
  isSimulated?: boolean;
}): DonationRecord {
  return {
    id: params.id,
    timestamp: params.timestamp,
    authorName: params.authorName,
    type: params.type,
    typeLabel: DONATION_TYPE_LABELS[params.type],
    rawAmountText: params.rawAmountText,
    currency: params.parsed.currency,
    amount: params.parsed.amount,
    jpyAmount: params.parsed.jpyAmount,
    rateUsed: params.parsed.rateUsed,
    isUnknownCurrency: params.parsed.isUnknownCurrency,
    message: params.message,
    isSimulated: params.isSimulated,
  };
}

/**
 * youtubei.js を用いて YouTube Live チャットを購読・監視するサービス
 */
export class YoutubeListenerService {
  private innertube: Innertube | null = null;
  private activeLiveChat: { stop: () => void } | null = null;
  private activeSessionToken = 0;
  private state: MonitorState = {
    status: 'idle',
    videoId: null,
    videoUrl: null,
    streamTitle: null,
    channelName: null,
    lastError: null,
    startedAt: null,
  };

  constructor(private readonly callbacks: ListenerCallbacks) {}

  /**
   * 現在の監視ステータスを返す
   */
  public getState(): MonitorState {
    return { ...this.state };
  }

  /**
   * 監視状態を更新して通知する
   */
  private updateState(partial: Partial<MonitorState>): void {
    this.state = {
      ...this.state,
      ...partial,
    };
    this.callbacks.onStatusChange(this.getState());
  }

  /**
   * 指定された YouTube Live URL または動画IDの監視を開始する
   */
  public async startMonitoring(inputUrlOrId: string): Promise<MonitorState> {
    const videoId = extractVideoId(inputUrlOrId);
    if (!videoId) {
      throw new Error('有効な YouTube 配信URL または 11文字の動画ID を入力してください。');
    }

    // 既に別の監視が動いていれば先に停止する
    this.stopMonitoring(false);

    const sessionToken = ++this.activeSessionToken;
    const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;

    this.updateState({
      status: 'connecting',
      videoId,
      videoUrl: normalizedUrl,
      streamTitle: null,
      channelName: null,
      lastError: null,
      startedAt: null,
    });

    try {
      if (!this.innertube) {
        this.innertube = await Innertube.create({
          lang: 'ja',
          location: 'JP',
          retrieve_player: false,
        });
      }

      // 接続処理中に停止・別配信開始された場合は中断
      if (sessionToken !== this.activeSessionToken) {
        return this.getState();
      }

      const info = await this.innertube.getInfo(videoId);
      const streamTitle = info.basic_info?.title ?? null;
      const channelName = info.basic_info?.author ?? null;

      let liveChat;
      try {
        liveChat = info.getLiveChat();
      } catch {
        throw new Error(
          'この動画ではライブチャットを取得できませんでした。配信が開始されているか、チャットが有効か確認してください。'
        );
      }

      if (sessionToken !== this.activeSessionToken) {
        return this.getState();
      }

      this.activeLiveChat = liveChat;

      liveChat.on('start', () => {
        if (sessionToken !== this.activeSessionToken) {
          return;
        }
        console.log(`[YouTube監視] チャット監視を開始しました: ${streamTitle ?? videoId}`);
        this.updateState({
          status: 'monitoring',
          streamTitle,
          channelName,
          lastError: null,
          startedAt: new Date().toISOString(),
        });
      });

      liveChat.on('chat-update', (action: unknown) => {
        if (sessionToken !== this.activeSessionToken) {
          return;
        }
        this.handleChatAction(action);
      });

      liveChat.on('error', (err: Error) => {
        if (sessionToken !== this.activeSessionToken) {
          return;
        }
        console.error('[YouTube監視] ライブチャットエラー:', err);
        this.updateState({
          status: 'error',
          lastError: err.message || 'ライブチャットの取得中にエラーが発生しました。',
        });
      });

      liveChat.on('end', () => {
        if (sessionToken !== this.activeSessionToken) {
          return;
        }
        console.log('[YouTube監視] ライブ配信またはチャットが終了しました。');
        this.activeLiveChat = null;
        this.updateState({
          status: 'idle',
          lastError: null,
        });
      });

      liveChat.start();

      // start イベント発火前にもタイトル等を反映しておく
      this.updateState({
        streamTitle,
        channelName,
      });

      return this.getState();
    } catch (error) {
      if (sessionToken !== this.activeSessionToken) {
        return this.getState();
      }
      const message =
        error instanceof Error
          ? error.message
          : 'YouTube Live への接続に失敗しました。';
      console.error('[YouTube監視] 接続失敗:', message);
      this.activeLiveChat = null;
      this.updateState({
        status: 'error',
        lastError: message,
      });
      throw new Error(message);
    }
  }

  /**
   * 現在のライブチャット監視を停止する
   */
  public stopMonitoring(emitState = true): MonitorState {
    this.activeSessionToken += 1;

    if (this.activeLiveChat) {
      try {
        this.activeLiveChat.stop();
      } catch (error) {
        console.warn('[YouTube監視] 停止処理で警告が発生しました:', error);
      }
      this.activeLiveChat = null;
    }

    if (emitState) {
      this.updateState({
        status: 'idle',
        lastError: null,
      });
    }

    return this.getState();
  }

  /**
   * ライブチャットのアクション1件を処理する
   */
  private handleChatAction(action: unknown): void {
    if (!action || typeof action !== 'object') {
      return;
    }

    const actionObj = action as Record<string, unknown>;
    const actionType = String(actionObj.type ?? '');

    // AddChatItemAction 以外のティッカー追加や削除アクションは重複・非対象のためスキップ
    if (actionType && actionType !== 'AddChatItemAction') {
      return;
    }

    const item = actionObj.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') {
      return;
    }

    if (config.debugChatEvents) {
      console.log('[DEBUG_CHAT_EVENTS]', JSON.stringify({ actionType, itemType: item.type, item }));
    }

    this.processRawChatItem(item, false);
  }

  /**
   * 生のチャットアイテム（実配信・シミュレーション共通）を分類してコールバックを呼び出す
   */
  public processRawChatItem(
    item: Record<string, unknown>,
    isSimulated = false
  ): ClassificationResult {
    const result = classifyChatItem(item, { isSimulated });

    if (result.kind === 'donation') {
      this.callbacks.onDonation(result.record);
    } else if (result.kind === 'excluded_membership') {
      this.callbacks.onExcludedMembership({
        rawType: result.rawType,
        reason: result.reason,
        authorName: result.authorName,
        timestamp: new Date().toISOString(),
      });
    }

    return result;
  }
}
