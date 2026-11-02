// engine.js — 物理シミュレーションの中核（FFT・チャネル・各ブランチ処理・NLMS 等化器）
// createEngine() は自己完結。Web Worker 用に文字列化して渡すため、外部の変数を参照しません。
//
// 【このファイルがやること】
//   送信（16QAM 生成）→ 光ファイバのチャネル（偏波回転・波長分散・ASE 雑音）
//   → 受信フロントエンド（サブバンド分割・IQ 不平衡・スキュー）→ DSP（CDCF・共役パス）
//   → 4 方式（A/B/C/D）の等化器で等化 → BER と実効 SNR を計算、までを 1 ブロック分まとめて実行する。
//   step() を繰り返し呼ぶことで「リアルタイムに流れ続ける」ように見せている。
//
// 【信号の持ち方】
//   複素信号は { re:Float64Array(N), im:Float64Array(N) } の形（実部・虚部を別配列で保持）。
//   周波数領域と時間領域を FFT/IFFT で行き来する。周波数は「ビン番号 k」で表し、
//   sgn(k) で符号付き（-N/2..N/2）に直し、×DF で実際の周波数[Hz]になる。
//
// 【4 方式】A: 再結合後に SL 等化 / B: 再結合後に WL 等化 / C: ブランチ毎に SL 等化 / D（提案）: ブランチ毎に WL 等化
function createEngine(){
  // ---- system constants ----
  // NS: 1 ブロックのシンボル数、SPS: 1 シンボルあたりサンプル数（2 倍オーバーサンプル）、N: FFT 長
  const NS = 1024, SPS = 2, N = NS * SPS;
  // RS: シンボルレート 100 GBaud、FS: サンプルレート 200 GSa/s、DF: FFT の 1 ビンの周波数幅
  const RS = 100e9, FS = RS * SPS, DF = FS / N;          // 97.65625 MHz/bin
  // 2 サブバンドの LO 周波数オフセット（f0 ± 25 GHz）。±256 ビン ×DF がちょうど ±25 GHz になる
  const CBIN = [-256, 256];                              // LO offsets ±25 GHz (exact bins)
  // 送信ナイキストフィルタのロールオフ率
  const ALPHA = 0.1;                                     // raised-cosine roll-off
  // L: 等化器のタップ数（2 sps で 25 タップ）、HC: 中央タップの位置
  const L = 25, HC = (L - 1) >> 1;                       // taps (2 sps)
  // 波長・分散値(17 ps/nm/km)・ファイバ長 500 km・光速
  const LAMBDA = 1550e-9, DISP = 17e-6, LEN = 500e3, CL = 299792458;
  // 波長分散の位相係数。分散による位相は CDK×f^2 で与えられる（f は周波数[Hz]）
  const CDK = Math.PI * LAMBDA * LAMBDA * DISP * LEN / CL; // CD phase = CDK f^2
  // FE_BW: フロントエンド帯域 33 GHz、ADC_NYQ: ADC のナイキスト、WSS_BW: WSS 通過帯域、XOVER: BPF の遷移幅
  const FE_BW = 33e9, ADC_NYQ = 40e9, WSS_BW = 60e9, XOVER = 2e9;
  // 16QAM の正規化係数（平均電力 1 にするため各振幅を √10 で割る）
  const SQ10 = Math.sqrt(10);
  // 16QAM を構成する 4 値 PAM の振幅レベル（-3,-1,+1,+3 を正規化）
  const LV = [-3 / SQ10, -1 / SQ10, 1 / SQ10, 3 / SQ10];
  // GRAY: 4 レベル → グレイ符号のビット列、POP: XOR 結果ごとのビット誤り数（ハミング重み）
  const GRAY = [0, 1, 3, 2];
  const POP = [0, 1, 1, 2];

  // ---- FFT ----
  // ビット反転並べ替え表 REV と回転因子（twiddle）テーブル COS/SIN を前計算しておく基数 2 の FFT
  const LOG2N = Math.round(Math.log2(N));
  const REV = new Uint32Array(N);
  // 各インデックス i のビットを反転した値を REV[i] に用意（FFT 入力の並べ替え用）
  for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < LOG2N; b++) { r = (r << 1) | (x & 1); x >>= 1; } REV[i] = r; }
  const COS = new Float64Array(N / 2), SIN = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / N); SIN[i] = Math.sin(2 * Math.PI * i / N); }
  // その場（in-place）FFT。inv=true で逆変換（最後に 1/N でスケール）。re/im は破壊的に書き換えられる
  function fft(re, im, inv) {
    // 1) ビット反転で並べ替え
    for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    // 2) バタフライ演算（段を倍々にしながら合成）
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = COS[k], wi = inv ? SIN[k] : -SIN[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    // 逆変換のときだけ 1/N スケーリング
    if (inv) { const s = 1 / N; for (let i = 0; i < N; i++) { re[i] *= s; im[i] *= s; } }
  }
  // sgn: ビン番号 k を符号付き周波数インデックス(-N/2..N/2)へ。wrap: 範囲外インデックスを 0..N-1 に丸める
  const sgn = k => (k < N / 2 ? k : k - N);
  const wrap = m => ((m % N) + N) % N;
  // F64: 長さ N の実数バッファ、cpx: 実部・虚部ペアの複素バッファを確保するショートカット
  const F64 = () => new Float64Array(N);
  const cpx = () => ({ re: F64(), im: F64() });

  // ---- static filters ----
  // 毎回同じなので前計算しておく各種フィルタ（周波数領域の振幅・位相）
  // FB[k]: 各ビンの符号付き周波数[Hz]
  const FB = F64(); for (let k = 0; k < N; k++) FB[k] = sgn(k) * DF;
  // HTX: 送信レイズドコサインの振幅特性（f1 まで通過、f1〜f2 でコサインロールオフ）
  const HTX = F64();
  for (let k = 0; k < N; k++) {
    const f = Math.abs(FB[k]), f1 = (1 - ALPHA) * RS / 2, f2 = (1 + ALPHA) * RS / 2;
    let h = 0; if (f <= f1) h = 1; else if (f < f2) h = 0.5 * (1 + Math.cos(Math.PI / (ALPHA * RS) * (f - f1)));
    HTX[k] = 2 * h;
  }
  // HCD: ファイバの波長分散（全域の位相回転 e^{-j CDK f^2}。振幅は変えない全通過特性）
  const HCD = cpx();
  for (let k = 0; k < N; k++) { const p = -CDK * FB[k] * FB[k]; HCD.re[k] = Math.cos(p); HCD.im[k] = Math.sin(p); }
  // HFE: 受信フロントエンドのローパス（8 次の超ガウス型。ADC ナイキスト以上は完全に遮断）
  const HFE = F64();
  for (let k = 0; k < N; k++) { const f = Math.abs(FB[k]); HFE[k] = f >= ADC_NYQ ? 0 : 1 / Math.sqrt(1 + Math.pow(f / FE_BW, 8)); }
  // INWSS: ASE 雑音を載せる帯域マスク（WSS 通過帯域の内側なら 1）
  const INWSS = new Uint8Array(N); for (let k = 0; k < N; k++) INWSS[k] = Math.abs(FB[k]) <= WSS_BW ? 1 : 0;
  // per-branch CDCF / BPF / rotation (branch baseband coordinate m; optical f = (m + c) DF)
  // サブバンドごと（2 本）に前計算する: cd=分散補償 CDCF、bpf=サブバンド選択フィルタ、
  //   rot=再結合時に元の LO 位置へ戻す時間領域の回転、src=ブランチのベースバンドビン → 受信光ビンの対応表。
  //   c はそのブランチの LO オフセット（ビン）、m はブランチ内のベースバンド周波数、光周波数は (m + c)×DF。
  const BR = CBIN.map((c, b) => {
    const cd = cpx(), bpf = F64(), rot = cpx(), src = new Int32Array(N);
    for (let k = 0; k < N; k++) {
      const m = sgn(k), fo = (m + c) * DF;
      // CDCF は光周波数 fo での分散を打ち消す補償位相 e^{+j CDK fo^2}
      const p = CDK * fo * fo; cd.re[k] = Math.cos(p); cd.im[k] = Math.sin(p);
      // サブバンド選択フィルタ: 境界(f0)付近を cos^2 で滑らかに分割。branch0 は低域側、branch1 は高域側
      const u = Math.min(1, Math.max(0, (fo + XOVER / 2) / XOVER));
      const lo = Math.cos(Math.PI * u / 2) ** 2;
      bpf[k] = b === 0 ? lo : 1 - lo;
      // src: 光ビン s=(m+c) が範囲内なら対応する受信ビン番号、範囲外なら -1（信号なし）
      const s = m + c; src[k] = (s >= -N / 2 && s < N / 2) ? wrap(s) : -1;
    }
    // rot: 時間領域で e^{j 2π c n / N} をかけると周波数が +c ビンだけシフト（再結合時に元の位置へ戻す）
    for (let n = 0; n < N; n++) { const p = 2 * Math.PI * c * n / N; rot.re[n] = Math.cos(p); rot.im[n] = Math.sin(p); }
    return { c, cd, bpf, rot, src };
  });

  // ---- RNG ----
  // 乱数生成（毎回同じ系列になるよう固定シード）。rnd=xorshift32 で [0,1)、gauss=正規乱数（ASE 雑音用）
  let seed = 0x9e3779b9 >>> 0;
  function rnd() { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; }
  // Box-Muller 法。1 回の計算で 2 個作れるので片方を gSpare に取っておく
  let gSpare = null;
  function gauss() {
    if (gSpare !== null) { const g = gSpare; gSpare = null; return g; }
    let u = 0; while (u < 1e-12) u = rnd();
    const v = rnd(), r = Math.sqrt(-2 * Math.log(u));
    gSpare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v);
  }

  // ---- buffers ----
  // 毎ブロック使い回す作業バッファ（確保のやり直しを避けて高速化）
  // sym: 送信シンボルの 4 値インデックス（x/y 偏波 × I/Q）
  const sym = { xi: new Uint8Array(NS), xq: new Uint8Array(NS), yi: new Uint8Array(NS), yq: new Uint8Array(NS) };
  // TX: 送信スペクトル、DT: 理想（所望）全帯域波形（時間領域, 等化の目標）、RX: 受信スペクトル（各偏波）
  const TX = [cpx(), cpx()], DT = [cpx(), cpx()], RX = [cpx(), cpx()];
  // tmp/tmp2: 一時作業用
  const tmp = cpx(), tmp2 = cpx();
  // BIN: ブランチ毎・偏波毎に d=直接パス、c=共役パス、des=所望信号（参照）を持つ
  const BIN = [0, 1].map(() => ({ d: [cpx(), cpx()], c: [cpx(), cpx()], des: [cpx(), cpx()] }));
  // REC: 再結合後の信号（偏波毎、方式 A/B 用）
  const REC = [cpx(), cpx()];
  // ext: 等化器入力用の拡張バッファ（巡回畳み込みのため先頭に L-1 だけ余白を持たせる）
  const ext = () => ({ re: new Float64Array(N + L - 1), im: new Float64Array(N + L - 1) });

  // 等化器 1 基を作る。nIn: 複素入力の本数、xIdx/yIdx: 初期化で単位応答にする入力の番号（x/y 偏波の対角）
  function makeEq(nIn, xIdx, yIdx) {
    // 各タップ重みは実部(xr,yr)・虚部(xi,yi)。x 出力用と y 出力用をそれぞれ nIn×L 本持つ
    const w = { xr: new Float64Array(nIn * L), xi: new Float64Array(nIn * L), yr: new Float64Array(nIn * L), yi: new Float64Array(nIn * L), nIn, xIdx, yIdx };
    // reset: 重みを 0 に戻し、対角入力の中央タップだけ 1（= 恒等＝素通し）に初期化
    w.reset = () => { w.xr.fill(0); w.xi.fill(0); w.yr.fill(0); w.yi.fill(0); w.xr[xIdx * L + HC] = 1; w.yr[yIdx * L + HC] = 1; };
    // ins: 各入力の拡張バッファ、ox/oy: 2 偏波の出力
    w.reset(); w.ins = []; for (let i = 0; i < nIn; i++) w.ins.push(ext()); w.ox = cpx(); w.oy = cpx();
    return w;
  }
  // Schemes: A post-rec SL, B post-rec WL, C per-branch SL, D per-branch WL
  // 方式ごとの等化器構成:
  //   A: 再結合後に 1 基・2 入力（X,Y）の SL（線形）
  //   B: 再結合後に 1 基・4 入力（X,X*,Y,Y*）の WL（広義線形＝共役も入力に使う）
  //   C: ブランチ毎に 1 基ずつ（計 2 基）・各 2 入力の SL
  //   D（提案）: ブランチ毎に 1 基ずつ・各 4 入力の WL（直接＋共役）
  const EQ = {
    A: [makeEq(2, 0, 1)],
    B: [makeEq(4, 0, 2)],
    C: [makeEq(2, 0, 1), makeEq(2, 0, 1)],
    D: [makeEq(4, 0, 2), makeEq(4, 0, 2)]
  };
  const SCHEMES = ['A', 'B', 'C', 'D'];

  // 時間領域の複素信号 src を等化器入力 e へコピー。conj=true なら虚部を反転（共役入力 X* 用）。
  // 先頭の HC 分を巡回でずらして入れておき、畳み込みで中央タップが合うようにする
  function fillExt(e, src, conj) {
    const sr = src.re, si = src.im, er = e.re, ei = e.im, s = conj ? -1 : 1;
    for (let j = 0; j < N + L - 1; j++) { const k = (j - HC + N) % N; er[j] = sr[k]; ei[j] = s * si[k]; }
  }

  // NLMS 等化器の 1 ブロック実行。各出力サンプル n について nIn 入力×L タップを畳み込み、
  //   mu>0 なら所望信号 dX,dY との誤差で重みを正規化 LMS 更新する（mu=学習率、mu=0 なら更新せず出力のみ）
  function runEq(w, dX, dY, mu) {
    const nIn = w.nIn, ins = w.ins, xr = w.xr, xi = w.xi, yr = w.yr, yi = w.yi;
    const oxr = w.ox.re, oxi = w.ox.im, oyr = w.oy.re, oyi = w.oy.im;
    const dxr = dX.re, dxi = dX.im, dyr = dY.re, dyi = dY.im;
    for (let n = 0; n < N; n++) {
      // axr..ayi: x/y 出力の複素アキュムレータ、en: 入力エネルギー（正規化用, 0 割り防止に 1e-9）
      let axr = 0, axi = 0, ayr = 0, ayi = 0, en = 1e-9;
      // 全入力・全タップで複素積和（フィルタ本体）
      for (let i = 0; i < nIn; i++) {
        const er = ins[i].re, ei = ins[i].im, b = i * L;
        for (let l = 0; l < L; l++) {
          const ur = er[n + l], ui = ei[n + l], q = b + l;
          const a1 = xr[q], a2 = xi[q], b1 = yr[q], b2 = yi[q];
          axr += a1 * ur - a2 * ui; axi += a1 * ui + a2 * ur;
          ayr += b1 * ur - b2 * ui; ayi += b1 * ui + b2 * ur;
          en += ur * ur + ui * ui;
        }
      }
      oxr[n] = axr; oxi[n] = axi; oyr[n] = ayr; oyi[n] = ayi;
      // 学習: 誤差 e = 所望 - 出力 を入力エネルギーで正規化して各タップに反映
      if (mu > 0) {
        const g = mu / en;
        const exr = (dxr[n] - axr) * g, exi = (dxi[n] - axi) * g, eyr = (dyr[n] - ayr) * g, eyi = (dyi[n] - ayi) * g;
        for (let i = 0; i < nIn; i++) {
          const er = ins[i].re, ei = ins[i].im, b = i * L;
          for (let l = 0; l < L; l++) {
            const ur = er[n + l], ui = ei[n + l], q = b + l;
            // w += e × conj(入力)（複素共役相関で更新）
            xr[q] += exr * ur + exi * ui; xi[q] += exi * ur - exr * ui;
            yr[q] += eyr * ur + eyi * ui; yi[q] += eyi * ur - eyr * ui;
          }
        }
      }
    }
  }

  // ---- state ----
  // P: 外から設定されるパラメータ（スキュー tau1/2, 振幅/位相不平衡, OSNR, 偏波回転 ON, 共役CDCF ON, 学習率 mu）
  const P = { tau1: 0, tau2: 0, amp1: 0, amp2: 0, ph1: 0, ph2: 0, snrDb: 17, sopRot: false, conjCDCF: true, mu: 0.03 };
  // 偏波状態(SOP)の 2 角度。sopRot が ON なら毎ブロック少しずつ回す
  let sopT = 0.62, sopP = 0.35;
  // setParams: UI から渡された値のうち P にあるキーだけ反映。resetEq: 全方式の等化器を初期化（学習やり直し）
  function setParams(p) { for (const k in p) if (k in P) P[k] = p[k]; }
  function resetEq() { for (const s of SCHEMES) for (const w of EQ[s]) w.reset(); }

  // 4 値 PAM の判定（しきい値 -2,0,+2 を √10 スケールで）。復調のシンボル判定に使う
  function decide(v) { const t = v * SQ10; return t < -2 ? 0 : t < 0 ? 1 : t < 2 ? 2 : 3; }

  // 1 ブロック分のシミュレーションを実行し、方式ごとの結果（誤り数・MSE・表示用点列）を返す
  function step() {
    // 1) symbols & transmitter
    // 送信: 偏波ごとに 16QAM シンボルを乱数生成 → 2 sps で零詰めアップサンプル → FFT → 送信 RC 整形。
    //       DT は等化の目標となる理想全帯域波形（整形後スペクトルを IFFT したもの）
    const S = [[sym.xi, sym.xq], [sym.yi, sym.yq]];
    for (let p = 0; p < 2; p++) {
      const [ai, aq] = S[p]; const t = TX[p];
      t.re.fill(0); t.im.fill(0);
      // I/Q それぞれ 4 値をランダムに選び、偶数サンプル位置に配置（奇数は 0＝アップサンプル）
      for (let m = 0; m < NS; m++) { ai[m] = (rnd() * 4) | 0; aq[m] = (rnd() * 4) | 0; t.re[2 * m] = LV[ai[m]]; t.im[2 * m] = LV[aq[m]]; }
      fft(t.re, t.im, false);
      for (let k = 0; k < N; k++) { t.re[k] *= HTX[k]; t.im[k] *= HTX[k]; }
      DT[p].re.set(t.re); DT[p].im.set(t.im); fft(DT[p].re, DT[p].im, true); // ideal full-band waveform
    }
    // 2) channel: SOP + CD + ASE
    // チャネル: 偏波回転（ジョーンズ行列 J）→ 波長分散（HCD）→ 帯域内に ASE 雑音を加算
    if (P.sopRot) { sopT += 0.012; sopP += 0.009; }
    const c = Math.cos(sopT), s = Math.sin(sopT), cp = Math.cos(sopP), sp = Math.sin(sopP);
    // J = [[c e^{jp}, -s],[s, c e^{-jp}]]
    // OSNR から雑音標準偏差 sd を決める（snrDb が大きいほど雑音は小さい）
    const snr = Math.pow(10, P.snrDb / 10), sd = Math.sqrt(N / snr);
    for (let k = 0; k < N; k++) {
      const xr = TX[0].re[k], xi = TX[0].im[k], yr = TX[1].re[k], yi = TX[1].im[k];
      // 偏波回転 J を 2 偏波に適用
      let rxr = c * (cp * xr - sp * xi) - s * yr, rxi = c * (cp * xi + sp * xr) - s * yi;
      let ryr = s * xr + c * (cp * yr + sp * yi), ryi = s * xi + c * (cp * yi - sp * yr);
      // 波長分散 HCD（複素乗算）を 2 偏波に適用
      const hr = HCD.re[k], hi = HCD.im[k];
      let t1 = rxr * hr - rxi * hi, t2 = rxr * hi + rxi * hr; rxr = t1; rxi = t2;
      t1 = ryr * hr - ryi * hi; t2 = ryr * hi + ryi * hr; ryr = t1; ryi = t2;
      // WSS 帯域内にだけ ASE（ガウス雑音）を加える
      if (INWSS[k]) { rxr += sd * gauss(); rxi += sd * gauss(); ryr += sd * gauss(); ryi += sd * gauss(); }
      RX[0].re[k] = rxr; RX[0].im[k] = rxi; RX[1].re[k] = ryr; RX[1].im[k] = ryi;
    }
    // 3) receiver branches
    // 受信: サブバンド（2 本）× 偏波（2）ごとに、フロントエンド→IQ 不平衡→DSP（直接/共役）を行う
    // tau: スキュー[s]、gain: 振幅不平衡（dB→線形）、phi: 直交位相誤差[rad]（各サブバンド独立）
    const tau = [P.tau1 * 1e-12, P.tau2 * 1e-12];
    const gain = [Math.pow(10, P.amp1 / 20), Math.pow(10, P.amp2 / 20)];
    const phi = [P.ph1 * Math.PI / 180, P.ph2 * Math.PI / 180];
    for (let b = 0; b < 2; b++) {
      const br = BR[b], bn = BIN[b];
      const cph = Math.cos(phi[b]), sph = Math.sin(phi[b]), g = gain[b];
      for (let p = 0; p < 2; p++) {
        // frontend: shift to branch baseband + LPF
        // フロントエンド: 受信スペクトルをこのブランチのベースバンドへ周波数シフト（src で対応付け）し、HFE で帯域制限
        const R = RX[p], X = tmp;
        for (let k = 0; k < N; k++) { const q = br.src[k]; if (q < 0) { X.re[k] = 0; X.im[k] = 0; } else { X.re[k] = R.re[q] * HFE[k]; X.im[k] = R.im[q] * HFE[k]; } }
        // IQ imbalance: Q' = g (Q cos phi + I sin phi) delayed by tau  (frequency domain)
        // IQ 不平衡（周波数領域）: X(f) と conj X(-f) から I 成分・Q 成分を分離し、Q に振幅誤差 g・位相誤差 phi・スキュー tau を与えて再合成
        const Y = tmp2;
        for (let k = 0; k < N; k++) {
          const km = wrap(-sgn(k));
          const ar = X.re[k], ai = X.im[k], br_ = X.re[km], bi = -X.im[km]; // X(f), conj X(-f)
          // I = (X(f)+conjX(-f))/2
          const Ir = (ar + br_) / 2, Ii = (ai + bi) / 2;
          // Q = -j (X - Xm)/2
          const Qr = (ai - bi) / 2, Qi = -(ar - br_) / 2;
          // Q 側に振幅 g・位相誤差（cph,sph）を適用
          let qr = g * (Qr * cph + Ir * sph), qi = g * (Qi * cph + Ii * sph);
          // スキュー tau = 周波数に比例した位相回転（時間遅延）を Q 側にかける
          const ph = -2 * Math.PI * FB[k] * tau[b], dr = Math.cos(ph), di = Math.sin(ph);
          const t1 = qr * dr - qi * di, t2 = qr * di + qi * dr; qr = t1; qi = t2;
          Y.re[k] = Ir - qi; Y.im[k] = Ii + qr; // I + j Q'
        }
        // DSP: direct & conjugate paths with CDCF + BPF
        // DSP: 直接パス Dd（CDCF＋サブバンド BPF）と共役パス Cc を作る。
        //   共役は WL 等化で IQ イメージを打ち消すための入力。conjCDCF が ON なら「共役→同じ CDCF」の順（提案手法）
        const Dd = bn.d[p], Cc = bn.c[p];
        for (let k = 0; k < N; k++) {
          const km = wrap(-sgn(k));
          const hr = br.cd.re[k], hi = br.cd.im[k], w = br.bpf[k];
          // 直接パス: CDCF で分散補償してから BPF
          Dd.re[k] = (Y.re[k] * hr - Y.im[k] * hi) * w; Dd.im[k] = (Y.re[k] * hi + Y.im[k] * hr) * w;
          if (P.conjCDCF) {
            // 提案: 先に共役 conj Y(-f) をとり、その上で同じ CDCF をかける（複製にも同じ残留分散が乗り短タップで打ち消せる）
            const zr = Y.re[km], zi = -Y.im[km];
            Cc.re[k] = (zr * hr - zi * hi) * w; Cc.im[k] = (zr * hi + zi * hr) * w;
          } else { // conjugate taken after CDCF (ablation)
            // アブレーション: CDCF をかけてから共役（＝共役パスに CDCF を適用しない場合）。提案要素を 1 つ外した比較用
            const h2r = br.cd.re[km], h2i = br.cd.im[km];
            const vr = Y.re[km] * h2r - Y.im[km] * h2i, vi = Y.re[km] * h2i + Y.im[km] * h2r;
            Cc.re[k] = vr * w; Cc.im[k] = -vi * w;
          }
        }
        // 直接/共役パスを時間領域に戻す
        fft(Dd.re, Dd.im, true); fft(Cc.re, Cc.im, true);
        // per-branch desired signal (theta = 0 : no laser phase noise in this demo)
        // 所望信号 De: 送信スペクトルをこのブランチの BPF で切り出した「このブランチが受け持つべき理想波形」（レーザ位相雑音は θ=0 で省略）
        const De = bn.des[p], T = TX[p];
        for (let k = 0; k < N; k++) { const q = br.src[k]; if (q < 0) { De.re[k] = 0; De.im[k] = 0; } else { De.re[k] = T.re[q] * br.bpf[k]; De.im[k] = T.im[q] * br.bpf[k]; } }
        fft(De.re, De.im, true);
      }
    }
    // 4) post-recombination signals (direct paths only)
    // 方式 A/B 用に、各ブランチの直接パスを rot で元の LO 位置へ戻して足し合わせた再結合信号 REC を作る
    for (let p = 0; p < 2; p++) {
      const o = REC[p]; o.re.fill(0); o.im.fill(0);
      for (let b = 0; b < 2; b++) {
        const d = BIN[b].d[p], r = BR[b].rot;
        for (let n = 0; n < N; n++) { o.re[n] += d.re[n] * r.re[n] - d.im[n] * r.im[n]; o.im[n] += d.re[n] * r.im[n] + d.im[n] * r.re[n]; }
      }
    }
    const mu = P.mu;
    // A
    // A: 再結合信号 REC(X,Y) を 2 入力で SL 等化。目標は理想全帯域波形 DT
    { const w = EQ.A[0]; fillExt(w.ins[0], REC[0]); fillExt(w.ins[1], REC[1]); runEq(w, DT[0], DT[1], mu); }
    // B
    // B: 再結合信号を 4 入力（X, X*, Y, Y*）で WL 等化（再結合後に共役をとる方式）
    { const w = EQ.B[0]; fillExt(w.ins[0], REC[0]); fillExt(w.ins[1], REC[0], true); fillExt(w.ins[2], REC[1]); fillExt(w.ins[3], REC[1], true); runEq(w, DT[0], DT[1], mu); }
    // C, D
    // C: ブランチ毎に 2 入力 SL、D（提案）: ブランチ毎に 4 入力 WL（直接＋共役）。目標は各ブランチの所望信号 des
    for (let b = 0; b < 2; b++) {
      const bn = BIN[b];
      const wc = EQ.C[b]; fillExt(wc.ins[0], bn.d[0]); fillExt(wc.ins[1], bn.d[1]); runEq(wc, bn.des[0], bn.des[1], mu);
      const wd = EQ.D[b]; fillExt(wd.ins[0], bn.d[0]); fillExt(wd.ins[1], bn.c[0]); fillExt(wd.ins[2], bn.d[1]); fillExt(wd.ins[3], bn.c[1]); runEq(wd, bn.des[0], bn.des[1], mu);
    }
    // 5) recombine per-branch outputs and evaluate
    // 各方式の最終出力を作り、BER（誤りビット数）と MSE（誤差電力）を計算
    const res = {};
    for (const sc of SCHEMES) {
      let ox, oy;
      // A/B は等化器出力がそのまま最終出力
      if (sc === 'A' || sc === 'B') { ox = EQ[sc][0].ox; oy = EQ[sc][0].oy; }
      else {
        // C/D はブランチ毎の出力を rot で元の位置に戻して足し合わせ、全帯域の出力に再結合
        ox = { re: new Float64Array(N), im: new Float64Array(N) }; oy = { re: new Float64Array(N), im: new Float64Array(N) };
        for (let b = 0; b < 2; b++) {
          const w = EQ[sc][b], r = BR[b].rot;
          for (let n = 0; n < N; n++) {
            ox.re[n] += w.ox.re[n] * r.re[n] - w.ox.im[n] * r.im[n]; ox.im[n] += w.ox.re[n] * r.im[n] + w.ox.im[n] * r.re[n];
            oy.re[n] += w.oy.re[n] * r.re[n] - w.oy.im[n] * r.im[n]; oy.im[n] += w.oy.re[n] * r.im[n] + w.oy.im[n] * r.re[n];
          }
        }
      }
      // シンボル位置（2 sps なので偶数サンプル）だけ取り出して判定・誤り数え・誤差電力を集計
      let err = 0, se = 0; const pts = new Float32Array(2 * NS);
      for (let m = 0; m < NS; m++) {
        const n = 2 * m;
        const vxr = ox.re[n], vxi = ox.im[n], vyr = oy.re[n], vyi = oy.im[n];
        // pts: コンスタレーション表示用に X 偏波の (I,Q) を記録
        pts[2 * m] = vxr; pts[2 * m + 1] = vxi;
        // 判定値と送信値をグレイ符号で比較し、POP でビット誤り数を加算
        const a = [decide(vxr), decide(vxi), decide(vyr), decide(vyi)];
        const t = [sym.xi[m], sym.xq[m], sym.yi[m], sym.yq[m]];
        for (let j = 0; j < 4; j++) err += POP[GRAY[a[j]] ^ GRAY[t[j]]];
        // 理想点との距離二乗を MSE（→実効 SNR）用に積算
        const exr = vxr - LV[t[0]], exi = vxi - LV[t[1]], eyr = vyr - LV[t[2]], eyi = vyi - LV[t[3]];
        se += exr * exr + exi * exi + eyr * eyr + eyi * eyi;
      }
      // bits: 1 ブロックの総ビット数（NS シンボル×4 次元×2 bit）、mse: 1 次元あたりの平均二乗誤差
      res[sc] = { err, bits: NS * 8, mse: se / (2 * NS), pts };
    }
    return res;
  }
  // 外へ公開する API（UI 側はこれだけを使う）
  return { step, setParams, resetEq, P, NS, L, consts: { RS, DF, CBIN, LEN, FE_BW } };
}
