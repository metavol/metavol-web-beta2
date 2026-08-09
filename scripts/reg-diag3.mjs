// 重心初期化がなぜ数百 mm 飛ぶのか、実体を見る。
// あわせて「重心を使わず粗探索だけ identity から」の構成も測る。
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','Hirata20260728')}`;
const FIXED = parseInt(opt('fixed','8'),10), MOVING = parseInt(opt('moving','14'),10);

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForFunction(()=>(document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0)>0,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) { const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); } await page.waitForTimeout(5000); }
  console.log(`\nloaded ${prev} series`);

  const out = await page.evaluate(async ({FIXED,MOVING}) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    d.ensureVolume_(FIXED); d.ensureVolume_(MOVING);
    await new Promise(r=>setTimeout(r,5000));
    const B='/metavol-web-beta2/src/components/registration/';
    const [reg,mi,tf] = await Promise.all([import(B+'registerMrPt.ts'),import(B+'mi.ts'),import(B+'transform.ts')]);
    const F = d.seriesList[FIXED].volume, M = d.seriesList[MOVING].volume;
    const snap = tf.captureRegistrationSnapshot(M);

    const bbox = v => {
      const c=[]; for (const [i,j,k] of [[0,0,0],[v.nx,v.ny,v.nz]])
        c.push([v.imagePosition.x+i*v.vectorX.x+j*v.vectorY.x+k*v.vectorZ.x,
                v.imagePosition.y+i*v.vectorX.y+j*v.vectorY.y+k*v.vectorZ.y,
                v.imagePosition.z+i*v.vectorX.z+j*v.vectorY.z+k*v.vectorZ.z]);
      return c.map(p=>p.map(x=>+x.toFixed(0)));
    };
    const stat = v => { const s=Math.max(1,Math.floor(v.voxel.length/50000)); const a=[];
      for(let i=0;i<v.voxel.length;i+=s)a.push(v.voxel[i]); a.sort((x,y)=>x-y);
      const p=q=>+a[Math.floor(a.length*q)].toFixed(2);
      return {min:p(0),p50:p(0.5),p90:p(0.9),p99:p(0.99),max:p(0.999)}; };

    const cF = reg.computeCentroidWorld(F), cM = reg.computeCentroidWorld(M);
    const pts=[]; for(const fx of[0.3,0.5,0.7])for(const fy of[0.3,0.5,0.7])for(const fz of[0.2,0.5,0.8]){
      const i=fx*M.nx,j=fy*M.ny,k=fz*M.nz;
      pts.push([M.imagePosition.x+i*M.vectorX.x+j*M.vectorY.x+k*M.vectorZ.x,
                M.imagePosition.y+i*M.vectorX.y+j*M.vectorY.y+k*M.vectorZ.y,
                M.imagePosition.z+i*M.vectorX.z+j*M.vectorY.z+k*M.vectorZ.z]); }
    const applyP=(p,q)=>{const m=tf.makeRigidMatrix(p).elements;
      return [m[0]*q[0]+m[4]*q[1]+m[8]*q[2]+m[12],m[1]*q[0]+m[5]*q[1]+m[9]*q[2]+m[13],m[2]*q[0]+m[6]*q[1]+m[10]*q[2]+m[14]];};
    const mTRE=(pb,fo)=>{let s=0;for(const q of pts){const a=applyP(fo,applyP(pb,q));s+=Math.hypot(a[0]-q[0],a[1]-q[1],a[2]-q[2]);}return s/pts.length;};

    const O={normalized:false,bodyOnly:false};
    const P=[20,-15,10,0,0,0];
    tf.applyRigidToVolume(M,snap,P);
    const centroidP = reg.centroidInitParams(F,M);
    const coarseFromIdentity = reg.coarseTranslationSearch(F,M,[0,0,0,0,0,0],O);
    const guess = reg.estimateInitialParams(F,M,O);
    const samples = mi.generateFixedSamples(F,8000,12345,{bodyOnly:false});
    const stats = mi.estimateIntensityRange(F,M,samples);
    const score = p => +mi.computeNegativeMI(F,M,samples,stats,p,undefined,{normalized:false}).toFixed(4);
    const truth = tf.paramsFromMatrix(tf.makeRigidMatrix(P).clone().invert());
    const runFrom = (start,factors) => { const r = reg.registerMrToPt(F,M,start,undefined,undefined,
        {...O,factors,samples:factors.map(()=>10000)});
      return { mTRE:+mTRE(P,r.params).toFixed(1), score:score(r.params) }; };

    const res = {
      fixed:{ desc:F.metadata?.seriesDescription, bbox:bbox(F), stat:stat(F) },
      moving:{ desc:M.metadata?.seriesDescription, bbox:bbox(M), stat:stat(M) },
      centroidFixed: cF?[+cF.x.toFixed(0),+cF.y.toFixed(0),+cF.z.toFixed(0)]:null,
      centroidMovingPerturbed: cM?[+cM.x.toFixed(0),+cM.y.toFixed(0),+cM.z.toFixed(0)]:null,
      centroidParams: centroidP.map(v=>+v.toFixed(1)),
      centroidMTRE: +mTRE(P,centroidP).toFixed(1),
      coarseFromIdentityParams: coarseFromIdentity.map(v=>+v.toFixed(1)),
      coarseFromIdentityMTRE: +mTRE(P,coarseFromIdentity).toFixed(1),
      guessMTRE: +mTRE(P,guess).toFixed(1),
      scores: { identity: score([0,0,0,0,0,0]), truth: score(truth),
                centroid: score(centroidP), coarseFromIdentity: score(coarseFromIdentity), guess: score(guess) },
      F_coarseIdent_then_single: runFrom(coarseFromIdentity,[1]),
      G_coarseIdent_then_pyr21:  runFrom(coarseFromIdentity,[2,1]),
    };
    tf.applyRigidToVolume(M,snap,[0,0,0,0,0,0]);
    return res;
  }, {FIXED,MOVING});
  console.log(JSON.stringify(out,null,1));
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
