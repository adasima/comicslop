let state = {
  status: 'idle',
  logs: []
};

let currentTabIds = new Set();
let stopRequested = false;
let activeDebuggers = new Map(); // tabId -> true


// ========================================================
// ユーティリティ
// ========================================================
function addLog(text, type = 'info') {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  const logEntry = { text: `[${timeStr}] ${text}`, type };
  state.logs.push(logEntry);
  if (state.logs.length > 200) state.logs.shift();
  chrome.runtime.sendMessage({ action: 'log', text: logEntry.text, type: logEntry.type }).catch(() => {});
}

function updateStatus(newStatus) {
  state.status = newStatus;
  chrome.runtime.sendMessage({ action: 'statusChanged', status: newStatus }).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRunning() {
  return state.status === 'running' && !stopRequested;
}

// ========================================================
// chrome.debugger CDP ヘルパー
// Content Script からのリクエストを処理
// ========================================================
async function attachDebugger(tabId) {
  if (activeDebuggers.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    activeDebuggers.set(tabId, true);
    console.log(`[BG] Debugger attached to tab ${tabId}`);
    return true;
  } catch (e) {
    console.warn(`[BG] Failed to attach debugger to tab ${tabId}:`, e.message);
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!activeDebuggers.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  activeDebuggers.delete(tabId);
}

async function cdpClick(tabId, x, y) {
  const attached = await attachDebugger(tabId);
  if (!attached) return false;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    });
    return true;
  } catch (e) {
    console.warn(`[BG] CDP click failed:`, e.message);
    return false;
  }
}

async function cdpKeyPress(tabId, key) {
  const attached = await attachDebugger(tabId);
  if (!attached) return false;
  const keyMap = {
    'ArrowLeft': { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
    'ArrowRight': { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  };
  const keyInfo = keyMap[key] || { windowsVirtualKeyCode: 0, code: key, key };
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
      code: keyInfo.code, key: keyInfo.key,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
      code: keyInfo.code, key: keyInfo.key,
    });
    return true;
  } catch (e) {
    console.warn(`[BG] CDP key press failed:`, e.message);
    return false;
  }
}

// デバッガーデタッチ時のクリーンアップ
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    activeDebuggers.delete(source.tabId);
    console.log(`[BG] Debugger detached from tab ${source.tabId}: ${reason}`);
  }
});

// ========================================================
// タブ管理ヘルパー
// ========================================================
function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!isRunning()) { reject(new Error('Stopped')); return; }
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      fn();
    };
    const listener = (id, info) => {
      if (!isRunning()) { settle(() => reject(new Error('Stopped'))); return; }
      if (id === tabId && info.status === 'complete') { settle(() => resolve()); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => { settle(() => reject(new Error('Tab load timeout'))); }, timeoutMs);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') { settle(() => resolve()); }
    }).catch(() => {});
  });
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_action.js'] });
    return true;
  } catch (e) {
    console.warn(`[BG] Content script injection failed for tab ${tabId}:`, e.message);
    return false;
  }
}

// タブを URL へ遷移させ、loading→complete を見届けてから戻る。
// tabs.update 直後に waitTabComplete を呼ぶと旧ページの 'complete' を拾って
// ナビゲーション前に解決してしまう競合があるため、必ずこちらを使う。
function navigateTab(tabId, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!isRunning()) { reject(new Error('Stopped')); return; }
    let settled = false;
    let sawLoading = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(stopCheck);
      clearTimeout(timer);
      fn();
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) settle(() => resolve());
    };
    const stopCheck = setInterval(() => {
      if (!isRunning()) settle(() => reject(new Error('Stopped')));
    }, 500);
    const timer = setTimeout(() => settle(() => resolve()), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }).catch(e => settle(() => reject(e)));
  });
}

// 「次の話を読む」ボタンをページ内でクリック（href が取れない場合の遷移手段）
async function clickNextEpisodeInPage(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // mode-next 必須。[class*="last-btn"] はお気に入りボタン等も拾い同話ループの原因になる。
        const b = document.querySelector('#xCVLastPageNextBtn, .last_page_next_button, .-cv-last-btn.mode-next');
        if (b) { b.click(); return true; }
        return false;
      },
    });
    return !!(r && r[0] && r[0].result);
  } catch (_) { return false; }
}

function waitForActionComplete(tabId, taskName, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!isRunning()) { reject(new Error('Stopped')); return; }
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(msgListener);
      clearInterval(stopCheck);
      clearTimeout(timeoutHandle);
      fn();
    };
    const msgListener = (msg, sender) => {
      if (sender.tab && sender.tab.id === tabId &&
          msg.action === 'actionComplete' && msg.task === taskName) {
        settle(() => resolve(msg));
      }
    };
    const stopCheck = setInterval(() => {
      if (!isRunning()) { settle(() => reject(new Error('Stopped'))); }
    }, 500);
    const timeoutHandle = setTimeout(() => { settle(() => resolve({ status: 'timeout' })); }, timeoutMs);
    chrome.runtime.onMessage.addListener(msgListener);
  });
}

function waitForUrlChange(tabId, originalUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val) => {
      if (settled) return; settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(val);
    };
    const listener = (id, info) => {
      if (id === tabId && info.url && info.url !== originalUrl) { settle(info.url); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => settle(null), timeoutMs);
  });
}

// ========================================================
// ミッション解析
// ========================================================
function parseMissionTypes(missions, domain) {
  const queue = [];
  missions.forEach(m => {
    const title = m.title;
    // 「XエピソードからYエピソードまで」形式は対象エピソードが固定されている。
    // ミッションURLからは常に第1話が開くため、残り話数だけ読むと後半の話に
    // 到達できず未達成になる。範囲ミッションは常に総話数分を先頭から読む。
    const isRangeMission = /\d+\s*エピソードから\s*\d+\s*エピソードまで/.test(title);
    const count = isRangeMission
      ? ((m.totalCount > 0) ? m.totalCount : (m.readCount > 0 ? m.readCount : 1))
      : ((m.readCount > 0) ? m.readCount : 1);
    const url = m.url;
    let isExternal = false;
    try {
      const missionHost = new URL(url).hostname;
      const siteHost = new URL(domain).hostname;
      isExternal = missionHost !== siteHost;
    } catch (_) {}

    if (isExternal || title.includes('他サイト')) {
      queue.push({ type: 'externalRead', title, url, count });
    } else if (title.includes('お気に入り')) {
      queue.push({ type: 'readAndBookmark', title, url, count });
    } else if (title.includes('読了') || title.includes('読む') || title.includes('エピソード')) {
      queue.push({ type: 'readEpisode', title, url, count });
    } else if (title.includes('ガチャ')) {
      queue.push({ type: 'gacha', title, url });
    } else {
      queue.push({ type: 'readEpisode', title, url, count });
    }
  });
  return queue;
}

// ========================================================
// タスク実行: 読了
// ========================================================
async function executeReadTask(item, tabId) {
  addLog(`読了開始: ${item.title} (${item.count}話)`, 'info');
  const tab = { id: tabId };
  try {
    await navigateTab(tab.id, item.url);
    if (!isRunning()) throw new Error('Stopped');

    // CDPは合成キーが効かない場合のフォールバックのみ。必要時にオンデマンドでアタッチする。
    await sleep(300); // ビューアー初期化はcontent側でもポーリング待ちする

    if (!await injectContentScript(tab.id)) {
      addLog(`エラー: content script注入失敗: ${item.title}`, 'error');
      return;
    }
    await sleep(150);

    const target = item.count || 1;
    let done = 0;
    // 同一エピソードの再読ループ防止（次話ボタン誤検出などへの最終防衛線）
    const visited = new Set();
    {
      const u = (await chrome.tabs.get(tab.id).catch(() => ({})))?.url;
      if (u) visited.add(u);
    }

    while (done < target && isRunning()) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'executeRead' });
      } catch (e) {
        addLog(`エラー: メッセージ送信失敗: ${e.message}`, 'error');
        break;
      }

      const result = await waitForActionComplete(tab.id, 'readEpisode', 15 * 60 * 1000);
      if (result.status === 'timeout') {
        addLog(`警告: 読了タイムアウト (${done}/${target}話): ${item.title}`, 'warn');
        break;
      }
      if (result.status === 'paywall') {
        addLog(`無料範囲外のため停止 (${done}/${target}話): ${item.title}`, 'warn');
        break;
      }
      if (result.status === 'error' || result.count === 0) {
        addLog(`警告: 読了失敗 (${done}/${target}話): ${result.message || ''}`, 'warn');
        break;
      }

      done++;
      addLog(`読了 ${done}/${target}話: ${item.title}`, done >= target ? 'success' : 'info');
      if (done >= target) break;

      // 次話へ遷移（background が制御 → ページ再読込に耐える）
      const originUrl = (await chrome.tabs.get(tab.id).catch(() => ({})))?.url || '';
      if (result.nextUrl) {
        await navigateTab(tab.id, result.nextUrl);
      } else if (result.nextBtnPresent) {
        const clicked = await clickNextEpisodeInPage(tab.id);
        if (!clicked) { addLog('次話ボタン押下失敗。読了終了。', 'warn'); break; }
        const newUrl = await waitForUrlChange(tab.id, originUrl, 12000);
        // SPA遷移だと前話の状態が残るため、遷移先URLへ強制リロードして状態を排除
        if (newUrl) { await navigateTab(tab.id, newUrl); }
        else { try { await waitTabComplete(tab.id); } catch (_) {} }
      } else {
        addLog('次話への遷移手段なし。読了終了。', 'info');
        break;
      }

      if (!isRunning()) break;

      // 遷移先が既読エピソードなら同話ループとみなして中断
      const landedUrl = (await chrome.tabs.get(tab.id).catch(() => ({})))?.url || '';
      if (landedUrl) {
        if (visited.has(landedUrl)) {
          addLog(`警告: 同じエピソードに戻ったため中断 (${done}/${target}話)`, 'warn');
          break;
        }
        visited.add(landedUrl);
      }

      await sleep(300); // ビューアー再初期化はcontent側でもポーリング待ちする
      if (!await injectContentScript(tab.id)) {
        addLog('次話でcontent script注入失敗。終了。', 'warn');
        break;
      }
      await sleep(150);
    }
  } catch (e) {
    if (e.message === 'Stopped') throw e;
    addLog(`エラー: ${item.title}: ${e.message}`, 'error');
  } finally {
    await detachDebugger(tab.id);
  }
}

// ========================================================
// タスク実行: 外部サイト読了
// ========================================================
async function executeExternalReadTask(item, tabId) {
  addLog(`外部サイト読了開始: ${item.title}`, 'info');
  const tab = { id: tabId };
  try {
    await navigateTab(tab.id, item.url);
    if (!isRunning()) throw new Error('Stopped');
    await sleep(500);

    if (!await injectContentScript(tab.id)) {
      addLog(`エラー: content script注入失敗: ${item.title}`, 'error');
      return;
    }
    await sleep(150);

    // ビューアーかチェック
    let isViewer = false;
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'checkViewer' });
      isViewer = resp?.isViewer || false;
    } catch (_) {}

    if (isViewer) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'executeRead', count: item.count || 1 });
      } catch (e) {
        addLog(`エラー: メッセージ送信失敗: ${e.message}`, 'error');
        return;
      }
    } else {
      // シリーズページ → エピソード選択
      addLog('外部サイト: シリーズページからエピソードを選択中...', 'info');
      const currentUrl = (await chrome.tabs.get(tab.id).catch(() => ({})))?.url || '';
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'executeExternalRead' });
      } catch (e) {
        addLog(`エラー: 外部読了メッセージ送信失敗: ${e.message}`, 'error');
        return;
      }
      const newUrl = await waitForUrlChange(tab.id, currentUrl, 10000);
      if (newUrl) {
        addLog(`外部サイト: エピソードに遷移: ${newUrl}`, 'info');
        await waitTabComplete(tab.id);
        await sleep(500);
        if (!await injectContentScript(tab.id)) {
          addLog('エラー: エピソードページでcontent script注入失敗', 'error');
          return;
        }
        await sleep(150);
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'executeRead', count: item.count || 1 });
        } catch (e) {
          addLog(`エラー: 読了メッセージ送信失敗: ${e.message}`, 'error');
          return;
        }
      } else {
        addLog('外部サイト: エピソード遷移タイムアウト', 'warn');
        return;
      }
    }

    const result = await waitForActionComplete(tab.id, 'readEpisode', 15 * 60 * 1000);
    if (result.status === 'timeout') {
      addLog(`警告: 外部サイト読了タイムアウト: ${item.title}`, 'warn');
    } else {
      addLog(`成功: 外部サイト読了完了: ${item.title}`, 'success');
    }
  } catch (e) {
    if (e.message === 'Stopped') throw e;
    addLog(`エラー: 外部: ${item.title}: ${e.message}`, 'error');
  } finally {
    await detachDebugger(tab.id);
  }
}

// ========================================================
// タスク実行: 読了+お気に入り
// ========================================================
async function executeReadAndBookmarkTask(item, tabId) {
  addLog(`読了+お気に入り開始: ${item.title}`, 'info');
  const tab = { id: tabId };
  try {
    await navigateTab(tab.id, item.url);
    if (!isRunning()) throw new Error('Stopped');
    await sleep(300);

    if (!await injectContentScript(tab.id)) {
      addLog(`エラー: content script注入失敗: ${item.title}`, 'error');
      return;
    }
    await sleep(150);

    // 読了後、最終ページ上のお気に入りボタンを content 側が直接叩く
    // （シリーズページへの遷移を省いて高速化）
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'executeRead', count: item.count || 1, bookmark: true });
    } catch (e) {
      addLog(`エラー: メッセージ送信失敗: ${e.message}`, 'error');
      return;
    }

    const readResult = await waitForActionComplete(tab.id, 'readEpisode', 15 * 60 * 1000);
    if (readResult.status === 'timeout') {
      addLog('警告: 読了タイムアウト', 'warn');
      return;
    }

    const bs = readResult.bookmarkStatus;
    if (bs === 'already') {
      addLog('お気に入り: 既に登録済みのため手を付けず維持。', 'info');
      return;
    }
    if (bs === 'success') {
      addLog('成功: 最終ページでお気に入り登録→解除完了（ミッション計上）。', 'success');
      return;
    }

    // 最終ページにボタンがない/失敗した場合のみ、従来のシリーズページ方式へフォールバック
    addLog(`最終ページお気に入り不可 (${bs || '不明'})。シリーズページ方式へフォールバック。`, 'warn');
    const seriesUrl = readResult.seriesUrl;
    if (!seriesUrl) {
      addLog('警告: シリーズURL取得不可。お気に入りスキップ。', 'warn');
      return;
    }
    if (!isRunning()) throw new Error('Stopped');

    await navigateTab(tab.id, seriesUrl);
    await sleep(300);

    if (!await injectContentScript(tab.id)) return;
    await sleep(150);

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'executeBookmark' });
    } catch (e) {
      addLog(`エラー: お気に入りメッセージ送信失敗: ${e.message}`, 'error');
      return;
    }

    const bookmarkResult = await waitForActionComplete(tab.id, 'bookmark', 60 * 1000);
    if (bookmarkResult.status === 'timeout' || bookmarkResult.status === 'error') {
      addLog(`警告: お気に入り不完了: ${bookmarkResult.message || 'タイムアウト'}`, 'warn');
    } else if (bookmarkResult.status === 'already') {
      addLog('お気に入り: 既に登録済みのため手を付けず維持。', 'info');
    } else {
      addLog('成功: お気に入り登録→解除完了（ミッション計上）。', 'success');
    }
  } catch (e) {
    if (e.message === 'Stopped') throw e;
    addLog(`エラー: ${item.title}: ${e.message}`, 'error');
  } finally {
    await detachDebugger(tab.id);
  }
}

// ========================================================
// タスク実行: ガチャ
// ========================================================
async function executeGachaTask(item, tabId) {
  addLog(`ガチャ開始: ${item.title}`, 'info');
  let xTabListener = null;
  const tab = { id: tabId };
  try {
    await navigateTab(tab.id, item.url);
    if (!isRunning()) throw new Error('Stopped');
    await sleep(800);

    xTabListener = (tabId, changeInfo, tabInfo) => {
      const checkUrl = changeInfo.url || tabInfo.pendingUrl || tabInfo.url || '';
      if (checkUrl.includes('x.com') || checkUrl.includes('twitter.com')) {
        chrome.tabs.remove(tabId).catch(() => {});
        addLog('Xシェアタブを自動クローズ', 'info');
      }
    };
    chrome.tabs.onUpdated.addListener(xTabListener);

    if (!await injectContentScript(tab.id)) {
      addLog(`エラー: content script注入失敗: ${item.title}`, 'error');
      return;
    }
    await sleep(500);

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'executeGacha' });
    } catch (e) {
      addLog(`エラー: ガチャメッセージ送信失敗: ${e.message}`, 'error');
      return;
    }

    const result = await waitForActionComplete(tab.id, 'gacha', 3 * 60 * 1000);
    if (result.status === 'timeout' || result.status === 'error') {
      addLog(`警告: ガチャ不完了: ${result.message || 'タイムアウト'}`, 'warn');
    } else if (result.status === 'skipped') {
      addLog('ガチャ: 本日分は消化済み', 'info');
    } else {
      addLog('成功: ガチャ完了', 'success');
    }
  } catch (e) {
    if (e.message === 'Stopped') throw e;
    addLog(`エラー: ガチャ: ${e.message}`, 'error');
  } finally {
    if (xTabListener) chrome.tabs.onUpdated.removeListener(xTabListener);
    await detachDebugger(tab.id);
  }
}

// ========================================================
// メインの自動実行フロー（並列: 無制限）
// ========================================================
async function startAutomation() {
  updateStatus('running');
  stopRequested = false;
  state.logs = [];
  currentTabIds.clear();
  activeDebuggers.clear();
  addLog('ミッション自動化処理を開始します...', 'info');

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) { addLog('アクティブなタブが見つかりません。', 'error'); return; }

    const activeTab = tabs[0];
    const url = new URL(activeTab.url);
    const domain = url.origin;
    const missionUrl = activeTab.url;
    addLog(`対象ドメイン: ${domain}`, 'info');

    if (!url.pathname.includes('/mission')) {
      addLog('エラー: /mission ページで実行してください。', 'error');
      return;
    }

    addLog('ミッション一覧を解析中...', 'info');
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content_mission.js']
    });

    const rawMissions = results[0]?.result || [];
    addLog(`未達成ミッションが ${rawMissions.length} 件見つかりました。`, 'info');

    const queue = parseMissionTypes(rawMissions, domain);

    // ガチャ追加
    if (!queue.some(item => item.type === 'gacha')) {
      queue.push({ type: 'gacha', title: '無料ガチャ (直接遷移)', url: `${domain}/gacha` });
    }

    addLog(`実行キュー: ${queue.length} 件`, 'info');
    queue.forEach((item, idx) => {
      addLog(`  [${idx + 1}] ${item.type}: ${item.title}${item.count ? ` (${item.count}話)` : ''}`, 'info');
    });

    // アクティブタブ1本で1ミッションずつ直列実行（ガチャは最後）
    const orderedQueue = [
      ...queue.filter(i => i.type !== 'gacha'),
      ...queue.filter(i => i.type === 'gacha'),
    ];
    for (const item of orderedQueue) {
      if (!isRunning()) break;
      try {
        switch (item.type) {
          case 'readAndBookmark': await executeReadAndBookmarkTask(item, activeTab.id); break;
          case 'externalRead': await executeExternalReadTask(item, activeTab.id); break;
          case 'gacha': await executeGachaTask(item, activeTab.id); break;
          default: await executeReadTask(item, activeTab.id); break;
        }
      } catch (e) {
        const msg = e?.message || String(e);
        if (msg === 'Stopped') break;
        addLog(`エラー: ${item.title}: ${msg}`, 'error');
      }
    }

    // 最後にミッションページへ戻る
    if (isRunning()) {
      try { await navigateTab(activeTab.id, missionUrl); } catch (_) {}
    }
    addLog('すべてのミッション処理が完了しました。', 'success');
  } catch (error) {
    if (error.message === 'Stopped') {
      addLog('処理が停止されました。', 'warn');
    } else {
      addLog(`全体エラー: ${error.message}`, 'error');
      console.error(error);
    }
  } finally {
    for (const tabId of activeDebuggers.keys()) { await detachDebugger(tabId); }
    for (const tabId of currentTabIds) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    currentTabIds.clear();
    activeDebuggers.clear();
    stopRequested = false;
    updateStatus('idle');
  }
}

// ========================================================
// メッセージ受信リスナー
// ========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getState') {
    sendResponse(state);
    return true;
  } else if (message.action === 'start') {
    if (state.status === 'idle') {
      startAutomation();
      sendResponse({ ok: true });
    }
  } else if (message.action === 'stop') {
    if (state.status === 'running') {
      addLog('停止要求を受信。処理を停止します...', 'warn');
      stopRequested = true;
      updateStatus('idle');
      for (const tabId of currentTabIds) { chrome.tabs.remove(tabId).catch(() => {}); }
      currentTabIds.clear();
      for (const tabId of activeDebuggers.keys()) { chrome.debugger.detach({ tabId }).catch(() => {}); }
      activeDebuggers.clear();
    }
  } else if (message.action === 'log') {
    addLog(message.text, message.type || 'system');

  // === Content Script からの CDP操作リクエスト ===
  } else if (message.action === 'cdpClick') {
    const tabId = sender.tab?.id;
    if (tabId) {
      cdpClick(tabId, message.x, message.y).then(ok => {
        sendResponse({ ok });
      });
      return true; // async response
    }
  } else if (message.action === 'cdpKeyPress') {
    const tabId = sender.tab?.id;
    if (tabId) {
      cdpKeyPress(tabId, message.key).then(ok => {
        sendResponse({ ok });
      });
      return true; // async response
    }
  }
  return false;
});
