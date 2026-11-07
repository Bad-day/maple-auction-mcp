import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import {
  AllowedBridgeAction,
  assertAllowedBridgeAction,
  AuctionItem,
  AuctionQuotaInfo,
  AuctionStatus,
  BridgeRequest,
  BridgeResponse,
  formatMeso,
  MarketPriceParams,
  MarketPriceRecord,
  SearchAuctionParams,
} from '../../shared/src/index.js';

interface PendingRequest {
  resolve: (resp: BridgeResponse<any>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  request: BridgeRequest<any>;
}

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class LocalBridgeServer {
  private server: http.Server | null = null;
  private wsClients = new Set<Duplex>();
  private pendingRequests = new Map<string, PendingRequest>();
  private pollQueue: BridgeRequest<any>[] = [];
  private lastKnownStatus: AuctionStatus | null = null;
  private lastRequestTimestamp = 0;
  private readonly minIntervalMs = 1200; // 넥슨 웹 옥션 봇 탐지 방지용 최소 간격 (1.2초)
  private demoWishlistIds = new Set<string>(['item-1002']);
  private demoSearchUsed = 0;

  constructor(private readonly port = Number(process.env.MAPLE_AUCTION_BRIDGE_PORT || 19595)) {}

  public async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleWsUpgrade(req, socket, head));

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
      this.server!.on('error', () => {
        // 이미 포트가 사용 중인 경우에도 MCP stdio 동작은 계속되도록 허용
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    for (const client of this.wsClients) {
      client.destroy();
    }
    this.wsClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  public isExtensionConnected(): boolean {
    if (this.wsClients.size > 0) return true;
    if (this.lastKnownStatus) {
      const ageMs = Date.now() - new Date(this.lastKnownStatus.lastUpdated).getTime();
      return ageMs < 15000;
    }
    return false;
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTimestamp;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestTimestamp = Date.now();
  }

  /**
   * 크롬 확장 브릿지로 안전하게 명령 전송 (화이트리스트 검증 필수)
   */
  public async sendAction<TPayload, TResult>(
    action: AllowedBridgeAction,
    payload: TPayload,
    timeoutMs = 12000
  ): Promise<BridgeResponse<TResult>> {
    // 1. 보안 화이트리스트 가드 (구매/판매 원천 차단)
    assertAllowedBridgeAction(action);

    // 2. 레이트 리미팅
    if (action === 'SEARCH_ITEMS' || action === 'GET_MARKET_PRICE') {
      await this.enforceRateLimit();
    }

    // 3. 확장 프로그램이 연결되어 있으면 실제 브라우저 세션으로 전달
    if (this.isExtensionConnected()) {
      const requestId = crypto.randomUUID();
      const request: BridgeRequest<TPayload> = {
        requestId,
        action,
        payload,
        timestamp: Date.now(),
      };

      return new Promise<BridgeResponse<TResult>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(
            new Error(
              `크롬 확장 브릿지 응답 시간 초과 (${timeoutMs}ms). 크롬에서 https://auction.maplestory.nexon.com/buy 탭이 열려 있고 로그인되어 있는지 확인해주세요.`
            )
          );
        }, timeoutMs);

        this.pendingRequests.set(requestId, { resolve, reject, timer, request });

        // WebSocket 클라이언트로 브로드캐스트 및 HTTP 폴링 큐 등록
        const rawJson = JSON.stringify(request);
        for (const ws of this.wsClients) {
          this.sendWsFrame(ws, rawJson);
        }
        this.pollQueue.push(request);
      });
    }

    // 4. 데모/오프라인 테스트 모드 지원
    if (process.env.MAPLE_AUCTION_DEMO_MODE !== 'false') {
      return this.handleDemoModeAction<TResult>(action, payload);
    }

    return {
      requestId: crypto.randomUUID(),
      success: false,
      error: {
        code: 'TAB_NOT_FOUND',
        message:
          '크롬 확장 프로그램 브릿지가 연결되지 않았습니다. 크롬에서 확장 프로그램을 활성화하고 https://auction.maplestory.nexon.com/buy 에 로그인해주세요.',
      },
      timestamp: Date.now(),
    };
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/bridge/poll') {
      const nextReq = this.pollQueue.shift() ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ request: nextReq }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/bridge/respond' || req.url === '/bridge/heartbeat')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (req.url === '/bridge/heartbeat') {
            this.lastKnownStatus = parsed as AuctionStatus;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          this.resolvePendingResponse(parsed as BridgeResponse<any>);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'maple-auction-mcp-bridge',
        extensionConnected: this.isExtensionConnected(),
        port: this.port,
      })
    );
  }

  private handleWsUpgrade(req: http.IncomingMessage, socket: Duplex, _head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + WS_MAGIC_STRING)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    this.wsClients.add(socket);

    socket.on('data', (buffer: Buffer) => {
      const messages = this.decodeWsFrames(buffer);
      for (const msg of messages) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'HEARTBEAT' && parsed.status) {
            this.lastKnownStatus = parsed.status as AuctionStatus;
          } else if (parsed.requestId) {
            this.resolvePendingResponse(parsed as BridgeResponse<any>);
          }
        } catch {
          // ignore malformed frames
        }
      }
    });

    socket.on('close', () => this.wsClients.delete(socket));
    socket.on('error', () => this.wsClients.delete(socket));
  }

  private sendWsFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  private decodeWsFrames(buffer: Buffer): string[] {
    const results: string[] = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const opcode = buffer[offset] & 0x0f;
      if (opcode === 0x08) break; // close frame
      const isMasked = (buffer[offset + 1] & 0x80) !== 0;
      let payloadLen = buffer[offset + 1] & 0x7f;
      offset += 2;

      if (payloadLen === 126) {
        if (offset + 2 > buffer.length) break;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (offset + 8 > buffer.length) break;
        payloadLen = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (isMasked) {
        if (offset + 4 > buffer.length) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (offset + payloadLen > buffer.length) break;
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      offset += payloadLen;

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x01) {
        results.push(payload.toString('utf8'));
      }
    }
    return results;
  }

  private resolvePendingResponse(resp: BridgeResponse<any>): void {
    const pending = this.pendingRequests.get(resp.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(resp.requestId);
    pending.resolve(resp);
  }

  /**
   * 브라우저 미연결 시에도 기능 검증과 시뮬레이션이 가능하도록 사용자 스크린샷("낑선", 344억 메소) 기반 샘플 데이터 제공
   */
  private handleDemoModeAction<TResult>(
    action: AllowedBridgeAction,
    payload: any
  ): BridgeResponse<TResult> {
    const quota: AuctionQuotaInfo = {
      searchUsed: this.demoSearchUsed,
      searchLimit: 100,
      searchRemaining: Math.max(0, 100 - this.demoSearchUsed),
      sellUsed: 0,
      sellLimit: 20,
    };

    const sampleItems: AuctionItem[] = [
      {
        itemId: 'item-1001',
        itemName: '아케인셰이드 너클',
        itemPart: '무기',
        category: '무기',
        subCategory: '너클',
        starforce: 22,
        price: 185_0000_0000,
        priceFormatted: formatMeso(185_0000_0000),
        quantity: 1,
        potential: {
          grade: '레전드리',
          options: [
            '보스 몬스터 공격 시 데미지 +40%',
            '보스 몬스터 공격 시 데미지 +40%',
            '공격력 +12%',
          ],
        },
        additionalPotential: {
          grade: '레전드리',
          options: ['공격력 +12%', '공격력 +9%', '보스 몬스터 공격 시 데미지 +18%'],
        },
        totalOptions: {
          str: 410,
          dex: 250,
          allStatPct: 6,
          attackPower: 742,
          bossDamagePct: 30,
          ignoreDefensePct: 20,
        },
        bonusStatSummary: '1추(공격력 +133) + 보공 10% + 올스탯 6%',
        combatPowerDelta: 6850000,
        remainingTime: '38시간 15분',
        world: '스카니아',
        isWishlisted: this.demoWishlistIds.has('item-1001'),
        auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
      },
      {
        itemId: 'item-1002',
        itemName: '아케인셰이드 무투장갑',
        itemPart: '장갑',
        category: '방어구',
        subCategory: '장갑',
        starforce: 22,
        price: 112_0000_0000,
        priceFormatted: formatMeso(112_0000_0000),
        quantity: 1,
        potential: {
          grade: '레전드리',
          options: ['크리티컬 데미지 +8%', '크리티컬 데미지 +8%', 'STR +9%'],
        },
        additionalPotential: {
          grade: '유니크',
          options: ['크리티컬 데미지 +3%', 'STR +7%', '공격력 +14'],
        },
        totalOptions: {
          str: 315,
          dex: 165,
          allStatPct: 6,
          attackPower: 118,
        },
        bonusStatSummary: 'STR +72, 올스탯 +6% (152급)',
        combatPowerDelta: 5420000,
        remainingTime: '19시간 40분',
        world: '스카니아',
        isWishlisted: this.demoWishlistIds.has('item-1002'),
        auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
      },
      {
        itemId: 'item-1003',
        itemName: '하이네스 워리어헬름',
        itemPart: '모자',
        category: '방어구',
        subCategory: '모자',
        starforce: 22,
        price: 68_0000_0000,
        priceFormatted: formatMeso(68_0000_0000),
        quantity: 1,
        potential: {
          grade: '레전드리',
          options: ['STR +12%', 'STR +9%', '올스탯 +9%'],
        },
        additionalPotential: {
          grade: '유니크',
          options: ['STR +7%', 'STR +5%', '공격력 +11'],
        },
        totalOptions: {
          str: 325,
          dex: 150,
          allStatPct: 6,
          attackPower: 98,
          ignoreDefensePct: 10,
        },
        bonusStatSummary: 'STR +80, 올스탯 +6% (160급)',
        combatPowerDelta: 4150000,
        remainingTime: '44시간 05분',
        world: '스카니아',
        isWishlisted: this.demoWishlistIds.has('item-1003'),
        auctionPageUrl: 'https://auction.maplestory.nexon.com/buy',
      },
    ];

    if (action === 'GET_STATUS') {
      const status: AuctionStatus = {
        connected: this.isExtensionConnected(),
        loggedIn: true,
        pageUrl: 'https://auction.maplestory.nexon.com/buy',
        character: {
          name: '낑선',
          world: '스카니아',
          level: 293,
          job: '아크',
          combatPower: 97618592,
          combatPowerFormatted: '9761만 8592',
          mvpGrade: 'MVP',
        },
        currency: {
          meso: 344_4263_0477,
          mesoFormatted: '344억 4263만 477',
          maplePoint: 343,
        },
        quota,
        capturedEndpoints: [
          'POST https://auction.maplestory.nexon.com/api/buy/search',
          'POST https://auction.maplestory.nexon.com/api/market/history',
          'GET https://auction.maplestory.nexon.com/api/wishlist',
          'POST https://auction.maplestory.nexon.com/api/wishlist/toggle',
        ],
        lastUpdated: new Date().toISOString(),
      };
      return { requestId: crypto.randomUUID(), success: true, data: status as unknown as TResult, timestamp: Date.now() };
    }

    if (action === 'SEARCH_ITEMS') {
      this.demoSearchUsed = Math.min(100, this.demoSearchUsed + 1);
      const updatedQuota: AuctionQuotaInfo = {
        ...quota,
        searchUsed: this.demoSearchUsed,
        searchRemaining: Math.max(0, 100 - this.demoSearchUsed),
      };
      const params = payload as SearchAuctionParams;
      const matched = sampleItems.filter((it) =>
        it.itemName.includes(params.itemName.trim()) || params.itemName.trim() === '아케인셰이드'
      );
      const resultItems = matched.length > 0 ? matched : sampleItems;
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: { items: resultItems, quota: updatedQuota } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    if (action === 'GET_MARKET_PRICE') {
      this.demoSearchUsed = Math.min(100, this.demoSearchUsed + 1);
      const updatedQuota: AuctionQuotaInfo = {
        ...quota,
        searchUsed: this.demoSearchUsed,
        searchRemaining: Math.max(0, 100 - this.demoSearchUsed),
      };
      const params = payload as MarketPriceParams;
      const records: MarketPriceRecord[] = [
        {
          tradeId: 'trade-901',
          itemName: params.itemName,
          starforce: 22,
          soldPrice: 108_0000_0000,
          soldPriceFormatted: formatMeso(108_0000_0000),
          quantity: 1,
          soldAt: '2026-11-07 14:22:10',
          potential: { grade: '레전드리', options: ['크리티컬 데미지 +8%', '크리티컬 데미지 +8%', 'STR +9%'] },
          additionalPotential: { grade: '유니크', options: ['크리티컬 데미지 +3%', 'STR +7%'] },
          bonusStatSummary: '150급',
          world: '스카니아',
        },
        {
          tradeId: 'trade-902',
          itemName: params.itemName,
          starforce: 22,
          soldPrice: 115_0000_0000,
          soldPriceFormatted: formatMeso(115_0000_0000),
          quantity: 1,
          soldAt: '2026-11-06 21:10:05',
          potential: { grade: '레전드리', options: ['크리티컬 데미지 +8%', '크리티컬 데미지 +8%', '올스탯 +9%'] },
          additionalPotential: { grade: '유니크', options: ['크리티컬 데미지 +3%', '공격력 +12'] },
          bonusStatSummary: '156급',
          world: '스카니아',
        },
        {
          tradeId: 'trade-903',
          itemName: params.itemName,
          starforce: 22,
          soldPrice: 104_5000_0000,
          soldPriceFormatted: formatMeso(104_5000_0000),
          quantity: 1,
          soldAt: '2026-11-05 19:45:30',
          potential: { grade: '레전드리', options: ['크리티컬 데미지 +8%', 'STR +12%', 'STR +9%'] },
          additionalPotential: { grade: '유니크', options: ['STR +7%', 'STR +5%'] },
          bonusStatSummary: '148급',
          world: '스카니아',
        },
      ];
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: { records, quota: updatedQuota } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    if (action === 'GET_WISHLIST') {
      const wishlisted = sampleItems.filter((it) => this.demoWishlistIds.has(it.itemId));
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: { items: wishlisted, maxSlots: 10 } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    if (action === 'ADD_WISHLIST') {
      const { itemId } = payload as { itemId: string };
      this.demoWishlistIds.add(itemId);
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: {
          itemId,
          wishlistCount: this.demoWishlistIds.size,
          wishlistMaxSlots: 10,
        } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    if (action === 'REMOVE_WISHLIST') {
      const { itemId } = payload as { itemId: string };
      this.demoWishlistIds.delete(itemId);
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: {
          itemId,
          wishlistCount: this.demoWishlistIds.size,
          wishlistMaxSlots: 10,
        } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    if (action === 'FOCUS_AND_HIGHLIGHT') {
      const { target, itemId } = payload as { target: string; itemId?: string };
      return {
        requestId: crypto.randomUUID(),
        success: true,
        data: {
          focusedTabUrl: 'https://auction.maplestory.nexon.com/buy',
          target,
          highlightedItemId: itemId,
        } as unknown as TResult,
        timestamp: Date.now(),
      };
    }

    return {
      requestId: crypto.randomUUID(),
      success: false,
      error: { code: 'INTERNAL_ERROR', message: `Unhandled action: ${action}` },
      timestamp: Date.now(),
    };
  }
}
