// views.js — タブ切替（デモ／しくみ）と「しくみ」ビューのスペクトル図
'use strict';
//
// このファイルは2つの役割を持つ:
//   (1) 画面上部のタブ「デモ」/「しくみ」の切り替え（showView）
//   (2) 「しくみ」ビューの対話的なスペクトル図（drawHow）
//       横軸は f₀ からの光周波数差 [GHz]。信号成分・IQイメージ・共役で作る複製を描き、
//       方式B（再結合後に共役）と提案D（ブランチ毎に共役）で折り返しの軸がどう変わるかを見せる。
//
/* ---------- views ---------- */
// currentView: 現在表示中のビュー（'demo' か 'how'）。描画ループ(main.js)がこれを見て処理を分ける。
let currentView = 'demo';
// showView(v): ビューを切り替える。タブの選択状態・表示/非表示・URLハッシュを更新し、再レイアウトする。
function showView(v){
  currentView = v;
  // タブボタンの aria-selected を、押されたビューだけ true にする（見た目と支援技術の両方に反映）。
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  // 対応する <main> を表示、もう片方を hidden にする。
  $('#view-demo').hidden = v !== 'demo'; $('#view-how').hidden = v !== 'how';
  // URL のハッシュを同期（デモは無し、しくみは #how）。履歴を汚さないよう replaceState を使い、失敗は無視。
  if (location.hash !== '#' + v) { try { history.replaceState(null, '', v === 'demo' ? location.pathname + location.search : '#how'); } catch(e){} }
  // 切替直後はキャンバスの寸法が変わるので、次フレームでレイアウトし直し、スマホの1画面フィットも測り直す。
  requestAnimationFrame(() => { layoutAll(); fitFirstScreen(); });
}
// タブのクリックで該当ビューへ切替（userAct は放置タイマーのリセット＝自動デモ抑止）。
$$('.tabs button').forEach(b => b.addEventListener('click', () => { userAct(); showView(b.dataset.view); }));
// ブラウザの戻る/進むやリンクでハッシュが変わったときもビューを追従させる。
window.addEventListener('hashchange', () => showView(location.hash === '#how' ? 'how' : 'demo'));
// 「しくみ」内の“デモでこの処理を外してみる”ボタン: デモへ移動し、共役パスのCDCFをOFF、
// スキューを (τ₁,τ₂)=(4,-4) に設定して、提案Dでも劣化する様子を見せる。
$('#tryAbl').addEventListener('click', () => {
  userAct(); showView('demo'); $('#more').open = true;
  st.conjCDCF = false; setTau(4, -4, true); syncUI();
  setStatus('共役パスの CDCF を外しました．スキューがあると D も劣化します．スイッチを戻すと回復します．');
});
// 「しくみ」内の“デモで学習の様子を見る”ボタン: デモへ移動して等化器の学習を開始。
$('#tryLearn').addEventListener('click', () => { userAct(); showView('demo'); startLearn(); });

/* ---------- HOW view: interactive spectrum ---------- */
// 以降は「しくみ」ビューのスペクトル図。周波数軸 [GHz] 上に信号成分とそのIQイメージ、
// 共役操作で作る複製を矢印で描き、イメージと複製の周波数が一致するか（＝打ち消せるか）を示す。
const howCv = $('#howCv');
// 図の状態: howMode 'B'/'D'、howFs=信号成分の周波数[GHz]、howAnim=切替アニメの進捗(0→1)、
// howAnimFrom=アニメ開始位置、howTau=説明用スキュー[ps]。
let howDpr = 1, howMode = 'D', howFs = -42, howAnim = 1, howAnimFrom = null, howTau = 5;
// キャンバスの解像度（DPR対応）を合わせてから描画。幅が極小のとき（非表示中など）は何もしない。
function layoutHow(){ const r = howCv.parentElement.getBoundingClientRect(); if (r.width < 10) return; howDpr = sizeCanvas(howCv, r.width, r.height); drawHow(); }
// フロントエンド帯域の概形。|f|≤45GHzで1、55GHz以上で0、その間はcos²でなだらかに落とす（信号/イメージの高さに掛ける）。
const rcAmp = f => { const a = Math.abs(f); return a <= 45 ? 1 : a >= 55 ? 0 : 0.5 * (1 + Math.cos(Math.PI * (a - 45) / 10)); };
// howGeom(): 図の寸法と座標変換をまとめる。
//   fx(f): 周波数[GHz] → キャンバスのx座標（-70〜+70 GHz を描画幅へ写像）。
//   base: 周波数軸(y)の位置、ph: 軸より上に使える高さ、xf(x): 逆変換（x座標→周波数）。
function howGeom(){
  const W = howCv.width, H = howCv.height, d = howDpr;
  // l,r,t,b は左右上下の余白（d はDPR倍率）。
  const l = 18 * d, r = 18 * d, t = 54 * d, b = 52 * d;
  const fx = f => l + (f + 70) / 140 * (W - l - r);
  const base = H - b, ph = H - t - b;
  return { W, H, d, l, r, t, b, fx, base, ph, xf: x => (x - l) / (W - l - r) * 140 - 70 };
}
// arrow(): 縦向きの矢印を描く汎用関数。x位置・y0(根元)→y1(先端)、太さw、色、hollow=中抜き、dash=破線。
function arrow(ctx, x, y0, y1, w, color, hollow, dash, d){
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
  if (dash) ctx.setLineDash([5 * d, 4 * d]);
  // 縦線（根元から先端の少し手前まで）。
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 + 9 * d); ctx.stroke(); ctx.setLineDash([]);
  // 先端の三角（矢じり）。hollow なら輪郭のみ、そうでなければ塗りつぶす。
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x - 7 * d, y1 + 12 * d); ctx.lineTo(x + 7 * d, y1 + 12 * d); ctx.closePath();
  if (hollow) { ctx.lineWidth = 2 * d; ctx.stroke(); } else ctx.fill();
  ctx.restore();
}
// drawHow(): 「しくみ」図の本体。現在の howMode / howFs / howTau から1枚を描く。
function drawHow(){
  // 「しくみ」ビューを見ていないときは描かない（無駄な描画を省く）。
  if (currentView !== 'how') return;
  const g = howGeom(), ctx = howCv.getContext('2d'), d = g.d, { fx, base, ph } = g;
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0, 0, g.W, g.H);
  // フォント指定のヘルパー（w=ウェイト, s=サイズpx、DPR倍率を掛ける）。
  const font = (w, s) => `${w} ${s * d}px "IBM Plex Sans JP","Hiragino Sans",sans-serif`;
  // axis
  // 周波数軸（横線）と目盛り（-60〜+60 GHz を20刻み）。
  ctx.strokeStyle = T.text2; ctx.lineWidth = 1.2 * d; ctx.beginPath(); ctx.moveTo(g.l, base); ctx.lineTo(g.W - g.r, base); ctx.stroke();
  ctx.fillStyle = T.text2; ctx.font = font(400, 11); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = -60; f <= 60; f += 20) { ctx.beginPath(); ctx.moveTo(fx(f), base); ctx.lineTo(fx(f), base + 5 * d); ctx.stroke(); ctx.fillText((f > 0 ? '+' : f < 0 ? '−' : '') + Math.abs(f), fx(f), base + 8 * d); }
  ctx.fillText('光周波数（f₀ からの差）[GHz]', g.W / 2, base + 26 * d);
  // spectra
  // 2つのサブバンドのスペクトル概形を塗る。sh はその高さ。
  const sh = ph * 0.40;
  // band(lo,hi,col,k): lo〜hi の帯を描く。k=0/1 で境界(f=0付近)のcos²遷移の向きを変え、#1と#2を相補にする。
  const band = (lo, hi, col, k) => {
    ctx.beginPath(); ctx.moveTo(fx(lo), base);
    for (let f = lo; f <= hi + 1e-9; f += 0.25) {
      // u: 境界±1GHz を 0→1 に正規化。w: cos²で滑らかに立ち上げ/立ち下げ（サブバンド分割のBPF形状）。
      const u = Math.min(1, Math.max(0, (f + 1) / 2)), w = k === 0 ? Math.cos(Math.PI * u / 2) ** 2 : 1 - Math.cos(Math.PI * u / 2) ** 2;
      // 高さ = sh × フロントエンド帯域の形(rcAmp) × BPF形(w)。
      ctx.lineTo(fx(f), base - sh * rcAmp(f) * w);
    }
    ctx.lineTo(fx(hi), base); ctx.closePath();
    // うっすら塗ってから輪郭線を描く。
    ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 1.6 * d; ctx.stroke();
  };
  // #1(青)は負側、#2(緑)は正側。中心 f=±1 付近で相補的に交差する。
  band(-56, 1, T.sb1, 0); band(-1, 56, T.sb2, 1);
  ctx.font = font(600, 12); ctx.textBaseline = 'bottom';
  ctx.fillStyle = T.sb1; ctx.fillText('サブバンド #1', fx(-38), base - sh - 6 * d);
  ctx.fillStyle = T.sb2; ctx.fillText('サブバンド #2', fx(38), base - sh - 6 * d);
  // axes markers
  // vline(): LO や f₀ を示す縦の基準線＋ラベル。これらが「折り返しの軸」になる。
  const vline = (f, label, col, dash) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.4 * d; if (dash) ctx.setLineDash([4 * d, 4 * d]);
    ctx.beginPath(); ctx.moveTo(fx(f), base); ctx.lineTo(fx(f), g.t - 22 * d); ctx.stroke(); ctx.restore();
    ctx.fillStyle = col; ctx.font = font(700, 12.5); ctx.textBaseline = 'bottom'; ctx.textAlign = 'center'; ctx.fillText(label, fx(f), g.t - 26 * d);
  };
  // LO₁=-25GHz, LO₂=+25GHz, f₀=0GHz。
  vline(-25, 'LO₁', T.sb1, true); vline(25, 'LO₂', T.sb2, true); vline(0, 'f₀', T.text2, true);
  // tone and image
  // 信号成分の周波数 fs。どちらのサブバンドか(k)でLO(=折り返し軸)が決まる。
  //   fimg = 2*LO - fs : IQイメージの周波数（LO を軸に fs を折り返した位置）。
  //   fbb  = fs - LO   : LO から見たベースバンド周波数。
  const fs = howFs, k = fs < 0 ? 0 : 1, LO = k ? 25 : -25, fimg = 2 * LO - fs, fbb = fs - LO;
  const th = ph * 0.70, toneTop = base - th;
  // イメージの大きさ比: スキュー τ による遅延の位相 tan に比例（0〜1にクランプ）。τ=0ならイメージ無し。
  let ratio = Math.abs(Math.tan(Math.PI * fbb * 1e9 * howTau * 1e-12)); ratio = Math.min(ratio, 1);
  const ih = th * ratio, hasImg = ih > 2 * d;
  const loName = k ? 'LO₂' : 'LO₁';
  const archY = toneTop - 34 * d;
  // 折り返しを示す「弧」のラベルは最後にまとめて描く（他の要素に隠れないように）。
  const lateLabels = [];
  // pill(): 文字の背景に角丸の下敷きを敷いて読みやすくするラベル。align で左/右/中央寄せ、画面外へはみ出さないよう補正。
  const pill = (txt, x, y, col, align) => {
    ctx.font = font(600, 12); const w = ctx.measureText(txt).width, h = 18 * d;
    let x0 = align === 'left' ? x : align === 'right' ? x - w - 12 * d : x - w / 2 - 6 * d;
    x0 = Math.max(2 * d, Math.min(g.W - w - 14 * d, x0));
    ctx.fillStyle = T.surface; ctx.globalAlpha = 0.92; ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y - h, w + 12 * d, h, 5 * d); else ctx.rect(x0, y - h, w + 12 * d, h);
    ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, x0 + 6 * d, y - h / 2 + 0.5 * d);
  };
  // arch(): fa から fb への「折り返し」を表す弧＋その先端から下へ降りる点線＋矢じり。label は後で pill で描く。
  const arch = (fa, fb, lift, col, dash, yEnd, label) => {
    const xa = fx(fa), xb = fx(fb), xm = (xa + xb) / 2;
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2 * d; if (dash) ctx.setLineDash([6 * d, 4 * d]);
    // 二次ベジェで山なりの弧。lift が山の高さ。
    ctx.beginPath(); ctx.moveTo(xa, archY); ctx.quadraticCurveTo(xm, archY - 2 * lift, xb, archY); ctx.stroke();
    // 弧の終点から対象の高さ(yEnd)まで点線で降ろす。
    ctx.setLineDash([2 * d, 4 * d]); ctx.lineWidth = 1.4 * d;
    ctx.beginPath(); ctx.moveTo(xb, archY); ctx.lineTo(xb, yEnd); ctx.stroke(); ctx.setLineDash([]);
    // 終点に矢じり（折り返した先を指す）。dir は左右どちら向きか。
    const dir = Math.sign(xb - xa) || 1;
    ctx.beginPath(); ctx.moveTo(xb, archY + 1 * d); ctx.lineTo(xb - dir * 11 * d, archY - 9 * d); ctx.lineTo(xb - dir * 2 * d, archY - 11 * d); ctx.closePath(); ctx.fill();
    ctx.restore();
    lateLabels.push([label, xm, archY - lift - 4 * d, col]);
  };
  // tone
  // 信号成分を実線の矢印＋丸印で描く。
  arrow(ctx, fx(fs), base, toneTop, 3 * d, T.text, false, false, d);
  ctx.fillStyle = T.surface; ctx.strokeStyle = T.text; ctx.lineWidth = 2.5 * d;
  ctx.beginPath(); ctx.arc(fx(fs), toneTop - 16 * d, 10 * d, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = T.text; ctx.font = font(600, 12.5); ctx.textAlign = fs < LO ? 'right' : 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('信号成分', fx(fs) + (fs < LO ? -16 : 16) * d, toneTop - 16 * d);
  // image
  // IQイメージ（赤）を描く。side はイメージが信号成分の左右どちらにあるか。
  const side = fimg > fs ? 1 : -1;
  if (hasImg) {
    // τ≠0 のとき: イメージ矢印＋ラベル＋「LO を軸に折り返し」の弧。
    arrow(ctx, fx(fimg), base, base - ih, 3 * d, T.bad, false, false, d);
    pill('IQ イメージ', fx(fimg) + side * 10 * d, base - ih + 9 * d, T.bad, side > 0 ? 'left' : 'right');
    arch(fs, fimg, Math.min(46 * d, Math.abs(fx(fimg) - fx(fs)) * 0.22), T.bad, false, base - ih - 2 * d, 'IQ 不平衡：' + loName + ' を軸に折り返し');
  } else {
    // τ=0 ならイメージは生じない。
    pill('τ = 0 なのでイメージなし', fx(fimg), base - 10 * d, T.text2, 'center');
  }
  // replica
  // 共役で作る「複製」の目標周波数 target: 方式B は f₀ を軸(=-fs)、提案D は LO を軸(=fimg)。
  const target = howMode === 'B' ? -fs : fimg;
  // 方式切替時のアニメーション: from→target を ease-out で補間（howAnim 0→1）。
  const from = howAnimFrom === null ? target : howAnimFrom;
  const e = 1 - Math.pow(1 - howAnim, 3);
  const cur = from + (target - from) * e;
  const rh = Math.max(ih, th * 0.22);
  // 複製の色は方式に合わせる（B=方式Bの色、D=提案Dの色）。中抜き・破線の矢印で描く。
  const rc = howMode === 'B' ? T.s.B : T.s.D;
  arrow(ctx, fx(cur), base, base - rh, 2.4 * d, rc, true, true, d);
  // 複製がイメージとほぼ一致したか（＝打ち消せる配置か）。ラベル位置の微調整に使う。
  const coincide = Math.abs(cur - fimg) < 4 && hasImg;
  const rside = coincide ? -side : (cur > fs ? 1 : -1);
  pill('共役で作る複製', fx(cur) + rside * 10 * d, base - rh + (coincide ? 33 : 9) * d, rc, rside > 0 ? 'left' : 'right');
  // アニメが終わっていれば、折り返しの弧（どの軸で折り返したか）を描く。
  if (howAnim >= 1) {
    const span = Math.abs(fx(target) - fx(fs));
    const lift = howMode === 'B' ? Math.min(78 * d, span * 0.3) : Math.min(46 * d, span * 0.22) + 34 * d;
    arch(fs, target, lift, rc, true, base - rh - 2 * d, howMode === 'B' ? '再結合後の共役：f₀ を軸に折り返し' : 'ブランチ毎の共役：' + loName + ' を軸に折り返し');
  }
  // 弧のラベルをまとめて描画。
  for (const L of lateLabels) pill(L[0], L[1], L[2], L[3], 'center');
  ctx.fillStyle = T.text2; ctx.font = font(400, 12); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('グラフに触れると信号成分の位置を動かせます', g.l, 6 * d);
  // status
  // 図の下の説明文。方式Bは「打ち消せない」、提案Dは「打ち消せる」理由を周波数の数値付きで示す。
  const f1 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(0);
  const st_ = $('#howStatus');
  if (howMode === 'B') {
    // B: 複製は f₀ を軸に折り返した -fs に来るが、イメージは LO を軸に折り返した fimg にあり、両者が一致しない。
    st_.innerHTML = `<b class="ng">打ち消せない．</b>再結合後に共役をとると，複製は f₀ を軸に折り返した ${f1(-fs)} GHz にできます．イメージは ${loName} を軸に折り返した ${f1(fimg)} GHz にあるので，周波数が合いません．`;
  } else {
    // D: 複製も LO を軸に折り返されるので、イメージと同じ fimg に一致し、WLフィルタが差し引ける。
    st_.innerHTML = `<b class="ok">打ち消せる．</b>ブランチ毎に共役をとると，複製も ${loName} を軸に折り返され，イメージと同じ ${f1(fimg)} GHz にできます．WL フィルタが重みを合わせて差し引きます．`;
  }
}
// howDrag: グラフ上でドラッグ中かどうか。
let howDrag = false;
// ポインタ位置(x)を周波数に変換して信号成分 howFs を動かす。±54GHzに制限し、f₀付近(±3未満)は避ける。
function howSetFromEvent(ev){
  const r = howCv.getBoundingClientRect(), g = howGeom();
  let f = g.xf((ev.clientX - r.left) * g.d);
  f = Math.max(-54, Math.min(54, f)); if (Math.abs(f) < 3) f = f < 0 ? -3 : 3;
  howFs = Math.round(f); drawHow();
}
// タッチ/マウスで信号成分をドラッグできるようにする。
howCv.addEventListener('pointerdown', ev => {
  userAct(); howDrag = true; howCv.setPointerCapture(ev.pointerId); howSetFromEvent(ev);
});
howCv.addEventListener('pointermove', ev => { if (howDrag) howSetFromEvent(ev); });
howCv.addEventListener('pointerup', () => { howDrag = false; });
howCv.addEventListener('pointercancel', () => { howDrag = false; });
// 方式セグメント（B / D）の切替。切替時は現在位置をアニメの開始点にして、滑らかに複製を動かす。
$$('.seg button').forEach(b => b.addEventListener('click', () => {
  userAct(); if (b.dataset.m === howMode) return;
  const fs = howFs, LO = fs < 0 ? -25 : 25;
  // 旧方式での複製位置を記録（これを from にしてアニメ）。reduceMotion なら即座に完了。
  howAnimFrom = howMode === 'B' ? -fs : 2 * LO - fs;
  howMode = b.dataset.m; howAnim = reduceMotion ? 1 : 0;
  $$('.seg button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.m === howMode)));
  drawHow();
}));
// 説明用スキュー τ のスライダー。値を表示に反映して再描画（イメージの大きさが変わる）。
$('#howTau').addEventListener('input', e => { userAct(); howTau = +e.target.value; $('#howTauo').textContent = howTau.toFixed(1) + ' ps'; drawHow(); });
