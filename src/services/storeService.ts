import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  CurrencyBreakdown,
  DONATION_TYPE_LABELS,
  DonationRecord,
  DonationType,
  GoalState,
  MonitorState,
  PersistedSessionData,
  SessionSnapshot,
  TypeBreakdown,
} from '../types.js';
import { getExchangeRateMeta, getExchangeRates } from './currencyService.js';

const SESSION_FILENAME = 'session.json';
const STORAGE_VERSION = 1;
const ALL_DONATION_TYPES: DonationType[] = ['super_chat', 'super_sticker', 'gift'];

/**
 * 集計データのメモリ保持・重複排除・JSONファイル永続化・CSV生成を担当するストア
 */
export class StoreService {
  private readonly sessionFilePath: string;
  private events: DonationRecord[] = [];
  private processedIds: Set<string> = new Set();
  private excludedMembershipCount = 0;
  private goal: GoalState = {
    targetJpy: 0,
    visible: false,
    achieved: false,
    achievedAt: null,
  };
  private updatedAt: string = new Date().toISOString();

  constructor(dataDir: string = config.dataDir) {
    this.sessionFilePath = path.join(dataDir, SESSION_FILENAME);
    this.ensureDataDirectory(dataDir);
    this.loadFromDisk();
  }

  /**
   * データ保存用ディレクトリが存在しない場合は作成する
   */
  private ensureDataDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 起動時にローカルJSONファイルから前回のセッションを復元する
   */
  private loadFromDisk(): void {
    if (!fs.existsSync(this.sessionFilePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.sessionFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedSessionData>;

      if (Array.isArray(parsed.events)) {
        this.events = parsed.events;
        this.processedIds = new Set(this.events.map((e) => e.id));
      }

      if (typeof parsed.excludedMembershipCount === 'number' && parsed.excludedMembershipCount >= 0) {
        this.excludedMembershipCount = parsed.excludedMembershipCount;
      }

      if (parsed.goal && typeof parsed.goal === 'object') {
        const targetJpy =
          typeof parsed.goal.targetJpy === 'number' &&
          Number.isFinite(parsed.goal.targetJpy) &&
          parsed.goal.targetJpy >= 0
            ? Math.round(parsed.goal.targetJpy)
            : 0;
        const visible = Boolean(parsed.goal.visible);
        const currentTotal = this.getTotalJpy();
        const achieved =
          targetJpy > 0 && (Boolean(parsed.goal.achieved) || currentTotal >= targetJpy);
        this.goal = {
          targetJpy,
          visible,
          achieved,
          achievedAt:
            achieved && typeof parsed.goal.achievedAt === 'string'
              ? parsed.goal.achievedAt
              : null,
        };
      }

      if (typeof parsed.updatedAt === 'string') {
        this.updatedAt = parsed.updatedAt;
      }

      console.log(`[ストア] 保存済みセッションを復元しました（課金件数: ${this.events.length}件）`);
    } catch (error) {
      console.error('[ストア] セッションファイルの復元に失敗したため新規状態で起動します:', error);
    }
  }

  /**
   * 現在のセッション状態をローカルJSONへアトミックに保存する
   */
  private saveToDisk(): void {
    const payload: PersistedSessionData = {
      version: STORAGE_VERSION,
      updatedAt: this.updatedAt,
      excludedMembershipCount: this.excludedMembershipCount,
      goal: this.goal,
      events: this.events,
    };

    const tempPath = `${this.sessionFilePath}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.sessionFilePath);
    } catch (error) {
      console.error('[ストア] セッションのJSON保存に失敗しました:', error);
      // 一時ファイルが残っていれば掃除する
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // 無視
      }
    }
  }

  /**
   * 現在の日本円換算合計金額を計算する
   */
  public getTotalJpy(): number {
    return this.events.reduce((sum, event) => sum + event.jpyAmount, 0);
  }

  /**
   * 新しい課金イベントを登録する（ID重複時は added=false）
   * 目標額を今回初めて達成した場合は goalJustAchieved=true を返す
   */
  public addDonation(record: DonationRecord): { added: boolean; goalJustAchieved: boolean } {
    if (this.processedIds.has(record.id)) {
      return { added: false, goalJustAchieved: false };
    }

    this.processedIds.add(record.id);
    this.events.unshift(record); // 新しいイベントを先頭に保持

    let goalJustAchieved = false;
    if (this.goal.targetJpy > 0 && !this.goal.achieved) {
      const total = this.getTotalJpy();
      if (total >= this.goal.targetJpy) {
        this.goal.achieved = true;
        this.goal.achievedAt = new Date().toISOString();
        // 目標表示がONのときのみお祝いエフェクトを発火対象とする
        goalJustAchieved = this.goal.visible;
      }
    }

    this.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return { added: true, goalJustAchieved };
  }

  /**
   * 目標額・表示ON/OFF設定を更新する
   * 目標額を現在合計より高く変更した場合は達成フラグを自動で未達成に戻す
   */
  public updateGoal(patch: { targetJpy?: number; visible?: boolean }): GoalState {
    if (typeof patch.targetJpy === 'number' && Number.isFinite(patch.targetJpy)) {
      const nextTarget = Math.max(0, Math.round(patch.targetJpy));
      this.goal.targetJpy = nextTarget;

      const currentTotal = this.getTotalJpy();
      if (nextTarget === 0 || currentTotal < nextTarget) {
        this.goal.achieved = false;
        this.goal.achievedAt = null;
      } else if (currentTotal >= nextTarget && !this.goal.achieved) {
        this.goal.achieved = true;
        this.goal.achievedAt = new Date().toISOString();
      }
    }

    if (typeof patch.visible === 'boolean') {
      this.goal.visible = patch.visible;
    }

    this.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return { ...this.goal };
  }

  /**
   * 現在の目標設定を取得する
   */
  public getGoal(): GoalState {
    return { ...this.goal };
  }

  /**
   * 除外されたメンバーシップ関連イベントの参考カウントを増やす
   * ※ 金額や課金件数には一切加算しない
   */
  public recordExcludedMembership(): number {
    this.excludedMembershipCount += 1;
    this.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return this.excludedMembershipCount;
  }

  /**
   * 集計データと履歴をすべてリセットする（目標金額と表示ON/OFF設定は維持し、達成状態のみリセット）
   */
  public reset(): void {
    this.events = [];
    this.processedIds.clear();
    this.excludedMembershipCount = 0;
    this.goal.achieved = false;
    this.goal.achievedAt = null;
    this.updatedAt = new Date().toISOString();
    this.saveToDisk();
  }

  /**
   * 画面表示・WebSocket配信用の最新集計スナップショットを生成する
   */
  public getSnapshot(monitor: MonitorState): SessionSnapshot {
    let totalJpy = 0;

    // 通貨別集計マップ
    const currencyMap = new Map<string, CurrencyBreakdown>();

    // 種別ごと集計マップ（0件でも常に全種別を表示するため初期登録）
    const typeMap = new Map<DonationType, TypeBreakdown>();
    for (const type of ALL_DONATION_TYPES) {
      typeMap.set(type, {
        type,
        label: DONATION_TYPE_LABELS[type],
        jpyTotal: 0,
        count: 0,
      });
    }

    for (const event of this.events) {
      totalJpy += event.jpyAmount;

      // 通貨別の集計
      const existingCurrency = currencyMap.get(event.currency);
      if (existingCurrency) {
        existingCurrency.originalTotal = Number((existingCurrency.originalTotal + event.amount).toFixed(4));
        existingCurrency.jpyTotal += event.jpyAmount;
        existingCurrency.count += 1;
        existingCurrency.isUnknown = existingCurrency.isUnknown || event.isUnknownCurrency;
      } else {
        currencyMap.set(event.currency, {
          currency: event.currency,
          originalTotal: Number(event.amount.toFixed(4)),
          jpyTotal: event.jpyAmount,
          count: 1,
          isUnknown: event.isUnknownCurrency,
        });
      }

      // 種別ごとの集計
      const typeEntry = typeMap.get(event.type);
      if (typeEntry) {
        typeEntry.jpyTotal += event.jpyAmount;
        typeEntry.count += 1;
      }
    }

    const byCurrency = Array.from(currencyMap.values()).sort((a, b) => {
      if (b.jpyTotal !== a.jpyTotal) {
        return b.jpyTotal - a.jpyTotal;
      }
      return b.count - a.count;
    });

    return {
      totalJpy,
      totalCount: this.events.length,
      excludedMembershipCount: this.excludedMembershipCount,
      byCurrency,
      byType: Array.from(typeMap.values()),
      events: [...this.events],
      monitor,
      goal: { ...this.goal },
      updatedAt: this.updatedAt,
      testModeEnabled: config.enableTestMode,
      exchangeRates: getExchangeRates(),
      exchangeRateMeta: getExchangeRateMeta(),
    };
  }

  /**
   * UTF-8（BOM付き）のCSV文字列を生成する
   * 出力列: 日時, ユーザー名, 課金種別, 元通貨, 元金額, 日本円換算額, メッセージ
   */
  public generateCsv(): string {
    const headers = ['日時', 'ユーザー名', '課金種別', '元通貨', '元金額', '日本円換算額', 'メッセージ'];

    // CSVは時系列順（古い→新しい）で並べ替えて出力する
    const chronological = [...this.events].reverse();

    const rows = chronological.map((event) => {
      const formattedDate = formatLocalDateTime(event.timestamp);
      return [
        formattedDate,
        event.authorName,
        event.typeLabel,
        event.currency,
        String(event.amount),
        String(event.jpyAmount),
        event.message,
      ]
        .map(escapeCsvCell)
        .join(',');
    });

    // Excel での文字化けを防ぐため UTF-8 BOM を先頭に付与
    return `\uFEFF${headers.map(escapeCsvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
  }
}

/**
 * RFC 4180 に準拠したCSVセルエスケープ処理
 */
function escapeCsvCell(value: string): string {
  const str = value ?? '';
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * ISO日時文字列をローカル時刻の見やすい形式（YYYY-MM-DD HH:mm:ss）へ整形する
 */
function formatLocalDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
