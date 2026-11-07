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
   * DOM 내 모든 텍스트 노드를 순서대로 배열로 수집 (노드 간 텍스트가 합쳐지지 않도록 분리)
   */
  function collectOrderedTextTokens() {
    const tokens = [];
    if (!document.body) return tokens;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        return txt.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    let current;
    while ((current = walker.nextNode())) {
      tokens.push((current.nodeValue || '').replace(/\s+/g, ' ').trim());
    }
    return tokens;
  }

  /**
   * 웹 옥션 상단 배너에서 검색 횟수(0/100), 캐릭터(닉네임, 레벨, 직업, 전투력), 보유 메소, 메이플포인트를 정확히 파싱
   *
   * 화면 구조 (텍스트 노드 순서):
   * ... -> "로그아웃" -> ["MVP"] -> "낑선" -> "Lv.293" | "아크" | "전투력 9761만 8592"
   *     -> "344억 4263만 477" (보유 메소) -> "343" (메이플포인트) -> "구매" -> "판매" ...
   */
  function parseAuctionDomStatus() {
    const bodyText = document.body?.innerText || '';
    const tokens = collectOrderedTextTokens();
    const isLoggedIn = !bodyText.includes('로그인이 필요합니다') && bodyText.includes('로그아웃');

    // 1. 검색 횟수 0 / 100 · 판매 횟수 0 / 20 파싱
    const searchQuotaMatch = bodyText.match(/검색\s*횟수\s*(\d+)\s*\/\s*(\d+)/);
    const sellQuotaMatch = bodyText.match(/판매\s*횟수\s*(\d+)\s*\/\s*(\d+)/);

    const searchUsed = searchQuotaMatch ? Number(searchQuotaMatch[1]) : 0;
    const searchLimit = searchQuotaMatch ? Number(searchQuotaMatch[2]) : 100;
    const sellUsed = sellQuotaMatch ? Number(sellQuotaMatch[1]) : 0;
    const sellLimit = sellQuotaMatch ? Number(sellQuotaMatch[2]) : 20;

    // 2. "로그아웃" 토큰과 "구매" 탭 토큰 사이의 배너 영역 토큰만 슬라이스
    const logoutIdx = tokens.findIndex((t) => t.includes('로그아웃'));
    const buyTabIdx = tokens.findIndex(
      (t, idx) => idx > logoutIdx && (t === '구매' || t === '판매')
    );

    const bannerTokens =
      logoutIdx !== -1 && buyTabIdx !== -1
        ? tokens.slice(logoutIdx + 1, buyTabIdx)
        : tokens.slice(0, 40);

    // 3. 레벨("Lv.293") 위치 탐색
    const lvIdx = bannerTokens.findIndex((t) => /Lv\.?\s*\d+/i.test(t));

    // 4. 캐릭터 닉네임 추출: "로그아웃" 뒤 ~ "Lv.293" 앞의 토큰 중 MVP/기호를 제외한 마지막 텍스트 ("낑선")
    const ignoredPreLvTokens = new Set([
      'MVP',
      '브론즈',
      '실버',
      '골드',
      '다이아',
      '레드',
      '블랙',
      '▼',
      '▲',
      '|',
      '·',
      '도움말',
      '로그아웃',
    ]);

    let charName = null;
    if (lvIdx > 0) {
      for (let i = lvIdx - 1; i >= 0; i--) {
        const candidate = bannerTokens[i].replace(/[▼▲|·]/g, '').trim();
        if (candidate && !ignoredPreLvTokens.has(candidate) && candidate.length <= 16) {
          charName = candidate;
          break;
        }
      }
    }

    // 5. 레벨, 직업, 전투력 추출
    let level = 0;
    let job = '';
    let combatPowerFormatted = '';
    let afterCombatTokenIdx = lvIdx !== -1 ? lvIdx + 1 : 0;

    if (lvIdx !== -1) {
      // Lv.293 | 아크 | 전투력 9761만 8592 가 한 노드에 있거나 여러 노드로 나뉜 경우 모두 대응
      const joinedFromLv = bannerTokens.slice(lvIdx).join(' | ');
      const fullCharMatch = joinedFromLv.match(
        /Lv\.?\s*(\d+)\s*[|·\s]+([가-힣A-Za-z()]+)\s*[|·\s]+전투력\s*([0-9조억만,\s]+?)(?=\s*\||$)/i
      );

      if (fullCharMatch) {
        level = Number(fullCharMatch[1]);
        job = fullCharMatch[2].trim();
        combatPowerFormatted = fullCharMatch[3].trim();
      } else {
        const lvMatch = bannerTokens[lvIdx].match(/Lv\.?\s*(\d+)/i);
        if (lvMatch) level = Number(lvMatch[1]);
      }

      // 전투력 텍스트가 끝나는 토큰 인덱스 찾기 (그 이후 토큰들이 메소와 메이플포인트임!)
      const cpTokenIdx = bannerTokens.findIndex((t, idx) => idx >= lvIdx && t.includes('전투력'));
      if (cpTokenIdx !== -1) {
        const cpToken = bannerTokens[cpTokenIdx];
        const inlineNum = cpToken.replace('전투력', '').trim();
        if (inlineNum && /[0-9]/.test(inlineNum)) {
          combatPowerFormatted = combatPowerFormatted || inlineNum;
          afterCombatTokenIdx = cpTokenIdx + 1;
        } else if (cpTokenIdx + 1 < bannerTokens.length) {
          combatPowerFormatted = combatPowerFormatted || bannerTokens[cpTokenIdx + 1].trim();
          afterCombatTokenIdx = cpTokenIdx + 2;
        }
      }
    }

    // 6. 보유 메소 & 메이플포인트 추출: 전투력 토큰 이후 ~ "구매" 탭 이전의 숫자/단위 토큰
    const postCombatTokens = bannerTokens.slice(afterCombatTokenIdx);
    const currencyCandidates = [];
    for (const tok of postCombatTokens) {
      const cleaned = tok.replace(/^P\s*/i, '').trim();
      // 숫자로 구성되거나 조/억/만 단위가 포함된 재화 문자열만 추출
      if (
        cleaned &&
        /^[0-9,조억만\s]+$/.test(cleaned) &&
        /[0-9]/.test(cleaned)
      ) {
        currencyCandidates.push(cleaned);
      }
    }

    const mesoFormatted = currencyCandidates.length > 0 ? currencyCandidates[0] : '0';
    const maplePointFormatted = currencyCandidates.length > 1 ? currencyCandidates[1] : '0';

    const character =
      level > 0 || charName
        ? {
            name: charName || '확인중',
            level,
            job: job || '-',
            combatPower: parseKoreanNumber(combatPowerFormatted),
            combatPowerFormatted: combatPowerFormatted || '0',
          }
        : null;

    const currency = {
      meso: parseKoreanNumber(mesoFormatted),
      mesoFormatted,
      maplePoint: parseKoreanNumber(maplePointFormatted),
    };

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

  // Background Service Worker 및 Popup으로부터 메시지 수신
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;

    // 팝업에서 즉시 현재 페이지 상태를 요청하는 경우
    if (message.type === 'GET_LIVE_DOM_STATUS') {
      const status = parseAuctionDomStatus();
      sendResponse({ ok: true, status });
      return false;
    }

    if (message.type !== 'MCP_BRIDGE_REQUEST') return false;

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

    return true;
  });

  function sendImmediateHeartbeat() {
    try {
      const status = parseAuctionDomStatus();
      chrome.runtime.sendMessage({ type: 'AUCTION_STATUS_HEARTBEAT', status });
    } catch {
      // ignore
    }
  }

  // 페이지 로드 직후 즉시 전송 + 2초 간격 업데이트
  sendImmediateHeartbeat();
  setTimeout(sendImmediateHeartbeat, 600);
  setInterval(sendImmediateHeartbeat, 2500);
})();
