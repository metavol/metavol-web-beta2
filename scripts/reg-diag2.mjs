// 破綻箇所をさらに絞る。ピラミッド / 初期値 / 指標 のどれが効いているか。
// 使い方: node scripts/reg-diag2.mjs   (dev server 起動済み)

import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','Hirata20260728')}`;
const FIXED = parseInt(opt('fixed', '8'), 10);
const MOVING = parseInt(opt('moving', '14'), 10);

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) > 0,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\nloaded ${prev} series`);

  const out = await page.evaluate(async ({ FIXED, MOVING }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    d.ensureVolume_(FIXED); d.ensureVolume_(MOVING);
    await new Promise(r => setTimeout(r, 5000));
    const B = '/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([
      import(B+'registerMrPt.ts'), import(B+'mi.ts'), import(B+'transform.ts')]);
    const F = d.seriesList[FIXED].volume, M = d.seriesList[MOVING].volume;
    const snap = tf.captureRegistrationSnapshot(M);

    const pts = [];
    for (const fx of [0.3,0.5,0.7]) for (const fy of [0.3,0.5,0.7]) for (const fz of [0.2,0.5,0.8]) {
      const i=fx*M.nx, j=fy*M.ny, k=fz*M.nz;
      pts.push([M.imagePosition.x+i*M.vectorX.x+j*M.vectorY.x+k*M.vectorZ.x,
                M.imagePosition.y+i*M.vectorX.y+j*M.vectorY.y+k*M.vectorZ.y,
                M.imagePosition.z+i*M.vectorX.z+j*M.vectorY.z+k*M.vectorZ.z]); }
    const applyP = (p,q)=>{const m=tf.makeRigidMatrix(p).elements;
      return [m[0]*q[0]+m[4]*q[1]+m[8]*q[2]+m[12], m[1]*q[0]+m[5]*q[1]+m[9]*q[2]+m[13],
              m[2]*q[0]+m[6]*q[1]+m[10]*q[2]+m[14]];};
    const mTRE=(pb,fo)=>{let s=0;for(const q of pts){const a=applyP(fo,applyP(pb,q));
      s+=Math.hypot(a[0]-q[0],a[1]-q[1],a[2]-q[2]);}return s/pts.length;};
    const inv = p => tf.paramsFromMatrix(tf.makeRigidMatrix(p).clone().invert());

    const P = [20,-15,10,0,0,0];
    const truth = inv(P);
    const o = { normalized:false, bodyOnly:false };

    tf.applyRigidToVolume(M, snap, P);
    const centroid = reg.centroidInitParams(F, M);
    const guess = reg.estimateInitialParams(F, M, o);

    // 単一解像度 (factor 1) と ピラミッド の比較、identity 始動 / truth 始動
    const run = (start, factors) => {
      const r = reg.registerMrToPt(F, M, start, undefined, undefined,
        { ...o, factors, samples: factors.map(()=>8000) });
      return { mTRE:+mTRE(P, r.params).toFixed(1), negMI:+r.finalNegMI.toFixed(4),
               params: r.params.map(v=>+v.toFixed(1)) };
    };

    // 指標の絶対比較 (同じ sample/stats で identity・truth・各結果を採点)
    const samples = mi.generateFixedSamples(F, 8000, 12345, { bodyOnly:false });
    const stats = mi.estimateIntensityRange(F, M, samples);
    const score = p => +mi.computeNegativeMI(F, M, samples, stats, p, undefined, {normalized:false}).toFixed(4);

    const res = {
      centroid: { mTRE:+mTRE(P,centroid).toFixed(1), p: centroid.map(v=>+v.toFixed(1)) },
      guess:    { mTRE:+mTRE(P,guess).toFixed(1),    p: guess.map(v=>+v.toFixed(1)) },
      scoreIdentity: score([0,0,0,0,0,0]),
      scoreTruth:    score(truth),
      pyramid_fromIdentity: run([0,0,0,0,0,0], [4,2,1]),
      single_fromIdentity:  run([0,0,0,0,0,0], [1]),
      single_fromTruth:     run(truth,          [1]),
      pyramid_fromTruth:    run(truth,          [4,2,1]),
    };
    res.scoreOf_single_fromIdentity = score(res.single_fromIdentity.params);
    res.scoreOf_single_fromTruth    = score(res.single_fromTruth.params);
    tf.applyRigidToVolume(M, snap, [0,0,0,0,0,0]);
    return res;
  }, { FIXED, MOVING });

  console.log('\n' + JSON.stringify(out, null, 1));
  console.log(`\n判定: score(truth)=${out.scoreTruth} vs score(single_fromTruth)=${out.scoreOf_single_fromTruth}`);
  console.log(out.scoreOf_single_fromTruth < out.scoreTruth
    ? '  → 最適化は「スコアの良い」点へ動いている = **指標が間違っている**'
    : '  → 最適化はスコアを悪化させている = **最適化の不具合**');
} catch (e) { console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
