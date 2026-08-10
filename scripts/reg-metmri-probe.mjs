// 重心と MI サンプルの実体を直接見る。
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt=(n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','metmri')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:300000 });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B='/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([import(B+'registerMrPt.ts'),import(B+'mi.ts'),import(B+'transform.ts')]);
    const V = await import('/metavol-web-beta2/src/components/Volume.ts');
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');

    const vols = d.seriesList.map((s,i)=>({i, v:s?.volume, mod:(s?.volume?.metadata?.modality??'').toUpperCase(),
                                           desc:s?.volume?.metadata?.seriesDescription??''})).filter(x=>!!x.v);
    const pt = vols.find(x=>x.mod==='PT'||x.mod==='PET') ?? vols[1];
    const mr = vols.find(x=>x!==pt) ?? vols[0];
    const F=pt.v, M=mr.v;

    const cF = reg.computeCentroidWorld(F), cM = reg.computeCentroidWorld(M);
    const ci = reg.centroidInitParams(F, M);

    // サンプルが moving に何点入るか (IDENT と centroid のそれぞれ)
    const overlapCount = (params) => {
      const samples = mi.generateFixedSamples(F, 4000, 12345);
      const T = tf.makeRigidMatrix(params); const Tinv = T.clone().invert();
      let inF=0, inM=0;
      const w=new THREE.Vector3(), w2=new THREE.Vector3();
      for (let i=0;i<samples.length/3;i++){
        w.set(samples[i*3],samples[i*3+1],samples[i*3+2]);
        const vf=V.worldToVoxel(w,F);
        if (vf.x>=0&&vf.x<F.nx&&vf.y>=0&&vf.y<F.ny&&vf.z>=0&&vf.z<F.nz) inF++;
        w2.copy(w).applyMatrix4(Tinv);
        const vm=V.worldToVoxel(w2,M);
        if (vm.x>=0&&vm.x<M.nx&&vm.y>=0&&vm.y<M.ny&&vm.z>=0&&vm.z<M.nz) inM++;
      }
      return { nSamples: 4000, insideFixed: inF, insideMoving: inM };
    };

    // 体内サンプルが本当に頭部を捉えているか (fixed の値分布)
    const sampleVals = () => {
      const s = mi.generateFixedSamples(F, 3000, 999);
      const w=new THREE.Vector3(); const vals=[];
      for (let i=0;i<s.length/3;i++){ w.set(s[i*3],s[i*3+1],s[i*3+2]);
        const v=V.worldToVoxel(w,F);
        const xi=Math.floor(v.x),yi=Math.floor(v.y),zi=Math.floor(v.z);
        if(xi<0||yi<0||zi<0||xi>=F.nx||yi>=F.ny||zi>=F.nz) continue;
        vals.push(F.voxel[zi*F.nx*F.ny+yi*F.nx+xi]); }
      vals.sort((a,b)=>a-b);
      const P=t=>vals.length?+vals[Math.floor(vals.length*t)].toFixed(3):null;
      return { n:vals.length, p10:P(0.1), p50:P(0.5), p90:P(0.9) };
    };

    return {
      which: { fixed:{ i:pt.i, mod:pt.mod, desc:pt.desc }, moving:{ i:mr.i, mod:mr.mod, desc:mr.desc } },
      centroidFixed: cF?[+cF.x.toFixed(1),+cF.y.toFixed(1),+cF.z.toFixed(1)]:null,
      centroidMoving: cM?[+cM.x.toFixed(1),+cM.y.toFixed(1),+cM.z.toFixed(1)]:null,
      centroidInitParams: ci.map(v=>+v.toFixed(1)),
      sampleValues: sampleVals(),
      overlapAtIdentity: overlapCount([0,0,0,0,0,0]),
      overlapAtCentroid: overlapCount(ci),
      miAtIdentity: (()=>{ const s=mi.generateFixedSamples(F,4000,12345);
        const st=mi.estimateIntensityRange(F,M,s);
        return { stats:{fMin:+st.fixedMin.toFixed(3),fMax:+st.fixedMax.toFixed(3),
                        mMin:+st.movingMin.toFixed(1),mMax:+st.movingMax.toFixed(1)},
                 negMI:+mi.computeNegativeMI(F,M,s,st,[0,0,0,0,0,0]).toFixed(4) }; })(),
      miAtCentroid: (()=>{ const s=mi.generateFixedSamples(F,4000,12345);
        const st=mi.estimateIntensityRange(F,M,s);
        return +mi.computeNegativeMI(F,M,s,st,ci).toFixed(4); })(),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
