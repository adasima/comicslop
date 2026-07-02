(function() {
  if (window.hasComiciActionRun) return;
  window.hasComiciActionRun = true;

  console.log('[Comici Automator] Action content script injected.');

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 速度チューニング（小さいほど速いが、描画/計上が追いつかないリスク）
  const SEEK_SWEEP_DWELL_MS = 15;  // 横読み高速パス: スライド1チャンクごとの待ち
  const SEEK_DWELL_MS = 30;        // 横読み: シークバー1段スライド後の待ち（計上トリガー本命）
  const KEY_DWELL_MS = 30;         // 横読み: キー送り後の待ち（フォールバック）
  const VERT_STEP_RATIO = 0.95;    // 縦読み: 1ステップのスクロール量（画面高比）
  const VERT_MAX_WAIT_MS = 80;     // 縦読み: 画像ロード待ちの上限

  function addLogToBg(text) {
    chrome.runtime.sendMessage({ action: 'log', text: `[CS] ${text}`, type: 'system' }).catch(() => {});
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  // ========================================================
  // ビューアー判定・状態取得
  // ========================================================
  function getSeekbar() {
    return document.querySelector('#xCVSeekBar') ||
           document.querySelector('input[type="range"][class*="seek"]') ||
           document.querySelector('.-cv-f-seek input[type="range"]');
  }

  function isViewerPage() {
    return !!(getSeekbar() ||
      document.querySelector('.-cv-f-page-current, .-cv-f-page-total, #xCVLastPageNextBtn') ||
      document.querySelector('canvas[class*="cv"], [class*="cv-viewer"]'));
  }

  function isHorizontalViewer() {
    // 横読みはシークバー(input[type=range])を持つ。縦読みは持たない。
    return !!getSeekbar();
  }

  // ページ番号 { current, total } を取得。Comici系は current/total が別要素。
  function getViewerPageInfo() {
    const curEl = document.querySelector('.-cv-f-page-current, [class*="page-current"], [class*="pageCurrent"]');
    const totEl = document.querySelector('.-cv-f-page-total, [class*="page-total"], [class*="pageTotal"]');
    if (curEl && totEl) {
      const cur = parseInt((curEl.textContent || '').replace(/[^\d]/g, ''), 10);
      const tot = parseInt((totEl.textContent || '').replace(/[^\d]/g, ''), 10);
      if (!isNaN(cur) && !isNaN(tot) && tot > 0) return { current: cur, total: tot };
    }
    // フォールバック: "3 / 25" 連結形式
    const dedicated = document.querySelector('.-cv-page-num, [class*="page-num"], [class*="pageNum"]');
    if (dedicated) {
      const m = dedicated.textContent.trim().match(/(\d+)\s*\/\s*(\d+)/);
      if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    const els = document.querySelectorAll('span, div, p');
    for (const el of els) {
      const m = el.textContent.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    return null;
  }

  // 注意: `[class*="last-btn"]` は使わない。最終ページのお気に入りボタン
  // （.-cv-last-btn.mode-fav）や「最初から読む」も一致してしまい、
  // 次話のつもりで同じ話の先頭へ戻るバグの原因になった。mode-next 必須。
  function getLastPageButton() {
    const btn = document.querySelector('#xCVLastPageNextBtn, .last_page_next_button, .-cv-last-btn.mode-next');
    return isVisible(btn) ? btn : null;
  }

  function isReadingComplete() {
    if (getLastPageButton()) return true;
    const info = getViewerPageInfo();
    if (info && info.total > 0 && info.current >= info.total) return true;
    return false;
  }

  // 課金/レンタルUI検出（無料範囲外の停止用）
  function isPaywall() {
    if (isViewerPage()) return false; // ビューアーが開けているなら無料
    const buyEl = document.querySelector(
      '[class*="purchase"], [class*="rental"], [class*="mode-buy"], [class*="buy-btn"], [class*="coin"]'
    );
    if (buyEl && isVisible(buyEl)) return true;
    const bodyText = document.body.innerText || '';
    return /この作品を購入|レンタルする|コインが必要|チケットを使って読む|購入して読む/.test(bodyText);
  }

  // ========================================================
  // オーバーレイ・操作説明を閉じる
  // ========================================================
  function closeOnboarding() {
    const instOk = document.querySelector('.x-cv-inst-ok, [class*="inst-ok"]');
    if (isVisible(instOk)) { instOk.click(); return true; }

    const banner = document.querySelector('.ga-viewer-sign-up-banner, .-cv-pr-link.x-cv-pr-link');
    if (banner && banner.closest('body')) {
      const parent = banner.parentElement;
      if (parent) parent.style.display = 'none';
      banner.style.display = 'none';
      return true;
    }

    const candidates = document.querySelectorAll('button, span, div, a');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (text === '閉じる' || text === 'スキップ' || text === 'チュートリアルを閉じる' ||
          text === 'はじめから読む' || text === 'OK') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 300 && rect.height < 100) { el.click(); return true; }
      }
    }
    return false;
  }

  async function closeOverlaysRepeatedly(times = 5) {
    for (let i = 0; i < times; i++) {
      if (closeOnboarding()) await sleep(150);
      else break;
    }
  }

  // ========================================================
  // シリーズURL検索（お気に入り登録の後続用）
  // ========================================================
  function findSeriesUrl() {
    const sels = [
      'a.ep-h-main-h-series', 'a.ep-h-close', 'a[href*="/series/"]',
      'a[href*="/title/"]', 'a[href*="/titles/"]', 'a[href*="/works/"]',
      'a[href*="/manga/"]', '.breadcrumb a[href]', '#xCVSeriesBtn a', '.series-link',
    ];
    for (const sel of sels) {
      const links = document.querySelectorAll(sel);
      for (const link of links) {
        if (link && link.href && !link.href.includes('/episodes/') && link.href.startsWith('http')) {
          return link.href;
        }
      }
    }
    return null;
  }

  // ========================================================
  // Background.js への CDP キー操作リクエスト（合成イベントが効かない時のフォールバック）
  // ========================================================
  function requestCdpKeyPress(key) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      try {
        chrome.runtime.sendMessage({ action: 'cdpKeyPress', key }, (resp) => {
          finish(resp && resp.ok);
        });
      } catch (_) { finish(false); }
      setTimeout(() => finish(false), 1500);
    });
  }

  // ========================================================
  // ページ送りドライバー（横読み）
  // 各ドライバーは「1見開き分前進を試みる」。実際に進んだかは呼び出し側がページ番号で検証。
  // ========================================================
  function driveSyntheticKey() {
    const opts = {
      key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    for (const target of [document, document.documentElement, document.body, window]) {
      if (!target) continue;
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', opts));
        target.dispatchEvent(new KeyboardEvent('keyup', opts));
      } catch (_) {}
    }
    return Promise.resolve(true);
  }

  async function driveCdpKey() {
    return requestCdpKeyPress('ArrowLeft');
  }

  function setSeekbarValue(sb, val) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(sb, String(val));
    sb.dispatchEvent(new Event('input', { bubbles: true }));
    sb.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 人間のドラッグ相当: 現在値から端まで数チャンクの input イベントで一気にスライド
  async function sweepSeekbarTo(sb, endVal, chunks = 10) {
    const start = Number(sb.value);
    if (start === endVal) { setSeekbarValue(sb, endVal); return; }
    for (let i = 1; i <= chunks; i++) {
      const v = Math.round(start + (endVal - start) * (i / chunks));
      setSeekbarValue(sb, v);
      await sleep(SEEK_SWEEP_DWELL_MS);
    }
  }

  // 高速パス: シークバーを先頭から最終ページ端へ一気にスライドして読了させる。
  // 人間がスライダーを1→最終ページへドラッグする操作と同等で、数秒で計上される。
  // 成功すれば true。方向が逆だった場合は反対端で1回だけ再試行。
  async function tryFastSeekbarRead() {
    const sb = getSeekbar();
    if (!sb) return false;
    const min = Number(sb.min || 1);
    const max = Number(sb.max || sb.value);
    if (!(max > min)) return false;
    const cur = Number(sb.value);
    // 先頭ページでは value は min 寄り(LTR)か max 寄り(RTL)。遠い方の端が最終ページ。
    let end = (cur - min) >= (max - cur) ? min : max;
    for (let attempt = 0; attempt < 2; attempt++) {
      await sweepSeekbarTo(sb, end);
      // 完了状態（最終ページ表示 or 次話ボタン出現）の反映を待つ
      for (let w = 0; w < 12; w++) {
        if (isReadingComplete()) return true;
        await sleep(100);
      }
      end = (end === max) ? min : max;
    }
    return isReadingComplete();
  }

  // シークバーの value を1段階、最終ページ方向へ動かす。
  // seekDir: -1=前進でvalue減少(RTL), +1=前進でvalue増加(LTR)。未確定(0)なら現在値から推測。
  let seekDir = 0;
  function driveSeekbar() {
    const sb = getSeekbar();
    if (!sb) return Promise.resolve(false);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const cur = Number(sb.value);
    const min = Number(sb.min || 1);
    const max = Number(sb.max || cur);
    const step = Number(sb.step) > 0 ? Number(sb.step) : 1;
    if (seekDir === 0) {
      // 先頭では value が max 寄り(RTL)か min 寄り(LTR)か。前進方向を推測。
      seekDir = (cur - min) >= (max - cur) ? -1 : 1;
    }
    let target = cur + seekDir * step;
    target = Math.max(min, Math.min(max, target));
    try {
      setter.call(sb, String(target));
      sb.dispatchEvent(new Event('input', { bubbles: true }));
      sb.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) { return Promise.resolve(false); }
    return Promise.resolve(true);
  }

  // ========================================================
  // 新エピソード開始状態になるまで待つ（前話の残留状態を排除）
  // ========================================================
  async function waitFreshEpisodeStart(horizontal) {
    for (let w = 0; w < 12; w++) {
      const info = getViewerPageInfo();
      const btnGone = !getLastPageButton();
      if (horizontal) {
        // 先頭 = current が min 付近（見開きで1〜2）かつ次話ボタン非表示
        const atStart = !info || info.current <= Math.min(2, info.total || 2);
        if (atStart && btnGone) return;
      } else {
        // 縦読みは先頭にスクロールを戻して開始
        if (window.scrollY <= 4 && btnGone) return;
        if (window.scrollY > 4) window.scrollTo({ top: 0, behavior: 'instant' });
      }
      await sleep(150);
    }
    if (!horizontal) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ========================================================
  // 横読みエピソードを最後まで読み進める（1話分）
  // ドライバーを合成キー→CDPキー→シークバーの順に試し、
  // ページ番号で前進を検証。効いた方法を固定。停滞したら次の方法へ。
  // ========================================================
  async function readHorizontalEpisode() {
    await closeOverlaysRepeatedly();
    await sleep(150);

    // 高速パス: シークバーを先頭→最終ページへ一気にスライド（数秒で読了）
    if (await tryFastSeekbarRead()) {
      addLogToBg('横読み: シークバージャンプで読了。');
      return { complete: true, nextBtn: getLastPageButton() };
    }
    addLogToBg('横読み: ジャンプで完了確認できず。1ページずつ送りにフォールバック。');

    // シークバーのスライド（1→最終）が計上トリガー本命。これを主軸にし、
    // 効かない場合のみキー送りにフォールバック。
    const drivers = [
      { name: 'seekbar', fn: driveSeekbar, dwell: SEEK_DWELL_MS },
      { name: 'synthKey', fn: driveSyntheticKey, dwell: KEY_DWELL_MS },
      { name: 'cdpKey', fn: driveCdpKey, dwell: KEY_DWELL_MS },
    ];
    let di = 0;
    let seekFlipped = false;

    const readSeekVal = () => { const sb = getSeekbar(); return sb ? Number(sb.value) : null; };
    let info = getViewerPageInfo();
    let lastCurrent = info ? info.current : 0;
    let lastSeekVal = readSeekVal();
    let total = info ? info.total : 0;
    let stall = 0;
    let hasAdvanced = false;    // 実際に1コマでも送ったか（誤即完了を防ぐ）
    const STALL_ESCALATE = 3;   // この回数進まなければ次のドライバーへ
    const STALL_GIVEUP = 14;    // 全ドライバーでこの回数進まなければ終了
    const MAX_STEPS = 3000;
    const startedAt = Date.now();
    const MAX_MS = 6 * 60 * 1000;

    for (let step = 0; step < MAX_STEPS; step++) {
      // 1コマでも送った後にのみ完了を受理（前話の残留状態での誤完了を防止）。
      // ページ総数が1〜2の極短編は最初から完了扱いでよい。
      if ((hasAdvanced || (total > 0 && total <= 2)) && isReadingComplete()) break;
      if (Date.now() - startedAt > MAX_MS) { addLogToBg('横読み: 時間上限で打ち切り'); break; }

      await drivers[di].fn();
      await sleep(drivers[di].dwell); // レンダラ過負荷回避＋描画待ち（連打しない）

      info = getViewerPageInfo();
      const cur = info ? info.current : null;
      if (info && info.total > 0) total = info.total;
      const seekVal = readSeekVal();

      // 前進判定: ページ番号が読めればそれを厳密に使う（表示が凍結していても
      // シークバー値だけ動く誤検知を避ける）。読めない時のみシークバー値の変化で代替。
      let advanced;
      if (cur !== null) advanced = cur > lastCurrent;
      else advanced = (seekVal !== null && seekVal !== lastSeekVal);

      if (cur !== null) lastCurrent = Math.max(lastCurrent, cur);
      lastSeekVal = seekVal;

      if (advanced) {
        hasAdvanced = true;
        stall = 0;
        if (step % 20 === 0) addLogToBg(`前進中 ${cur !== null ? cur : '?'}/${total || '?'} (${drivers[di].name})`);
      } else {
        stall++;
        // シークバー方式で進まない場合、方向を一度だけ反転して再試行
        if (drivers[di].name === 'seekbar' && !seekFlipped && stall >= 2) {
          seekDir = -seekDir; seekFlipped = true; stall = 0;
        } else if (stall >= STALL_ESCALATE && di < drivers.length - 1) {
          di++; stall = 0;
          addLogToBg(`前進せず。ドライバーを ${drivers[di].name} に切替`);
        } else if (stall >= STALL_GIVEUP) {
          addLogToBg('横読み: どの方法でも前進せず打ち切り');
          break;
        }
      }

      if (step % 10 === 0) closeOnboarding();
    }

    const complete = isReadingComplete();
    return { complete, nextBtn: getLastPageButton() };
  }

  // ========================================================
  // 縦読みエピソードを最後まで読み進める（1話分）
  // window を1画面高ずつスクロールし、各ステップで画像ロードを待つ。
  // 全高は固定なので最下部到達は確実。飛ばし読みにならないよう刻む。
  // ========================================================
  // ビューポート内の画像がロード完了するまで待つ（固定待ちより速い・確実）
  async function waitImagesInView(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const imgs = Array.from(document.images).filter(im => {
        const r = im.getBoundingClientRect();
        return r.width > 0 && r.bottom > -50 && r.top < window.innerHeight + 50;
      });
      if (imgs.length > 0 && imgs.every(im => im.complete && im.naturalHeight > 0)) return;
      await sleep(50);
    }
  }

  async function readVerticalEpisode() {
    await closeOverlaysRepeatedly();
    await sleep(150);

    const scrollStep = Math.floor(window.innerHeight * VERT_STEP_RATIO);
    let prevY = -1;
    let stall = 0;
    let total = (getViewerPageInfo() || {}).total || 0;
    const MAX_STEPS = 4000;
    const startedAt = Date.now();
    const MAX_MS = 10 * 60 * 1000;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (isReadingComplete()) break;
      if (Date.now() - startedAt > MAX_MS) { addLogToBg('縦読み: 時間上限で打ち切り'); break; }

      window.scrollBy({ top: scrollStep, behavior: 'instant' });
      await waitImagesInView(VERT_MAX_WAIT_MS); // 画像ロード完了で早期抜け

      const y = window.scrollY;
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      const info = getViewerPageInfo();
      if (info && info.total > 0) total = info.total;
      if (step % 15 === 0) {
        closeOnboarding();
        if (info) addLogToBg(`縦読み ページ ${info.current}/${total || '?'}`);
      }

      if (y >= maxY - 4) {
        // 最下部到達。最終画像＋次話ボタンの出現を待つ。
        await sleep(500);
        if (isReadingComplete()) break;
        stall++;
        if (stall > 5) break;
        await sleep(300);
      } else if (Math.abs(y - prevY) < 2) {
        stall++;
        if (stall > 8) { addLogToBg('縦読み: スクロール停滞で打ち切り'); break; }
        await sleep(250);
      } else {
        stall = 0;
      }
      prevY = y;
    }

    const atBottom = window.scrollY >= (document.documentElement.scrollHeight - window.innerHeight - 8);
    return { complete: isReadingComplete() || atBottom, nextBtn: getLastPageButton() };
  }

  // ========================================================
  // エピソード閲覧フロー（このページの1話分を読み切って報告）
  // 複数話の連鎖遷移は background.js が制御する（ページ再読込で
  // content script が破棄されても確実に次話へ進めるため）。
  // ========================================================
  // ========================================================
  // 最終ページのお気に入りボタン操作（画面遷移なしでお気に入りミッションを計上）
  // 実機確定（comicride.jp）: ボタン #xCVLastPageFavBtn（.-cv-last-btn.mode-fav）、
  // 未登録時は #xCVLastPageFavLabel、登録済時は #xCVLastPageFavedLabel が表示される。
  // ========================================================
  async function lastPageFavoriteFlow() {
    const findBtn = () =>
      document.querySelector('#xCVLastPageFavBtn, .last_page_fav_button, .-cv-last-btn.mode-fav');
    const isFaved = () => {
      const favedLabel = document.querySelector('#xCVLastPageFavedLabel');
      if (favedLabel) return window.getComputedStyle(favedLabel).display !== 'none';
      const b = findBtn();
      return !!b && (b.classList.contains('mode-faved') || b.classList.contains('is-favorited'));
    };
    const btn = findBtn();
    if (!btn) return 'notfound';
    if (isFaved()) {
      // 既にお気に入り済み → 読了だけで達成するため手を付けない
      return 'already';
    }
    // 未登録 → 登録してミッションを計上させ、同じ要素を再度発火して解除
    btn.click();
    let registered = false;
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      if (isFaved()) { registered = true; break; }
    }
    addLogToBg(registered ? 'お気に入り登録を確認。解除します。' : 'お気に入り登録の反映未確認。解除を試行します。');
    await sleep(400); // サーバー側の計上待ち
    const btnAgain = findBtn();
    if (btnAgain) {
      btnAgain.click();
      await sleep(400);
    }
    return 'success';
  }

  async function readEpisodeFlow(withBookmark = false) {
    await sleep(200); // ビューアー初期化待ち（background側でも読み込み待ち済み）
    await closeOverlaysRepeatedly();

    if (isPaywall()) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'readEpisode', count: 0, status: 'paywall', message: '無料範囲外' });
      return;
    }

    let ready = false;
    for (let w = 0; w < 27; w++) {
      if (isViewerPage()) { ready = true; break; }
      if (isPaywall()) break;
      await sleep(300);
    }
    if (!ready) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'readEpisode', count: 0, status: 'error', message: 'ビューアー未検出' });
      return;
    }

    const horizontal = isHorizontalViewer();

    // 前エピソードの最終状態（最終ページ/次話ボタン）が残っていると
    // 誤って即完了判定してしまう。先頭ページ相当に落ち着くまで待つ。
    await waitFreshEpisodeStart(horizontal);

    addLogToBg(`読了中（${horizontal ? '横読み' : '縦読み'}）...`);

    const result = horizontal ? await readHorizontalEpisode() : await readVerticalEpisode();

    const nextBtn = result.nextBtn || getLastPageButton();
    // 現在ページと同じURLへの「次話」は遷移にならない（同話ループ防止）
    let nextUrl = (nextBtn && nextBtn.href && /^https?:/.test(nextBtn.href)) ? nextBtn.href : null;
    if (nextUrl === window.location.href) nextUrl = null;
    const seriesUrl = findSeriesUrl();

    // お気に入りミッションは最終ページ上のボタンで完結させる（シリーズページ遷移を省く）
    let bookmarkStatus = null;
    if (withBookmark) {
      try { bookmarkStatus = await lastPageFavoriteFlow(); }
      catch (e) { bookmarkStatus = 'error'; addLogToBg(`最終ページお気に入り失敗: ${e.message}`); }
      addLogToBg(`最終ページお気に入り: ${bookmarkStatus}`);
    }

    addLogToBg(result.complete ? '1話読了完了。' : '最終ページ未確定（読了扱い）。');
    chrome.runtime.sendMessage({
      action: 'actionComplete', task: 'readEpisode',
      count: 1, complete: result.complete,
      nextUrl, nextBtnPresent: !!nextBtn, seriesUrl, bookmarkStatus,
    });
  }

  // ========================================================
  // 外部サイト読了フロー
  // ========================================================
  async function executeExternalReadFlow() {
    await sleep(800);
    if (isViewerPage()) { await readEpisodeFlow(false); return; }

    const episodeSelectors = [
      'a.mission-list-item-link[href*="/episodes/"]',
      'a[href*="/episodes/"]',
      '.episode-list a[href]', '[class*="episode"] a[href]',
      '.series-ep-list a[href]', 'a.series-ep-list-item',
      '[class*="ep-list"] a[href]',
    ];
    let firstEpLink = null;
    for (const sel of episodeSelectors) {
      const links = document.querySelectorAll(sel);
      for (const link of links) {
        if ((link.href || '').includes('/episodes/')) { firstEpLink = link; break; }
      }
      if (firstEpLink) break;
    }
    if (firstEpLink && firstEpLink.href) {
      addLogToBg(`外部サイトエピソードに移動: ${firstEpLink.href}`);
      window.location.href = firstEpLink.href;
    } else {
      addLogToBg('外部サイトでエピソードリンクが見つかりませんでした。');
      chrome.runtime.sendMessage({
        action: 'actionComplete', task: 'readEpisode', count: 0,
        status: 'error', message: 'No episode link found on external site.'
      });
    }
  }

  // ========================================================
  // お気に入り登録＆即時解除フロー
  // ========================================================
  async function executeBookmarkFlow() {
    await sleep(300);
    const favSelectors = [
      'a.series-h-fav', 'button.series-h-fav', '[class*="series-h-fav"]',
      '[class*="fav-btn"]', 'a[class*="favorite"]', 'button[class*="favorite"]',
      'a[class*="bookmark"]', 'button[class*="bookmark"]',
      '[data-action="favorite"]', '[data-action="bookmark"]',
    ];
    // クリックで要素が再描画されることがあるため、状態確認のたびに再取得する
    const findFavBtn = () => {
      for (const sel of favSelectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };
    const checkFaved = () => {
      const b = findFavBtn();
      return !!b && (
        b.classList.contains('mode-faved') || b.classList.contains('is-favorited') ||
        b.classList.contains('active') || b.getAttribute('aria-pressed') === 'true');
    };
    const favBtn = findFavBtn();
    if (!favBtn) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'bookmark', status: 'error', message: 'Favorite button not found.' });
      return;
    }
    try {
      if (checkFaved()) {
        // 既にお気に入り済み → 1話読了で達成するため手を付けない
        chrome.runtime.sendMessage({ action: 'actionComplete', task: 'bookmark', status: 'already' });
        return;
      }
      // 未登録 → 登録してミッションを計上させたあと、同じ要素を再度発火して解除する
      favBtn.click();
      let registered = false;
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        if (checkFaved()) { registered = true; break; }
      }
      addLogToBg(registered ? 'お気に入り登録を確認。解除します。' : 'お気に入り登録の反映未確認。解除を試行します。');
      await sleep(700); // サーバー側の計上待ち
      const btnAgain = findFavBtn();
      if (btnAgain) {
        btnAgain.click();
        await sleep(700);
      }
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'bookmark', status: 'success' });
    } catch (e) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'bookmark', status: 'error', message: e.message });
    }
  }

  // ========================================================
  // ガチャ実行フロー
  // ========================================================
  function isGachaAvailable() {
    const gachaBtn = document.querySelector('a.gacha-btn.mode-user');
    const shareBtn = document.querySelector('a.gacha-panel-btn.mode-share');
    if (!gachaBtn && !shareBtn) return false;
    if (gachaBtn) {
      const btnText = gachaBtn.textContent.trim();
      if (btnText.includes('明日') || btnText.includes('終了') ||
          btnText.includes('制限') || btnText.includes('上限')) return false;
    }
    return true;
  }

  async function executeGachaFlow() {
    await sleep(800);
    if (!isGachaAvailable()) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'skipped', message: 'Gacha not available.' });
      return;
    }
    const gachaBtn = document.querySelector('a.gacha-btn.mode-user');
    const shareBtnInitial = document.querySelector('a.gacha-panel-btn.mode-share');
    if (!gachaBtn && shareBtnInitial) { await handleShareAndRetry(shareBtnInitial); return; }
    if (!gachaBtn) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'skipped', message: 'No gacha button.' });
      return;
    }
    try {
      gachaBtn.click();
      let shareBtn = null;
      for (let attempt = 0; attempt < 14; attempt++) {
        await sleep(500);
        shareBtn = document.querySelector('a.gacha-panel-btn.mode-share');
        if (shareBtn) break;
        const resultPanel = document.querySelector('.gacha-panel, .gacha-result, .mode-result');
        if (resultPanel) { await sleep(800); shareBtn = document.querySelector('a.gacha-panel-btn.mode-share'); if (!shareBtn) break; }
      }
      if (shareBtn) { await handleShareAndRetry(shareBtn); }
      else { chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'success' }); }
    } catch (e) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'error', message: e.message });
    }
  }

  async function handleShareAndRetry(shareBtn) {
    try {
      shareBtn.click();
      await sleep(1500);
      const retryBtn = document.querySelector('a.gacha-btn.mode-user');
      if (retryBtn) { retryBtn.click(); await sleep(3500); }
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'success' });
    } catch (e) {
      chrome.runtime.sendMessage({ action: 'actionComplete', task: 'gacha', status: 'error', message: e.message });
    }
  }

  // ========================================================
  // メッセージ受信リスナー
  // ========================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'executeRead') {
      readEpisodeFlow(!!message.bookmark);
      sendResponse({ status: 'started' });
    } else if (message.action === 'executeBookmark') {
      executeBookmarkFlow();
      sendResponse({ status: 'started' });
    } else if (message.action === 'executeGacha') {
      executeGachaFlow();
      sendResponse({ status: 'started' });
    } else if (message.action === 'executeExternalRead') {
      executeExternalReadFlow();
      sendResponse({ status: 'started' });
    } else if (message.action === 'checkViewer') {
      sendResponse({ isViewer: isViewerPage() });
    }
  });
})();
