import 'dotenv/config';
import path from 'node:path';

/**
 * オフライン時・取得失敗時のフォールバック用内蔵概算為替レート（1単位あたりの日本円換算額）
 * 通常は起動時に外部API（APIキー不要）から最新レートを自動取得し、
 * .env で明示的に指定された通貨のみ手動値で上書きされる
 */
export const DEFAULT_EXCHANGE_RATES: Record<string, number> = {
  JPY: 1,
  USD: 150,
  EUR: 163,
  GBP: 190,
  CAD: 108,
  AUD: 98,
  NZD: 90,
  TWD: 4.7,
  HKD: 19.3,
  KRW: 0.11,
  SGD: 112,
  PHP: 2.6,
  INR: 1.8,
  BRL: 26,
  MXN: 7.5,
  THB: 4.4,
  MYR: 34,
  IDR: 0.0095,
  VND: 0.006,
  CHF: 170,
  SEK: 14,
  NOK: 13.5,
  DKK: 21.8,
  PLN: 37,
  TRY: 4.3,
  CZK: 6.4,
  HUF: 0.4,
  ZAR: 8.2,
  CLP: 0.15,
  COP: 0.035,
  PEN: 40,
  ARS: 0.15,
  AED: 41,
  SAR: 40,
  ILS: 40,
  CNY: 20.8,
  // YouTube 縦型ライブ等のジュエル（1ジュエルあたりの概算円換算）
  JEWEL: 1.5,
};

/**
 * .env で明示的に指定された為替レート上書き設定のみを抽出する
 */
function loadEnvRateOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};

  // 1. 個別の RATE_<通貨コード> 環境変数を読み込み
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!key.startsWith('RATE_') || !rawValue || !rawValue.trim()) {
      continue;
    }
    const currencyCode = key.slice('RATE_'.length).trim().toUpperCase();
    const numericRate = Number(rawValue);
    if (currencyCode && Number.isFinite(numericRate) && numericRate > 0) {
      overrides[currencyCode] = numericRate;
    }
  }

  // 2. EXCHANGE_RATES_JSON が指定されていれば上書き
  const jsonRaw = process.env.EXCHANGE_RATES_JSON?.trim();
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
      for (const [code, value] of Object.entries(parsed)) {
        const numericRate = Number(value);
        if (code && Number.isFinite(numericRate) && numericRate > 0) {
          overrides[code.trim().toUpperCase()] = numericRate;
        }
      }
    } catch (error) {
      console.warn('[設定] EXCHANGE_RATES_JSON のJSON解析に失敗しました。無視して続行します:', error);
    }
  }

  return overrides;
}

/**
 * 真偽値型の環境変数を解釈する
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

const parsedPort = Number(process.env.PORT ?? 3000);
const parsedRateTimeout = Number(process.env.EXCHANGE_RATE_TIMEOUT_MS ?? 5000);
const envRateOverrides = loadEnvRateOverrides();

export interface AppConfig {
  port: number;
  host: string;
  enableTestMode: boolean;
  debugChatEvents: boolean;
  dataDir: string;
  autoFetchExchangeRates: boolean;
  exchangeRateTimeoutMs: number;
  defaultExchangeRates: Record<string, number>;
  envRateOverrides: Record<string, number>;
}

export const config: AppConfig = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3000,
  host: process.env.HOST?.trim() || '127.0.0.1',
  enableTestMode: parseBoolean(process.env.ENABLE_TEST_MODE, true),
  debugChatEvents: parseBoolean(process.env.DEBUG_CHAT_EVENTS, false),
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || './data'),
  autoFetchExchangeRates: parseBoolean(process.env.AUTO_FETCH_EXCHANGE_RATES, true),
  exchangeRateTimeoutMs:
    Number.isFinite(parsedRateTimeout) && parsedRateTimeout >= 1000 && parsedRateTimeout <= 30000
      ? parsedRateTimeout
      : 5000,
  defaultExchangeRates: { ...DEFAULT_EXCHANGE_RATES },
  envRateOverrides,
};
