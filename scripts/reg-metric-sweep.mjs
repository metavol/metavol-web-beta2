// **どの指標が正しい姿勢で最小になるか**を決める実験。
//
// hirata2 の目視判定 (冠状断の融合画像):
//   identity (tz=0)      … 肺・肝臓・腎臓が一致。ほぼ正しい
//   centroid->MI (tz=+49) … 肝臓が右肺下部へ食い込む。明確に誤り
// つまり **正解は tz ≒ 0 付近**。tz を振って各指標の最小点を調べ、
// 0 付近で最小になる指標だけを採用する。
//
// 候補: MI / NMI / それぞれ体内サンプル限定。
// 使い方: node scripts/reg-metric-sweep.mjs

import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt=(n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','hirata2')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m=>{ if(m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  console.log('[sweep] loading…');
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:900000 });
  let prev=-1, stable=0;
  while (stable<6) {
    const n = await page.evaluate(()=>document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n===prev) stable++; else { stable=0; prev=n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[sweep] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const B='/metavol-web-beta2/src/components/registration/';
    const mi = await import(B+'mi.ts');
    const sum = app._instance.setupState.seriesSummariesView;
    let ctIdx=-1, ptIdx=-1;
    sum.forEach((s,i)=>{ const m=(s.modality||'').toUpperCase();
      if(m==='CT'&&ctIdx<0)ctIdx=i; if((m==='PT'||m==='PET')&&ptIdx<0)ptIdx=i; });
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r=>setTimeout(r,6000));
    const F=d.seriesList[ctIdx].volume, M=d.seriesList[ptIdx].volume;

    // 4 通りの指標を用意 (sample セットは指標ごとに固定)
    const variants = [
      { name: 'MI  all-box',  normalized:false, bodyOnly:false },
      { name: 'MI  body-only',normalized:false, bodyOnly:true  },
      { name: 'NMI all-box',  normalized:true,  bodyOnly:false },
      { name: 'NMI body-only',normalized:true,  bodyOnly:true  },
    ];
    const prep = variants.map(v => {
      const s = mi.generateFixedSamples(F, 10000, 12345, { bodyOnly: v.bodyOnly });
      return { ...v, samples: s, stats: mi.estimateIntensityRange(F, M, s) };
    });

    const TZ = [];
    for (let z=-60; z<=80; z+=5) TZ.push(z);
    const curves = prep.map(p => ({ name: p.name,
      vals: TZ.map(z => +mi.computeNegativeMI(F, M, p.samples, p.stats, [0,0,z,0,0,0],
                                              undefined, { normalized: p.normalized }).toFixed(4)) }));
    // 各指標の最小点
    const argmin = curves.map(c => {
      let bi=0; for (let i=1;i<c.vals.length;i++) if (c.vals[i] < c.vals[bi]) bi=i;
      return { name: c.name, tzAtMin: TZ[bi], min: c.vals[bi], atZero: c.vals[TZ.indexOf(0)] };
    });
    return { TZ, curves, argmin };
  });

  console.log('\n各指標の最小点 (正解は tz ≒ 0):');
  console.log('  指標             最小の tz    最小値    tz=0 での値   判定');
  console.log('  ' + '-'.repeat(64));
  for (const a of out.argmin) {
    const ok = Math.abs(a.tzAtMin) <= 15 ? 'OK' : 'NG';
    console.log(`  ${a.name.padEnd(15)} ${String(a.tzAtMin).padStart(8)}mm ${String(a.min).padStart(9)} ${String(a.atZero).padStart(11)}   ${ok}`);
  }
  console.log('\n曲線 (tz: 値):');
  for (const c of out.curves) {
    console.log(`  ${c.name}`);
    const parts = out.TZ.map((z,i)=>`${z}:${c.vals[i]}`);
    for (let i=0;i<parts.length;i+=7) console.log('    ' + parts.slice(i,i+7).join('  '));
  }
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
