// auto-register が破綻している原因の切り分け。
//
//   指標 (MI) が悪いのか / 最適化が失敗しているのか / 初期値推定が壊しているのか
// を分けて見るために、既知の正解姿勢でのスコアと、各段階の残差を並べて出す。
//
// 使い方: node scripts/reg-diag.mjs   (dev server 起動済みであること)

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const PORT = parseInt(opt('port', '3000'), 10);
const BASE = opt('base', '/metavol-web-beta2');
const CASE = opt('case', 'Hirata20260728');
const FIXED = parseInt(opt('fixed', '8'), 10);
const MOVING = parseInt(opt('moving', '14'), 10);

const URL = `http://localhost:${PORT}${BASE}/?dev=${CASE}`;
console.log(`[reg-diag] ${URL} fixed=${FIXED} moving=${MOVING}`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const ss = document.querySelector('#app')?.__vue_app__?._instance?.setupState;
    return (ss?.seriesSummariesView?.length ?? 0) > 0;
  }, null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() =>
      document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[reg-diag] loaded ${prev} series`);

  const out = await page.evaluate(async ({ FIXED, MOVING }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    d.ensureVolume_(FIXED); d.ensureVolume_(MOVING);
    await new Promise(r => setTimeout(r, 5000));
    const B = '/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([
      import(B + 'registerMrPt.ts'), import(B + 'mi.ts'), import(B + 'transform.ts')]);
    const F = d.seriesList[FIXED].volume, M = d.seriesList[MOVING].volume;
    const snap = tf.captureRegistrationSnapshot(M);

    const pts = [];
    for (const fx of [0.3, 0.5, 0.7]) for (const fy of [0.3, 0.5, 0.7]) for (const fz of [0.2, 0.5, 0.8]) {
      const i = fx * M.nx, j = fy * M.ny, k = fz * M.nz;
      pts.push([
        M.imagePosition.x + i*M.vectorX.x + j*M.vectorY.x + k*M.vectorZ.x,
        M.imagePosition.y + i*M.vectorX.y + j*M.vectorY.y + k*M.vectorZ.y,
        M.imagePosition.z + i*M.vectorX.z + j*M.vectorY.z + k*M.vectorZ.z]);
    }
    const applyP = (p, q) => { const m = tf.makeRigidMatrix(p).elements;
      return [m[0]*q[0]+m[4]*q[1]+m[8]*q[2]+m[12],
              m[1]*q[0]+m[5]*q[1]+m[9]*q[2]+m[13],
              m[2]*q[0]+m[6]*q[1]+m[10]*q[2]+m[14]]; };
    const mTRE = (perturb, found) => {
      let s = 0; for (const q of pts) { const a = applyP(found, applyP(perturb, q));
        s += Math.hypot(a[0]-q[0], a[1]-q[1], a[2]-q[2]); } return s / pts.length; };
    const invParams = (p) => tf.paramsFromMatrix(tf.makeRigidMatrix(p).clone().invert());

    const D = Math.PI/180;
    const P = [20, -15, 10, 0, 0, 0];           // 既知の摂動
    const truth = invParams(P);                  // これが正解 (戻すべき値)

    const rows = [];
    for (const o of [{ normalized:false, bodyOnly:false, name:'MI +all' },
                     { normalized:true,  bodyOnly:true,  name:'NMI+body' }]) {
      tf.applyRigidToVolume(M, snap, P);
      // --- 指標の健全性: 正解姿勢のスコアは identity より良いか ---
      const samples = mi.generateFixedSamples(F, 8000, 12345, { bodyOnly: o.bodyOnly });
      const stats = mi.estimateIntensityRange(F, M, samples);
      const score = (p) => mi.computeNegativeMI(F, M, samples, stats, p, undefined, { normalized: o.normalized });
      const sIdent = score([0,0,0,0,0,0]);
      const sTruth = score(truth);
      // 正解の周りを ±30mm 振って、正解が谷底かどうか
      const around = [];
      for (const dx of [-30,-10,10,30]) { const q=[...truth]; q[0]+=dx; around.push(+ (score(q)-sTruth).toFixed(4)); }

      // --- 初期値推定の寄与 ---
      const guess = reg.estimateInitialParams(F, M, o);
      const centroid = reg.centroidInitParams(F, M);

      // --- 最適化: identity 始動 / 正解始動 / guess 始動 ---
      const fromIdent = reg.registerMrToPt(F, M, [0,0,0,0,0,0], undefined, undefined, o);
      const fromTruth = reg.registerMrToPt(F, M, truth,         undefined, undefined, o);
      const fromGuess = reg.registerMrToPt(F, M, guess,         undefined, undefined, o);

      rows.push({
        variant: o.name,
        sIdent: +sIdent.toFixed(4), sTruth: +sTruth.toFixed(4),
        truthIsBetter: sTruth < sIdent,
        aroundTruthDelta: around,          // 正の値ばかりなら正解が谷底
        nSamples: samples.length/3,
        mTRE_start:    +mTRE(P, [0,0,0,0,0,0]).toFixed(1),
        mTRE_centroid: +mTRE(P, centroid).toFixed(1),
        mTRE_guess:    +mTRE(P, guess).toFixed(1),
        mTRE_fromIdent:+mTRE(P, fromIdent.params).toFixed(1),
        mTRE_fromTruth:+mTRE(P, fromTruth.params).toFixed(1),
        mTRE_fromGuess:+mTRE(P, fromGuess.params).toFixed(1),
      });
    }
    tf.applyRigidToVolume(M, snap, [0,0,0,0,0,0]);
    return { rows, fixedDesc: F.metadata?.seriesDescription, movingDesc: M.metadata?.seriesDescription };
  }, { FIXED, MOVING });

  console.log(`\nfixed = ${out.fixedDesc} / moving = ${out.movingDesc}`);
  for (const r of out.rows) {
    console.log(`\n--- ${r.variant} (samples=${r.nSamples}) ---`);
    console.log(`  score identity=${r.sIdent}  truth=${r.sTruth}  → truth is better? ${r.truthIsBetter}`);
    console.log(`  score delta around truth (x ±10/±30mm): ${JSON.stringify(r.aroundTruthDelta)}  (all > 0 = truth is a minimum)`);
    console.log(`  mTRE  start=${r.mTRE_start}  centroid=${r.mTRE_centroid}  guess=${r.mTRE_guess}`);
    console.log(`  mTRE  optimize from identity=${r.mTRE_fromIdent}  from truth=${r.mTRE_fromTruth}  from guess=${r.mTRE_fromGuess}`);
  }
} catch (e) {
  console.error('[reg-diag] failed:', e?.stack ?? e);
} finally {
  await browser.close();
}
