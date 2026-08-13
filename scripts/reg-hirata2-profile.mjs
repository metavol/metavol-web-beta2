// hirata2 の位置合わせを **z 方向に鋭い独立指標** で検証する。
//
// 体マスクの Dice は全身どうしだと z ずれに鈍い (実測: z を 160mm 動かしても 0.704→0.710)。
// そこで「world z ごとの体断面積プロファイル」を CT と PT で作り、相互相関のピーク位置を見る。
// 胸部は肩・肺・横隔膜で面積が特徴的に変化するので、z のズレが mm 単位で読める。
// あわせて各 z での体重心 (x, y) の差も出す (左右・前後のズレ)。
// **どれも MI とは独立**なので、最適化の自己申告ではなく実際に合っているかを判定できる。

import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','hirata2')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  console.log('[profile] loading…');
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) {
    const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[profile] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B='/metavol-web-beta2/src/components/registration/';
    const [reg, mi, tf] = await Promise.all([import(B+'registerMrPt.ts'),import(B+'mi.ts'),import(B+'transform.ts')]);
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

    // CT の world z 範囲で 5mm 刻みのプロファイルを作る
    const zs=[]; { const xs=[],ys=[],zz=[];
      for(const i of [0,F.nx]) for(const j of [0,F.ny]) for(const k of [0,F.nz])
        zz.push(F.imagePosition.z+i*F.vectorX.z+j*F.vectorY.z+k*F.vectorZ.z);
      const z0=Math.min(...zz), z1=Math.max(...zz);
      for(let z=z0;z<=z1;z+=5) zs.push(z); void xs; void ys; }
    // xy 走査範囲は CT の bbox
    const xr=[],yr=[];
    for(const i of [0,F.nx]) for(const j of [0,F.ny]) for(const k of [0,F.nz]){
      xr.push(F.imagePosition.x+i*F.vectorX.x+j*F.vectorY.x+k*F.vectorZ.x);
      yr.push(F.imagePosition.y+i*F.vectorX.y+j*F.vectorY.y+k*F.vectorZ.y); }
    const x0=Math.min(...xr), x1=Math.max(...xr), y0=Math.min(...yr), y1=Math.max(...yr);
    const XY=4;

    // params を掛けた moving のプロファイル (面積と重心)
    const profile = (vol, thr, params) => {
      const T = params ? tf.makeRigidMatrix(params) : null;
      const Tinv = T ? T.clone().invert() : null;
      const w=new THREE.Vector3(), w2=new THREE.Vector3();
      const area=[], cx=[], cy=[];
      for (const z of zs) {
        let n=0, sx=0, sy=0;
        for (let y=y0;y<=y1;y+=XY) for (let x=x0;x<=x1;x+=XY) {
          w.set(x,y,z);
          let v;
          if (Tinv) { w2.copy(w).applyMatrix4(Tinv); v = sampleNN(vol, w2); }
          else v = sampleNN(vol, w);
          if (v != null && v > thr) { n++; sx+=x; sy+=y; }
        }
        area.push(n); cx.push(n?sx/n:NaN); cy.push(n?sy/n:NaN);
      }
      return { area, cx, cy };
    };

    // 2 つの面積プロファイルの相互相関 (bin=5mm)。
    // **探索範囲を絞り、重なりを十分要求すること。** 広く探すと端の数 bin だけで
    // 相関が跳ね、偽のピークを拾う (実測: ±245mm まで許したら 83bin 中 34bin の重なりで
    // 190〜245mm が「最良」と出た)。ここでは ±60mm、重なり 80% 以上に限定する。
    const MAX_SHIFT_BINS = 12;   // 60mm
    const MIN_OVERLAP = 0.8;
    const corrAt = (A, Bn, s) => {
      let c=0,n=0;
      for(let i=0;i<A.length;i++){ const j=i+s; if(j<0||j>=Bn.length) continue; c+=A[i]*Bn[j]; n++; }
      if (n < A.length*MIN_OVERLAP) return null;
      return c/n;
    };
    const normalize = (v)=>{ const m=v.reduce((s,x)=>s+x,0)/v.length;
      const sd=Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/v.length)||1;
      return v.map(x=>(x-m)/sd); };
    const bestShift = (a, b) => {
      const A=normalize(a), Bn=normalize(b);
      let best=0, bestC=-Infinity;
      for (let s=-MAX_SHIFT_BINS;s<=MAX_SHIFT_BINS;s++){
        const c = corrAt(A,Bn,s);
        if (c != null && c>bestC){ bestC=c; best=s; }
      }
      const c0 = corrAt(A,Bn,0);
      return { shiftMm: best*5, corr:+bestC.toFixed(3), corrAtZero: c0!=null?+c0.toFixed(3):null };
    };

    const ctP = profile(F, CT_THR, null);
    const snap = tf.captureRegistrationSnapshot(M);
    const IDENT=[0,0,0,0,0,0], D=Math.PI/180;
    const centroid = reg.centroidInitParams(F, M);
    const cur = reg.registerMrToPt(F, M, centroid).params;
    const fromId = reg.registerMrToPt(F, M, IDENT).params;

    const rows=[];
    for (const [name, p] of [['identity',IDENT],['centroid',centroid],
                             ['centroid -> MI',cur],['identity -> MI',fromId]]) {
      const pp = profile(M, PT_THR, p);
      const bs = bestShift(ctP.area, pp.area);
      // 面積が有効な bin での重心差 (x,y)
      let dx=0, dy=0, n=0;
      for (let i=0;i<zs.length;i++){
        if (!Number.isFinite(ctP.cx[i]) || !Number.isFinite(pp.cx[i])) continue;
        dx += pp.cx[i]-ctP.cx[i]; dy += pp.cy[i]-ctP.cy[i]; n++;
      }
      rows.push({ name, params: p.map((v,i)=>+(i<3?v:v/D).toFixed(1)),
        zShiftMm: bs.shiftMm, corr: bs.corr, corr0: bs.corrAtZero,
        dxMm: n?+(dx/n).toFixed(1):null, dyMm: n?+(dy/n).toFixed(1):null, validBins: n });
    }
    // ---- 指標の自己試験 ----
    // 「一番良い」姿勢に既知の z を足して、指標がその量を検出できるか確かめる。
    // 検出できないなら指標が壊れているので、以降の数値は信用しない。
    const selfTest = [];
    for (const dz of [-20, 10, 25]) {
      const p = [...cur]; p[2] += dz;
      const pp = profile(M, PT_THR, p);
      const bs = bestShift(ctP.area, pp.area);
      selfTest.push({ appliedDz: dz, detectedShiftMm: bs.shiftMm, corr: bs.corr });
    }

    tf.applyRigidToVolume(M, snap, IDENT);
    return { zBins: zs.length, ctAreaSum: ctP.area.reduce((a,b)=>a+b,0), rows, selfTest };
  });

  console.log(`\nprofile bins (5mm): ${out.zBins}`);
  console.log('\n  経路               z ずれ(mm)  相関   Δx(mm)  Δy(mm)  有効bin');
  console.log('  ' + '-'.repeat(62));
  for (const r of out.rows) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.zShiftMm).padStart(8)} ${String(r.corr).padStart(7)} ` +
                `${String(r.dxMm).padStart(7)} ${String(r.dyMm).padStart(7)} ${String(r.validBins).padStart(6)}`);
  }
  console.log('\n  z ずれ ≒ 0 かつ相関が高いほど良い。Δx/Δy は体重心の左右/前後ずれ。');
  console.log('  params:');
  for (const r of out.rows) console.log(`    ${r.name.padEnd(18)} ${JSON.stringify(r.params)}`);
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
