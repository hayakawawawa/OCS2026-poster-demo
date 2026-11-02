// theme.js — 外観まわり（配色トークンの読み取り・自動/ダーク/ライト切替・全画面・スリープ防止）
'use strict';
/* ---------- tokens ---------- */
// 配色は CSS の :root に定義した変数（--bg や --sA など）を「真実の情報源」にしている。
// JS 側（Canvas 描画）はその値を文字列で読み取って使うため、ここで一括取得して T にまとめる。
// T: 現在のテーマの色一式。テーマやOSのダーク設定が変わるたび readTokens() で読み直す。
let T = {};
// readTokens: getComputedStyle で :root の CSS 変数を読み、描画で使う色オブジェクト T を作る。
function readTokens(){
  const cs = getComputedStyle(document.documentElement);
  // g: CSS 変数名 → その値（前後空白除去）を返す近道。
  const g = n => cs.getPropertyValue(n).trim();
  // s: 方式A-Dの線色、p: 方式A-Dの点群色、map: BERマップの3色、その他は背景/文字/罫線など。
  T = { bg:g('--bg'), surface:g('--surface'), surface2:g('--surface-2'), line:g('--line'), text:g('--text'), text2:g('--text-2'),
    scopeBg:g('--scope-bg'), scopeGrid:g('--scope-grid'), scopeIdeal:g('--scope-ideal'), scopeText:g('--scope-text'),
    acc:g('--acc'), sb1:g('--sb1'), sb2:g('--sb2'), bad:g('--bad'),
    s:{A:g('--sA'),B:g('--sB'),C:g('--sC'),D:g('--sD')}, p:{A:g('--pA'),B:g('--pB'),C:g('--pC'),D:g('--pD')},
    map:[g('--map-0'),g('--map-1'),g('--map-2')], mapNone:g('--map-none') };
}
// 読み込み時に一度実行して T を初期化。
readTokens();

/* ---------- theme ---------- */
// テーマ切替：auto（OS追従）/ dark / light を順に回す。<html data-theme="..."> を付け外しして CSS 側を切り替える。
const THEMES = ['auto','dark','light'], THEME_L = {auto:'自動', dark:'ダーク', light:'ライト'};
// 前回選んだテーマを localStorage から復元（無ければ auto）。
let theme = 'auto';
try { theme = localStorage.getItem('wl-demo-theme') || 'auto'; } catch(e){}
// applyTheme: 現在の theme を DOM に反映し、ボタン表示を更新。色が変わるので T を読み直して全再描画する。
function applyTheme(){
  // auto のときは data-theme 属性を外し、CSS の @media(prefers-color-scheme) に任せる。
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  $('#themeBtn').textContent = '外観：' + THEME_L[theme];
  // 新しい配色を読み直し（readTokens）→ 静的な図を描き直す（redrawAllStatic は main.js）。
  readTokens(); redrawAllStatic();
}
// 外観ボタン：押すたびに auto→dark→light→auto と循環し、選択を保存して適用。
$('#themeBtn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % 3];
  try { localStorage.setItem('wl-demo-theme', theme); } catch(e){}
  applyTheme();
});
// auto 表示中に OS のダーク/ライトが切り替わったら、色を読み直して描き直す。
if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); redrawAllStatic(); });

/* ---------- fullscreen & wake lock ---------- */
// 全画面表示とスリープ防止。ポスター会場で放置してもスリープせず全画面で見せるための補助。
const de = document.documentElement;
// ブラウザによって API 名が違うので requestFullscreen / webkit 版の使える方を拾う。
const reqFS = de.requestFullscreen || de.webkitRequestFullscreen;
// 全画面が使える環境でのみ「全画面」ボタンを表示し、押下で入/出を切り替える。
if (reqFS && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
  const b = $('#fsBtn'); b.hidden = false;
  b.addEventListener('click', () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      // すでに全画面なら解除、そうでなければ全画面に入る。
      if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else reqFS.call(de);
    } catch(e){}
  });
}
// wake: 取得中の Wake Lock（画面スリープ抑止）。未取得なら null。
let wake = null;
// keepAwake: Screen Wake Lock を要求して画面が消えないようにする。非対応やエラーは握りつぶす（必須機能ではない）。
async function keepAwake(){
  try { if ('wakeLock' in navigator && !wake && !document.hidden) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch(e){}
}
