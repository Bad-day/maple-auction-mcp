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
   * DOM 내 모든 텍스트 노드를 순서대로 배열로 수집
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
   * 웹 옥션 상단 배너 파서
   * 실제 웹 옥션 DOM 텍스트 노드 분리 구조:
   * ["MVP", "낑선", "Lv.", "293", "아크", "전투력", "9761만 8592", "344억 4263만 477", "343"]
   * ("Lv."와 "293", "전투력"과 "9761만 8592"가 별도 텍스트 노드로 분리되어 있음)
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

    // 3. "Lv." 또는 "Lv.293" 노드 위치 찾기 ("Lv." 단독 텍스트 노드도 정확히 매칭!)
    const lvIdx = bannerTokens.findIndex((t) => /^Lv\.?(\s*\d+)?$/i.test(t.trim()) || /^Lv\./i.test(t.trim()));

    // 4. 캐릭터 닉네임 추출: "Lv." 직전 토큰 ("낑선")
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

    // 5. 레벨("293"), 직업("아크"), 전투력("9761만 8592") 추출
    let level = 0;
    let job = '';
    let combatPowerFormatted = '';
    let afterCombatTokenIdx = 0;

    if (lvIdx !== -1) {
      const lvToken = bannerTokens[lvIdx].trim();
      const inlineLvMatch = lvToken.match(/Lv\.?\s*(\d+)/i);
      let jobStartIdx = lvIdx + 1;

      if (inlineLvMatch) {
        level = Number(inlineLvMatch[1]);
        // 만약 한 노드에 "Lv.293 | 아크 | 전투력 9761만 8592"가 통째로 들어있는 경우
        const singleNodeMatch = lvToken.match(
          /Lv\.?\s*(\d+)\s*[|·\s]+([가-힣A-Za-z()]+)\s*[|·\s]+전투력\s*([0-9조억만,\s]+)/i
        );
        if (singleNodeMatch) {
          job = singleNodeMatch[2].trim();
          combatPowerFormatted = singleNodeMatch[3].trim();
          afterCombatTokenIdx = lvIdx + 1;
        }
      } else if (lvIdx + 1 < bannerTokens.length && /^\d+$/.test(bannerTokens[lvIdx + 1].trim())) {
        // "Lv." 노드 바로 다음 노드가 "293"인 경우
        level = Number(bannerTokens[lvIdx + 1].trim());
        jobStartIdx = lvIdx + 2;
      }

      // "전투력" 토큰 찾기
      const cpTokenIdx = bannerTokens.findIndex((t, idx) => idx >= lvIdx && t.includes('전투력'));
      if (cpTokenIdx !== -1) {
        // 레벨 토큰과 "전투력" 토큰 사이에 있는 직업명("아크") 추출
        if (!job) {
          for (let i = jobStartIdx; i < cpTokenIdx; i++) {
            const tok = bannerTokens[i].replace(/[|·]/g, '').trim();
            if (tok && !/^\d+$/.test(tok)) {
              job = tok;
              break;
            }
          }
        }

        const cpToken = bannerTokens[cpTokenIdx].trim();
        const inlineCp = (cpToken.split('전투력')[1] || '').replace(/[|·]/g, '').trim();
        if (inlineCp && /[0-9]/.test(inlineCp)) {
          // "전투력 9761만 8592"가 한 노드인 경우
          combatPowerFormatted = inlineCp;
          afterCombatTokenIdx = cpTokenIdx + 1;
        } else {
          // "전투력" 다음 노드가 "9761만 8592"인 경우
          for (let i = cpTokenIdx + 1; i < bannerTokens.length; i++) {
            const candidateCp = bannerTokens[i].replace(/[|·]/g, '').trim();
            if (candidateCp && /[0-9]/.test(candidateCp)) {
              combatPowerFormatted = candidateCp;
              afterCombatTokenIdx = i + 1;
              break;
            }
          }
        }
      }
    }

    // 6. 보유 메소 & 메이플포인트 추출: 전투력 값 노드(afterCombatTokenIdx) **직후**부터의 숫자 토큰들
    const postCombatTokens = bannerTokens.slice(afterCombatTokenIdx);
    const currencyCandidates = [];
    for (const tok of postCombatTokens) {
      const cleaned = tok.replace(/^P\s*/i, '').trim();
      if (cleaned && /^[0-9,조억만\s]+$/.test(cleaned) && /[0-9]/.test(cleaned)) {
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

  /**
   * 웹 옥션 상단 배너 우측의 재화/세션 새로고침 아이콘 버튼 클릭 후 최신 DOM 상태 반환
   */
  async function triggerBannerSessionRefresh() {
    try {
      // 배너 영역(구매 탭 상단, y < 160px)에 위치한 아이콘 전용 새로고침 버튼 탐색 및 클릭
      const buttons = Array.from(document.querySelectorAll('button'));
      const bannerRefreshBtn = buttons.find((btn) => {
        const rect = btn.getBoundingClientRect();
        const txt = (btn.textContent || '').trim();
        return rect.top > 30 && rect.top < 150 && rect.left > 500 && txt.length === 0;
      });
      if (bannerRefreshBtn) {
        bannerRefreshBtn.click();
        await new Promise((r) => setTimeout(r, 450));
      }
    } catch {
      // ignore click error
    }
    const status = parseAuctionDomStatus();
    try {
      chrome.runtime.sendMessage({ type: 'AUCTION_STATUS_HEARTBEAT', status });
    } catch {
      // ignore
    }
    return status;
  }

  // Background Service Worker 및 Popup으로부터 메시지 수신
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;

    if (message.type === 'GET_LIVE_DOM_STATUS') {
      const status = parseAuctionDomStatus();
      sendResponse({ ok: true, status });
      return false;
    }

    if (message.type === 'REFRESH_AUCTION_SESSION') {
      triggerBannerSessionRefresh().then((status) => {
        sendResponse({ ok: true, status });
      });
      return true;
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

  sendImmediateHeartbeat();
  setTimeout(sendImmediateHeartbeat, 600);
  setInterval(sendImmediateHeartbeat, 2500);
})();
