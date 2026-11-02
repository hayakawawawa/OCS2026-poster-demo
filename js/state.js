// state.js — 全ファイルで共有する定数・状態と DOM ショートカット（$ / $$）
// ほかの UI 系ファイルより先に読み込む必要があります。
'use strict';
// SCH: 比較する 4 方式の識別子。A=再結合後SL / B=再結合後WL / C=ブランチ毎SL / D=ブランチ毎WL（提案）。
//      以降のループやデータ構造はすべてこの 4 つをキーに回します。
const SCH = ['A','B','C','D'];
// FEC: HD-FEC のしきい値 BER（3.8e-3）。これを下回れば誤り訂正後にエラーフリーとみなせる基準線。
const FEC = 3.8e-3;
// RANGE: コンスタレーション表示の片側の幅（±1.32）。16QAM の外側シンボル(±3/√10≒±0.95)に余白を足した値。
const RANGE = 1.32;          // constellation half-width
// TRACE_LEN: 実効 SNR 推移グラフに保持する点数（直近 240 ブロック分）。
const TRACE_LEN = 240;
// BER_WIN: BER / 実効SNR を平均する窓の長さ（直近 8 ブロック）。表示のばらつきを抑える移動平均。
const BER_WIN = 8;           // blocks in BER window
// DEF: パラメータの初期値（＝論文 Fig.3 の条件）。「初期設定に戻す」でこの値に戻します。
//   tau1,tau2: 各サブバンドの IQ スキュー [ps] / amp1,amp2: IQ 振幅不平衡 [dB] / ph1,ph2: IQ 位相誤差 [deg]
//   snrDb: OSNR 相当のスライダー値 / sopRot: 偏波状態を回し続けるか / conjCDCF: 共役パスにも CDCF をかけるか
//   mu: NLMS のステップサイズ
const DEF = { tau1:0, tau2:0, amp1:0, amp2:0, ph1:0, ph2:0, snrDb:17, sopRot:false, conjCDCF:true, mu:0.03 };
// st: 現在のパラメータ（ライブで書き換わる唯一の可変状態）。DEF を複製して作り、UI 操作で更新 → 毎フレーム engine へ渡す。
const st = Object.assign({}, DEF);
// reduceMotion: OS の「視差効果を減らす」設定。true なら方式切替アニメ等を省略します。
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
// $ / $$: document.querySelector / querySelectorAll の短縮形。$$ は配列を返す（forEach 等をそのまま使える）。
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
