#!/usr/bin/env node
import * as readline from 'node:readline';
import {
  AuctionItem,
  AuctionQuotaInfo,
  AuctionStatus,
  calculateMarketPriceSummary,
  ManageWishlistParams,
  ManageWishlistResult,
  MarketPriceParams,
  MarketPriceRecord,
  MarketPriceResult,
  OpenItemInBrowserParams,
  OpenItemInBrowserResult,
  SearchAuctionParams,
  SearchAuctionResult,
} from '../../shared/src/index.js';
import { AuctionSearchCache } from './cache.js';
import { LocalBridgeServer } from './bridge-server.js';
import { NexonOpenApiClient } from './nexon-api.js';
import { SpecUpSimulator } from './spec-simulator.js';

/**
 * CLI 인자에서 --api-key 추출
 */
function parseCliApiKey(): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--api-key');
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return process.env.NEXON_OPEN_API_KEY;
}

export class MapleAuctionMcpService {
  public readonly cache = new AuctionSearchCache(300);
  public readonly bridge = new LocalBridgeServer();
  public readonly nexonApi = new NexonOpenApiClient(parseCliApiKey());

  public async initialize(): Promise<void> {
    await this.bridge.start();
  }

  public async shutdown(): Promise<void> {
    await this.bridge.stop();
  }

  /**
   * 1. 옥션 상태 및 남은 검색 횟수 조회
   */
  public async getAuctionStatus(): Promise<AuctionStatus> {
    const resp = await this.bridge.sendAction<Record<string, never>, AuctionStatus>(
      'GET_STATUS',
      {}
    );
    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '웹 옥션 상태를 가져오지 못했습니다.');
    }
    return resp.data;
  }

  /**
   * 2. 경매장 매물 검색 (100회 제한 보호 캐싱 + 로컬 재필터링)
   */
  public async searchAuctionItems(params: SearchAuctionParams): Promise<SearchAuctionResult> {
    const cached = this.cache.getSearchCache(params);
    if (cached) {
      const filtered = this.cache.filterAndSortItems(cached.items, params);
      return {
        fromCache: true,
        cacheTtlSecondsRemaining: cached.ttlRemainingSec,
        quota: cached.quota,
        warning: AuctionSearchCache.buildQuotaWarning(cached.quota),
        totalCount: filtered.length,
        items: filtered,
        purchaseGuide: {
          auctionBuyUrl: 'https://auction.maplestory.nexon.com/buy',
          howToBuy:
            '직접 구매(메소 차감)는 안전을 위해 차단되어 있습니다. 마음에 드는 매물의 itemId로 manage_wishlist(action="add")를 호출해 찜목록에 담거나 open_item_in_browser를 호출해 웹 옥션에서 바로 구매하세요.',
        },
      };
    }

    const resp = await this.bridge.sendAction<
      SearchAuctionParams,
      { items: AuctionItem[]; quota: AuctionQuotaInfo }
    >('SEARCH_ITEMS', params);

    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '매물 검색에 실패했습니다.');
    }

    this.cache.setSearchCache(params, resp.data.items, resp.data.quota);
    const filtered = this.cache.filterAndSortItems(resp.data.items, params);

    return {
      fromCache: false,
      quota: resp.data.quota,
      warning: AuctionSearchCache.buildQuotaWarning(resp.data.quota),
      totalCount: filtered.length,
      items: filtered,
      purchaseGuide: {
        auctionBuyUrl: 'https://auction.maplestory.nexon.com/buy',
        howToBuy:
          '직접 구매(메소 차감)는 안전을 위해 차단되어 있습니다. 마음에 드는 매물의 itemId로 manage_wishlist(action="add")를 호출해 찜목록에 담거나 open_item_in_browser를 호출해 웹 옥션에서 바로 구매하세요.',
      },
    };
  }

  /**
   * 3. 시세 탭 조회 및 통계 분석 (평균/중앙값/최저/최고가 자동 계산)
   */
  public async getMarketPrice(params: MarketPriceParams): Promise<MarketPriceResult> {
    const cached = this.cache.getMarketPriceCache(params);
    if (cached) {
      const filtered = this.cache.filterMarketPriceRecords(cached.records, params);
      return {
        fromCache: true,
        itemName: params.itemName,
        summary: calculateMarketPriceSummary(filtered),
        recentTrades: filtered,
        quota: cached.quota,
      };
    }

    const resp = await this.bridge.sendAction<
      MarketPriceParams,
      { records: MarketPriceRecord[]; quota: AuctionQuotaInfo }
    >('GET_MARKET_PRICE', params);

    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '시세 조회에 실패했습니다.');
    }

    this.cache.setMarketPriceCache(params, resp.data.records, resp.data.quota);
    const filtered = this.cache.filterMarketPriceRecords(resp.data.records, params);

    return {
      fromCache: false,
      itemName: params.itemName,
      summary: calculateMarketPriceSummary(filtered),
      recentTrades: filtered,
      quota: resp.data.quota,
    };
  }

  /**
   * 4. 찜목록 조회
   */
  public async getWishlist(): Promise<{
    items: AuctionItem[];
    maxSlots: number;
    wishlistUrl: string;
  }> {
    const resp = await this.bridge.sendAction<
      Record<string, never>,
      { items: AuctionItem[]; maxSlots: number }
    >('GET_WISHLIST', {});

    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '찜목록 조회에 실패했습니다.');
    }

    this.cache.registerItems(resp.data.items);
    return {
      items: resp.data.items,
      maxSlots: resp.data.maxSlots,
      wishlistUrl: 'https://auction.maplestory.nexon.com/buy',
    };
  }

  /**
   * 5. 찜 등록 / 해제 (안전한 구매 브릿지)
   */
  public async manageWishlist(params: ManageWishlistParams): Promise<ManageWishlistResult> {
    const bridgeAction = params.action === 'add' ? 'ADD_WISHLIST' : 'REMOVE_WISHLIST';
    const resp = await this.bridge.sendAction<
      { itemId: string },
      { itemId: string; wishlistCount: number; wishlistMaxSlots: number }
    >(bridgeAction, { itemId: params.itemId });

    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '찜목록 변경에 실패했습니다.');
    }

    const isAdd = params.action === 'add';
    return {
      success: true,
      action: params.action,
      itemId: params.itemId,
      message: isAdd
        ? `매물(${params.itemId})을 메이플 옥션 [찜목록]에 추가했습니다. 웹 브라우저의 [찜목록] 탭에서 즉시 옵션을 확인하고 구매하실 수 있습니다.`
        : `매물(${params.itemId})을 [찜목록]에서 제거했습니다.`,
      wishlistCount: resp.data.wishlistCount,
      wishlistMaxSlots: resp.data.wishlistMaxSlots,
      directPurchaseGuide: {
        wishlistUrl: 'https://auction.maplestory.nexon.com/buy',
        instruction:
          '크롬 브라우저의 메이플 옥션 상단 [찜목록] 탭을 클릭하면 방금 찜한 매물을 재검색 없이 바로 구매할 수 있습니다.',
      },
    };
  }

  /**
   * 6. 브라우저 웹 옥션 화면 포커스 및 매물 하이라이트
   */
  public async openItemInBrowser(
    params: OpenItemInBrowserParams
  ): Promise<OpenItemInBrowserResult> {
    const resp = await this.bridge.sendAction<
      OpenItemInBrowserParams,
      { focusedTabUrl: string; target: string; highlightedItemId?: string }
    >('FOCUS_AND_HIGHLIGHT', params);

    if (!resp.success || !resp.data) {
      throw new Error(resp.error?.message || '브라우저 탭 포커스에 실패했습니다.');
    }

    return {
      success: true,
      focusedTabUrl: resp.data.focusedTabUrl,
      highlightedItemId: resp.data.highlightedItemId,
      message: params.itemId
        ? `크롬 메이플 옥션 탭을 활성화하고 매물(${params.itemId})을 화면에 하이라이트했습니다. 웹 페이지에서 옵션을 확인 후 구매하세요.`
        : `크롬 메이플 옥션 [${params.target}] 화면을 활성화했습니다 (${resp.data.focusedTabUrl}).`,
    };
  }

  /**
   * 7. Nexon Open API 기반 내 캐릭터 장착 장비 및 스탯 조회
   */
  public async getMyCharacterEquipment(characterName?: string, forceRefresh = false) {
    let targetName = characterName?.trim();
    if (!targetName) {
      const status = await this.getAuctionStatus();
      targetName = status.character?.name || '낑선';
    }
    return this.nexonApi.getCharacterEquipment(targetName, forceRefresh);
  }

  /**
   * 8. 내 캐릭터 장착 장비 vs 경매장 매물 스펙업(최종 데미지 증감률 및 가성비) 비교
   */
  public async compareSpecUp(params: {
    characterName?: string;
    itemId?: string;
    searchParams?: SearchAuctionParams;
    targetSlot?: string;
    sortBy?: 'damage_desc' | 'efficiency_asc';
  }) {
    const character = await this.getMyCharacterEquipment(params.characterName, false);

    let candidates: AuctionItem[] = [];
    if (params.itemId) {
      const found = this.cache.getItemById(params.itemId);
      if (found) {
        candidates = [found];
      }
    }
    if (candidates.length === 0 && params.searchParams) {
      const searchRes = await this.searchAuctionItems(params.searchParams);
      candidates = searchRes.items;
    }
    if (candidates.length === 0 && params.itemId) {
      // 기본 캐시에 없으면 전체 데모/최근 검색을 통해 조회 시도
      const fallbackSearch = await this.searchAuctionItems({ itemName: '아케인셰이드' });
      const matched = fallbackSearch.items.find((i) => i.itemId === params.itemId);
      candidates = matched ? [matched] : fallbackSearch.items;
    }

    const comparisons = candidates.map((candidate) =>
      SpecUpSimulator.compareCandidate(character, candidate, params.targetSlot)
    );

    const sortMode = params.sortBy ?? 'damage_desc';
    comparisons.sort((a, b) => {
      if (sortMode === 'efficiency_asc') {
        const effA = a.mesoPerOnePctFinalDamage ?? Number.MAX_SAFE_INTEGER;
        const effB = b.mesoPerOnePctFinalDamage ?? Number.MAX_SAFE_INTEGER;
        return effA - effB;
      }
      return b.estimatedFinalDamageChangePct - a.estimatedFinalDamageChangePct;
    });

    return {
      character: {
        name: character.characterName,
        world: character.worldName,
        job: character.characterClass,
        level: character.characterLevel,
        combatPower: character.combatPower,
        mainStatName: character.mainStatName,
        attackTypeName: character.attackTypeName,
      },
      comparedCount: comparisons.length,
      comparisons,
      purchaseGuide:
        '가장 스펙업 효율이 좋은 매물의 itemId를 manage_wishlist(action="add")로 찜한 뒤 https://auction.maplestory.nexon.com/buy 의 [찜목록]에서 안전하게 구매하세요.',
    };
  }
}

/**
 * MCP Tool 스키마 정의 (8종)
 */
export const MCP_TOOLS_DEFINITION = [
  {
    name: 'get_auction_status',
    description:
      '메이플스토리 웹 옥션(auction.maplestory.nexon.com) 연결 상태, 로그인된 캐릭터 정보(닉네임, 레벨, 직업, 전투력), 보유 메소/메이플포인트, 남은 일일 검색 횟수(0/100)를 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_auction_items',
    description:
      '메이플 옥션에서 현재 판매 중인 아이템 매물을 검색합니다. 동일한 기본 검색어는 5분간 로컬 캐시에서 재필터링하여 일일 검색 횟수(100회 제한) 차감을 방지합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '검색할 아이템 이름 (예: "아케인셰이드 너클")' },
        exactMatch: { type: 'boolean', description: '아이템 이름 정확히 일치 여부' },
        currentWorldOnly: { type: 'boolean', description: '현재 월드 매물만 검색할지 여부' },
        category: {
          type: 'string',
          enum: ['방어구', '무기', '소비', '캐시', '코디', '기타'],
          description: '대분류 카테고리',
        },
        subCategory: { type: 'string', description: '하위 분류 (예: "너클", "모자", "장갑")' },
        minPrice: { type: 'number', description: '최소 가격 (메소)' },
        maxPrice: { type: 'number', description: '최대 가격 (메소)' },
        minStarforce: { type: 'number', description: '최소 스타포스 수치 (예: 18, 22)' },
        maxStarforce: { type: 'number', description: '최대 스타포스 수치' },
        potentialGrade: {
          type: 'string',
          enum: ['노멀', '레어', '에픽', '유니크', '레전드리'],
          description: '잠재능력(윗잠) 등급 필터',
        },
        additionalPotentialGrade: {
          type: 'string',
          enum: ['노멀', '레어', '에픽', '유니크', '레전드리'],
          description: '에디셔널 잠재능력(아랫잠) 등급 필터',
        },
        potentialKeyword: {
          type: 'string',
          description: '잠재옵션/추옵 키워드 필터 (예: "크리티컬 데미지", "보스 몬스터", "STR")',
        },
        sortBy: {
          type: 'string',
          enum: ['price_asc', 'price_desc', 'combat_power_desc', 'starforce_desc'],
          description: '정렬 기준 (기본값: price_asc)',
        },
        limit: { type: 'number', description: '반환할 최대 매물 개수 (기본 20)' },
        forceRefresh: {
          type: 'boolean',
          description: '캐시를 무시하고 웹 옥션에서 새로 검색할지 여부 (검색 횟수 1회 차감됨)',
        },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'get_market_price',
    description:
      '메이플 옥션 [시세] 탭을 통해 특정 아이템의 최근 실제 거래 완료 가격 내역과 통계(평균가, 중앙값, 최저가, 최고가)를 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '시세를 조회할 아이템 이름' },
        exactMatch: { type: 'boolean', description: '아이템 이름 정확히 일치 여부' },
        minStarforce: { type: 'number', description: '최소 스타포스 조건' },
        maxStarforce: { type: 'number', description: '최대 스타포스 조건' },
        potentialGrade: {
          type: 'string',
          enum: ['노멀', '레어', '에픽', '유니크', '레전드리'],
          description: '잠재능력 등급 조건',
        },
        limit: { type: 'number', description: '조회할 최근 거래 건수 (기본 25)' },
        forceRefresh: { type: 'boolean', description: '캐시 무시 여부' },
      },
      required: ['itemName'],
    },
  },
  {
    name: 'get_wishlist',
    description: '현재 메이플 옥션 [찜목록]에 저장된 매물 목록과 상세 옵션, 가격을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'manage_wishlist',
    description:
      '마음에 드는 경매장 매물을 [찜목록]에 등록(add)하거나 해제(remove)합니다. 직접 구매 대신 찜목록에 등록한 후 웹 옥션 링크를 통해 안전하게 구매할 수 있도록 돕습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: '찜 등록("add") 또는 찜 해제("remove")',
        },
        itemId: { type: 'string', description: '검색 결과에서 확인한 매물 고유 ID (itemId)' },
      },
      required: ['action', 'itemId'],
    },
  },
  {
    name: 'open_item_in_browser',
    description:
      '사용자가 매물을 구매하거나 자세히 확인할 수 있도록 크롬 브라우저의 메이플 옥션 탭을 활성화하고 해당 매물(또는 찜목록)을 화면에 표시합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['wishlist', 'buy', 'market'],
          description: '이동할 탭 화면 ("wishlist": 찜목록, "buy": 구매 검색 화면, "market": 시세 화면)',
        },
        itemId: { type: 'string', description: '하이라이트할 매물 고유 ID (선택)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'get_my_character_equipment',
    description:
      'Nexon Open API를 연동하여 내 캐릭터(또는 지정한 캐릭터명)의 현재 장착 장비 목록과 종합 능력치(주스탯, 공격력/마력, 보공, 방무, 크뎀, 전투력)를 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        characterName: {
          type: 'string',
          description: '조회할 캐릭터 닉네임 (생략 시 현재 웹 옥션에 로그인된 캐릭터 사용)',
        },
        forceRefresh: { type: 'boolean', description: '로컬 캐릭터 캐시를 무시하고 새로 조회할지 여부' },
      },
    },
  },
  {
    name: 'compare_spec_up',
    description:
      'Nexon Open API로 조회한 내 캐릭터의 현재 장착 장비와 경매장 매물을 비교하여 교체 시 예상 최종 데미지 증감률(%)과 최종뎀 1% 상승당 소요 메소(가성비 지표)를 시뮬레이션합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        characterName: {
          type: 'string',
          description: '비교 기준 캐릭터 닉네임 (생략 시 웹 옥션 로그인 캐릭터 사용)',
        },
        itemId: {
          type: 'string',
          description: '특정 단일 매물(itemId)만 비교할 경우 입력',
        },
        searchParams: {
          type: 'object',
          description: '검색 조건으로 매물들을 찾아 일괄 스펙업 비교할 경우 입력',
          properties: {
            itemName: { type: 'string' },
            minStarforce: { type: 'number' },
            maxPrice: { type: 'number' },
          },
        },
        targetSlot: {
          type: 'string',
          description: '교체할 장비 부위 명시 (예: "무기", "장갑", "모자" - 생략 시 자동 추론)',
        },
        sortBy: {
          type: 'string',
          enum: ['damage_desc', 'efficiency_asc'],
          description: '정렬 기준 ("damage_desc": 최종뎀 상승량 높은 순, "efficiency_asc": 1%당 메소 가성비 좋은 순)',
        },
      },
    },
  },
];

/**
 * MCP JSON-RPC 2.0 Stdio 서버 실행기
 */
async function startMcpStdioServer(): Promise<void> {
  const service = new MapleAuctionMcpService();
  await service.initialize();

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  const sendResponse = (id: string | number | null, result?: unknown, error?: { code: number; message: string }) => {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      id,
    };
    if (error) {
      payload.error = error;
    } else {
      payload.result = result;
    }
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    const { id, method, params } = msg;

    try {
      if (method === 'initialize') {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'maple-auction-mcp',
            version: '1.0.0',
          },
        });
        return;
      }

      if (method === 'notifications/initialized') {
        return;
      }

      if (method === 'tools/list') {
        sendResponse(id, {
          tools: MCP_TOOLS_DEFINITION,
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name as string;
        const args = (params?.arguments ?? {}) as any;
        let output: unknown;

        switch (toolName) {
          case 'get_auction_status':
            output = await service.getAuctionStatus();
            break;
          case 'search_auction_items':
            output = await service.searchAuctionItems(args);
            break;
          case 'get_market_price':
            output = await service.getMarketPrice(args);
            break;
          case 'get_wishlist':
            output = await service.getWishlist();
            break;
          case 'manage_wishlist':
            output = await service.manageWishlist(args);
            break;
          case 'open_item_in_browser':
            output = await service.openItemInBrowser(args);
            break;
          case 'get_my_character_equipment':
            output = await service.getMyCharacterEquipment(args.characterName, args.forceRefresh);
            break;
          case 'compare_spec_up':
            output = await service.compareSpecUp(args);
            break;
          default:
            throw new Error(`알 수 없는 MCP Tool입니다: ${toolName}`);
        }

        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
        });
        return;
      }

      if (id !== undefined) {
        sendResponse(id, undefined, {
          code: -32601,
          message: `Method not found: ${method}`,
        });
      }
    } catch (err: any) {
      if (id !== undefined) {
        sendResponse(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[오류] ${err?.message || String(err)}`,
            },
          ],
        });
      }
    }
  });
}

// 직접 실행 시 Stdio 서버 구동
if (import.meta.url && process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  startMcpStdioServer().catch((err) => {
    process.stderr.write(`Fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
