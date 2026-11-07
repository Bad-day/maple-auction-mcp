document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge');
  const charInfo = document.getElementById('charInfo');
  const combatInfo = document.getElementById('combatInfo');
  const mesoInfo = document.getElementById('mesoInfo');
  const mpInfo = document.getElementById('mpInfo');
  const quotaInfo = document.getElementById('quotaInfo');
  const syncTimeInfo = document.getElementById('syncTimeInfo');
  const refreshBtn = document.getElementById('refreshSessionBtn');
  const openBtn = document.getElementById('openAuctionBtn');

  let isMcpConnected = false;

  function formatSyncTime(isoString) {
    try {
      const d = isoString ? new Date(isoString) : new Date();
      return d.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '-';
    }
  }

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
    if (st && st.lastUpdated) {
      syncTimeInfo.textContent = formatSyncTime(st.lastUpdated);
    }
  }

  async function getPrioritizedAuctionTabs() {
    const tabs = await chrome.tabs.query({ url: 'https://auction.maplestory.nexon.com/*' });
    if (!tabs || tabs.length === 0) return [];
    return [...tabs].sort((a, b) => {
      const score = (t) => (t.active ? 4 : 0) + (t.url && t.url.includes('/buy') ? 2 : 0);
      return score(b) - score(a);
    });
  }

  function queryTabMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          resolve(null);
        } else {
          resolve(resp);
        }
      });
    });
  }

  async function fetchLiveStatus() {
    chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' }, async (bgResp) => {
      isMcpConnected = Boolean(bgResp && bgResp.mcpBridgeConnected);
      let bestStatus = bgResp ? bgResp.latestAuctionStatus : null;

      const tabs = await getPrioritizedAuctionTabs();
      for (const tab of tabs) {
        if (!tab.id) continue;
        const tabResp = await queryTabMessage(tab.id, { type: 'GET_LIVE_DOM_STATUS' });
        if (tabResp && tabResp.status) {
          bestStatus = tabResp.status;
          if (tabResp.status.character && tabResp.status.character.level > 0) {
            chrome.runtime.sendMessage({
              type: 'AUCTION_STATUS_HEARTBEAT',
              status: bestStatus,
            });
            break;
          }
        }
      }
      renderStatus(bestStatus, isMcpConnected);
    });
  }

  fetchLiveStatus();

  // [세션 새로고침] 버튼 클릭 시
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '🔄 갱신 중...';

    const tabs = await getPrioritizedAuctionTabs();
    if (tabs.length > 0 && tabs[0].id) {
      const targetTab = tabs[0];
      const tabResp = await queryTabMessage(targetTab.id, { type: 'REFRESH_AUCTION_SESSION' });
      if (tabResp && tabResp.status) {
        renderStatus(tabResp.status, isMcpConnected);
        refreshBtn.textContent = '✅ 갱신 완료!';
        setTimeout(() => {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '🔄 세션 새로고침';
        }, 1000);
      } else {
        await chrome.tabs.reload(targetTab.id);
        setTimeout(async () => {
          await fetchLiveStatus();
          refreshBtn.textContent = '✅ 갱신 완료!';
          setTimeout(() => {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 세션 새로고침';
          }, 1000);
        }, 1500);
      }
    } else {
      refreshBtn.textContent = '⚠️ 탭 없음';
      setTimeout(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 세션 새로고침';
      }, 1200);
    }
  });

  // [메이플 옥션 탭 이동] 버튼 클릭 시
  openBtn.addEventListener('click', async () => {
    const tabs = await getPrioritizedAuctionTabs();
    if (tabs.length > 0 && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: 'https://auction.maplestory.nexon.com/buy', active: true });
    }
  });
});
