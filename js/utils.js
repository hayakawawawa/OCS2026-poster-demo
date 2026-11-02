// utils.js — 純粋なヘルパー（指数表記・数値整形・色変換・キャンバス解像度）
'use strict';
// どの関数も副作用のない小道具。表示用の文字列づくりと Canvas まわりの共通処理をまとめています。
/* ---------- helpers ---------- */
// SUP: 0-9 と「-」を上付き文字へ変換する対応表。sci() が指数部（10 の肩の数字）を上付きにするのに使う。
const SUP = {'-':'⁻','0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'};
// sci: 数値を「仮数×10^指数」の科学表記文字列にする（例 0.0023 → "2.3×10⁻³"）。BER 表示用。
function sci(v){
  // 0 以下（記録なし等）は "0" を返す。
  if (!(v > 0)) return '0';
  // 指数 e＝floor(log10)、仮数 m＝v/10^e。
  let e = Math.floor(Math.log10(v)), m = v / Math.pow(10, e);
  // 四捨五入で m が 10 近傍になる場合は m=1, e+1 に繰り上げて "10×10^n" を避ける。
  if (m >= 9.95) { m = 1; e += 1; }
  // 指数部の各桁を SUP で上付きに変換して連結。
  return m.toFixed(1) + '×10' + String(e).split('').map(c => SUP[c]).join('');
}
// fmtPs: ピコ秒を符号付きで整形（例 "+3.5 ps"／負号は見やすい U+2212）。スキュー表示用。
const fmtPs = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' ps';
// fmtSigned: 符号付きの汎用整形。d=小数桁数, u=単位（" dB" や "°"）。
const fmtSigned = (v, d, u) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + u;
// hexToRgb: "#rrggbb"（または短縮形 "#rgb"）を [r,g,b] の数値配列へ。CSS のトークン色を補間計算するため。
function hexToRgb(h){
  h = h.replace('#','');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// mapColor: BER マップの色。t=0(良い)〜1(悪い) を map-0→map-1→map-2 の 3 色グラデで補間して "rgb(...)" を返す。
function mapColor(t){ // t: 0 good .. 1 bad
  t = Math.max(0, Math.min(1, t));
  // T.map は theme.js が CSS から読んだ 3 色（良→中→悪）。
  const c = T.map.map(hexToRgb);
  // 前半[0,0.5]は c0→c1、後半[0.5,1]は c1→c2 を線形補間（u は各区間内の 0〜1）。
  const [a, b, u] = t < 0.5 ? [c[0], c[1], t * 2] : [c[1], c[2], (t - 0.5) * 2];
  return 'rgb(' + a.map((x, i) => Math.round(x + (b[i] - x) * u)).join(',') + ')';
}
// sizeCanvas: Canvas を CSS サイズ w×h で表示しつつ、実ピクセルは devicePixelRatio 倍にして高精細に描く。
//   返り値 dpr は描画側が線幅・座標のスケールに使う。Retina 等でぼやけないようにする定番処理。
function sizeCanvas(cv, w, h){
  // dpr は 2.5 で頭打ち（高すぎる端末で重くなりすぎないよう上限）。
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  // サイズが変わる時だけ内部解像度を再設定（毎回だと中身がクリアされるため）。
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  // 見た目の大きさは CSS px で指定。
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  return dpr;
}
