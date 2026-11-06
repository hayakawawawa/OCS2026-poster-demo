// pad.js — IQ スキュー（τ₁ / τ₂）を同時に動かす XY パッド
'use strict';
//
// パッド上をドラッグすると、縦軸＝サブバンド#1 のスキュー τ₁、横軸＝#2 の τ₂ を同時に設定できる。
// 実際の値の反映は controls.js の setTau() が行い、ここは「描画」と「ポインタ入力→τ への変換」を担当。

/* ---------- XY pad ---------- */
const pad = $('#pad');
// padSize/padDpr：現在の一辺ピクセルと描画解像度。trail：手の軌跡（過去の τ を少し残して線で描く）。
let padDpr = 1, padSize = 0;
const trail = [];
// 指ヒント：最初だけパッド上に薄く指の絵を出し「ドラッグで動かせる」ことを示す。一度操作すると消える。
// padHintShow=まだ操作されていない(=指を出す), padHintK=表示の強さ0..1(最初はフェードイン→操作後フェードアウト)。
// padFx/padFy=指先の描画位置（目標へ滑らかに追従。null は未初期化）。
let padHintShow = true, padHintK = 0, padFx = null, padFy = null;
// 操作があったら指ヒント（手の絵）と「指でドラッグ…」の文字表示を同時に消す。
// （パッドのタッチ・スライダー・各ボタン＝setTau(user) から呼ぶ。updateIdleHint は controls.js）
function dismissPadHint(){ if (padHintShow){ padHintShow = false; padDirty = true; updateIdleHint(); } }
// layoutPad：要素の実寸に合わせて正方キャンバスの解像度を設定し直し、再描画。
function layoutPad(){ const r = pad.getBoundingClientRect(); padSize = Math.floor(r.width); padDpr = sizeCanvas(pad, padSize, padSize); pad.style.width = ''; pad.style.height = ''; drawPad(); }
function drawPad(){
  if (!padSize) return;
  // R=10：軸の範囲 ±10 ps。px/py：τ 値→ピクセル。px は τ₂(横, 右が +)、py は τ₁(縦, 上が +→反転)。
  const ctx = pad.getContext('2d'), S = pad.width, d = padDpr, R = 10;
  const px = t2 => (t2 + R) / (2 * R) * S, py = t1 => (R - t1) / (2 * R) * S;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = T.surface2; ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = 1;
  // 格子：0 の軸と 5 ps ごとの線だけ描く（それ以外はスキップ）。
  for (let v = -R; v <= R; v++) {
    ctx.strokeStyle = v === 0 ? T.text2 : (v % 5 === 0 ? T.line : 'transparent');
    if (v % 5 !== 0 && v !== 0) continue;
    ctx.globalAlpha = v === 0 ? 0.5 : 1;
    ctx.beginPath(); ctx.moveTo(px(v), 0); ctx.lineTo(px(v), S); ctx.moveTo(0, py(v)); ctx.lineTo(S, py(v)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // paper range
  // 論文 Fig.3 の測定範囲（±5 ps の正方形）を破線で示す。
  ctx.strokeStyle = T.acc; ctx.lineWidth = 1.5 * d; ctx.setLineDash([5 * d, 4 * d]);
  ctx.strokeRect(px(-5), py(5), px(5) - px(-5), py(-5) - py(5)); ctx.setLineDash([]);
  ctx.fillStyle = T.acc; ctx.font = `600 ${10.5 * d}px "IBM Plex Sans JP","Hiragino Sans",sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('論文の測定範囲', px(-5) + 4 * d, py(5) - 3 * d);
  // 軸端の目盛りラベル（±10 ps）。
  ctx.fillStyle = T.text2; ctx.font = `${10 * d}px "IBM Plex Sans JP","Hiragino Sans",sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText('−10', 4 * d, py(0) + 3 * d); ctx.textAlign = 'right'; ctx.fillText('+10', S - 4 * d, py(0) + 3 * d);
  ctx.textAlign = 'left'; ctx.fillText('+10', px(0) + 4 * d, 4 * d); ctx.textBaseline = 'bottom'; ctx.fillText('−10', px(0) + 4 * d, S - 4 * d);
  // trail
  // 軌跡：古いほど薄く（透明度を i/length に比例）して線でつなぐ＝動かした跡が尾を引く。
  if (trail.length > 1) {
    ctx.lineWidth = 2 * d; ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      ctx.globalAlpha = i / trail.length * 0.6; ctx.strokeStyle = T.text;
      ctx.beginPath(); ctx.moveTo(px(trail[i - 1][1]), py(trail[i - 1][0])); ctx.lineTo(px(trail[i][1]), py(trail[i][0])); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // handle
  // 現在値のつまみ：十字の補助線＋白丸＋中心点。hx,hy は (τ₂,τ₁) の現在位置。
  const hx = px(st.tau2), hy = py(st.tau1);
  ctx.strokeStyle = T.text; ctx.lineWidth = 1 * d; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, S); ctx.moveTo(0, hy); ctx.lineTo(S, hy); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = T.surface; ctx.strokeStyle = T.text; ctx.lineWidth = 3 * d;
  ctx.beginPath(); ctx.arc(hx, hy, 12 * d, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = T.text; ctx.beginPath(); ctx.arc(hx, hy, 3.5 * d, 0, 7); ctx.fill();
  // --- 指ヒント（最初だけ：ドラッグのジェスチャーを実演。一度操作すると手・文字とも消える） ---
  // 手首は右下（パッドの外）から入り、指先がパッド内でドラッグするよう動く（シミュレーションは動かさない）。
  // 放置で自動デモ(drift)が始まったら、指はハンドルに乗って一緒に動く。
  const hintTarget = padHintShow ? 1 : 0;
  padHintK += (hintTarget - padHintK) * 0.16;           // 緩やかにフェード
  if (padHintK > 0.01) {
    const now = performance.now(), k = S / 300;          // 大きさはパッド幅に比例
    // 指先の目標位置を決める。
    let fxT, fyT;
    if (drift) {
      // 放置後の自動デモ中：指をハンドルに乗せ、一緒に動かす（＝指がドラッグしているように見せる）。
      fxT = px(st.tau2); fyT = py(st.tau1);
    } else {
      // 静止中：ドラッグのジェスチャー（ゆっくりした輪）を実演。シミュレーションは動かさない。
      const ph = now / 3400 * 2 * Math.PI;
      fxT = S * 0.6 + Math.cos(ph) * S * 0.09;
      fyT = S * 0.6 + Math.sin(ph) * S * 0.075;
    }
    if (padFx === null) { padFx = fxT; padFy = fyT; }
    padFx += (fxT - padFx) * 0.18; padFy += (fyT - padFy) * 0.18; // 目標へ滑らかに追従（ドリフト切替の飛びも吸収）
    const tx = padFx, ty = padFy;
    const a = padHintK * 0.5;                             // 薄め
    // タッチ点の波紋（指先から広がる輪）。
    const rp = (now / 1600) % 1;
    ctx.globalAlpha = padHintK * 0.55 * (1 - rp); ctx.strokeStyle = T.text; ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.arc(tx, ty, (4 + rp * 16) * d, 0, 7); ctx.stroke();
    // 手：指先 tx,ty を起点に右下（45°）へ伸ばし、こぶし〜手首〜前腕はパッド外へ抜ける。
    ctx.save(); ctx.translate(tx, ty); ctx.rotate(-Math.PI / 4); ctx.scale(k, k);
    const hand = new Path2D();
    hand.roundRect(-14.5, 0, 11, 42, 5.5);               // 人差し指（短め・親指寄り）
    hand.roundRect(-21, 32, 42, 50, 15);                 // こぶし（手の甲）＝いちばん太い部分
    hand.roundRect(-31, 40, 16, 15, 7.5);                // 親指
    hand.roundRect(-13, 72, 26, 64, 12);                 // 手首（短め・パッドの外へ）
    ctx.globalAlpha = a * 0.35; ctx.lineWidth = 7; ctx.strokeStyle = T.surface2; ctx.stroke(hand); // 格子から浮かせる下地
    ctx.globalAlpha = a; ctx.fillStyle = T.text; ctx.fill(hand);
    ctx.restore(); ctx.globalAlpha = 1;
    // 次フレームの再描画は main.js の frame() が padHintK>0 を見て駆動する。
  } else if (!padHintShow) padHintK = 0;
}
// padSet：ポインタ座標を τ₁/τ₂ に変換して反映。要素内の相対位置 0..1 を ±10 ps に写像し、0.5 ps 刻みに丸める。
function padSet(e){
  const r = pad.getBoundingClientRect();
  const t2 = ((e.clientX - r.left) / r.width) * 20 - 10, t1 = 10 - ((e.clientY - r.top) / r.height) * 20;
  setTau(Math.round(t1 * 2) / 2, Math.round(t2 * 2) / 2, true);
}
// ドラッグ操作：押した指を捕捉（setPointerCapture）し、押下中の移動を τ に反映し続ける。
pad.addEventListener('pointerdown', e => { userAct(); dismissPadHint(); pad.setPointerCapture(e.pointerId); padSet(e); });
pad.addEventListener('pointermove', e => { if (pad.hasPointerCapture(e.pointerId)) padSet(e); });
