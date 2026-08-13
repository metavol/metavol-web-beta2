// **形状ベース指標が正解を指すか**を確かめる。
//
// hirata2 では強度ベース (MI / NMI、体内サンプル有無いずれも) の最小点が tz≒+50〜55mm で、
// 目視の正解 (tz≒0) を指さなかった。視野が非対称 (CT=胸部のみ / PET=全身) なため、
// MI が「情報量の多い腹部を視野に引き込む」方向を高評価してしまうのが原因。
//
// ここでは強度に依らない「world z ごとの体断面積プロファイルの相関」を tz について掃引し、
// tz≒0 で最大になるかを見る。なれば目的関数として使える。
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','hirata2')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  console.log('[shape] loading…');
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) {
    const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[shape] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B='/metavol-web-beta2/src/components/registration/';
    const tf = await import(B+'transform.ts');
    const V = await import('/metavol-web-beta2/src/components/Volume.ts');
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');

    const sum = app._instance.setupState.seriesSummariesView;
    let ctIdx=-1, ptIdx=-1;
    sum.forEach((s,i)=>{ const m=(s.modality||'').toUpperCase();
      if(m==='CT'&&ctIdx<0)ctIdx=i; if((m==='PT'||m==='PET')&&ptIdx<0)ptIdx=i; });
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r=>setTimeout(r,6000));
    const F=d.seriesList[ctIdx].volume, M=d.seriesList[ptIdx].volume;

    const ptVals=[]; { const st=Math.max(1,Math.floor(M.voxel.length/40000));
      for(let i=0;i<M.voxel.length;i+=st) ptVals.push(M.voxel[i]); ptVals.sort((a,b)=>a-b); }
    const PT_THR = (ptVals[Math.floor(ptVals.length*0.975)]||1)*0.15;
    const CT_THR = -300;

    const sampleNN = (vol,w)=>{ const v=V.worldToVoxel(w,vol);
      const x=Math.round(v.x),y=Math.round(v.y),z=Math.round(v.z);
      if(x<0||y<0||z<0||x>=vol.nx||y>=vol.ny||z>=vol.nz) return null;
      return vol.voxel[z*vol.nx*vol.ny+y*vol.nx+x]; };

    const corners = (v,f)=>{ const a=[];
      for(const i of [0,v.nx]) for(const j of [0,v.ny]) for(const k of [0,v.nz]) a.push(f(i,j,k)); return a; };
    const zz = corners(F,(i,j,k)=>F.imagePosition.z+i*F.vectorX.z+j*F.vectorY.z+k*F.vectorZ.z);
    const xx = corners(F,(i,j,k)=>F.imagePosition.x+i*F.vectorX.x+j*F.vectorY.x+k*F.vectorZ.x);
    const yy = corners(F,(i,j,k)=>F.imagePosition.y+i*F.vectorX.y+j*F.vectorY.y+k*F.vectorZ.y);
    const zs=[]; for(let z=Math.min(...zz); z<=Math.max(...zz); z+=5) zs.push(z);
    const x0=Math.min(...xx), x1=Math.max(...xx), y0=Math.min(...yy), y1=Math.max(...yy);
    const XY=4;

    const profile = (vol, thr, params) => {
      const Tinv = params ? tf.makeRigidMatrix(params).clone().invert() : null;
      const w=new THREE.Vector3(), w2=new THREE.Vector3();
      const area=[];
      for (const z of zs) {
        let n=0;
        for (let y=y0;y<=y1;y+=XY) for (let x=x0;x<=x1;x+=XY) {
          w.set(x,y,z);
          let v;
          if (Tinv) { w2.copy(w).applyMatrix4(Tinv); v = sampleNN(vol, w2); }
          else v = sampleNN(vol, w);
          if (v != null && v > thr) n++;
        }
        area.push(n);
      }
      return area;
    };

    const normalize = (v)=>{ const m=v.reduce((s,x)=>s+x,0)/v.length;
      const sd=Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/v.length)||1;
      return v.map(x=>(x-m)/sd); };
    const corrZero = (a,b)=>{ const A=normalize(a), Bn=normalize(b);
      let c=0; for(let i=0;i<A.length;i++) c+=A[i]*Bn[i]; return c/A.length; };

    const ctArea = profile(F, CT_THR, null);
    const snap = tf.captureRegistrationSnapshot(M);
    const sweep = [];
    for (let z=-60; z<=80; z+=5) {
      sweep.push({ tz: z, corr: +corrZero(ctArea, profile(M, PT_THR, [0,0,z,0,0,0])).toFixed(4) });
    }
    let bi=0; for(let i=1;i<sweep.length;i++) if(sweep[i].corr>sweep[bi].corr) bi=i;
    tf.applyRigidToVolume(M, snap, [0,0,0,0,0,0]);
    return { zBins: zs.length, sweep, best: sweep[bi], atZero: sweep.find(s=>s.tz===0) };
  });

  console.log(`\nprofile bins: ${out.zBins}`);
  console.log(`形状指標の最大点: tz=${out.best.tz}mm (corr ${out.best.corr})`);
  console.log(`tz=0 での値: ${out.atZero.corr}`);
  console.log(`判定: ${Math.abs(out.best.tz) <= 15 ? 'OK — 正解付近で最大。目的関数に使える' : 'NG — この指標も正解を指さない'}`);
  console.log('\n掃引 (tz: corr):');
  const parts = out.sweep.map(s=>`${s.tz}:${s.corr}`);
  for (let i=0;i<parts.length;i+=7) console.log('  ' + parts.slice(i,i+7).join('  '));
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
