// hirata2 の位置合わせを **目で見て** 確認する。
//
// 自作の代理指標 (体マスク Dice / 断面積プロファイル相関) は 3 回作って 3 回とも
// 信用できなかった (感度不足・偽ピーク・相互に矛盾)。全身 PET/CT の位置合わせは
// **冠状断の融合画像を見るのが最も直接的**なので、画像を出して判断する。
//
// 出力: .screenshots/h2_<pose>_<plane>.png
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt=(n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','hirata2')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  console.log('[visual] loading…');
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) {
    const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[visual] ${prev} series`);

  const info = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const B='/metavol-web-beta2/src/components/registration/';
    const [reg, tf] = await Promise.all([import(B+'registerMrPt.ts'),import(B+'transform.ts')]);

    const sum = ss.seriesSummariesView;
    let ctIdx=-1, ptIdx=-1;
    sum.forEach((s,i)=>{ const m=(s.modality||'').toUpperCase();
      if(m==='CT'&&ctIdx<0)ctIdx=i; if((m==='PT'||m==='PET')&&ptIdx<0)ptIdx=i; });
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r=>setTimeout(r,6000));

    // CT を base、PET を overlay にした fusion box を作る
    d.promoteBoxToVolume(0, ctIdx);
    await new Promise(r=>setTimeout(r,1500));
    d.fuseSeriesIntoBox(ptIdx, 0);
    await new Promise(r=>setTimeout(r,2500));

    // 大きめの canvas
    ss.imageBoxW = 520; ss.imageBoxH = 760;
    await new Promise(r=>setTimeout(r,1200));

    const F=d.seriesList[ctIdx].volume, M=d.seriesList[ptIdx].volume;
    const snap = tf.captureRegistrationSnapshot(M);
    const centroid = reg.centroidInitParams(F, M);
    const reg1 = reg.registerMrToPt(F, M, centroid).params;
    window.__h2 = { ctIdx, ptIdx, snap, poses: { identity:[0,0,0,0,0,0], registered: reg1 },
                    tf, F, M, d, ss };
    return { ctIdx, ptIdx, registered: reg1.map((v,i)=>+(i<3?v:v*180/Math.PI).toFixed(1)) };
  });
  console.log('registered params (mm,deg):', JSON.stringify(info.registered));

  for (const pose of ['identity','registered']) {
    for (const plane of ['cor','axi']) {
      const r = await page.evaluate(async ({ pose, plane }) => {
        const h = window.__h2;
        h.tf.applyRigidToVolume(h.M, h.snap, h.poses[pose]);
        h.d.setPlaneOnBox(0, plane);
        await new Promise(r=>setTimeout(r,1500));
        // volume 全体が入るように視野を合わせる
        const info = h.d.imageBoxInfos[0], F = h.F;
        // **volume 中心はベクトル和で求めること。** 成分ごとに |nx*vecX| を足すと、
        // vectorZ が負の volume で中心が体外に飛ぶ (実測: CT が画面下端の帯にしか映らなかった)。
        const cx = F.imagePosition.x + (F.nx*F.vectorX.x + F.ny*F.vectorY.x + F.nz*F.vectorZ.x)/2;
        const cy = F.imagePosition.y + (F.nx*F.vectorX.y + F.ny*F.vectorY.y + F.nz*F.vectorZ.y)/2;
        const cz = F.imagePosition.z + (F.nx*F.vectorX.z + F.ny*F.vectorY.z + F.nz*F.vectorZ.z)/2;
        const eX=F.nx*F.vectorX.length(), eY=F.ny*F.vectorY.length(), eZ=F.nz*F.vectorZ.length();
        // 冠状断は縦が z、横が x。CT の範囲がちょうど入るように縦横それぞれで決める。
        const mmY = ((plane==='cor') ? eZ : eY) * 1.08 / h.d.imageBoxH;
        const mmX = eX * 1.08 / h.d.imageBoxW;
        const mm = Math.max(mmX, mmY);
        info.vecx.multiplyScalar(mm/info.vecx.length());
        info.vecy.multiplyScalar(mm/info.vecy.length());
        info.centerInWorld.set(cx, cy, cz);
        h.d.boxStateVersion++; h.d.showImage(0);
        await new Promise(r=>setTimeout(r,3500));
        const c=[...document.querySelectorAll('canvas')].filter(x=>x.width>32)[0];
        const res = await fetch(`/api/screenshot?name=h2_${pose}_${plane}`, {method:'POST', body:c.toDataURL('image/png')});
        return { saved: res.status, canvas:[c.width,c.height] };
      }, { pose, plane });
      console.log(`  ${pose} / ${plane}: ${JSON.stringify(r)}`);
    }
  }
  await page.evaluate(() => { const h=window.__h2; h.tf.applyRigidToVolume(h.M, h.snap, [0,0,0,0,0,0]); });
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
