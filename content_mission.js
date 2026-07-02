(function() {
  // ===================================================================
  // ミッション一覧パーサー v2.0
  // comicpash.jp / comici系プラットフォーム対応
  // 実際のDOM構造:
  //   a.mission-list-item-link > div > p(タイトル)
  //   progress要素の隣のspan: "1\n/\n10" (改行区切り)
  //   missionStatus=0 は未完了ミッションのみが表示される前提
  // ===================================================================


  function parseProgress(rawText) {
    if (!rawText) return null;
    const normalized = rawText.replace(/\s+/g, '');
    const match = normalized.match(/^(\d+)\/(\d+)$/);
    if (!match) return null;
    return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
  }

  function extractReadCount(title, progress) {
    const rangeMatch = title.match(/(\d+)\s*エピソードから\s*(\d+)\s*エピソードまで/);
    if (rangeMatch) return parseInt(rangeMatch[2], 10);
    if (progress && progress.total > 0) return progress.total;
    const nums = title.match(/\d+/g);
    if (nums && nums.length > 0) return Math.max(...nums.map(n => parseInt(n, 10)));
    return 1;
  }

  function parseMissions() {
    const ITEM_SELECTORS = [
      'a.mission-list-item-link',
      '[class*=mission-list] a[href]',
      '.mission-list a[href]',
      '.mission-item a[href]',
      '[class*=mission-item] a[href]',
      '[class*=mission] li a[href]',
      'ul[class*=mission] a[href]',
    ];

    let items = null;
    let usedSelector = '';

    for (const sel of ITEM_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { items = found; usedSelector = sel; break; }
    }

    if (!items || items.length === 0) {
      console.warn('[Comici Mission] ミッションアイテムが見つかりませんでした。');
      return [];
    }

    console.log('[Comici Mission] セレクタ: ' + usedSelector + ' で ' + items.length + ' 件を検出。');

    const missions = [];

    items.forEach(item => {
      const titleEl =
        item.querySelector('p') ||
        item.querySelector('h3, h4, h5') ||
        item.querySelector('[class*=title]') ||
        item.querySelector('[class*=name]');
      const title = titleEl
        ? titleEl.textContent.trim()
        : item.textContent.trim().split('\n')[0].trim();

      let progressText = '';
      let parsedProgress = null;

      // 確定セレクタ: .mission-list-item-progress-num（"現在/目標" 例 "2/5"）
      // 進捗表示は <a> の外（親 .mission-list-item 内）にある場合があるため親も探索。
      const scope = item.closest('.mission-list-item, li, [class*=mission-list-item]') || item;
      const progressNumEl = item.querySelector('.mission-list-item-progress-num, [class*=progress-num]') ||
        scope.querySelector('.mission-list-item-progress-num, [class*=progress-num]');
      if (progressNumEl) {
        parsedProgress = parseProgress(progressNumEl.textContent.trim());
        if (parsedProgress) {
          progressText = parsedProgress.current + ' / ' + parsedProgress.total;
        }
      }

      // progress要素の隣のspanから取得（comicpash.jp の実際の構造）
      const progressEl = !parsedProgress ? scope.querySelector('progress') : null;
      if (progressEl) {
        const siblingSpan = progressEl.nextElementSibling;
        if (siblingSpan && siblingSpan.tagName === 'SPAN') {
          parsedProgress = parseProgress(siblingSpan.textContent.trim());
          if (parsedProgress) {
            progressText = parsedProgress.current + ' / ' + parsedProgress.total;
          }
        }
        if (!parsedProgress) {
          const val = parseInt(progressEl.getAttribute('value') || '0', 10);
          const max = parseInt(progressEl.getAttribute('max') || '0', 10);
          if (max > 0) {
            parsedProgress = { current: val, total: max };
            progressText = val + ' / ' + max;
          }
        }
      }

      // 汎用フォールバック: spanのX/Y形式テキスト
      if (!parsedProgress) {
        const spans = scope.querySelectorAll('span');
        for (const span of spans) {
          parsedProgress = parseProgress(span.textContent.trim());
          if (parsedProgress) {
            progressText = parsedProgress.current + ' / ' + parsedProgress.total;
            break;
          }
        }
      }

      let isCompleted = false;
      if (parsedProgress) {
        isCompleted = parsedProgress.current >= parsedProgress.total;
      }
      if (item.classList.contains('is-completed') ||
          item.classList.contains('mode-done') ||
          item.classList.contains('completed')) {
        isCompleted = true;
      }

      const url = item.href;
      const totalCount = extractReadCount(title, parsedProgress);
      const alreadyRead = parsedProgress ? parsedProgress.current : 0;
      const readCount = Math.max(totalCount - alreadyRead, 0);

      missions.push({
        title,
        progressText: progressText || (isCompleted ? '達成済み' : '未完了'),
        url,
        isCompleted,
        readCount,
        totalCount
      });
    });

    return missions;
  }

  const allMissions = parseMissions();
  const uncompletedMissions = allMissions.filter(m => !m.isCompleted);

  console.log('[Comici Mission] 全ミッション:', allMissions);
  console.log('[Comici Mission] 未達成ミッション:', uncompletedMissions);

  return uncompletedMissions;
})();
