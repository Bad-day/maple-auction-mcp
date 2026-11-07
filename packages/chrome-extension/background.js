/**
 * Maple Auction MCP Bridge - Background Service Worker (Manifest V3)
 * 역할:
 * 1. 로컬 MCP 서버(ws://127.0.0.1:19595)와 실시간 연결 유지
 * 2. https://auction.maplestory.nexon.com/* 탭 탐색, 활성화(포커스) 및 메시지 중계
 * 3. 읽기/찜/포커스 외의 구매·판매 액션 차단 가드
 */

const BRIDGE_PORT = 19595;
const WS_URL = `ws://127.0.0.1:${BRIDGE_PORT}/ws`;
const HTTP_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const ALLOWED_ACTIONS = new Set([
  'GET_STATUS',
  'SEARCH_ITEMS',
  'GET_MARKET_PRICE',
  'GET_WISHLIST',
  'ADD_WISHLIST',
  'REMOVE_WISHLIST',
  'FOCUS_AND_HIGHLIGHT',
]);

let socket = null;
let isConnected = false;
let latestAuctionStatus = null;

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      isConnected = true;
      chrome.storage.local.set({ mcpBridgeConnected: true });
      if (latestAuctionStatus) {
        socket.send(JSON.stringify({ type: 'HEARTBEAT', status: latestAuctionStatus }));
      }
    };

    socket.onmessage = async (event) => {
      try {
        const request = JSON.parse(event.data);
        if (!request || !request.requestId) return;
        const response = await handleBridgeRequest(request);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(response));
        } else {
          await fetch(`${HTTP_BASE}/bridge/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
          });
        }
      } catch {
        // ignore parse errors
      }
    };

    socket.onclose = () => {
      isConnected = false;
      socket = null;
      chrome.storage.local.set({ mcpBridgeConnected: false });
    };

    socket.onerror = () => {
      isConnected = false;
    };
  } catch {
    isConnected = false;
  }
}

/**
 * 열려 있는 메이플 옥션 탭(https://auction.maplestory.nexon.com/*) 찾기
 */
async function findMapleAuctionTab() {
  const tabs = await chrome.tabs.query({ url: 'https://auction.maplestory.nexon.com/*' });
  if (tabs && tabs.length > 0) {
    return tabs[0];
  }
  return null;
}

/**
 * MCP 서버의 요청을 검증하고 메이플 옥션 탭의 Content Script로 전달
 */
async function handleBridgeRequest(request) {
  const { requestId, action, payload } = request;

  // 1. 보안 화이트리스트 검증 (구매/판매 원천 차단)
  if (!ALLOWED_ACTIONS.has(action)) {
    return {
      requestId,
      success: false,
      error: {
        code: 'FORBIDDEN_ACTION',
        message: `[보안 차단] 허용되지 않은 브릿지 액션입니다: ${action}`,
      },
      timestamp: Date.now(),
    };
  }

  // 2. 메이플 옥션 탭 탐색 (FOCUS_AND_HIGHLIGHT 시 탭이 없으면 새로 열기 지원)
  let tab = await findMapleAuctionTab();
  if (!tab && action === 'FOCUS_AND_HIGHLIGHT') {
    tab = await chrome.tabs.create({
      url: 'https://auction.maplestory.nexon.com/buy',
      active: true,
    });
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!tab || !tab.id) {
    return {
      requestId,
      success: false,
      error: {
        code: 'TAB_NOT_FOUND',
        message:
          '크롬에 열려 있는 메이플 옥션(https://auction.maplestory.nexon.com/buy) 탭을 찾을 수 없습니다. 탭을 열고 로그인해주세요.',
      },
      timestamp: Date.now(),
    };
  }

  // 3. 브라우저 탭 활성화 요청인 경우 해당 탭 및 윈도우 포커스
  if (action === 'FOCUS_AND_HIGHLIGHT') {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  }

  // 4. Content Script로 메시지 전달
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'MCP_BRIDGE_REQUEST', request: { requestId, action, payload } },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          resolve({
            requestId,
            success: false,
            error: {
              code: 'NETWORK_ERROR',
              message:
                chrome.runtime.lastError?.message ||
                '메이플 옥션 탭과 통신할 수 없습니다. 페이지를 새로고침(F5) 해주세요.',
            },
            timestamp: Date.now(),
          });
          return;
        }
        resolve(response);
      }
    );
  });
}

// Content Script 및 Popup 메시지 리스너
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'AUCTION_STATUS_HEARTBEAT' && msg.status) {
    latestAuctionStatus = msg.status;
    chrome.storage.local.set({ latestAuctionStatus });

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'HEARTBEAT', status: latestAuctionStatus }));
    } else {
      connectWebSocket();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'GET_POPUP_STATE') {
    sendResponse({
      mcpBridgeConnected: isConnected,
      latestAuctionStatus,
      wsUrl: WS_URL,
    });
    return false;
  }

  return false;
});

// 주기적 재연결 타이머
setInterval(connectWebSocket, 4000);
connectWebSocket();
