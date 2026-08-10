// auto-register の精度を **実データで数値評価**するスクリプト。
//
// 前提: dev server を起動しておく (npm run dev)。
// 使い方:
//   node scripts/reg-eval.mjs
//   node scripts/reg-eval.mjs --case Hirata20260728 --fixed 8 --moving 14
//
// ---- 何を正解とするか ----
// Hirata20260728 の "CT TRANSAXIAL+" (series 8) と "PET TRANSAXIAL" (series 14) は
// **同一 FrameOfReferenceUID** = 同じ PET/CT 装置が同一座標系で撮ったもので、既に正しく
// 位置が合っている。これを ground truth とし、
//   1. PET に既知の剛体変換 P を掛けてわざとずらす
//   2. auto-register を走らせて戻させる
//   3. 残差 = (戻した後の姿勢) と (正解姿勢) の差
// を測る。残差は体内の代表点群の平均変位 (mTRE, mm) で表す。
//
// 出力は variant (MI/NMI × 全体サンプル/体内サンプル) ごとの mTRE 表。

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const PORT = parseInt(opt('port', '3000'), 10);
const BASE = opt('base', '/metavol-web-beta2');
const CASE = opt('case', 'Hirata20260728');
const FIXED = parseInt(opt('fixed', '8'), 10);
const MOVING = parseInt(opt('moving', '14'), 10);
const LOAD_TIMEOUT_MS = parseInt(opt('load-timeout', '900000'), 10);

const URL = `http://localhost:${PORT}${BASE}/?dev=${CASE}`;
console.log(`[reg-eval] ${URL}  fixed=series${FIXED} moving=series${MOVING}`);

const browser = await chromium.launch({ headless: true });
let exitCode = 0;
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // シリーズが出揃うまで待つ (逐次ロードなので件数が増えなくなるまで)
  console.log('[reg-eval] waiting for series to load…');
  await page.waitForFunction(() => {
    const ss = document.querySelector('#app')?.__vue_app__?._instance?.setupState;
    return (ss?.seriesSummariesView?.length ?? 0) > 0;
  }, null, { timeout: LOAD_TIMEOUT_MS });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() =>
      document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[reg-eval] loaded ${prev} series`);

  const result = await page.evaluate(async ({ FIXED, MOVING }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    d.ensureVolume_(FIXED); d.ensureVolume_(MOVING);
    await new Promise(r => setTimeout(r, 5000));
    const B = '/metavol-web-beta2/src/components/registration/';
    const [reg, tf] = await Promise.all([import(B + 'registerMrPt.ts'), import(B + 'transform.ts')]);
    const F = d.seriesList[FIXED].volume, M = d.seriesList[MOVING].volume;
    if (!F || !M) return { error: 'volume missing' };

    // 正解姿勢を snapshot として確保 (以後の applyRigidToVolume はここからの相対)
    const snap = tf.captureRegistrationSnapshot(M);

    // mTRE 用の代表点: moving volume 内に格子状 (正解姿勢での world 座標)
    const pts = [];
    for (const fx of [0.3, 0.5, 0.7]) for (const fy of [0.3, 0.5, 0.7]) for (const fz of [0.2, 0.5, 0.8]) {
      const i = fx * M.nx, j = fy * M.ny, k = fz * M.nz;
      pts.push([
        M.imagePosition.x + i * M.vectorX.x + j * M.vectorY.x + k * M.vectorZ.x,
        M.imagePosition.y + i * M.vectorX.y + j * M.vectorY.y + k * M.vectorZ.y,
        M.imagePosition.z + i * M.vectorX.z + j * M.vectorY.z + k * M.vectorZ.z,
      ]);
    }
    // 剛体パラメータ p を world 点に適用する (makeRigidMatrix と同じ規約)
    const applyP = (p, q) => {
      const m = tf.makeRigidMatrix(p).elements;   // column-major
      return [
        m[0]*q[0] + m[4]*q[1] + m[8]*q[2]  + m[12],
        m[1]*q[0] + m[5]*q[1] + m[9]*q[2]  + m[13],
        m[2]*q[0] + m[6]*q[1] + m[10]*q[2] + m[14],
      ];
    };
    // net = found ∘ perturb。正解なら恒等 → 変位 0
    const mTRE = (perturb, found) => {
      let s = 0;
      for (const q of pts) {
        const a = applyP(found, applyP(perturb, q));
        s += Math.hypot(a[0]-q[0], a[1]-q[1], a[2]-q[2]);
      }
      return s / pts.length;
    };

    const D = Math.PI / 180;
    const perturbs = [
      { name: 'T20',        p: [20, -15, 10, 0, 0, 0] },
      { name: 'T30+R5',     p: [30, 20, -25, 5*D, -3*D, 4*D] },
      { name: 'T10+R3',     p: [-10, 8, 12, -3*D, 2*D, -2*D] },
      { name: 'T50 (large)',p: [45, -35, 40, 0, 0, 0] },
    ];
    // **パイプライン構成の比較。** 指標 (MI/NMI) ではなく、初期値推定とピラミッドの
    // 有無で切る。診断で「guess が数百 mm 飛ばす」「ピラミッドが正解から離す」と出たため。
    const O = { normalized: false, bodyOnly: false };
    // 2026-08 再測定: applyRigidToVolume の正規化バグ (voxel pitch 破壊) と
    // estimateIntensityRange の姿勢依存バグ (MI が恒等的に 0) を直した後の比較。
    // 以前の結論 (CLAUDE.md 3.58) はこの 2 つのバグの上に立てたもので信頼できない。
    const variants = [
      { name: 'A centroid + pyr[4,2,1]',   guess: true,  o: { ...O } },
      { name: 'B no-init + pyr[4,2,1]',    guess: false, o: { ...O } },
      { name: 'C centroid + pyr[2,1]',     guess: true,  o: { ...O, factors: [2,1], samples: [8000,8000] } },
      { name: 'D centroid + single[1]',    guess: true,  o: { ...O, factors: [1],   samples: [12000] } },
      { name: 'E no-init + single[1]',     guess: false, o: { ...O, factors: [1],   samples: [12000] } },
    ];

    const rows = [];
    for (const v of variants) {
      for (const pb of perturbs) {
        tf.applyRigidToVolume(M, snap, pb.p);       // わざとずらす
        const t0 = performance.now();
        const start = v.guess ? reg.centroidInitParams(F, M) : [0,0,0,0,0,0];
        const res = reg.registerMrToPt(F, M, start, undefined, undefined, v.o);
        const ms = Math.round(performance.now() - t0);
        rows.push({ variant: v.name, perturb: pb.name,
                    startMTRE: +mTRE(pb.p, [0,0,0,0,0,0]).toFixed(1),
                    guessMTRE: +mTRE(pb.p, start).toFixed(1),
                    mTRE: +mTRE(pb.p, res.params).toFixed(1), ms });
      }
    }
    tf.applyRigidToVolume(M, snap, [0,0,0,0,0,0]);  // 後始末
    return { rows };
  }, { FIXED, MOVING });

  if (result.error) { console.error('[reg-eval] ' + result.error); exitCode = 2; }
  else {
    const byVariant = new Map();
    console.log('\n variant                            perturb       start   guess   after     ms');
    console.log(' ' + '-'.repeat(80));
    for (const r of result.rows) {
      console.log(` ${r.variant.padEnd(34)} ${r.perturb.padEnd(13)} ${String(r.startMTRE).padStart(5)} ${String(r.guessMTRE).padStart(7)} ${String(r.mTRE).padStart(7)} ${String(r.ms).padStart(6)}`);
      if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
      byVariant.get(r.variant).push(r.mTRE);
    }
    console.log('\n mean mTRE by variant:');
    for (const [k, v] of byVariant) {
      console.log(`   ${k.padEnd(30)} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} mm`);
    }
  }
} catch (e) {
  console.error('[reg-eval] failed:', e?.message ?? e);
  exitCode = 2;
} finally {
  await browser.close();
}
process.exit(exitCode);
