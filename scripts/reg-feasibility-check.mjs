// assessFeasibility が 3 症例で正しく分岐するか確認する。
//   hirata2   … CT=胸部のみ × PET=全身  → 走らせない (NG) べき
//   metmri    … 脳 MR × 脳 PET (視野同等) → 走らせる (OK) べき
//   Hirata20260728 … 同一 FoR の CT×PET   → 走らせる (OK) べき
// 使い方: node scripts/reg-feasibility-check.mjs --case hirata2
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt=(n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const CASE = opt('case','hirata2');
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) {
    const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[${CASE}] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const reg = await import('/metavol-web-beta2/src/components/registration/registerMrPt.ts');
    const sum = app._instance.setupState.seriesSummariesView;
    // 代表ペアを選ぶ: PT と、それ以外 (CT or MR) の先頭
    let ptIdx=-1, otherIdx=-1;
    sum.forEach((s,i)=>{ const m=(s.modality||'').toUpperCase();
      if((m==='PT'||m==='PET')&&ptIdx<0) ptIdx=i;
      else if((m==='CT'||m==='MR')&&otherIdx<0) otherIdx=i; });
    if (ptIdx<0||otherIdx<0) return { error:'need PT + CT/MR', mods: sum.map(s=>s.modality) };
    d.ensureVolume_(ptIdx); d.ensureVolume_(otherIdx);
    await new Promise(r=>setTimeout(r,6000));
    const F=d.seriesList[otherIdx].volume, M=d.seriesList[ptIdx].volume;
    if(!F||!M) return { error:'volume build failed' };
    const zExt = v => Math.abs(v.nx*v.vectorX.z)+Math.abs(v.ny*v.vectorY.z)+Math.abs(v.nz*v.vectorZ.z);
    const f = reg.assessFeasibility(F, M);
    return { fixed: sum[otherIdx].modality + ' ' + (sum[otherIdx].description||'').slice(0,20),
             moving: sum[ptIdx].modality + ' ' + (sum[ptIdx].description||'').slice(0,20),
             zExtFixed: Math.round(zExt(F)), zExtMoving: Math.round(zExt(M)),
             ok: f.ok, centroidUsable: f.centroidUsable, reason: f.reason };
  });
  if (out.error) console.error('  error:', out.error, JSON.stringify(out.mods??''));
  else {
    console.log(`  fixed : ${out.fixed}  (z ${out.zExtFixed}mm)`);
    console.log(`  moving: ${out.moving}  (z ${out.zExtMoving}mm)`);
    console.log(`  => ok=${out.ok}  centroidUsable=${out.centroidUsable}`);
    console.log(`     ${out.reason}`);
  }
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
