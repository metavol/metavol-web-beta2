// metmri (脳 MR + PET, NIfTI) を使った registration 開発用ハーネス。
//
// **重要**: この症例は読み込み時点で MR と PT の重心が 210mm 離れている
// (別装置由来で world 座標系が噛み合っていない)。したがって
// 「読み込み時の姿勢 = 正解」という前提は使えない。評価は次の 3 本立てで行う:
//
//   ① 合わせた結果が MI の極小か  … 周囲を ±mm/±° 振って全て悪化するか
//   ② 収束半径と再現性            … ①の結果を基準に既知量ずらして戻せるか (mTRE)
//   ③ 目視                        … --shot で fusion 画像を .screenshots/ に保存
//
// 使い方:
//   node scripts/reg-metmri.mjs
//   node scripts/reg-metmri.mjs --quick     # 摂動 1 種だけ

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const has = (n) => args.includes(`--${n}`);
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','metmri')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[metmri] waiting for volumes…');
  await page.waitForFunction(() => {
    const ss = document.querySelector('#app')?.__vue_app__?._instance?.setupState;
    return (ss?.seriesSummariesView?.length ?? 0) >= 2;
  }, null, { timeout: 300000 });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(async ({ quick }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B = '/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([
      import(B+'registerMrPt.ts'), import(B+'mi.ts'), import(B+'transform.ts')]);

    const vols = d.seriesList.map((s,i)=>({i, v:s?.volume, mod:(s?.volume?.metadata?.modality??'').toUpperCase()}))
                             .filter(x=>!!x.v);
    const pt = vols.find(x=>x.mod==='PT'||x.mod==='PET') ?? vols[1];
    const mr = vols.find(x=>x!==pt) ?? vols[0];
    if (!pt || !mr) return { error:'need two volumes' };
    const F = pt.v, M = mr.v;

    // 評価点は **moving (MR) の頭部内**。撮像範囲の隅より解剖の中身で測りたい。
    const pts = [];
    for (const fx of [0.35,0.5,0.65]) for (const fy of [0.35,0.5,0.65]) for (const fz of [0.3,0.5,0.7]) {
      const i=fx*M.nx, j=fy*M.ny, k=fz*M.nz;
      pts.push([M.imagePosition.x+i*M.vectorX.x+j*M.vectorY.x+k*M.vectorZ.x,
                M.imagePosition.y+i*M.vectorX.y+j*M.vectorY.y+k*M.vectorZ.y,
                M.imagePosition.z+i*M.vectorX.z+j*M.vectorY.z+k*M.vectorZ.z]); }
    const applyP=(p,q)=>{const m=tf.makeRigidMatrix(p).elements;
      return [m[0]*q[0]+m[4]*q[1]+m[8]*q[2]+m[12], m[1]*q[0]+m[5]*q[1]+m[9]*q[2]+m[13],
              m[2]*q[0]+m[6]*q[1]+m[10]*q[2]+m[14]];};
    // 2 つの姿勢 a,b の差を、評価点の平均変位 (mm) で表す
    const poseDiff=(a,b)=>{let s=0;for(const q of pts){const p1=applyP(a,q),p2=applyP(b,q);
      s+=Math.hypot(p1[0]-p2[0],p1[1]-p2[1],p1[2]-p2[2]);}return s/pts.length;};
    const compose=(after,before)=>tf.paramsFromMatrix(
      tf.makeRigidMatrix(after).clone().multiply(tf.makeRigidMatrix(before)));

    const snap = tf.captureRegistrationSnapshot(M);
    const IDENT=[0,0,0,0,0,0];

    // ---- ① 読み込み姿勢から: 重心 → MI ----
    tf.applyRigidToVolume(M, snap, IDENT);
    const t0=performance.now();
    const centroid = reg.centroidInitParams(F, M);
    const tC=performance.now()-t0;
    const t1=performance.now();
    const res = reg.registerMrToPt(F, M, centroid);
    const tM=performance.now()-t1;
    const P0 = res.params;                       // これを以後の基準 (best estimate) とする

    // 同一の目的関数で各姿勢を採点する (レベル 1 相当)
    const samples = mi.generateFixedSamples(F, 12000, 12345);
    const stats = mi.estimateIntensityRange(F, M, samples);
    const score = p => +mi.computeNegativeMI(F, M, samples, stats, p).toFixed(4);

    // ---- ② 極小チェック: P0 の周囲を振る ----
    const D=Math.PI/180;
    const probes=[];
    for (const ax of [0,1,2]) for (const dd of [-20,-10,-5,5,10,20]) {
      const p=[...P0]; p[ax]+=dd; probes.push({ what:`t${'xyz'[ax]}${dd>0?'+':''}${dd}mm`, delta:+(score(p)-score(P0)).toFixed(4) });
    }
    for (const ax of [3,4,5]) for (const dd of [-5,-2,2,5]) {
      const p=[...P0]; p[ax]+=dd*D; probes.push({ what:`r${'xyz'[ax-3]}${dd>0?'+':''}${dd}deg`, delta:+(score(p)-score(P0)).toFixed(4) });
    }
    const worse = probes.filter(x=>x.delta>0).length;

    // ---- ③ 収束半径: P0 を基準に既知量ずらして戻す ----
    const perturbs = quick ? [{name:'T15+R5', p:[15,-10,8, 5*D,-3*D,4*D]}]
      : [{name:'T5',      p:[5,-4,3, 0,0,0]},
         {name:'T10+R3',  p:[10,-8,6, 3*D,-2*D,2*D]},
         {name:'T20+R8',  p:[-20,15,-12, -8*D,5*D,-6*D]},
         {name:'T40+R15', p:[40,-30,25, 15*D,-10*D,12*D]}];
    const rows=[];
    for (const pb of perturbs) {
      const startPose = compose(pb.p, P0);       // P0 からさらに pb だけずらした姿勢
      tf.applyRigidToVolume(M, snap, startPose);
      const c = reg.centroidInitParams(F, M);
      // c は「今の姿勢からの追加変換」なので、絶対姿勢は c∘startPose
      const cAbs = compose(c, startPose);
      const r = reg.registerMrToPt(F, M, c);
      const rAbs = compose(r.params, startPose);
      rows.push({ perturb: pb.name,
        start:    +poseDiff(startPose, P0).toFixed(1),
        centroid: +poseDiff(cAbs, P0).toFixed(1),
        final:    +poseDiff(rAbs, P0).toFixed(1),
        negMI:    +r.finalNegMI.toFixed(4) });
    }
    tf.applyRigidToVolume(M, snap, IDENT);

    return {
      fromLoaded: {
        centroidParams: centroid.map(v=>+v.toFixed(1)),
        centroidShiftMm: +poseDiff(centroid, IDENT).toFixed(1),
        finalParams: P0.map((v,i)=>+(i<3?v:v/D).toFixed(1)),   // 回転は deg で表示
        scoreLoaded: score(IDENT), scoreCentroid: score(centroid), scoreFinal: score(P0),
        msCentroid: Math.round(tC), msMi: Math.round(tM),
      },
      localMin: { probes: probes.length, worseCount: worse,
                  isLocalMin: worse === probes.length,
                  best: probes.slice().sort((a,b)=>a.delta-b.delta).slice(0,3) },
      recovery: rows,
    };
  }, { quick: has('quick') });

  if (out.error) { console.error('[metmri]', out.error); }
  else {
    const f = out.fromLoaded;
    console.log('\n=== ① 読み込み姿勢から (重心 → MI) ===');
    console.log(`  centroid が動かした量 : ${f.centroidShiftMm} mm   params=${JSON.stringify(f.centroidParams)}`);
    console.log(`  最終 params (mm,deg)  : ${JSON.stringify(f.finalParams)}`);
    console.log(`  negMI  loaded=${f.scoreLoaded}  centroid=${f.scoreCentroid}  final=${f.scoreFinal}  (小さいほど良い)`);
    console.log(`  所要 centroid=${f.msCentroid}ms  MI=${f.msMi}ms`);
    console.log('\n=== ② 最終姿勢は MI の極小か ===');
    console.log(`  ${out.localMin.worseCount}/${out.localMin.probes} の摂動で悪化 → ${out.localMin.isLocalMin ? 'OK (極小)' : 'NG (より良い点がある)'}`);
    if (!out.localMin.isLocalMin) console.log('  より良い方向:', JSON.stringify(out.localMin.best));
    console.log('\n=== ③ 収束半径 (最終姿勢を基準に、ずらして戻す) ===');
    console.log('  perturb      start   centroid    final    negMI');
    console.log('  ' + '-'.repeat(52));
    for (const r of out.recovery) {
      console.log(`  ${r.perturb.padEnd(11)} ${String(r.start).padStart(6)} ${String(r.centroid).padStart(9)} ${String(r.final).padStart(8)} ${String(r.negMI).padStart(9)}`);
    }
  }
} catch (e) { console.error('[metmri] failed:', e?.stack ?? e); }
finally { await browser.close(); }
