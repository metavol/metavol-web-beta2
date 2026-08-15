// 各シリーズの **index 軸 (i, j, k) が world のどの向きを指しているか** を出す。
//
// 目的: CLAUDE.md の「**MIP の回転軸は volume の k 軸 (添字空間)**。axial 撮像でのみ体軸まわりの
// 回転になる」という制約が、実データでどれだけ実害になるかを確かめる。
// k 軸が体軸 (world Z) でないシリーズがあれば、その MIP は解剖学的に誤った軸で回る。
//
// 出力: シリーズごとに dims / pitch / 各軸の world 方向 / 体軸に最も近い index 軸 / 判定。
//
// 使い方: node scripts/axis-orientation.mjs [--case Hirata20260728]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[axis] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[axis] ${prev} series`);

  const rows = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const sum = ss.seriesSummariesView;

    // volume を全部作ると重いので、PT / CT / MR だけ作る
    const want = [];
    sum.forEach((s, i) => {
      const m = (s.modality || '').toUpperCase();
      if (m === 'PT' || m === 'PET' || m === 'CT' || m === 'MR') want.push(i);
    });
    for (const i of want) d.ensureVolume_(i);
    await new Promise(r => setTimeout(r, Math.min(60000, 4000 + want.length * 2500)));

    const out = [];
    for (const i of want) {
      const v = d.seriesList[i].volume;
      if (!v) { out.push({ i, desc: sum[i].description, modality: sum[i].modality, error: 'no volume' }); continue; }
      const axes = [
        { name: 'i', v: v.vectorX, n: v.nx },
        { name: 'j', v: v.vectorY, n: v.ny },
        { name: 'k', v: v.vectorZ, n: v.nz },
      ];
      const info = axes.map(a => {
        const len = Math.hypot(a.v.x, a.v.y, a.v.z) || 1;
        return {
          name: a.name, n: a.n, pitch: +len.toFixed(3),
          dir: [+(a.v.x / len).toFixed(3), +(a.v.y / len).toFixed(3), +(a.v.z / len).toFixed(3)],
          absZ: Math.abs(a.v.z / len),          // world Z (体軸) との一致度
          extent: +(a.n * len).toFixed(0),
        };
      });
      // 体軸 (world Z) に最も近い index 軸
      let best = 0; for (let t = 1; t < 3; t++) if (info[t].absZ > info[best].absZ) best = t;
      out.push({
        i, desc: sum[i].description, modality: sum[i].modality,
        dims: [v.nx, v.ny, v.nz], axes: info,
        craniocaudalAxis: info[best].name, craniocaudalAlign: +info[best].absZ.toFixed(3),
        mipAxisOk: info[2].absZ > 0.9,      // MIP は k 軸まわりに回す。k が体軸ならOK
      });
    }
    return out;
  });

  console.log('\n  シリーズ                          dims              体軸に最も近い軸  MIP 回転軸(k)');
  console.log('  ' + '-'.repeat(84));
  let bad = 0;
  for (const r of rows) {
    if (r.error) { console.log(`  [${r.i}] ${(r.modality + ' ' + r.desc).slice(0, 30).padEnd(32)} ${r.error}`); continue; }
    const label = `[${r.i}] ${r.modality} ${r.desc ?? ''}`.slice(0, 32).padEnd(32);
    const verdict = r.mipAxisOk ? 'OK' : `NG (k は体軸でない)`;
    if (!r.mipAxisOk) bad++;
    console.log(`  ${label} ${r.dims.join('x').padEnd(16)} ${r.craniocaudalAxis} (${r.craniocaudalAlign})`.padEnd(72) + `  ${verdict}`);
  }
  console.log('\n  各軸の詳細 (world 方向 / voxel pitch / 全長mm)');
  for (const r of rows) {
    if (r.error) continue;
    console.log(`  [${r.i}] ${r.modality} ${r.desc ?? ''}`);
    for (const a of r.axes) {
      console.log(`      ${a.name}: n=${String(a.n).padStart(4)}  pitch=${String(a.pitch).padStart(6)}mm  ` +
                  `dir=[${a.dir.join(', ')}]  全長 ${String(a.extent).padStart(5)}mm`);
    }
  }
  console.log(`\n  MIP の回転軸が解剖学的に誤っているシリーズ: ${bad} / ${rows.filter(r => !r.error).length}`);
  if (bad > 0) {
    console.log('  → これらのシリーズで MIP を回すと、体軸まわりではなく別の軸まわりに回転する。');
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
