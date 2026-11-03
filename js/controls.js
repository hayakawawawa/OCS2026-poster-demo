// controls.js — スライダー／スイッチ操作、ゆらぎ再現、放置時の自動デモ（アイドル）
'use strict';
// このファイルの役割:
//  ・左パネルの操作UI(スキュー/OSNR/振幅/位相/各スイッチ)を状態 st と同期させる。
//  ・setTau(): スキュー τ1,τ2 を設定する中心的な関数（パッド・スライダー・自動測定から共通で呼ぶ）。
//  ・drift : スキューを滑らかに揺らし続ける「ゆらぎ再現」。
//  ・idle  : 一定時間無操作だと自動でゆらぎを始め、来場者を引き込む（アトラクトモード）。
/* ---------- controls ---------- */
// 各スライダー要素への参照をまとめて持つ。
const ui = {
  tau1: $('#tau1'), tau2: $('#tau2'), snr: $('#snr'), amp1: $('#amp1'), amp2: $('#amp2'), ph1: $('#ph1'), ph2: $('#ph2')
};
// 状態 st の値を UI の表示(スライダー位置・数値ラベル・スイッチ)へ一括反映する。
function syncUI(){
  ui.tau1.value = st.tau1; ui.tau2.value = st.tau2;
  $('#tau1o').textContent = fmtPs(st.tau1); $('#tau2o').textContent = fmtPs(st.tau2);
  // 内部の snrDb は信号帯域基準。表示は +9.03 dB して 0.1 nm 分解能換算の OSNR にする。
  ui.snr.value = st.snrDb; $('#snro').textContent = (st.snrDb + 9.03).toFixed(1) + ' dB';
  ui.amp1.value = st.amp1; ui.amp2.value = st.amp2; ui.ph1.value = st.ph1; ui.ph2.value = st.ph2;
  $('#amp1o').textContent = fmtSigned(st.amp1, 1, ' dB'); $('#amp2o').textContent = fmtSigned(st.amp2, 1, ' dB');
  $('#ph1o').textContent = fmtSigned(st.ph1, 1, '°'); $('#ph2o').textContent = fmtSigned(st.ph2, 1, '°');
  // トグルスイッチ(偏波回転 sopRot / 共役パス CDCF)の見た目を状態に合わせる。
  $('#sopSw').setAttribute('aria-checked', String(st.sopRot)); $('#cdcfSw').setAttribute('aria-checked', String(st.conjCDCF));
  $('#snro').title = 'SNR ' + st.snrDb.toFixed(1) + ' dB（100 GBaud，0.1 nm 換算）';
  // パッドと BER マップの再描画を予約。
  padDirty = true; mapsDirty = true;
}
// パッド(pad.js)の再描画が必要かのフラグ。描画ループ(main.js)が見ている。
let padDirty = true;
// スキュー τ1,τ2 を設定する中核関数。user=true は人の操作（自動測定などは false）。
function setTau(t1, t2, user){
  // 範囲を ±10 ps にクランプ。
  t1 = Math.max(-10, Math.min(10, t1)); t2 = Math.max(-10, Math.min(10, t2));
  // 人が動かしたときは、競合する自動ゆらぎ/自動測定を止め、指ヒントも消す。
  if (user) { stopDrift(); if (sweep) stopSweep('操作したので測定を止めました．'); dismissPadHint(); }
  // パッドに残す軌跡(trail)。前回位置から十分動いたときだけ点を足し、最大 60 点に制限。
  const lt = trail[trail.length - 1];
  if (!lt || Math.hypot(lt[0] - t1, lt[1] - t2) > 0.15) { trail.push([t1, t2]); if (trail.length > 60) trail.shift(); }
  st.tau1 = t1; st.tau2 = t2;
  $('#tau1o').textContent = fmtPs(t1); $('#tau2o').textContent = fmtPs(t2);
  // スライダー位置も合わせる（値が食い違うときだけ代入して無限ループを避ける）。
  if (+ui.tau1.value !== t1) ui.tau1.value = t1;
  if (+ui.tau2.value !== t2) ui.tau2.value = t2;
  padDirty = true; mapsDirty = true;
}
// τ1 / τ2 スライダー: 片方だけ更新して setTau（user=true）。
ui.tau1.addEventListener('input', () => { userAct(); setTau(+ui.tau1.value, st.tau2, true); });
ui.tau2.addEventListener('input', () => { userAct(); setTau(st.tau1, +ui.tau2.value, true); });
// 汎用スライダー結線: 値を st[key] に入れて UI 同期。測定中なら中断する。
function bindRange(el, key){ el.addEventListener('input', () => { userAct(); if (sweep) stopSweep('条件を変えたので測定を止めました．'); st[key] = +el.value; syncUI(); }); }
// OSNR・IQ振幅不平衡・IQ位相誤差の各スライダーを結線。
bindRange(ui.snr, 'snrDb'); bindRange(ui.amp1, 'amp1'); bindRange(ui.amp2, 'amp2'); bindRange(ui.ph1, 'ph1'); bindRange(ui.ph2, 'ph2');
// 偏波状態を回し続けるスイッチ。
$('#sopSw').addEventListener('click', () => { userAct(); st.sopRot = !st.sopRot; syncUI(); });
// 共役パスにも CDCF をかけるスイッチ（オフ=提案方式の要素を 1 つ外すアブレーション）。
$('#cdcfSw').addEventListener('click', () => { userAct(); if (sweep) stopSweep('条件を変えたので測定を止めました．'); st.conjCDCF = !st.conjCDCF; syncUI(); });
// 「0 に戻す」: スキューを原点へ。
$('#zeroBtn').addEventListener('click', () => { userAct(); setTau(0, 0, true); });
// 「ランダムに設定」: スキュー/振幅/位相をまとめて乱数化し、提案方式 D が崩れないかを見せる。
$('#randBtn').addEventListener('click', () => {
  userAct();
  // q: 0.5 刻みに丸める, rr: -1..+1 の一様乱数。
  const q = v => Math.round(v * 2) / 2, rr = () => Math.random() * 2 - 1;
  setTau(q(rr() * 5), q(rr() * 5), true);
  st.amp1 = Math.round(rr() * 15) / 10; st.amp2 = Math.round(rr() * 15) / 10;
  st.ph1 = q(rr() * 8); st.ph2 = q(rr() * 8);
  syncUI(); setStatus('スキュー，振幅，位相をランダムに設定しました．D が崩れるか見てください．');
});
// 「初期設定に戻す」: 全状態を DEF に戻し、ゆらぎ/測定/軌跡もリセット。
$('#defBtn').addEventListener('click', () => { userAct(); stopDrift(); if (sweep) stopSweep(); Object.assign(st, DEF); trail.length = 0; syncUI(); setStatus('初期設定に戻しました．'); });
// 学習デモ開始: 等化器を初期化(resetFlag)し、ステップサイズ mu を一旦小さくしてゆっくり収束を見せる。
function startLearn(){
  // slowLearn ブロックの間だけ低 mu、holdOff の間はマップ記録を止める（sim.js が参照）。
  resetFlag = true; st.mu = 0.0012; slowLearn = 45; holdOff = 60;
  setStatus('等化器を初期化しました．コンスタレーションが整っていく様子を見てください．');
}
$('#learnBtn').addEventListener('click', () => { userAct(); startLearn(); });

/* ---------- drift ---------- */
// ゆらぎ再現の状態。drift=実行中か, driftT=経過時間, lastFrame=前フレーム時刻(描画ループ用)。
let drift = false, driftT = 0, lastFrame = performance.now();
// driftFrom=開始時のスキュー, driftBlend=0→1 で「現在位置→ゆらぎ軌道」へ滑らかに移行する係数。
let driftFrom = [0, 0], driftBlend = 1;
// ゆらぎ開始: いまの位置を起点に記録し、ブレンドを 0 から始める。
function startDrift(){ if (sweep) stopSweep(); drift = true; driftFrom = [st.tau1, st.tau2]; driftBlend = 0; $('#driftBtn').setAttribute('aria-pressed', 'true'); }
function stopDrift(){ drift = false; $('#driftBtn').setAttribute('aria-pressed', 'false'); }
// 「ゆらぎを再現」ボタン（トグル）。
$('#driftBtn').addEventListener('click', () => { userAct(); drift ? stopDrift() : startDrift(); });
// 毎フレーム呼ばれ、2 つの正弦波を足した滑らかな軌道でスキューを動かす。dt は経過秒。
function driftStep(dt){
  driftT += dt;
  const t = driftT;
  // 周波数の異なる正弦波の和で、往復に見えない自然な揺れを作る。
  const t1 = 3.1 * Math.sin(0.42 * t + 0.3) + 1.6 * Math.sin(1.07 * t + 2.1);
  const t2 = 3.0 * Math.sin(0.37 * t + 1.9) + 1.7 * Math.sin(0.93 * t + 0.4);
  // 開始直後の飛びを防ぐため、現在位置から軌道へ滑らかに(スムーズステップで)寄せる。
  driftBlend = Math.min(1, driftBlend + dt / 2);
  const b = driftBlend * driftBlend * (3 - 2 * driftBlend);
  const u1 = driftFrom[0] + (t1 - driftFrom[0]) * b, u2 = driftFrom[1] + (t2 - driftFrom[1]) * b;
  setTau(Math.round(u1 * 100) / 100, Math.round(u2 * 100) / 100, false);
}

/* ---------- idle attract ---------- */
// lastAct=最後に操作した時刻。無操作が続くと自動デモを始めるための基準。
let lastAct = performance.now(), idleAttract = false;
// 「指でドラッグして動かせます」の表示を一元管理：
//   最初のヒント（手の絵が出ている間 = padHintShow）か、放置アトラクト中（idleAttract）に表示。
//   → 最初から出て、パッド操作で手と同時に消える（dismissPadHint が呼ぶ）。
function updateIdleHint(){ $('#idleHint').classList.toggle('on', padHintShow || idleAttract); }
// 操作があったことを記録する（アトラクトを解除し、表示を更新、画面スリープも抑止）。各UIから呼ばれる。
function userAct(){ lastAct = performance.now(); idleAttract = false; updateIdleHint(); keepAwake(); }
document.addEventListener('pointerdown', () => { lastAct = performance.now(); idleAttract = false; updateIdleHint(); keepAwake(); }, { passive: true });
// 2 秒ごとに点検: 60 秒以上無操作でデモ表示中なら、自動でゆらぎを始めてヒントを出す。
setInterval(() => {
  if (performance.now() - lastAct > 60000 && !drift && !sweep && currentView === 'demo') { startDrift(); idleAttract = true; updateIdleHint(); }
}, 2000);
// 起動時：まだ操作されていないので、最初からヒントを表示（手の絵と一緒に出る）。
updateIdleHint();
