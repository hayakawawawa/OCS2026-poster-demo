// sim.js — シミュレーション駆動（Worker ＋ メインスレッドのフォールバック）と測定データの集計
'use strict';
//
// このファイルの役割は 2 つ：
//  (1) engine.js の createEngine() を「別スレッド（Web Worker）」で回し続け、
//      1 ブロック分の計算結果（各方式のコンスタレーション点・誤り数・MSE）を受け取る。
//      Worker が使えない環境ではメインスレッドで同じ計算を回すフォールバックに切り替える。
//  (2) 受け取った結果を履歴（BER/SNR のトレース）や BER マップへ蓄積する。
// engine.js 側が重い数値計算、この sim.js 側が「いつ計算を投げて、結果をどう貯めるか」の司令塔。

/* ---------- simulation driver (worker with main-thread fallback) ---------- */
// workerMain は Worker スレッドの中で動く関数。ここでは定義するだけで、
// initSim() が createEngine と一緒に文字列化して Worker に流し込む（下記 initSim 参照）。
function workerMain(){
  // Worker 内で計算エンジンを 1 つ作る（メインスレッドのものとは別インスタンス）。
  const E = createEngine();
  // メインスレッドから { p:パラメータ, reset:等化器リセット } が届くたびに 1 ブロック計算して返す。
  self.onmessage = e => {
    const m = e.data;
    if (m.p) E.setParams(m.p);
    if (m.reset) E.resetEq();
    const r = E.step(), tr = [];
    // pts（点群）は Float32Array。buffer を「移譲（transfer）」してコピーを避け、転送を軽くする。
    for (const s in r) tr.push(r[s].pts.buffer);
    self.postMessage({ r, p: Object.assign({}, E.P) }, tr);
  };
}
// worker/engine: Worker 版かフォールバック版か（どちらか一方だけが非 null）。
// pending: 計算待ちフラグ。lastReq: 直近の投入時刻。gotFirst: Worker から初回応答が来たか。
// resetFlag: 次のブロックで等化器を初期化してほしいかどうか。
let worker = null, engine = null, pending = false, lastReq = 0, gotFirst = false, resetFlag = false;
// Worker が起動しない／失敗したときに、メインスレッド計算へ切り替える。
function useFallback(){
  if (engine) return;
  if (worker) { try { worker.terminate(); } catch(e){} worker = null; }
  engine = createEngine();
  pending = false; pump();
}
// Worker を起動。createEngine と workerMain のソースを文字列として連結し、
// Blob（即席の JS ファイル）にして Worker に読ませる＝別ファイルを用意せず Worker を作る定番手法。
function initSim(){
  try {
    const src = createEngine.toString() + '\n(' + workerMain.toString() + ')();';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = e => { gotFirst = true; onResult(e.data); };
    worker.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); useFallback(); };
    // 2.5 秒たっても初回応答が無ければ Worker を諦めてフォールバック（file:// 直開き等への保険）。
    setTimeout(() => { if (!gotFirst) useFallback(); }, 2500);
  } catch(e) { useFallback(); }
  pump();
}
// pump: 「次の 1 ブロックを計算させる」入口。1 ブロックの結果が来るたびに onResult から再び呼ばれ、回り続ける。
function pump(){
  // 計算中、またはタブが裏（非表示）のときは投げない。
  if (pending || document.hidden) return;
  // 投入間隔を最低 50ms に制限（＝最大 20 ブロック/秒）。早すぎる連投を防ぐ。
  const now = performance.now(), wait = 50 - (now - lastReq);
  if (wait > 0) { setTimeout(pump, wait); return; }
  lastReq = now; pending = true;
  // 現在の UI 状態 st をコピーして渡す（計算中に st が変わっても今回の結果はブレない）。
  const msg = { p: Object.assign({}, st), reset: resetFlag }; resetFlag = false;
  if (engine) {
    // フォールバック：メインスレッドで計算。setTimeout(…,0) で一旦画面に制御を返してから走らせる。
    setTimeout(() => {
      engine.setParams(msg.p); if (msg.reset) engine.resetEq();
      const r = engine.step(); onResult({ r, p: Object.assign({}, engine.P) });
    }, 0);
  } else if (worker) worker.postMessage(msg);
}
// タブが再表示されたら計算を再開し、画面スリープ防止（keepAwake）もかけ直す。
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pending = false; pump(); keepAwake(); } });

/* ---------- metrics & data ---------- */
// 各方式 A/B/C/D ごとの測定値を貯める入れ物。
// hist: 直近数ブロックの誤り数・ビット数・MSE（BER と実効 SNR の数値表示に使う）。
const hist = {}; SCH.forEach(s => hist[s] = []);
// trace: 実効 SNR（= -10log10(MSE)）の時系列。推移グラフ用のリングバッファ。
const trace = {}; SCH.forEach(s => trace[s] = []);
// latest: 最新ブロックの点群。newData: 未描画の新データがあるか。blockCount: 累積ブロック数。
// holdOff/slowLearn: 学習モードの残りブロック数（下の onResult と controls.js で使用）。
const latest = {}; let newData = false, blockCount = 0, holdOff = 0, slowLearn = 0;
const recent = []; // last echoed taus
// condKey: スキュー以外の条件（OSNR・振幅・位相・偏波回転・CDCF有無）を 1 本の文字列キーにまとめる。
// 条件が同じときだけ BER マップを同じ升目に積む（＝条件を変えると別マップになる）ための識別子。
function condKey(p){ return [p.snrDb, p.amp1, p.amp2, p.ph1, p.ph2, p.sopRot ? 1 : 0, p.conjCDCF ? 1 : 0].join('|'); }
// maps: 条件キー → その条件での BER マップ（11×11=121 升、τ₁,τ₂ = -5..+5 ps）。
const maps = new Map();
// getMap: 指定条件のマップを取り出す（無ければ 0 で初期化して作る）。err/bits を升ごとに溜め、BER=err/bits。
function getMap(k){
  if (!maps.has(k)) { const o = {}; SCH.forEach(s => o[s] = { err: new Float64Array(121), bits: new Float64Array(121) }); maps.set(k, o); }
  return maps.get(k);
}
let mapsDirty = true;

// onResult: 1 ブロックの計算結果 d = { r:各方式の結果, p:使用パラメータ } を受け取るコールバック。
// ここで履歴更新 → BER マップ記録 → 次ブロック投入（pump）までを行う。
function onResult(d){
  pending = false; blockCount++;
  const r = d.r, p = d.p;
  for (const s of SCH) {
    // 履歴に追加し、窓長を超えた古い分を捨てる（BER_WIN ブロックの移動窓）。
    const h = hist[s]; h.push({ err: r[s].err, bits: r[s].bits, mse: r[s].mse }); if (h.length > BER_WIN) h.shift();
    // 実効 SNR = -10log10(MSE) をトレースに追加（TRACE_LEN 点のリングバッファ）。
    const t = trace[s]; t.push(-10 * Math.log10(Math.max(r[s].mse, 1e-6))); if (t.length > TRACE_LEN) t.shift();
    latest[s] = r[s].pts;
  }
  newData = true;
  // slow-learn schedule
  // 学習モード：最初は小さい μ でゆっくり収束させ、slowLearn ブロック経過後に通常 μ へ戻す。
  if (slowLearn > 0) { slowLearn--; if (slowLearn === 0) { st.mu = DEF.mu; } }
  if (holdOff > 0) holdOff--;
  // BER map recording
  // BER マップ記録：直近 3 ブロックのスキューがほぼ同じ（＝ユーザが手を止めた）ときだけ、その点に BER を積む。
  recent.push([p.tau1, p.tau2]); if (recent.length > 3) recent.shift();
  if (holdOff === 0 && recent.length === 3) {
    const [a, b, c] = recent;
    // 直近 3 点のばらつきが 0.12 ps 未満なら「静止」とみなす。
    const stable = Math.max(Math.abs(a[0] - c[0]), Math.abs(a[1] - c[1]), Math.abs(b[0] - c[0]), Math.abs(b[1] - c[1])) < 0.12;
    const r1 = Math.round(c[0]), r2 = Math.round(c[1]);
    // さらに整数 ps（格子点, ±5 ps 以内）にほぼ乗っていれば、その升へ誤り数・ビット数を加算。
    if (stable && Math.abs(c[0] - r1) <= 0.25 && Math.abs(c[1] - r2) <= 0.25 && Math.abs(r1) <= 5 && Math.abs(r2) <= 5) {
      // 升インデックス i：行 = (5 - τ₁)（上が +5）、列 = (τ₂ + 5)（左が -5）。
      const m = getMap(condKey(p)), i = (5 - r1) * 11 + (r2 + 5);
      for (const s of SCH) { m[s].err[i] += r[s].err; m[s].bits[i] += r[s].bits; }
      mapsDirty = true;
    }
  }
  // 自動測定（Fig.3 スイープ）中なら 1 点進める（maps.js の sweepTick）。
  if (sweep) sweepTick(p);
  // 次のブロックを投入して回し続ける。
  pump();
}
