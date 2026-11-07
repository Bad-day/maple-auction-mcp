document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge');
  const charInfo = document.getElementById('charInfo');
  const combatInfo = document.getElementById('combatInfo');
  const mesoInfo = document.getElementById('mesoInfo');
  const mpInfo = document.getElementById('mpInfo');
  const quotaInfo = document.getElementById('quotaInfo');
  const openBtn = document.getElementById('openAuctionBtn');

  function renderStatus(st, mcpConnected) {
    const isLoggedIn = Boolean(st && (st.loggedIn || (st.character && st.character.level > 0)));

    if (isLoggedIn && mcpConnected) {
      statusBadge.textContent = '웹 옥션 & MCP 연결됨';
      statusBadge.className = 'badge ok';
    } else if (isLoggedIn) {
      statusBadge.textContent = '웹 옥션 로그인 연동됨';
      statusBadge.className = 'badge ok';
    } else {
      statusBadge.textContent = '웹 옥션 로그인 필요';
      statusBadge.className = 'badge off';
    }

    if (st && st.character) {
      charInfo.textContent = `${st.character.name} (Lv.${st.character.level} ${st.character.job})`;
      combatInfo.textContent = st.character.combatPowerFormatted || '-';
    }
    if (st && st.currency) {
      mesoInfo.textContent = st.currency.mesoFormatted || '0';
      mpInfo.textContent = `${st.currency.maplePoint ?? 0} P`;
    }
    if (st && st.quota) {
      quotaInfo.textContent = `${st.quota.searchUsed} / ${st.quota.searchLimit} (남은 횟수: ${st.quota.searchRemaining})`;
    }
  }

  // 1. 백그라운드 상태 우선 확인
  chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' }, async (bgResp) => {
    const mcpConnected = Boolean(bgResp && bgResp.mcpBridgeConnected);
    let currentStatus = bgResp ? bgResp.latestAuctionStatus : null;

    // 2. 열려 있는 메이플 옥션 탭에서 실시간 DOM 상태 직접 조회
    const tabs = await chrome.tabs.query({ url: 'https://auction.maplestory.nexon.com/*' });
    if (tabs && tabs.length > 0 && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LIVE_DOM_STATUS' }, (tabResp) => {
        if (!chrome.runtime.lastError && tabResp && tabResp.status) {
          currentStatus = tabResp.status;
          // 백그라운드에도 최신 상태 즉시 동기화
          chrome.runtime.sendMessage({
            type: 'AUCTION_STATUS_HEARTBEAT',
            status: currentStatus,
          });
        }
        renderStatus(currentStatus, mcpConnected);
      });
    } else {
      renderStatus(currentStatus, mcpConnected);
    }
  });

  openBtn.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://auction.maplestory.nexon.com/*' });
    if (tabs && tabs.length > 0 && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
      chrome.tabs.reload(tabs[0].id);
    } else {
      await chrome.tabs.create({ url: 'https://auction.maplestory.nexon.com/buy', active: true });
    }
  });
});
