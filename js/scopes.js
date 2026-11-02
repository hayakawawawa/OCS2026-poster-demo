// scopes.js — 4 方式のコンスタレーション表示と実効 SNR 推移グラフの描画
'use strict';
//
// 画面左側の 4 つの小画面（A/B/C/D のコンスタレーション）と、その下の SNR 推移グラフを描く。
// 計算そのものは sim.js / engine.js 側。ここは「貯まった結果を Canvas にどう描くか」だけを担当。

/* ---------- scopes ---------- */
// scopes[s]：方式 s(=A/B/C/D) の画面を構成する DOM とキャンバスをまとめた参照表。
//   bg=背景（格子・理想点）、fg=前景（実際の受信点）、v=BER 値、sn=実効 SNR、
//   fill=メーターの塗り、fec/fecL=HD-FEC しきい線とラベル、size/dpr=描画解像度。
const scopes = {};
$$('.scope').forEach(el => {
  const s = el.dataset.s;
  scopes[s] = { el, scr: el.querySelector('.screen'), bg: el.querySelector('canvas.bg'), fg: el.querySelector('canvas.fg'),
    v: el.querySelector('.ber .v'), sn: el.querySelector('.ber .s'), fill: el.querySelector('.meter i'), fec: el.querySelector('.meter b'), fecL: el.querySelector('.meter span'), size: 0, dpr: 1 };
});
// meterPos：BER(10^-5〜2×10^-1) を 0〜1 のメーター位置へ写像（0=良い, 1=悪い）。
// log10(BER)+5 で下限 10^-5 を 0 に寄せ、幅 4.3 で正規化。
const meterPos = ber => Math.max(0, Math.min(1, (Math.log10(Math.max(ber, 1e-6)) + 5) / 4.3)); // 1e-5 .. 2e-1
// 各メーター上の HD-FEC しきい線（縦棒＋ラベル）を、BER=FEC の位置に置く。
SCH.forEach(s => { const sc = scopes[s], x = meterPos(FEC) * 100; sc.fec.style.left = x + '%'; sc.fecL.style.left = x + '%'; });
// layoutScope：画面サイズが変わったとき、正方形のキャンバスを中央に配置し直して解像度を合わせる。
function layoutScope(s){
  const sc = scopes[s], r = sc.scr.getBoundingClientRect();
  // 幅・高さの小さい方に合わせた正方形（最小 40px）。
  const size = Math.floor(Math.max(40, Math.min(r.width, r.height)));
  const left = Math.floor((r.width - size) / 2), top = Math.floor((r.height - size) / 2);
  for (const cv of [sc.bg, sc.fg]) { sc.dpr = sizeCanvas(cv, size, size); cv.style.left = left + 'px'; cv.style.top = top + 'px'; }
  sc.size = size; drawScopeBg(s);
}
// LV：16QAM の 1 軸あたりの理想振幅レベル（平均電力 1 に正規化：±1/√10, ±3/√10）。
const LV = [-3, -1, 1, 3].map(v => v / Math.sqrt(10));
// drawScopeBg：背景（1 回だけ描けばよい静的な部分）＝黒地・格子・判定境界・理想シンボル位置・軸ラベル。
function drawScopeBg(s){
  // k：複素平面座標→ピクセルの倍率。RANGE は表示範囲の半幅。原点が中心に来るよう (v+RANGE)*k で変換。
  const sc = scopes[s], ctx = sc.bg.getContext('2d'), S = sc.bg.width, k = S / (2 * RANGE), d = sc.dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = T.scopeBg; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = T.scopeGrid; ctx.lineWidth = 1 * d;
  ctx.setLineDash([3 * d, 4 * d]);
  // 判定境界（±2/√10）の破線。16QAM は各軸この 2 本で 4 レベルを仕切る。
  for (const v of [-2 / Math.sqrt(10), 2 / Math.sqrt(10)]) {
    const x = (v + RANGE) * k; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, x); ctx.lineTo(S, x); ctx.stroke();
  }
  ctx.setLineDash([]);
  // 中心を通る I 軸・Q 軸（実線）。
  const c = RANGE * k; ctx.beginPath(); ctx.moveTo(c, 0); ctx.lineTo(c, S); ctx.moveTo(0, c); ctx.lineTo(S, c); ctx.stroke();
  ctx.strokeStyle = T.scopeIdeal; ctx.lineWidth = 1 * d;
  // 16 個の理想シンボル位置に小さな円（y は画面下向きが正なので RANGE - b で反転）。
  for (const a of LV) for (const b of LV) { const x = (a + RANGE) * k, y = (RANGE - b) * k; ctx.beginPath(); ctx.arc(x, y, 3.2 * d, 0, 7); ctx.stroke(); }
  ctx.fillStyle = T.scopeText; ctx.font = `${11 * d}px "IBM Plex Sans JP", "Hiragino Sans", sans-serif`;
  // 表示しているのは X 偏波のコンスタレーション。
  ctx.fillText('X 偏波', 8 * d, S - 8 * d);
  // 前景キャンバス（受信点）はここでクリアしておく。
  const fg = sc.fg.getContext('2d'); fg.setTransform(1,0,0,1,0,0); fg.clearRect(0, 0, S, S);
}
// drawScopePts：最新ブロックの受信点を前景へ描く。毎ブロック呼ばれ、残像を少しずつ消しながら上書き。
function drawScopePts(s){
  const sc = scopes[s], pts = latest[s]; if (!pts || !sc.size) return;
  const ctx = sc.fg.getContext('2d'), S = sc.fg.width, k = S / (2 * RANGE);
  // 既存の描画を 30% 薄める（destination-out）＝点が尾を引いて見える残光効果。
  ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, 0, S, S);
  // 加算合成（lighter）で方式色の小さな四角を打つ。密集ほど明るくなりヒートマップ風に。
  ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = T.p[s]; ctx.globalAlpha = 0.62;
  const r = Math.max(2, 1.6 * sc.dpr), h = r / 2;
  // pts は [I0,Q0, I1,Q1, …] の並び。各点を座標変換して打点。
  for (let i = 0; i < pts.length; i += 2) {
    const x = (pts[i] + RANGE) * k, y = (RANGE - pts[i + 1]) * k;
    ctx.fillRect(x - h, y - h, r, r);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
let lastText = 0;
// updateReadouts：各画面右上の BER 値・実効 SNR・メーターを、hist（移動窓）の集計から更新。
function updateReadouts(){
  for (const s of SCH) {
    const h = hist[s]; if (!h.length) continue;
    // 窓内の誤り数 e・ビット数 b・MSE 合計 m を足し込む。
    let e = 0, b = 0, m = 0; for (const x of h) { e += x.err; b += x.bits; m += x.mse; }
    const ber = e / b, snr = -10 * Math.log10(m / h.length), sc = scopes[s];
    // 誤りが 1 つも無い間は「< 1/ビット数」と下限表示にする（0 だと BER を出せないため）。
    const shown = e === 0 ? 1 / b : ber;
    sc.v.textContent = (e === 0 ? '< ' : '') + 'BER ' + sci(shown);
    // HD-FEC しきい値を超えたら赤表示。
    sc.v.classList.toggle('bad', ber > FEC);
    sc.sn.textContent = '実効 SNR ' + snr.toFixed(1) + ' dB';
    sc.fill.style.width = (meterPos(shown) * 100) + '%';
  }
}

/* ---------- trace ---------- */
// 画面下の「実効 SNR の推移」グラフ。横軸＝時間（直近 TRACE_LEN ブロック）、縦軸＝SNR[dB]。
const traceCv = $('#trace');
let traceDpr = 1;
function layoutTrace(){ const r = traceCv.parentElement.getBoundingClientRect(); traceDpr = sizeCanvas(traceCv, Math.max(50, r.width), Math.max(40, r.height)); drawTrace(); }
function drawTrace(){
  const ctx = traceCv.getContext('2d'), W = traceCv.width, H = traceCv.height, d = traceDpr;
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0, 0, W, H);
  const padL = 34 * d, padR = 6 * d, padT = 6 * d, padB = 6 * d;
  // y：SNR 値[dB]→縦ピクセル。lo..hi(6..20 dB) を描画高さに写像（範囲外はクランプ）。
  const lo = 6, hi = 20, y = v => padT + (hi - Math.max(lo, Math.min(hi, v))) / (hi - lo) * (H - padT - padB);
  ctx.font = `${10.5 * d}px "IBM Plex Sans JP","Hiragino Sans",sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  // 8/12/16/20 dB に目盛り線とラベル。
  for (const g of [8, 12, 16, 20]) {
    ctx.strokeStyle = T.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W - padR, y(g)); ctx.stroke();
    ctx.fillStyle = T.text2; ctx.fillText(g + ' dB', padL - 6 * d, y(g));
  }
  // x：バッファ内の i 番目→横ピクセル。n=TRACE_LEN を全幅に割り付ける。
  const n = TRACE_LEN, x = i => padL + (W - padL - padR) * i / (n - 1);
  for (const s of SCH) {
    const t = trace[s]; if (t.length < 2) continue;
    // 提案方式 D だけ太線で強調。off は、まだ満杯でないデータを右詰めで描くためのオフセット。
    ctx.strokeStyle = T.s[s]; ctx.lineWidth = (s === 'D' ? 2.6 : 1.5) * d; ctx.lineJoin = 'round';
    ctx.beginPath(); const off = n - t.length;
    for (let i = 0; i < t.length; i++) { const X = x(i + off), Y = y(t[i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
    ctx.stroke();
  }
}
