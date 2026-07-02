# CLAUDE.md

このファイルは、Claude Code がこのリポジトリで作業する際のガイドです。

## プロジェクト概要

Chrome 拡張機能（Manifest V3）。コミチ系マンガプラットフォームのミッションページを起点に、
作品の閲覧・お気に入り登録・ガチャなどの一連のブラウザ操作を自動化する個人用ツール。

ビルド工程はなく、素の JavaScript のみで構成される。`chrome://extensions` から
「パッケージ化されていない拡張機能を読み込む」でこのディレクトリを直接読み込んで動作させる。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `manifest.json` | 拡張機能定義（MV3、service worker、popup） |
| `background.js` | 中枢。タスクキューの構築、アクティブタブの直列遷移制御、各タスクの進行管理、CDP（chrome.debugger）フォールバック |
| `content_mission.js` | ミッション一覧ページの DOM を解析し、未達成ミッションの配列を返すパーサー（executeScript で単発実行） |
| `content_action.js` | 各ページに注入される操作スクリプト。ビューアーのページ送り（横読み/縦読み）、お気に入り、ガチャ操作を実装 |
| `popup.html` / `popup.js` | 開始/停止 UI とログ表示 |

## アーキテクチャの要点

- **background.js が司令塔**: 全ミッションは**アクティブタブ1本で1件ずつ直列実行**し、
  完了後にミッションページへ戻る。裏タブでの並列実行は Chrome のタイマー/rAF
  スロットリングでページ送りが進まないため使わない。
  複数話の連鎖遷移やページ再読込は background 側が制御する。
  content script はページ再読込で破棄されるため、「このページの1話分を処理して結果を報告する」
  ことだけに責任を持つ。
- **タブ遷移は `navigateTab` を使う**: `tabs.update` 直後に `waitTabComplete` を呼ぶと
  旧ページの `complete` を拾って遷移前に解決し、旧ページへ注入してしまう競合がある。
  `navigateTab` は loading→complete を見届けてから戻る。
- **お気に入りミッション**: 既にお気に入り済みなら触らず維持。未登録なら登録して
  ミッションを計上させた後、同じ要素を再クリックして解除する（お気に入り一覧を汚さない）。
  実行場所はビューアー最終ページの `#xCVLastPageFavBtn`（登録状態は `#xCVLastPageFavLabel` /
  `#xCVLastPageFavedLabel` の display 切替で判定）。シリーズページ遷移は
  ボタンが見つからない場合のフォールバックのみ。
- **次話ボタンのセレクタに `[class*="last-btn"]` を使わない**: 最終ページのお気に入り
  ボタン（`.-cv-last-btn.mode-fav`）等も一致し、同じ話を繰り返すバグの原因になった。
  `.-cv-last-btn.mode-next` のように mode-next を必須にする。加えて background 側は
  遷移後 URL の visited チェックで同話ループを検出して中断する。
- **メッセージプロトコル**: background → content は `executeRead` / `executeBookmark` /
  `executeGacha` / `executeExternalRead` / `checkViewer`。content → background は
  `actionComplete`（`task` と `status` を含む）と `log`。
- **ページ送りドライバー**: 横読みはシークバー操作が本命。高速パス（先頭→最終ページへ一括スライド）
  を最初に試し、ダメなら1段ずつのシークバー送り → 合成キー → CDP キー送りへ順にフォールバック。
  前進はページ番号表示で検証する。
- **範囲ミッション**: 「XエピソードからYエピソードまで」形式は対象話が固定なので、
  進捗の残数ではなく総話数分を第1話から読む（`parseMissionTypes` 参照）。
- **セレクタは複数候補方式**: サイト側の DOM 変更に備え、各要素はセレクタ配列を順に試す。
  実機で確認済みの主要セレクタ: `#xCVSeekBar`（シークバー）、`.-cv-f-page-current` /
  `.-cv-f-page-total`（ページ番号）、`#xCVLastPageNextBtn`（次話ボタン）、
  `a.mission-list-item-link`（ミッション項目）。

## 開発時の注意

- 変更後は `chrome://extensions` で拡張機能をリロードしてから動作確認する。
- `content_action.js` は多重注入ガード（`window.hasComiciActionRun`）を持つ。
- 速度チューニング定数は `content_action.js` 冒頭にまとまっている。
- ログは background の `addLog` に集約され、popup に転送される（content からは
  `[CS]` プレフィックス付き）。
