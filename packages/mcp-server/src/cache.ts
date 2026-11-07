import {
  AuctionItem,
  AuctionQuotaInfo,
  MarketPriceParams,
  MarketPriceRecord,
  SearchAuctionParams,
} from '../../shared/src/index.js';

interface CacheEntry<T> {
  data: T;
  quota: AuctionQuotaInfo;
  createdAt: number;
  expiresAt: number;
}

export class AuctionSearchCache {
  private searchCache = new Map<string, CacheEntry<AuctionItem[]>>();
  private marketPriceCache = new Map<string, CacheEntry<MarketPriceRecord[]>>();
  private lastKnownItemsById = new Map<string, AuctionItem>();
  private readonly ttlMs: number;

  constructor(ttlSeconds = 300) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * 기본 검색 키 생성 (아이템명 + 카테고리 + 월드 필터 기준)
   * 세부 가격/스타포스/잠재 필터는 로컬 재필터링 엔진이 처리하여 일일 검색 100회 차감을 절약합니다.
   */
  public buildBaseSearchKey(params: SearchAuctionParams): string {
    const name = params.itemName.trim().toLowerCase();
    const exact = params.exactMatch ? '1' : '0';
    const world = params.currentWorldOnly ? '1' : '0';
    const cat = params.category ?? 'ALL';
    const sub = params.subCategory ?? 'ALL';
    return `search:${name}|exact=${exact}|world=${world}|cat=${cat}|sub=${sub}`;
  }

  public buildMarketPriceKey(params: MarketPriceParams): string {
    const name = params.itemName.trim().toLowerCase();
    const exact = params.exactMatch ? '1' : '0';
    return `price:${name}|exact=${exact}`;
  }

  public setSearchCache(
    params: SearchAuctionParams,
    items: AuctionItem[],
    quota: AuctionQuotaInfo
  ): void {
    const key = this.buildBaseSearchKey(params);
    const now = Date.now();
    this.searchCache.set(key, {
      data: items,
      quota,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    for (const item of items) {
      this.lastKnownItemsById.set(item.itemId, item);
    }
  }

  public getSearchCache(
    params: SearchAuctionParams
  ): { items: AuctionItem[]; quota: AuctionQuotaInfo; ttlRemainingSec: number } | null {
    if (params.forceRefresh) return null;
    const key = this.buildBaseSearchKey(params);
    const entry = this.searchCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.searchCache.delete(key);
      return null;
    }

    return {
      items: entry.data,
      quota: entry.quota,
      ttlRemainingSec: Math.max(1, Math.round((entry.expiresAt - now) / 1000)),
    };
  }

  public setMarketPriceCache(
    params: MarketPriceParams,
    records: MarketPriceRecord[],
    quota: AuctionQuotaInfo
  ): void {
    const key = this.buildMarketPriceKey(params);
    const now = Date.now();
    this.marketPriceCache.set(key, {
      data: records,
      quota,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  public getMarketPriceCache(
    params: MarketPriceParams
  ): { records: MarketPriceRecord[]; quota: AuctionQuotaInfo; ttlRemainingSec: number } | null {
    if (params.forceRefresh) return null;
    const key = this.buildMarketPriceKey(params);
    const entry = this.marketPriceCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.marketPriceCache.delete(key);
      return null;
    }

    return {
      records: entry.data,
      quota: entry.quota,
      ttlRemainingSec: Math.max(1, Math.round((entry.expiresAt - now) / 1000)),
    };
  }

  public getItemById(itemId: string): AuctionItem | undefined {
    return this.lastKnownItemsById.get(itemId);
  }

  public registerItems(items: AuctionItem[]): void {
    for (const item of items) {
      this.lastKnownItemsById.set(item.itemId, item);
    }
  }

  /**
   * 캐싱된 매물 배열에 세부 조건 필터링 및 정렬 적용 (검색 횟수 소모 0)
   */
  public filterAndSortItems(items: AuctionItem[], params: SearchAuctionParams): AuctionItem[] {
    let filtered = items.filter((item) => {
      if (params.exactMatch && item.itemName.trim() !== params.itemName.trim()) {
        return false;
      }
      if (!params.exactMatch && !item.itemName.includes(params.itemName.trim())) {
        return false;
      }
      if (params.minPrice !== undefined && item.price < params.minPrice) {
        return false;
      }
      if (params.maxPrice !== undefined && item.price > params.maxPrice) {
        return false;
      }
      if (params.minStarforce !== undefined && item.starforce < params.minStarforce) {
        return false;
      }
      if (params.maxStarforce !== undefined && item.starforce > params.maxStarforce) {
        return false;
      }
      if (params.potentialGrade && item.potential?.grade !== params.potentialGrade) {
        return false;
      }
      if (
        params.additionalPotentialGrade &&
        item.additionalPotential?.grade !== params.additionalPotentialGrade
      ) {
        return false;
      }
      if (params.potentialKeyword) {
        const kw = params.potentialKeyword.toLowerCase();
        const potText = [
          ...(item.potential?.options ?? []),
          ...(item.additionalPotential?.options ?? []),
          item.bonusStatSummary ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!potText.includes(kw)) {
          return false;
        }
      }
      return true;
    });

    const sortBy = params.sortBy ?? 'price_asc';
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'price_asc':
          return a.price - b.price;
        case 'price_desc':
          return b.price - a.price;
        case 'starforce_desc':
          return b.starforce - a.starforce || a.price - b.price;
        case 'combat_power_desc':
          return (b.combatPowerDelta ?? 0) - (a.combatPowerDelta ?? 0) || a.price - b.price;
        default:
          return a.price - b.price;
      }
    });

    const limit = params.limit ?? 20;
    return filtered.slice(0, limit);
  }

  public filterMarketPriceRecords(
    records: MarketPriceRecord[],
    params: MarketPriceParams
  ): MarketPriceRecord[] {
    const filtered = records.filter((rec) => {
      if (params.exactMatch && rec.itemName.trim() !== params.itemName.trim()) {
        return false;
      }
      if (params.minStarforce !== undefined && rec.starforce < params.minStarforce) {
        return false;
      }
      if (params.maxStarforce !== undefined && rec.starforce > params.maxStarforce) {
        return false;
      }
      if (params.potentialGrade && rec.potential?.grade !== params.potentialGrade) {
        return false;
      }
      return true;
    });

    const limit = params.limit ?? 25;
    return filtered.slice(0, limit);
  }

  public static buildQuotaWarning(quota: AuctionQuotaInfo): string | undefined {
    if (quota.searchRemaining <= 0) {
      return '⚠️ 오늘 사용 가능한 메이플 옥션 검색 횟수(100회)를 모두 소진했습니다. 자정(00:00)에 초기화됩니다.';
    }
    if (quota.searchRemaining <= 15) {
      return `⚠️ 일일 검색 횟수가 ${quota.searchRemaining}회 남았습니다 (${quota.searchUsed}/${quota.searchLimit}). 불필요한 재검색을 피하고 캐시된 결과를 활용하세요.`;
    }
    return undefined;
  }
}
