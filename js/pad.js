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
}
// padSet：ポインタ座標を τ₁/τ₂ に変換して反映。要素内の相対位置 0..1 を ±10 ps に写像し、0.5 ps 刻みに丸める。
function padSet(e){
  const r = pad.getBoundingClientRect();
  const t2 = ((e.clientX - r.left) / r.width) * 20 - 10, t1 = 10 - ((e.clientY - r.top) / r.height) * 20;
  setTau(Math.round(t1 * 2) / 2, Math.round(t2 * 2) / 2, true);
}
// ドラッグ操作：押した指を捕捉（setPointerCapture）し、押下中の移動を τ に反映し続ける。
pad.addEventListener('pointerdown', e => { userAct(); pad.setPointerCapture(e.pointerId); padSet(e); });
pad.addEventListener('pointermove', e => { if (pad.hasPointerCapture(e.pointerId)) padSet(e); });
