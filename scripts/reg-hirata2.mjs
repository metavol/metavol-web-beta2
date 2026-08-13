// hirata2 (別撮影の CT Lung + PET TRANSAXIAL) で registration の実力を測る。
//
// **正解が無いケース**なので、Hirata20260728 で使った「既知量ずらして戻す」は使えない
// (読み込み時の姿勢が正しくない)。代わりに次の 2 本立てで評価する:
//
//   ① MI          … 最適化が目指している値そのもの。良くなって当然なので、これだけでは不十分
//   ② 体輪郭 Dice … **MI とは独立**。CT と PET それぞれの体マスクを作り、重なりを測る。
//                    別モダリティでも体の輪郭は一致するはずなので、合っているかの実質的な判定になる
//
// 使い方:
//   node scripts/reg-hirata2.mjs             # 現状の経路を評価
//   node scripts/reg-hirata2.mjs --multi     # 複数の初期値を試して最良を選ぶ経路も評価

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const has = (n) => args.includes(`--${n}`);
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','hirata2')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[hirata2] loading…');
  await page.waitForFunction(() =>
    (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() =>
      document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[hirata2] ${prev} series loaded`);

  const out = await page.evaluate(async ({ multi }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B = '/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([
      import(B+'registerMrPt.ts'), import(B+'mi.ts'), import(B+'transform.ts')]);
    const V = await import('/metavol-web-beta2/src/components/Volume.ts');
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');

    // series を modality で特定して volume 化
    const sum = app._instance.setupState.seriesSummariesView;
    let ctIdx = -1, ptIdx = -1;
    sum.forEach((s, i) => {
      const m = (s.modality || '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i;
      if ((m === 'PT' || m === 'PET') && ptIdx < 0) ptIdx = i;
    });
    if (ctIdx < 0 || ptIdx < 0) return { error: 'need CT and PT', sum: sum.map(s => s.modality) };
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r => setTimeout(r, 6000));
    const F = d.seriesList[ctIdx].volume;   // fixed = CT
    const M = d.seriesList[ptIdx].volume;   // moving = PT
    if (!F || !M) return { error: 'volume build failed' };

    const info = (v) => ({ dims: [v.nx, v.ny, v.nz],
      pitch: [+v.vectorX.length().toFixed(2), +v.vectorY.length().toFixed(2), +v.vectorZ.length().toFixed(2)],
      desc: v.metadata?.seriesDescription });

    // ---------- ② 独立指標: 体輪郭 Dice ----------
    // 各 volume を粗い共通格子 (world 3mm) 上で二値化して重なりを測る。
    // 閾値は modality ごとに: CT は -300HU、PT は volume の 97.5 パーセンタイルの 15%。
    const ptVals = [];
    { const st = Math.max(1, Math.floor(M.voxel.length / 40000));
      for (let i = 0; i < M.voxel.length; i += st) ptVals.push(M.voxel[i]);
      ptVals.sort((a, b) => a - b); }
    const ptHi = ptVals[Math.floor(ptVals.length * 0.975)] || 1;
    const PT_THR = ptHi * 0.15;
    const CT_THR = -300;

    // 共通格子: 2 volume の world bbox の交わり + 余白、3mm ステップ
    const bbox = (v) => { const xs=[],ys=[],zs=[];
      for (const i of [0,v.nx]) for (const j of [0,v.ny]) for (const k of [0,v.nz]) {
        xs.push(v.imagePosition.x + i*v.vectorX.x + j*v.vectorY.x + k*v.vectorZ.x);
        ys.push(v.imagePosition.y + i*v.vectorX.y + j*v.vectorY.y + k*v.vectorZ.y);
        zs.push(v.imagePosition.z + i*v.vectorX.z + j*v.vectorY.z + k*v.vectorZ.z); }
      return [[Math.min(...xs),Math.max(...xs)],[Math.min(...ys),Math.max(...ys)],[Math.min(...zs),Math.max(...zs)]]; };
    const bF = bbox(F);
    const STEP = 3;

    const sample = (vol, w) => {
      const v = V.worldToVoxel(w, vol);
      const x = Math.round(v.x), y = Math.round(v.y), z = Math.round(v.z);
      if (x < 0 || y < 0 || z < 0 || x >= vol.nx || y >= vol.ny || z >= vol.nz) return null;
      return vol.voxel[z*vol.nx*vol.ny + y*vol.nx + x];
    };
    // Dice: CT 体マスク vs (params を掛けた) PT 体マスク
    const dice = (params) => {
      const T = tf.makeRigidMatrix(params), Tinv = T.clone().invert();
      const w = new THREE.Vector3(), w2 = new THREE.Vector3();
      let inter = 0, a = 0, b = 0;
      for (let z = bF[2][0]; z <= bF[2][1]; z += STEP)
        for (let y = bF[1][0]; y <= bF[1][1]; y += STEP)
          for (let x = bF[0][0]; x <= bF[0][1]; x += STEP) {
            w.set(x, y, z);
            const fv = sample(F, w);
            const inCt = fv != null && fv > CT_THR;
            w2.copy(w).applyMatrix4(Tinv);
            const mv = sample(M, w2);
            const inPt = mv != null && mv > PT_THR;
            if (inCt) a++;
            if (inPt) b++;
            if (inCt && inPt) inter++;
          }
      return (a + b) > 0 ? +(2 * inter / (a + b)).toFixed(4) : 0;
    };

    // MI スコア (共通の sample/stats で全経路を同じ土俵に)
    const samples = mi.generateFixedSamples(F, 12000, 12345);
    const stats = mi.estimateIntensityRange(F, M, samples);
    const score = (p) => +mi.computeNegativeMI(F, M, samples, stats, p).toFixed(4);

    const snap = tf.captureRegistrationSnapshot(M);
    const IDENT = [0,0,0,0,0,0];
    const D = Math.PI/180;

    const runs = [];
    const evaluate = (name, params, ms) => {
      runs.push({ name, params: params.map((v,i)=>+(i<3?v:v/D).toFixed(1)),
                  negMI: score(params), dice: dice(params), ms });
    };

    evaluate('as loaded (identity)', IDENT, 0);
    const centroid = reg.centroidInitParams(F, M);
    evaluate('centroid only', centroid, 0);

    // 現行既定の経路
    let t0 = performance.now();
    const cur = reg.registerMrToPt(F, M, centroid);
    evaluate('centroid -> MI (current default)', cur.params, Math.round(performance.now()-t0));

    t0 = performance.now();
    const fromIdent = reg.registerMrToPt(F, M, IDENT);
    evaluate('identity -> MI', fromIdent.params, Math.round(performance.now()-t0));

    if (multi) {
      // 複数の初期値から回して最良を選ぶ (multi-start)
      const seeds = [];
      seeds.push({ n: 'centroid', p: centroid });
      seeds.push({ n: 'identity', p: IDENT });
      for (const dz of [-60, -30, 30, 60]) seeds.push({ n: `centroid z${dz}`, p: [centroid[0], centroid[1], centroid[2]+dz, 0,0,0] });
      for (const rz of [-10, 10]) seeds.push({ n: `centroid rz${rz}`, p: [centroid[0], centroid[1], centroid[2], 0,0,rz*D] });
      const t1 = performance.now();
      let best = null;
      for (const s of seeds) {
        const r = reg.registerMrToPt(F, M, s.p);
        const sc = score(r.params);
        if (!best || sc < best.sc) best = { sc, params: r.params, from: s.n };
      }
      evaluate(`multi-start best (from ${best.from}, ${seeds.length} seeds)`, best.params, Math.round(performance.now()-t1));
    }

    tf.applyRigidToVolume(M, snap, IDENT);
    return { fixed: info(F), moving: info(M),
      frameOfRef: [d.frameOfRefOf(ctIdx), d.frameOfRefOf(ptIdx)],
      sameFoR: d.frameOfRefOf(ctIdx) === d.frameOfRefOf(ptIdx),
      ptThreshold: +PT_THR.toFixed(2), runs };
  }, { multi: has('multi') });

  if (out.error) { console.error('[hirata2]', out.error, JSON.stringify(out.sum ?? '')); }
  else {
    console.log('\nfixed  (CT):', JSON.stringify(out.fixed));
    console.log('moving (PT):', JSON.stringify(out.moving));
    console.log('same FrameOfReference:', out.sameFoR, ' PT body threshold:', out.ptThreshold);
    console.log('\n  経路                                        negMI     Dice     ms');
    console.log('  ' + '-'.repeat(70));
    for (const r of out.runs) {
      console.log(`  ${r.name.padEnd(42)} ${String(r.negMI).padStart(8)} ${String(r.dice).padStart(8)} ${String(r.ms).padStart(6)}`);
    }
    console.log('\n  negMI は小さいほど良い / Dice は大きいほど良い (1.0 = 完全一致)');
    console.log('  params:');
    for (const r of out.runs) console.log(`    ${r.name.padEnd(42)} ${JSON.stringify(r.params)}`);
  }
} catch (e) { console.error('[hirata2] failed:', e?.stack ?? e); }
finally { await browser.close(); }
