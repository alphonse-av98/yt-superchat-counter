import https from 'node:https';
import { config } from '../config.js';
import type { ExchangeRateMeta } from '../types.js';

/**
 * 通貨パース・日本円換算の結果
 */
export interface ParsedCurrencyAmount {
  /** 正規化された通貨コード（例: JPY, USD, JEWEL, UNKNOWN） */
  currency: string;
  /** 元の数値金額 */
  amount: number;
  /** 日本円換算額（整数円） */
  jpyAmount: number;
  /** 適用した為替レート（未対応通貨時は 0） */
  rateUsed: number;
  /** レート未定義の通貨だった場合 true */
  isUnknownCurrency: boolean;
}

/**
 * 現在適用中の為替レートマップ（初期値は 内蔵デフォルト + .env 手動上書き）
 */
let currentRates: Record<string, number> = {
  ...config.defaultExchangeRates,
  ...config.envRateOverrides,
  JPY: 1,
};

/**
 * 為替レートの取得元・更新状態
 */
let rateMeta: ExchangeRateMeta = {
  source: 'fallback',
  provider: '内蔵概算レート / .env',
  fetchedAt: null,
  apiUpdatedAt: null,
  overriddenCurrencies: Object.keys(config.envRateOverrides),
  lastError: null,
};

/**
 * 通貨記号・表記から ISO 通貨コードへの変換テーブル
 * 誤判定を防ぐため、複数文字の記号（CA$, NT$ 等）が単一記号（$）より先に評価される順序で定義する
 */
const SYMBOL_TO_CURRENCY: Array<[string, string]> = [
  // ドル系の国別プレフィックス
  ['CA$', 'CAD'],
  ['C$', 'CAD'],
  ['A$', 'AUD'],
  ['AU$', 'AUD'],
  ['NZ$', 'NZD'],
  ['NT$', 'TWD'],
  ['HK$', 'HKD'],
  ['SG$', 'SGD'],
  ['S$', 'SGD'],
  ['MX$', 'MXN'],
  ['US$', 'USD'],
  ['R$', 'BRL'],
  ['CL$', 'CLP'],
  ['AR$', 'ARS'],
  // 円・人民元のプレフィックス
  ['JP¥', 'JPY'],
  ['JP￥', 'JPY'],
  ['CN¥', 'CNY'],
  ['CN￥', 'CNY'],
  // その他複数文字記号
  ['Rp', 'IDR'],
  ['RM', 'MYR'],
  ['CHF', 'CHF'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['Ft', 'HUF'],
  ['kr', 'SEK'],
  ['S/', 'PEN'],
  // 単一通貨記号
  ['¥', 'JPY'],
  ['￥', 'JPY'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₩', 'KRW'],
  ['₱', 'PHP'],
  ['₹', 'INR'],
  ['฿', 'THB'],
  ['₫', 'VND'],
  ['₺', 'TRY'],
  ['₪', 'ILS'],
];

/**
 * ISO 4217（3文字コード）として認識する主要通貨一覧
 */
const KNOWN_ISO_CODES = new Set<string>([
  'JPY',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'TWD',
  'HKD',
  'KRW',
  'SGD',
  'PHP',
  'INR',
  'BRL',
  'MXN',
  'THB',
  'MYR',
  'IDR',
  'VND',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'TRY',
  'CZK',
  'HUF',
  'ZAR',
  'CLP',
  'COP',
  'PEN',
  'ARS',
  'AED',
  'SAR',
  'ILS',
  'CNY',
  'JEWEL',
]);

/**
 * Node.js 標準の https モジュールで JSON を取得する（Node 16/18/20+ 共通対応）
 */
function fetchJsonHttps(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'yt-superchat-counter/1.0',
          Accept: 'application/json',
        },
      },
      (res) => {
        // 3xx リダイレクトに対応（1回のみ追跡）
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          fetchJsonHttps(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? '不明'}`));
          return;
        }

        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`JSON解析エラー: ${(err as Error).message}`));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`タイムアウト（${timeoutMs}ms）`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 1 JPY = X 通貨 のマップから 1 通貨 = Y JPY のマップへ変換する
 */
function invertJpyBaseRates(rawRates: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [rawCode, rawVal] of Object.entries(rawRates)) {
    const code = rawCode.trim().toUpperCase();
    // 3文字の法定通貨コードのみ取り込み（暗号資産等のノイズを避ける）
    if (!/^[A-Z]{3}$/.test(code)) {
      continue;
    }
    const perJpy = Number(rawVal);
    if (!Number.isFinite(perJpy) || perJpy <= 0) {
      continue;
    }
    // 1単位あたりの日本円額を算出（小数点以下6桁で丸め）
    result[code] = Number((1 / perJpy).toFixed(6));
  }
  result.JPY = 1;
  return result;
}

/**
 * プロバイダ1: ExchangeRate-API Open Access（APIキー不要・TWD含む160通貨以上対応）
 */
async function fetchFromOpenErApi(
  timeoutMs: number
): Promise<{ provider: string; apiUpdatedAt: string | null; rates: Record<string, number> }> {
  const data = (await fetchJsonHttps('https://open.er-api.com/v6/latest/JPY', timeoutMs)) as {
    result?: string;
    time_last_update_utc?: string;
    rates?: Record<string, unknown>;
  };

  if (data?.result !== 'success' || !data.rates || typeof data.rates !== 'object') {
    throw new Error('想定外のレスポンス形式');
  }

  const rates = invertJpyBaseRates(data.rates);
  if (Object.keys(rates).length < 10) {
    throw new Error('取得できた通貨数が少なすぎます');
  }

  return {
    provider: 'open.er-api.com',
    apiUpdatedAt: typeof data.time_last_update_utc === 'string' ? data.time_last_update_utc : null,
    rates,
  };
}

/**
 * プロバイダ2（予備）: fawazahmed0 currency-api（jsDelivr CDN・APIキー不要・TWD対応）
 */
async function fetchFromJsDelivrCurrencyApi(
  timeoutMs: number
): Promise<{ provider: string; apiUpdatedAt: string | null; rates: Record<string, number> }> {
  const data = (await fetchJsonHttps(
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/jpy.json',
    timeoutMs
  )) as {
    date?: string;
    jpy?: Record<string, unknown>;
  };

  if (!data?.jpy || typeof data.jpy !== 'object') {
    throw new Error('想定外のレスポンス形式');
  }

  const rates = invertJpyBaseRates(data.jpy);
  if (Object.keys(rates).length < 10) {
    throw new Error('取得できた通貨数が少なすぎます');
  }

  return {
    provider: 'currency-api (jsDelivr)',
    apiUpdatedAt: typeof data.date === 'string' ? data.date : null,
    rates,
  };
}

/**
 * 外部APIから最新の為替レートを取得して適用する
 * 失敗時は既存レート（または内蔵デフォルト/.env）を維持し、アプリを停止させない
 */
export async function refreshExchangeRates(): Promise<ExchangeRateMeta> {
  const providers = [fetchFromOpenErApi, fetchFromJsDelivrCurrencyApi];
  const errors: string[] = [];

  for (const fetcher of providers) {
    try {
      const result = await fetcher(config.exchangeRateTimeoutMs);
      // 優先順位: .env 手動固定値 > API取得レート > 内蔵デフォルト
      currentRates = {
        ...config.defaultExchangeRates,
        ...result.rates,
        ...config.envRateOverrides,
        JPY: 1,
      };

      rateMeta = {
        source: 'api',
        provider: result.provider,
        fetchedAt: new Date().toISOString(),
        apiUpdatedAt: result.apiUpdatedAt,
        overriddenCurrencies: Object.keys(config.envRateOverrides),
        lastError: null,
      };

      const usd = currentRates.USD?.toFixed(2) ?? '-';
      const eur = currentRates.EUR?.toFixed(2) ?? '-';
      const twd = currentRates.TWD?.toFixed(2) ?? '-';
      console.log(
        `[為替レート] ${result.provider} から最新レートを取得しました（${Object.keys(result.rates).length}通貨 / USD=¥${usd}, EUR=¥${eur}, TWD=¥${twd}）`
      );
      return getExchangeRateMeta();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(msg);
    }
  }

  const combinedError = `最新為替レートの自動取得に失敗しました（${errors.join(' / ')}）。フォールバックレートを使用します。`;
  console.warn(`[為替レート] ${combinedError}`);

  rateMeta = {
    ...rateMeta,
    lastError: combinedError,
  };

  return getExchangeRateMeta();
}

/**
 * 数値表記文字列を JavaScript の number に正規化する
 * 例: "1,234.56" -> 1234.56, "10,00" -> 10, "1.234,50" -> 1234.5, "5 000" -> 5000
 */
function parseLocalizedNumber(rawNumber: string): number {
  const cleaned = rawNumber.replace(/[\s\u00A0\u202F']/g, '');
  if (!cleaned) {
    return NaN;
  }

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  // ドットとカンマの両方がある場合、後ろにある方を小数点とみなす
  if (hasDot && hasComma) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      return Number(cleaned.replace(/\./g, '').replace(',', '.'));
    }
    return Number(cleaned.replace(/,/g, ''));
  }

  // カンマのみの場合（例: "10,00" の欧州小数点 vs "1,000" の3桁区切り）
  if (hasComma && !hasDot) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      return Number(`${parts[0]}.${parts[1]}`);
    }
    return Number(cleaned.replace(/,/g, ''));
  }

  // ドットのみの場合（例: "1.000.000" の3桁区切り vs "10.50" の小数点）
  if (hasDot && !hasComma) {
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      return Number(cleaned.replace(/\./g, ''));
    }
    return Number(cleaned);
  }

  return Number(cleaned);
}

/**
 * 通貨コードと金額から日本円換算額を算出する
 */
export function convertToJpy(currencyCode: string, amount: number): ParsedCurrencyAmount {
  const normalizedCode = currencyCode.trim().toUpperCase() || 'UNKNOWN';
  const safeAmount = Number.isFinite(amount) && amount >= 0 ? amount : 0;
  const rate = currentRates[normalizedCode];

  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    return {
      currency: normalizedCode,
      amount: safeAmount,
      jpyAmount: Math.round(safeAmount * rate),
      rateUsed: rate,
      isUnknownCurrency: false,
    };
  }

  return {
    currency: normalizedCode,
    amount: safeAmount,
    jpyAmount: 0,
    rateUsed: 0,
    isUnknownCurrency: true,
  };
}

/**
 * YouTube チャットから取得した金額文字列をパースし、日本円へ換算する
 * 例: "¥1,000", "$10.00", "NT$150.00", "10,00 €", "USD 5.00", "100 ジュエル"
 */
export function parseAmountText(rawText: string): ParsedCurrencyAmount | null {
  const normalized = rawText.replace(/\u00A0/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  // ジュエル表記の検出（例: "100 ジュエル", "50 Jewels"）
  const jewelMatch = normalized.match(/([\d.,\s]+)\s*(?:ジュエル|jewels?)/i);
  if (jewelMatch) {
    const jewelCount = parseLocalizedNumber(jewelMatch[1]);
    if (Number.isFinite(jewelCount) && jewelCount > 0) {
      return convertToJpy('JEWEL', jewelCount);
    }
  }

  // 金額内の数値部分を抽出
  const numberMatch = normalized.match(/\d[\d.,\s\u202F']*\d|\d/);
  if (!numberMatch) {
    return null;
  }

  const amount = parseLocalizedNumber(numberMatch[0]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  // 数値を除いた残りの文字列から通貨コードを判定
  const currencyPart = normalized.replace(numberMatch[0], ' ').trim();

  // 1. まず3文字のISO通貨コード（例: USD, TWD, PHP, JPY）を優先検出
  const isoTokens = currencyPart.match(/[A-Za-z]{3}/g);
  if (isoTokens) {
    for (const token of isoTokens) {
      const upper = token.toUpperCase();
      if (KNOWN_ISO_CODES.has(upper) || upper in currentRates) {
        return convertToJpy(upper, amount);
      }
    }
  }

  // 2. 通貨記号テーブル（長い記号から順に判定）
  for (const [symbol, code] of SYMBOL_TO_CURRENCY) {
    if (currencyPart.includes(symbol)) {
      return convertToJpy(code, amount);
    }
  }

  // 3. 未知の3文字コードがあればそのまま記録し、未対応通貨扱いにする
  if (isoTokens && isoTokens.length > 0) {
    return convertToJpy(isoTokens[0].toUpperCase(), amount);
  }

  return convertToJpy(currencyPart || 'UNKNOWN', amount);
}

/**
 * 現在の為替レート一覧（読み取り用コピー）を返す
 */
export function getExchangeRates(): Record<string, number> {
  return { ...currentRates };
}

/**
 * 為替レートの取得元・更新状態メタデータを返す
 */
export function getExchangeRateMeta(): ExchangeRateMeta {
  return {
    ...rateMeta,
    overriddenCurrencies: [...rateMeta.overriddenCurrencies],
  };
}
