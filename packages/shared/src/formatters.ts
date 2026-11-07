import { ALLOWED_BRIDGE_ACTIONS, AllowedBridgeAction, MarketPriceRecord, MarketPriceSummary } from './types.js';

/**
 * 메이플스토리 메소 단위를 한국어(조/억/만) 읽기 쉬운 문자열로 변환
 * 예: 34442630477 -> "344억 4263만 477"
 */
export function formatMeso(meso: number): string {
  if (!Number.isFinite(meso) || meso === 0) return '0';
  const isNegative = meso < 0;
  let remaining = Math.floor(Math.abs(meso));

  const jo = Math.floor(remaining / 1_0000_0000_0000);
  remaining %= 1_0000_0000_0000;

  const eok = Math.floor(remaining / 1_0000_0000);
  remaining %= 1_0000_0000;

  const man = Math.floor(remaining / 1_0000);
  const rest = remaining % 1_0000;

  const parts: string[] = [];
  if (jo > 0) parts.push(`${jo}조`);
  if (eok > 0) parts.push(`${eok}억`);
  if (man > 0) parts.push(`${man}만`);
  if (rest > 0) parts.push(`${rest}`);

  const formatted = parts.join(' ');
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * 한국어 메소 표기 문자열("344억 4263만 477" 또는 "12,500,000,000")을 숫자로 파싱
 */
export function parseKoreanMeso(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim();
  if (/^\d+$/.test(cleaned)) {
    return Number(cleaned);
  }

  let total = 0;
  const joMatch = cleaned.match(/(\d+)\s*조/);
  const eokMatch = cleaned.match(/(\d+)\s*억/);
  const manMatch = cleaned.match(/(\d+)\s*만/);

  if (joMatch) total += Number(joMatch[1]) * 1_0000_0000_0000;
  if (eokMatch) total += Number(eokMatch[1]) * 1_0000_0000;
  if (manMatch) total += Number(manMatch[1]) * 1_0000;

  // 만 단위 뒤의 나머지 숫자 추출
  const tailRemoved = cleaned
    .replace(/(\d+)\s*조/g, '')
    .replace(/(\d+)\s*억/g, '')
    .replace(/(\d+)\s*만/g, '')
    .trim();
  const restMatch = tailRemoved.match(/(\d+)/);
  if (restMatch) {
    total += Number(restMatch[1]);
  }

  return total;
}

/**
 * 시세 거래 내역 배열로부터 통계 요약(평균, 중앙값, 최저, 최고, 편차율) 계산
 */
export function calculateMarketPriceSummary(records: MarketPriceRecord[]): MarketPriceSummary {
  if (!records || records.length === 0) {
    return {
      sampleCount: 0,
      averagePrice: 0,
      averagePriceFormatted: '0',
      medianPrice: 0,
      medianPriceFormatted: '0',
      minPrice: 0,
      minPriceFormatted: '0',
      maxPrice: 0,
      maxPriceFormatted: '0',
      priceSpreadPct: 0,
    };
  }

  const prices = records
    .map((r) => r.unitPrice ?? r.soldPrice)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) {
    return {
      sampleCount: 0,
      averagePrice: 0,
      averagePriceFormatted: '0',
      medianPrice: 0,
      medianPriceFormatted: '0',
      minPrice: 0,
      minPriceFormatted: '0',
      maxPrice: 0,
      maxPriceFormatted: '0',
      priceSpreadPct: 0,
    };
  }

  const sum = prices.reduce((acc, cur) => acc + cur, 0);
  const avg = Math.round(sum / prices.length);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0
      ? Math.round((prices[mid - 1] + prices[mid]) / 2)
      : prices[mid];
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spreadPct = min > 0 ? Number((((max - min) / min) * 100).toFixed(2)) : 0;

  return {
    sampleCount: prices.length,
    averagePrice: avg,
    averagePriceFormatted: formatMeso(avg),
    medianPrice: median,
    medianPriceFormatted: formatMeso(median),
    minPrice: min,
    minPriceFormatted: formatMeso(min),
    maxPrice: max,
    maxPriceFormatted: formatMeso(max),
    priceSpreadPct: spreadPct,
  };
}

/**
 * 브릿지 액션이 허용된(Read / Wishlist / Focus 전용) 작업인지 검증하는 보안 가드
 * 구매(BUY/PURCHASE)나 판매(SELL/REGISTER) 관련 액션은 원천 차단합니다.
 */
export function assertAllowedBridgeAction(action: string): asserts action is AllowedBridgeAction {
  const normalized = String(action || '').toUpperCase();
  if (
    normalized.includes('BUY') ||
    normalized.includes('PURCHASE') ||
    normalized.includes('SELL') ||
    normalized.includes('REGISTER') ||
    normalized.includes('CANCEL_SALE')
  ) {
    throw new Error(
      `[SECURITY_BLOCK] 직접 구매·판매 관련 액션("${action}")은 정책 및 자산 보호를 위해 원천 차단되어 있습니다. 찜 등록(ADD_WISHLIST) 또는 브라우저 포커스(FOCUS_AND_HIGHLIGHT)를 사용하세요.`
    );
  }

  if (!ALLOWED_BRIDGE_ACTIONS.has(normalized as AllowedBridgeAction)) {
    throw new Error(`[FORBIDDEN_ACTION] 허용되지 않은 브릿지 액션입니다: ${action}`);
  }
}
