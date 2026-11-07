/**
 * Maple Auction MCP Bridge - Content Script (ISOLATED World)
 * 실행 대상: https://auction.maplestory.nexon.com/*
 */

(function () {
  let capturedEndpoints = [];

  window.addEventListener('MAPLE_AUCTION_API_CAPTURED', (e) => {
    if (e.detail?.capturedEndpoints) {
      capturedEndpoints = e.detail.capturedEndpoints;
    }
  });

  /**
   * 한국어 메소/전투력 문자열("344억 4263만 477" / "9761만 8592")을 숫자로 변환
   */
  function parseKoreanNumber(text) {
    if (!text) return 0;
    const cleaned = String(text).replace(/,/g, '').trim();
    if (/^\d+$/.test(cleaned)) return Number(cleaned);

    let total = 0;
    const jo = cleaned.match(/(\d+)\s*조/);
    const eok = cleaned.match(/(\d+)\s*억/);
    const man = cleaned.match(/(\d+)\s*만/);
    if (jo) total += Number(jo[1]) * 1_0000_0000_0000;
    if (eok) total += Number(eok[1]) * 1_0000_0000;
    if (man) total += Number(man[1]) * 1_0000;

    const restText = cleaned
      .replace(/(\d+)\s*조/g, '')
      .replace(/(\d+)\s*억/g, '')
      .replace(/(\d+)\s*만/g, '')
      .trim();
    const rest = restText.match(/(\d+)/);
    if (rest) total += Number(rest[1]);
    return total;
  }

  /**
   * 웹 옥션 상단 헤더에서 검색 횟수(0 / 100), 캐릭터 정보, 보유 메소/메이플포인트 파싱
   */
  function parseAuctionDomStatus() {
    const bodyText = document.body?.innerText || '';
    const isLoggedIn = !bodyText.includes('로그인이 필요합니다') && bodyText.includes('로그아웃');

    // 검색 횟수 0 / 100 · 판매 횟수 0 / 20 파싱
    const searchQuotaMatch = bodyText.match(/검색\s*횟수\s*(\d+)\s*\/\s*(\d+)/);
    const sellQuotaMatch = bodyText.match(/판매\s*횟수\s*(\d+)\s*\/\s*(\d+)/);

    const searchUsed = searchQuotaMatch ? Number(searchQuotaMatch[1]) : 0;
    const searchLimit = searchQuotaMatch ? Number(searchQuotaMatch[2]) : 100;
    const sellUsed = sellQuotaMatch ? Number(sellQuotaMatch[1]) : 0;
    const sellLimit = sellQuotaMatch ? Number(sellQuotaMatch[2]) : 20;

    // Lv.293 | 아크 | 전투력 9761만 8592 파싱
    const charMatch = bodyText.match(
      /Lv\.(\d+)\s*[|·]?\s*([가-힣A-Za-z()]+)\s*[|·]?\s*전투력\s*([0-9조억만\s,]+)/
    );
    const mesoMatch = bodyText.match(/(\d+억\s*\d+만\s*\d+|\d+억\s*\d+만|\d+만\s*\d+)/);

    let character = null;
    if (charMatch) {
      const combatStr = charMatch[3].trim();
      character = {
        name: detectCharacterName() || '메이플용사',
        level: Number(charMatch[1]),
        job: charMatch[2].trim(),
        combatPower: parseKoreanNumber(combatStr),
        combatPowerFormatted: combatStr,
      };
    }

    const currency = mesoMatch
      ? {
          meso: parseKoreanNumber(mesoMatch[1]),
          mesoFormatted: mesoMatch[1].trim(),
          maplePoint: 0,
        }
      : null;

    return {
      connected: true,
      loggedIn: isLoggedIn,
      pageUrl: window.location.href,
      character,
      currency,
      quota: {
        searchUsed,
        searchLimit,
        searchRemaining: Math.max(0, searchLimit - searchUsed),
        sellUsed,
        sellLimit,
      },
      capturedEndpoints,
      lastUpdated: new Date().toISOString(),
    };
  }

  function detectCharacterName() {
    const candidates = document.querySelectorAll('span, div, strong, button');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (txt.endsWith('▼') && txt.length >= 2 && txt.length <= 15) {
        return txt.replace('▼', '').trim();
      }
    }
    return null;
  }

  /**
   * MAIN 월드의 interceptor.js에 명령 전달 후 응답 수신
   */
  function callMainInterceptor(action, payload) {
    return new Promise((resolve) => {
      const requestId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const handler = (event) => {
        if (event.detail?.requestId === requestId) {
          window.removeEventListener('MAPLE_AUCTION_BRIDGE_RESULT', handler);
          resolve(event.detail);
        }
      };
      window.addEventListener('MAPLE_AUCTION_BRIDGE_RESULT', handler);
      window.dispatchEvent(
        new CustomEvent('MAPLE_AUCTION_BRIDGE_EXEC', {
          detail: { requestId, action, payload },
        })
      );
      setTimeout(() => {
        window.removeEventListener('MAPLE_AUCTION_BRIDGE_RESULT', handler);
        resolve({ ok: false, error: 'Interceptor timeout' });
      }, 4000);
    });
  }

  /**
   * 웹 옥션 상단 탭(구매, 시세, 찜목록) 전환 및 특정 매물 하이라이트 표시
   */
  function focusTabAndHighlightItem(target, itemId) {
    const tabLabelMap = {
      buy: '구매',
      market: '시세',
      wishlist: '찜목록',
    };
    const desiredLabel = tabLabelMap[target] || '구매';
    const navElements = Array.from(document.querySelectorAll('a, button, li, span'));
    const targetNav = navElements.find((el) => (el.textContent || '').trim() === desiredLabel);
    if (targetNav) {
      targetNav.click();
    }

    if (itemId) {
      setTimeout(() => {
        const targetEl =
          document.querySelector(`[data-item-id="${itemId}"]`) ||
          Array.from(document.querySelectorAll('tr, li, div')).find(
            (el) => el.getAttribute && el.getAttribute('data-id') === itemId
          );

        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.style.outline = '3px solid #f59e0b';
          targetEl.style.backgroundColor = 'rgba(245, 158, 11, 0.12)';
          targetEl.style.transition = 'all 0.3s ease';
        }
      }, 400);
    }

    return {
      focusedTabUrl: window.location.href,
      target,
      highlightedItemId: itemId,
    };
  }

  // Background Service Worker로부터 브릿지 요청 수신
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'MCP_BRIDGE_REQUEST') return false;

    const { request } = message;
    (async () => {
      try {
        const status = parseAuctionDomStatus();

        if (request.action === 'GET_STATUS') {
          sendResponse({
            requestId: request.requestId,
            success: true,
            data: status,
            timestamp: Date.now(),
          });
          return;
        }

        if (request.action === 'FOCUS_AND_HIGHLIGHT') {
          const res = focusTabAndHighlightItem(
            request.payload?.target || 'wishlist',
            request.payload?.itemId
          );
          sendResponse({
            requestId: request.requestId,
            success: true,
            data: res,
            timestamp: Date.now(),
          });
          return;
        }

        if (request.action === 'SEARCH_ITEMS') {
          const domRes = await callMainInterceptor('TRIGGER_DOM_SEARCH', request.payload);
          const refreshedStatus = parseAuctionDomStatus();
          const rawList = Array.isArray(domRes.lastSearchResponse?.items)
            ? domRes.lastSearchResponse.items
            : [];
          sendResponse({
            requestId: request.requestId,
            success: true,
            data: {
              items: rawList,
              quota: refreshedStatus.quota,
            },
            timestamp: Date.now(),
          });
          return;
        }

        if (request.action === 'GET_MARKET_PRICE') {
          focusTabAndHighlightItem('market');
          const domRes = await callMainInterceptor('TRIGGER_DOM_SEARCH', request.payload);
          const refreshedStatus = parseAuctionDomStatus();
          const rawRecords = Array.isArray(domRes.lastMarketPriceResponse?.records)
            ? domRes.lastMarketPriceResponse.records
            : [];
          sendResponse({
            requestId: request.requestId,
            success: true,
            data: {
              records: rawRecords,
              quota: refreshedStatus.quota,
            },
            timestamp: Date.now(),
          });
          return;
        }

        if (
          request.action === 'GET_WISHLIST' ||
          request.action === 'ADD_WISHLIST' ||
          request.action === 'REMOVE_WISHLIST'
        ) {
          const captured = await callMainInterceptor('GET_CAPTURED_STATE', {});
          sendResponse({
            requestId: request.requestId,
            success: true,
            data: {
              itemId: request.payload?.itemId,
              items: captured.lastWishlistResponse?.items || [],
              wishlistCount: (captured.lastWishlistResponse?.items || []).length,
              wishlistMaxSlots: 10,
              maxSlots: 10,
            },
            timestamp: Date.now(),
          });
          return;
        }

        sendResponse({
          requestId: request.requestId,
          success: false,
          error: {
            code: 'FORBIDDEN_ACTION',
            message: `지원하지 않거나 차단된 액션입니다: ${request.action}`,
          },
          timestamp: Date.now(),
        });
      } catch (err) {
        sendResponse({
          requestId: request.requestId,
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: String(err),
          },
          timestamp: Date.now(),
        });
      }
    })();

    return true; // 비동기 응답 유지
  });

  // 5초마다 백그라운드로 현재 상태 하트비트 전송
  setInterval(() => {
    try {
      const status = parseAuctionDomStatus();
      chrome.runtime.sendMessage({ type: 'AUCTION_STATUS_HEARTBEAT', status });
    } catch {
      // ignore when extension context invalidated
    }
  }, 5000);
})();
