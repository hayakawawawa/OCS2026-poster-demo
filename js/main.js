// main.js — レイアウト・描画ループと起動処理。最後に読み込みます。
'use strict';
//
// 最後に読み込まれるファイル。ここまでで各ファイルが定義した関数・状態を使って、
//   (1) レイアウト（キャンバスのサイズ合わせ）
//   (2) 毎フレームの描画ループ（frame）
//   (3) 起動処理（一番下の数行が全体のエントリーポイント）
// を担う。
//
/* ---------- layout & loop ---------- */
// layoutAll(): 今見ているビューに応じて必要なキャンバスの寸法を再計算する。
//   デモ: 4つのコンスタレーション・SNRトレース・XYパッド・BERマップ。しくみ: スペクトル図のみ。
function layoutAll(){
  if (currentView === 'demo') { SCH.forEach(layoutScope); layoutTrace(); layoutPad(); layoutMaps(); }
  else layoutHow();
}
// redrawAllStatic(): テーマ変更やフォント読込後など、静的な下地をまとめて描き直す。
//   各種の「汚れフラグ」を立てて次フレームで再描画させる。
function redrawAllStatic(){ SCH.forEach(s => scopes[s].size && drawScopeBg(s)); drawTrace(); padDirty = true; mapsDirty = true; drawHow(); }
// fitTitle(): ヘッダーのタイトルが常に1行で収まる最大の文字サイズへ自動調整する。
//   スマホなど幅が狭いときに折り返さないよう、1行幅を測ってはみ出す分だけ比率で縮める。
function fitTitle(){
  const h1 = $('.ttl h1');
  if (!h1) return;
  // CSS の基準フォントサイズ（上限）。幅の測定前に読む。
  h1.style.fontSize = '';
  const base = parseFloat(getComputedStyle(h1).fontSize);
  h1.style.whiteSpace = 'nowrap';   // 折り返さない
  // いったん十分小さいフォントにしてページを横に溢れさせない状態で「使える幅」を測る
  //   （基準サイズのまま測ると、はみ出しで親要素の幅自体が広がり誤測定になるため）。
  h1.style.fontSize = '10px';
  const avail = h1.parentElement.clientWidth;        // .ttl の内側幅（溢れていないので正しい）
  h1.style.display = 'inline-block';                 // 内容幅にフィットさせて実寸を測る
  const wPerPx = h1.getBoundingClientRect().width / 10; // フォント 1px あたりの 1 行テキスト幅
  h1.style.display = '';                             // block へ戻す
  if (avail <= 0 || wPerPx <= 0){ h1.style.fontSize = ''; return; }
  // 収まる最大フォントサイズ（1px の安全マージン、下限 10px）。基準サイズに収まるならそのまま。
  const fit = (avail - 1) / wPerPx;
  h1.style.fontSize = (fit < base) ? Math.max(10, fit) + 'px' : '';
}
// fitFirstScreen(): スマホ縦で「ヘッダー＋4画面＋IQスキュー操作」を1画面（スクロールなし）に収める。
//   IQスキューの最終行（τボタン）の下端が画面からはみ出す分だけ、XYパッド→4画面の順に縮めて引き上げる。
//   制御は CSS 変数（--pad-cap / --screens-h）経由。layoutPad が #pad のインライン幅を消すため、インライン指定は使わない。
function fitFirstScreen(){
  const root = document.documentElement;
  // スマホ縦（≤520px）以外は上書きを解除してCSS既定サイズへ戻す。
  if (!matchMedia('(max-width: 520px)').matches){
    if (root.style.getPropertyValue('--pad-cap') || root.style.getPropertyValue('--screens-h')){
      root.style.removeProperty('--pad-cap'); root.style.removeProperty('--screens-h');
      layoutPad(); SCH.forEach(layoutScope);
    }
    return;
  }
  // デモが非表示のとき（しくみビュー）は測れないので何もしない（デモに戻れば再計算される）。
  if ($('#view-demo').hidden) return;
  const btns = pad.closest('.blk').querySelector('.btns'); // IQスキューのボタン行（この区画の最終行）
  if (!btns) return;
  // いったん上書きを外し、既定サイズでの自然な配置を測る。
  root.style.removeProperty('--pad-cap'); root.style.removeProperty('--screens-h');
  // τボタン下端の“ページ最上部からの距離”と、使える画面高(innerHeight)との差（10pxの余白込み）。
  let over = btns.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 10;
  if (over <= 0){ layoutPad(); SCH.forEach(layoutScope); return; } // 既に1画面に収まっている
  // (1) XYパッドを縮める（下限130px）。正方なので高さ＝幅、超過分を1:1で詰められる。
  const padW = pad.getBoundingClientRect().width, padNew = Math.max(130, padW - over);
  root.style.setProperty('--pad-cap', padNew + 'px');
  over -= (padW - padNew);
  // (2) まだはみ出すなら4画面の高さを詰める（下限190px）。
  if (over > 1){
    const scH = $('.screens').getBoundingClientRect().height;
    root.style.setProperty('--screens-h', Math.max(190, scH - over) + 'px');
  }
  // 新サイズをキャンバスへ反映（再描画）。
  layoutPad(); SCH.forEach(layoutScope);
}
// 要素のサイズ変化（画面回転・ウィンドウリサイズ等）を監視して、自動でレイアウトし直す。
const ro = new ResizeObserver(() => layoutAll());
// 監視対象: body 全体＋各スコープ画面＋スペクトル図とトレースの親要素。
ro.observe(document.body); $$('.screen').forEach(el => ro.observe(el)); ro.observe(howCv.parentElement); ro.observe(traceCv.parentElement);
// リサイズ時はタイトルを測り直す。1画面フィットは“横幅が変わったときだけ”再計算する
//   （スマホで上下スクロール中に URL バーが伸縮して高さだけ変わると、パッドが伸縮して見えるのを防ぐ）。
let lastW = window.innerWidth;
addEventListener('resize', () => {
  fitTitle();
  if (window.innerWidth !== lastW){ lastW = window.innerWidth; fitFirstScreen(); }
});
// Webフォント確定のタイミングはブラウザ差があるため、フォント読込完了イベントと load でも測り直す。
if (document.fonts) document.fonts.addEventListener('loadingdone', () => { fitTitle(); fitFirstScreen(); });
addEventListener('load', () => { fitTitle(); fitFirstScreen(); });

// frame(now): requestAnimationFrame で毎フレーム呼ばれる描画ループ。now は高精度時刻[ms]。
function frame(now){
  // 前フレームからの経過秒 dt（最大0.1秒で頭打ち＝タブ復帰時の飛びを防ぐ）。
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  // ゆらぎ再現(ドリフト)が有効ならスキューを少しずつ動かす。
  if (drift) driftStep(dt);
  if (currentView === 'demo') {
    // 新しいシミュレーション結果が来ていれば、点群とトレースを描き直す。
    if (newData) { SCH.forEach(drawScopePts); drawTrace(); newData = false; }
    // 文字（BER等の読み値）は負荷軽減のため約180ms間隔で更新。
    if (now - lastText > 180) { updateReadouts(); lastText = now; }
    // XYパッドは「汚れフラグ」が立っているとき、または指ヒント表示中（padHintK>0）は毎フレーム再描画。
    //   後者で指・波紋のアニメーションを動かし続ける（padHintK は pad.js の共有変数）。
    if (padDirty || padHintK > 0.005) { padDirty = false; drawPad(); }
    if (mapsDirty) drawMaps();
  } else if (howAnim < 1) {
    // 「しくみ」ビューでは、方式切替アニメが進行中のときだけ再描画する。
    howAnim = Math.min(1, howAnim + dt / 0.55); if (howAnim >= 1) howAnimFrom = null; drawHow();
  }
  // 次フレームを予約（ループ継続）。
  requestAnimationFrame(frame);
}

/* ---------- start ---------- */
// ここからが起動処理（アプリの開始点）。
// テーマ適用 → UIを状態に同期。
applyTheme(); syncUI();
// URLハッシュに応じて初期ビューを表示（#how ならしくみ、それ以外はデモ）。
showView(location.hash === '#how' ? 'how' : 'demo');
// タイトルを1行に収める初回調整。
fitTitle();
// Webフォントの読み込みが終わったら、文字を含む下地を描き直す（フォント反映のため）。フォント確定後にタイトルと1画面フィットも測り直す。
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { redrawAllStatic(); fitTitle(); fitFirstScreen(); });
// シミュレーションを開始（Worker 起動、ダメならメインスレッドにフォールバック）。
initSim();
// 描画ループ開始。
requestAnimationFrame(frame);
