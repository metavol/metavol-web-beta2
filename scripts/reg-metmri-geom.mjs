// metmri の 2 volume が world 空間でどこにあるかを実測する。
// 「読み込み時の姿勢が正しい」と仮定してよいかどうかを判断するため。
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n,f)=>{const i=args.indexOf(`--${n}`);return i>=0?args[i+1]:f;};
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','metmri')}`;

const browser = await chromium.launch({ headless:true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type()==='error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForFunction(()=> (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout:300000 });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const reg = await import('/metavol-web-beta2/src/components/registration/registerMrPt.ts');

    const info = (v, label) => {
      // 8 隅から軸平行 bounding box を作る (対角 1 点だけでは回転時に誤る)
      const xs=[],ys=[],zs=[];
      for (const i of [0,v.nx]) for (const j of [0,v.ny]) for (const k of [0,v.nz]) {
        xs.push(v.imagePosition.x + i*v.vectorX.x + j*v.vectorY.x + k*v.vectorZ.x);
        ys.push(v.imagePosition.y + i*v.vectorX.y + j*v.vectorY.y + k*v.vectorZ.y);
        zs.push(v.imagePosition.z + i*v.vectorX.z + j*v.vectorY.z + k*v.vectorZ.z);
      }
      const r = a => [Math.min(...a), Math.max(...a)].map(n=>+n.toFixed(0));
      const c = reg.computeCentroidWorld(v);
      return { label, dims:[v.nx,v.ny,v.nz],
        vecX:[+v.vectorX.x.toFixed(3),+v.vectorX.y.toFixed(3),+v.vectorX.z.toFixed(3)],
        vecY:[+v.vectorY.x.toFixed(3),+v.vectorY.y.toFixed(3),+v.vectorY.z.toFixed(3)],
        vecZ:[+v.vectorZ.x.toFixed(3),+v.vectorZ.y.toFixed(3),+v.vectorZ.z.toFixed(3)],
        origin:[+v.imagePosition.x.toFixed(0),+v.imagePosition.y.toFixed(0),+v.imagePosition.z.toFixed(0)],
        bboxX:r(xs), bboxY:r(ys), bboxZ:r(zs),
        centroid: c ? [+c.x.toFixed(1),+c.y.toFixed(1),+c.z.toFixed(1)] : null };
    };
    const vols = d.seriesList.map((s,i)=>({i, v:s?.volume, mod:(s?.volume?.metadata?.modality??'').toUpperCase()}))
                             .filter(x=>!!x.v);
    const pt = vols.find(x=>x.mod==='PT'||x.mod==='PET') ?? vols[1];
    const mr = vols.find(x=>x!==pt) ?? vols[0];
    const a = info(pt.v,'PT'), b = info(mr.v,'MR');
    const dc = (a.centroid && b.centroid)
      ? [ +(a.centroid[0]-b.centroid[0]).toFixed(1), +(a.centroid[1]-b.centroid[1]).toFixed(1),
          +(a.centroid[2]-b.centroid[2]).toFixed(1) ] : null;
    const overlap = (r1,r2)=> Math.max(0, Math.min(r1[1],r2[1]) - Math.max(r1[0],r2[0]));
    return { pt:a, mr:b, centroidDelta: dc,
      centroidDist: dc ? +Math.hypot(...dc).toFixed(1) : null,
      bboxOverlapMm: { x: overlap(a.bboxX,b.bboxX), y: overlap(a.bboxY,b.bboxY), z: overlap(a.bboxZ,b.bboxZ) } };
  });
  console.log(JSON.stringify(out, null, 1));
} catch(e){ console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
