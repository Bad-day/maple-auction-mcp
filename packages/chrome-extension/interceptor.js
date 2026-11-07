/**
 * Maple Auction MCP Bridge - MAIN World Network Interceptor & Safe Executor
 * 실행 대상: https://auction.maplestory.nexon.com/*
 *
 * 역할:
 * 1. 웹 옥션 SPA가 호출하는 내부 fetch/XHR 응답을 자동 스니핑하여 최신 매물/시세/찜 JSON을 캡처
 * 2. MCP 브릿지로부터 전달된 조회/찜 요청을 안전하게 수행
 * 3. [보안 가드] 브릿지를 통한 직접 구매(purchase/buy) 및 판매 등록(sell/register) API 호출 원천 차단
 */

(function () {
  if (window.__MAPLE_AUCTION_MCP_INTERCEPTOR_INSTALLED__) return;
  window.__MAPLE_AUCTION_MCP_INTERCEPTOR_INSTALLED__ = true;

  const state = {
    capturedEndpoints: new Set(),
    lastSearchResponse: null,
    lastMarketPriceResponse: null,
    lastWishlistResponse: null,
    lastTemplates: {
      search: null,
      marketPrice: null,
      wishlistGet: null,
      wishlistToggle: null,
    },
  };

  /**
   * URL이 절대 호출되어서는 안 되는 결제/판매 트랜잭션 엔드포인트인지 판별
   */
  function isForbiddenTransactionEndpoint(url, method, bodyText) {
    const lowerUrl = String(url || '').toLowerCase();
    const upperMethod = String(method || 'GET').toUpperCase();
    if (upperMethod === 'GET') return false;

    const forbiddenPatterns = [
      '/purchase',
      '/buy/item',
      '/buy/confirm',
      '/order',
      '/trade/buy',
      '/sell/register',
      '/sell/item',
      '/cancel-sale',
    ];
    for (const pat of forbiddenPatterns) {
      if (lowerUrl.includes(pat)) return true;
    }
    if (bodyText && /"action"\s*:\s*"(buy|purchase|sell)"/i.test(bodyText)) {
      return true;
    }
    return false;
  }

  /**
   * 캡처된 API 응답 분류 및 Content Script로 이벤트 전달
   */
  function inspectCapturedTraffic(method, url, requestBody, responseData) {
    if (!url || typeof url !== 'string') return;
    if (!url.includes('nexon.com') && !url.startsWith('/')) return;

    const endpointKey = `${method.toUpperCase()} ${url.split('?')[0]}`;
    state.capturedEndpoints.add(endpointKey);

    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('search') || lowerUrl.includes('/buy')) {
      state.lastSearchResponse = responseData;
      state.lastTemplates.search = { url, method, requestBody };
    } else if (
      lowerUrl.includes('price') ||
      lowerUrl.includes('market') ||
      lowerUrl.includes('history') ||
      lowerUrl.includes('complete')
    ) {
      state.lastMarketPriceResponse = responseData;
      state.lastTemplates.marketPrice = { url, method, requestBody };
    } else if (
      lowerUrl.includes('wish') ||
      lowerUrl.includes('favorite') ||
      lowerUrl.includes('zzim')
    ) {
      state.lastWishlistResponse = responseData;
      if (method.toUpperCase() === 'GET') {
        state.lastTemplates.wishlistGet = { url, method };
      } else {
        state.lastTemplates.wishlistToggle = { url, method, requestBody };
      }
    }

    window.dispatchEvent(
      new CustomEvent('MAPLE_AUCTION_API_CAPTURED', {
        detail: {
          endpointKey,
          capturedEndpoints: Array.from(state.capturedEndpoints),
        },
      })
    );
  }

  // 1. window.fetch 후킹
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : '';

    // 브릿지가 트리거한 요청인 경우 결제/판매 여부 검사
    if (init?.headers && init.headers['x-maple-mcp-bridge'] === '1') {
      if (isForbiddenTransactionEndpoint(url, method, bodyText)) {
        throw new Error(
          '[SECURITY_BLOCK] MCP 브릿지를 통한 직접 구매/판매 API 호출은 차단되어 있습니다.'
        );
      }
    }

    const response = await originalFetch.apply(this, args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        clone
          .json()
          .then((data) => inspectCapturedTraffic(method, url, bodyText, data))
          .catch(() => {});
      }
    } catch {
      // ignore clone errors
    }
    return response;
  };

  // 2. XMLHttpRequest 후킹
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mcpMethod = method;
    this.__mcpUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        if (contentType.includes('application/json') && this.responseText) {
          const data = JSON.parse(this.responseText);
          inspectCapturedTraffic(
            this.__mcpMethod || 'GET',
            this.__mcpUrl || '',
            typeof body === 'string' ? body : '',
            data
          );
        }
      } catch {
        // ignore parse errors
      }
    });
    return origSend.call(this, body);
  };

  // 3. Content Script로부터 전달된 브릿지 명령 처리
  window.addEventListener('MAPLE_AUCTION_BRIDGE_EXEC', async (event) => {
    const { requestId, action, payload } = event.detail || {};
    if (!requestId) return;

    const reply = (result) => {
      window.dispatchEvent(
        new CustomEvent('MAPLE_AUCTION_BRIDGE_RESULT', {
          detail: { requestId, ...result },
        })
      );
    };

    try {
      if (action === 'GET_CAPTURED_STATE') {
        reply({
          ok: true,
          capturedEndpoints: Array.from(state.capturedEndpoints),
          lastSearchResponse: state.lastSearchResponse,
          lastMarketPriceResponse: state.lastMarketPriceResponse,
          lastWishlistResponse: state.lastWishlistResponse,
        });
        return;
      }

      if (action === 'TRIGGER_DOM_SEARCH') {
        const itemName = payload?.itemName || '';
        const inputEl =
          document.querySelector('input[placeholder*="아이템명"]') ||
          document.querySelector('input[type="text"]');

        if (inputEl) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(inputEl, itemName);
          } else {
            inputEl.value = itemName;
          }
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));

          // 필터 검색 버튼 클릭 또는 Enter 키 전송
          const buttons = Array.from(document.querySelectorAll('button'));
          const searchBtn = buttons.find(
            (b) => b.textContent && b.textContent.includes('필터 검색')
          );
          if (searchBtn) {
            searchBtn.click();
          } else {
            inputEl.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
              })
            );
          }
        }

        // 네트워크 응답 대기 (최대 1.5초)
        await new Promise((r) => setTimeout(r, 1500));
        reply({
          ok: true,
          lastSearchResponse: state.lastSearchResponse,
          lastMarketPriceResponse: state.lastMarketPriceResponse,
        });
        return;
      }

      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: String(err) });
    }
  });
})();
