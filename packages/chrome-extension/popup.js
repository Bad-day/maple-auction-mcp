document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const charInfo = document.getElementById('charInfo');
  const mesoInfo = document.getElementById('mesoInfo');
  const quotaInfo = document.getElementById('quotaInfo');
  const openBtn = document.getElementById('openAuctionBtn');

  chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' }, (resp) => {
    if (!resp) return;

    if (resp.mcpBridgeConnected) {
      statusBadge.textContent = 'MCP 서버 연결됨';
      statusBadge.className = 'badge ok';
    } else {
      statusBadge.textContent = 'MCP 서버 대기 중';
      statusBadge.className = 'badge off';
    }

    const st = resp.latestAuctionStatus;
    if (st && st.character) {
      charInfo.textContent = `${st.character.name} (Lv.${st.character.level} ${st.character.job})`;
    }
    if (st && st.currency) {
      mesoInfo.textContent = st.currency.mesoFormatted;
    }
    if (st && st.quota) {
      quotaInfo.textContent = `${st.quota.searchUsed} / ${st.quota.searchLimit} (남은 횟수: ${st.quota.searchRemaining})`;
    }
  });

  openBtn.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://auction.maplestory.nexon.com/*' });
    if (tabs && tabs.length > 0 && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: 'https://auction.maplestory.nexon.com/buy', active: true });
    }
  });
});
