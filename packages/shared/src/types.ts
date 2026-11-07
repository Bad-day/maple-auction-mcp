/**
 * @maple-auction/shared
 * 메이플스토리 웹 옥션(auction.maplestory.nexon.com) MCP 서버,
 * 크롬 확장 브릿지, Nexon Open API 스펙업 시뮬레이터 간 공통 타입 정의
 */

export type ItemCategory = '방어구' | '무기' | '소비' | '캐시' | '코디' | '기타';

export type PotentialGrade = '노멀' | '레어' | '에픽' | '유니크' | '레전드리';

/**
 * 웹 옥션 상단 배너 캐릭터 및 재화/쿼터 상태
 * (예: MVP 낑선 Lv.293 아크 전투력 9761만 8592 | 344억 4263만 477 메소 | 343 MP | 검색 횟수 0/100)
 */
export interface AuctionCharacterInfo {
  name: string;
  world?: string;
  level: number;
  job: string;
  combatPower: number;
   combatPowerFormatted: string;
  mvpGrade?: string;
}

export interface AuctionCurrencyInfo {
  meso: number;
  mesoFormatted: string;
  maplePoint: number;
}

export interface AuctionQuotaInfo {
  searchUsed: number;
  searchLimit: number;
  searchRemaining: number;
  sellUsed: number;
  sellLimit: number;
}

export interface AuctionStatus {
  connected: boolean;
  loggedIn: boolean;
  pageUrl: string;
  character: AuctionCharacterInfo | null;
  currency: AuctionCurrencyInfo | null;
  quota: AuctionQuotaInfo;
  capturedEndpoints: string[];
  lastUpdated: string;
}

/**
 * 아이템 세부 스탯 옵션 (기본 + 추옵 + 스타포스 + 주문서 합산 및 세부 수치)
 */
export interface ItemStatOptions {
  str?: number;
  dex?: number;
  int?: number;
  luk?: number;
  allStatPct?: number;
  maxHp?: number;
  maxMp?: number;
  attackPower?: number;
  magicPower?: number;
  bossDamagePct?: number;
  ignoreDefensePct?: number;
  damagePct?: number;
  criticalDamagePct?: number;
}

export interface ItemPotentialInfo {
  grade: PotentialGrade;
  options: string[];
}

/**
 * 경매장 매물 아이템 구조체
 */
export interface AuctionItem {
  /** 웹 옥션 내부 매물 고유 ID */
  itemId: string;
  /** 아이템 명칭 (예: "아케인셰이드 스태프") */
  itemName: string;
  /** 장착 부위 또는 분류 (예: "무기", "모자", "귀고리") */
  itemPart?: string;
  category?: ItemCategory;
  subCategory?: string;
  /** 스타포스 강화 단계 (예: 22) */
  starforce: number;
  /** 판매 가격 (메소) */
  price: number;
  /** 읽기 쉬운 한국어 가격 표기 (예: "125억 5000만") */
  priceFormatted: string;
  /** 묶음 판매 시 개당 단가 */
  unitPrice?: number;
  quantity: number;
  /** 윗잠 (잠재능력) */
  potential?: ItemPotentialInfo;
  /** 아랫잠 (에디셔널 잠재능력) */
  additionalPotential?: ItemPotentialInfo;
  /** 아이템 종합 스탯 옵션 (스펙업 계산에 사용) */
  totalOptions: ItemStatOptions;
  /** 추가옵션(추옵) 요약 문자열 (예: "마력 +76, 보공 +12%, 올스탯 +6%") */
  bonusStatSummary?: string;
  /** 웹 옥션에서 계산해주는 전투력 증가량 (표시된 경우) */
  combatPowerDelta?: number;
  /** 남은 등록 시간 (예: "47시간 12분") */
  remainingTime?: string;
  /** 판매 월드 */
  world?: string;
  /** 현재 찜 등록 여부 */
  isWishlisted?: boolean;
  /** 웹 옥션 바로가기 URL */
  auctionPageUrl: string;
}

/**
 * 매물 검색 요청 파라미터
 */
export interface SearchAuctionParams {
  itemName: string;
  exactMatch?: boolean;
  currentWorldOnly?: boolean;
  category?: ItemCategory;
  subCategory?: string;
  minPrice?: number;
  maxPrice?: number;
  minStarforce?: number;
  maxStarforce?: number;
  potentialGrade?: PotentialGrade;
  additionalPotentialGrade?: PotentialGrade;
  potentialKeyword?: string;
  sortBy?: 'price_asc' | 'price_desc' | 'combat_power_desc' | 'starforce_desc';
  limit?: number;
  forceRefresh?: boolean;
}

export interface SearchAuctionResult {
  fromCache: boolean;
  cacheTtlSecondsRemaining?: number;
  quota: AuctionQuotaInfo;
  warning?: string;
  totalCount: number;
  items: AuctionItem[];
  purchaseGuide: {
    auctionBuyUrl: string;
    howToBuy: string;
  };
}

/**
 * 시세 조회 요청 및 응답 구조체
 */
export interface MarketPriceParams {
  itemName: string;
  exactMatch?: boolean;
  minStarforce?: number;
  maxStarforce?: number;
  potentialGrade?: PotentialGrade;
  limit?: number;
  forceRefresh?: boolean;
}

export interface MarketPriceRecord {
  tradeId: string;
  itemName: string;
  starforce: number;
  soldPrice: number;
  soldPriceFormatted: string;
  unitPrice?: number;
  quantity: number;
  soldAt: string;
  potential?: ItemPotentialInfo;
  additionalPotential?: ItemPotentialInfo;
  bonusStatSummary?: string;
  totalOptions?: ItemStatOptions;
  world?: string;
}

export interface MarketPriceSummary {
  sampleCount: number;
  averagePrice: number;
  averagePriceFormatted: string;
  medianPrice: number;
  medianPriceFormatted: string;
  minPrice: number;
  minPriceFormatted: string;
  maxPrice: number;
  maxPriceFormatted: string;
  priceSpreadPct: number;
}

export interface MarketPriceResult {
  fromCache: boolean;
  itemName: string;
  summary: MarketPriceSummary;
  recentTrades: MarketPriceRecord[];
  quota: AuctionQuotaInfo;
}

/**
 * 찜(Wishlist) 관리 구조체
 */
export interface ManageWishlistParams {
  action: 'add' | 'remove';
  itemId: string;
  itemName?: string;
}

export interface ManageWishlistResult {
  success: boolean;
  action: 'add' | 'remove';
  itemId: string;
  message: string;
  wishlistCount: number;
  wishlistMaxSlots: number;
  directPurchaseGuide: {
    wishlistUrl: string;
    instruction: string;
  };
}

/**
 * 브라우저 탭 포커스 및 상세 매물 하이라이트 요청
 */
export interface OpenItemInBrowserParams {
  target: 'wishlist' | 'buy' | 'market';
  itemId?: string;
}

export interface OpenItemInBrowserResult {
  success: boolean;
  focusedTabUrl: string;
  highlightedItemId?: string;
  message: string;
}

/**
 * Nexon Open API 캐릭터 및 장착 장비 구조체
 */
export interface CharacterEquipmentSummary {
  characterName: string;
  worldName: string;
  characterClass: string;
  characterLevel: number;
  combatPower: number;
  mainStatName: 'STR' | 'DEX' | 'INT' | 'LUK';
  attackTypeName: '공격력' | '마력';
  currentStats: {
    mainStat: number;
    subStat: number;
    attackPower: number;
    magicPower: number;
    bossDamagePct: number;
    ignoreDefensePct: number;
    damagePct: number;
    criticalDamagePct: number;
    finalDamagePct: number;
  };
  equippedItems: Record<string, AuctionItem>;
  fetchedAt: string;
}

/**
 * 스펙업 시뮬레이션 비교 결과
 */
export interface SpecUpComparisonItem {
  candidateItem: AuctionItem;
  replacedSlot: string;
  currentEquippedItem: AuctionItem | null;
  statDiff: {
    mainStatDiff: number;
    allStatPctDiff: number;
    attackOrMagicDiff: number;
    bossDamagePctDiff: number;
    ignoreDefensePctDiff: number;
    criticalDamagePctDiff: number;
  };
  /** 예상 최종 데미지 증감률 (%, 예: +3.42) */
  estimatedFinalDamageChangePct: number;
  /** 1% 최종 데미지 상승당 소요 메소 (가성비 지표) */
  mesoPerOnePctFinalDamage: number | null;
  mesoPerOnePctFormatted: string;
  recommendationSummary: string;
}

/**
 * 로컬 브릿지 WebSocket 허용 액션 화이트리스트
 * (주의: 실제 메소 결제/판매 등록 액션은 화이트리스트에서 영구 배제됨)
 */
export type AllowedBridgeAction =
  | 'GET_STATUS'
  | 'SEARCH_ITEMS'
  | 'GET_MARKET_PRICE'
  | 'GET_WISHLIST'
  | 'ADD_WISHLIST'
  | 'REMOVE_WISHLIST'
  | 'FOCUS_AND_HIGHLIGHT';

export const ALLOWED_BRIDGE_ACTIONS: ReadonlySet<AllowedBridgeAction> = new Set([
  'GET_STATUS',
  'SEARCH_ITEMS',
  'GET_MARKET_PRICE',
  'GET_WISHLIST',
  'ADD_WISHLIST',
  'REMOVE_WISHLIST',
  'FOCUS_AND_HIGHLIGHT',
]);

export interface BridgeRequest<T = unknown> {
  requestId: string;
  action: AllowedBridgeAction;
  payload: T;
  timestamp: number;
}

export interface BridgeResponse<T = unknown> {
  requestId: string;
  success: boolean;
  data?: T;
  error?: {
    code: 'NOT_LOGGED_IN' | 'QUOTA_EXCEEDED' | 'FORBIDDEN_ACTION' | 'TAB_NOT_FOUND' | 'NETWORK_ERROR' | 'INTERNAL_ERROR';
    message: string;
  };
  timestamp: number;
}
