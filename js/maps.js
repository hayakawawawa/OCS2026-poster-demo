// maps.js — BER マップの記録・描画と Fig.3 の自動測定（スイープ）
'use strict';
// このファイルの役割:
//  (1) 4 方式(A/B/C/D)それぞれの「スキュー τ1×τ2 平面上の BER 地図」を小さなヒートマップで描く。
//      格子は 11×11 = 121 点（±5 ps を 1 ps 刻み）で、論文 Fig.3 と同じ軸。
//  (2) 「Fig.3 を自動測定」ボタンで 121 点を順に巡って地図を一気に埋める（スイープ）。
//  実際の BER 値の蓄積は sim.js の onResult() が行い、ここはその集計結果(getMap)を描くだけ。
/* ---------- BER maps ---------- */
// 各方式のミニキャンバスを集める。data-m="A".."D" をキーに {cv, dpr, size} を保持。
const mapCvs = {}; $$('.maps canvas').forEach(c => mapCvs[c.dataset.m] = { cv: c, dpr: 1, size: 0 });
// 画面サイズ変更時に各マップの解像度(ピクセル)を合わせ直す。mapsDirty=true で再描画を予約。
function layoutMaps(){ for (const s of SCH) { const m = mapCvs[s], r = m.cv.getBoundingClientRect(); m.size = Math.floor(r.width); m.dpr = sizeCanvas(m.cv, m.size, m.size); m.cv.style.width = ''; m.cv.style.height = ''; } mapsDirty = true; }
// 現在の条件(OSNR/振幅/位相/偏波回転/CDCF の有無)に対応する地図を取り出して 4 枚描く。
function drawMaps(){
  // condKey(st): スキュー以外の条件をまとめた「地図の識別子」。条件を変えると別の地図になる。
  const m = getMap(condKey(st));
  for (const s of SCH) {
    const o = mapCvs[s]; if (!o.size) continue;
    // c: 1 マス(セル)の画素サイズ。11×11 の格子を正方形キャンバスに敷き詰める。
    const ctx = o.cv.getContext('2d'), S = o.cv.width, c = S / 11, d = o.dpr;
    // まず未測定色(mapNone)で全面を塗り、測定済みのマスだけ上書きする。
    ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle = T.mapNone; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 121; i++) {
      // bits=0 のマスはまだ測っていないので飛ばす（未測定色のまま）。
      const b = m[s].bits[i]; if (!b) continue;
      // 累積した誤りビット数/総ビット数で BER を推定。誤り 0 でも 0.5 ビット分と見て下限を与える。
      const ber = Math.max(m[s].err[i], 0.5) / b;
      // BER 10^-4..10^-1 を t=0..1 に写像し、色(良い→悪い)へ。
      const t = (Math.log10(ber) + 4) / 3;
      ctx.fillStyle = mapColor(t);
      // i を 11 で割って行・列に分解し、該当セルを塗る（+1px 重ねて隙間を防ぐ）。
      ctx.fillRect(Math.floor((i % 11) * c), Math.floor(Math.floor(i / 11) * c), Math.ceil(c), Math.ceil(c));
    }
    // 現在のスキュー位置を白い円で重ねて「今どこを見ているか」を示す（±5.5ps 内のときだけ）。
    if (Math.abs(st.tau1) <= 5.5 && Math.abs(st.tau2) <= 5.5) {
      // 横=τ2, 縦=τ1。τ1 は上が+なので (5.5 - τ1) で反転。
      const x = (st.tau2 + 5.5) / 11 * S, y = (5.5 - st.tau1) / 11 * S;
      ctx.strokeStyle = T.text; ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(x, y, Math.max(3 * d, c * 0.42), 0, 7); ctx.stroke();
    }
  }
  // 条件が初期値(DEF)と同じなら「Fig.3 と同じ軸」、変えていれば別マップである旨を注記。
  const k = condKey(st), def = condKey(DEF);
  $('#mapCond').textContent = k === def ? 'Fig. 3 と同じ軸，±5 ps' : '条件を変更中（別のマップ）';
  mapsDirty = false;
}
// 「消去」ボタン: いま見ている条件の地図だけ破棄して測り直せるようにする。
$('#clearBtn').addEventListener('click', () => { userAct(); maps.delete(condKey(st)); mapsDirty = true; setStatus('この条件のマップを消去しました．'); });
// パネル下部のステータス文を書き換える小ヘルパ（他ファイルからも使う）。
function setStatus(t){ $('#mapStatus').textContent = t; }

/* ---------- sweep (Fig. 3 reproduction) ---------- */
// スイープ = 121 点を自動で巡回して地図を埋める処理。実行中は sweep に進行状況が入る（未実行は null）。
let sweep = null;
// 各点で SETTLE ブロック分だけ等化器を馴染ませ、その後 MEAS ブロック分を測定に使う。
const SETTLE = 2, MEAS = 3;
// スイープ開始: 巡回する 121 点の並びを作って最初の点へ移動する。
function startSweep(){
  // 自動ゆらぎ(drift)と競合するので止める。pts に巡回順の [τ1,τ2] を詰める。
  stopDrift(); const pts = [];
  // 行ごとに左右の向きを交互にする（ブースト移動を減らす蛇行スキャン）。τ1 は上(+5)から下(-5)へ。
  for (let r = 0; r < 11; r++) { const t1 = 5 - r; for (let c = 0; c < 11; c++) { const t2 = (r % 2 === 0) ? c - 5 : 5 - c; pts.push([t1, t2]); } }
  // i: 現在の点番号, n: その点で経過したブロック数。
  sweep = { pts, i: 0, n: 0 };
  setTau(pts[0][0], pts[0][1], false);
  $('#sweepBtn').textContent = '測定を止める'; $('#sweepBtn').setAttribute('aria-pressed', 'true');
  setStatus('測定中 1 / 121 点');
}
// スイープ終了（手動停止・完了のどちらでも）。msg があればステータスに表示。
function stopSweep(msg){
  if (!sweep) return; sweep = null;
  $('#sweepBtn').textContent = 'Fig. 3 を自動測定'; $('#sweepBtn').setAttribute('aria-pressed', 'false');
  if (msg) setStatus(msg);
}
// 1 ブロック進むたびに onResult() から呼ばれ、スイープを一歩進める。p は今のパラメータ。
function sweepTick(p){
  const [t1, t2] = sweep.pts[sweep.i];
  // まだスキューが目標点に届いていない(=移動の過渡中)なら数えない。
  if (Math.abs(p.tau1 - t1) > 1e-9 || Math.abs(p.tau2 - t2) > 1e-9) return;
  sweep.n++;
  // 馴染ませ+測定+余白の規定ブロック数に達したら次の点へ。
  if (sweep.n >= SETTLE + MEAS + 1) {
    sweep.i++; sweep.n = 0;
    // 全点終わったら完了。
    if (sweep.i >= sweep.pts.length) { stopSweep('121 点の測定が終わりました．論文の Fig. 3 と比べてみてください．'); return; }
    const q = sweep.pts[sweep.i]; setTau(q[0], q[1], false);
    setStatus('測定中 ' + (sweep.i + 1) + ' / 121 点');
  }
}
// 「Fig.3 を自動測定」ボタン: 実行中なら停止、そうでなければ開始のトグル。
$('#sweepBtn').addEventListener('click', () => { userAct(); if (sweep) stopSweep('測定を止めました．'); else startSweep(); });
