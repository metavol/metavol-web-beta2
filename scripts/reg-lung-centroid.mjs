// **肺マスクの重心合わせ**が使えるかを測る。
//
// 背景: 体の重心合わせは視野が食い違うと破綻する (CLAUDE.md 3.59。hirata2 で tz=+159.8mm)。
// 「写っている体」は視野で決まるが、**肺は解剖学的に閉じた臓器**なので、
// 両方の volume が肺を丸ごと含んでいれば重心は同じ解剖点を指す。
// 肺は CT では空気 (HU < -400)、PET では集積の抜けとして、どちらにも明瞭に写る。
//
// **前提条件 (必ず検査する)**: 肺マスクが FOV の端に接していないこと。
// 端に接していれば肺が切れており、重心は「写っている部分の重心」= 別の点になる。
//
// 出力: 各 volume の肺体積・重心、重心差 (= 推定並進)、端接触の有無。
// 正解が既知の症例 (同一 FoR = 差 0 が正解 / hirata2 = 目視で差 ≒ 0 が正解) で誤差を見る。
//
// 使い方: node scripts/reg-lung-centroid.mjs --case hirata2
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'hirata2');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[lung-centroid] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[lung-centroid] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const sum = app._instance.setupState.seriesSummariesView;
    let ctIdx = -1, ptIdx = -1;
    sum.forEach((s, i) => { const m = (s.modality || '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i; if ((m === 'PT' || m === 'PET') && ptIdx < 0) ptIdx = i; });
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r => setTimeout(r, 6000));
    const F = d.seriesList[ctIdx].volume, M = d.seriesList[ptIdx].volume;

    const pctl = (vol, p) => {
      const st = Math.max(1, Math.floor(vol.voxel.length / 60000));
      const a = []; for (let i = 0; i < vol.voxel.length; i += st) a.push(vol.voxel[i]);
      a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))];
    };
    const inBodyQuantile = (vol, bodyThr, q) => {
      const st = Math.max(1, Math.floor(vol.voxel.length / 200000));
      const a = [];
      for (let i = 0; i < vol.voxel.length; i += st) { const v = vol.voxel[i]; if (v > bodyThr) a.push(v); }
      if (a.length < 100) return bodyThr;
      a.sort((x, y) => x - y); return a[Math.floor(a.length * q)];
    };

    // 肺マスクを voxel 空間で作り、world 重心と「FOV 端に接しているか」を返す。
    // 体シルエットは **各スキャン行の左右端の内側** で近似する (体外の空気を除くため)。
    const lungOf = (vol, bodyThr, lungThr) => {
      let n = 0, cx = 0, cy = 0, cz = 0;
      let touchZ0 = 0, touchZ1 = 0, touchXY = 0;
      const nx = vol.nx, ny = vol.ny, nz = vol.nz;
      // 大きい volume でも一定コストに収める
      const sx = Math.max(1, Math.round(nx / 128)), sy = Math.max(1, Math.round(ny / 128)), sz = Math.max(1, Math.round(nz / 160));
      for (let k = 0; k < nz; k += sz) {
        const kb = k * nx * ny;
        for (let j = 0; j < ny; j += sy) {
          const rb = kb + j * nx;
          // 行の体の左右端
          let lo = -1, hi = -1;
          for (let i = 0; i < nx; i += sx) { if (vol.voxel[rb + i] > bodyThr) { if (lo < 0) lo = i; hi = i; } }
          if (lo < 0 || hi <= lo) continue;
          for (let i = lo; i <= hi; i += sx) {
            if (!(vol.voxel[rb + i] < lungThr)) continue;
            n++;
            cx += vol.imagePosition.x + vol.vectorX.x * i + vol.vectorY.x * j + vol.vectorZ.x * k;
            cy += vol.imagePosition.y + vol.vectorX.y * i + vol.vectorY.y * j + vol.vectorZ.y * k;
            cz += vol.imagePosition.z + vol.vectorX.z * i + vol.vectorY.z * j + vol.vectorZ.z * k;
            if (k < sz * 2) touchZ0++;
            if (k >= nz - sz * 3) touchZ1++;
            if (i <= lo || i >= hi - sx) touchXY++;
          }
        }
      }
      if (!n) return null;
      // voxel 体積 (mm^3) × サンプル間引き分
      const vv = Math.abs(vol.vectorX.length() * vol.vectorY.length() * vol.vectorZ.length()) * sx * sy * sz;
      return { n, volumeMl: (n * vv) / 1000,
               c: [cx / n, cy / n, cz / n],
               touchZ0Frac: touchZ0 / n, touchZ1Frac: touchZ1 / n, touchXYFrac: touchXY / n };
    };

    const ctBody = -300, ctLung = -400;
    const ptBody = pctl(M, 0.975) * 0.25;
    const ptLung = inBodyQuantile(M, ptBody, 0.25);

    const L = lungOf(F, ctBody, ctLung);
    const P = lungOf(M, ptBody, ptLung);
    if (!L || !P) return { error: 'lung mask empty', L, P };

    // 参考: 体重心 (従来の初期化) との比較
    const reg = await import('/metavol-web-beta2/src/components/registration/registerMrPt.ts');
    const bodyInit = reg.centroidInitParams(F, M);

    return {
      ctDesc: sum[ctIdx].description, ptDesc: sum[ptIdx].description,
      thresholds: { ctBody, ctLung, ptBody: +ptBody.toFixed(3), ptLung: +ptLung.toFixed(3) },
      ct: { ...L, c: L.c.map(v => +v.toFixed(1)), volumeMl: +L.volumeMl.toFixed(0),
            touchZ0Frac: +L.touchZ0Frac.toFixed(3), touchZ1Frac: +L.touchZ1Frac.toFixed(3), touchXYFrac: +L.touchXYFrac.toFixed(3) },
      pt: { ...P, c: P.c.map(v => +v.toFixed(1)), volumeMl: +P.volumeMl.toFixed(0),
            touchZ0Frac: +P.touchZ0Frac.toFixed(3), touchZ1Frac: +P.touchZ1Frac.toFixed(3), touchXYFrac: +P.touchXYFrac.toFixed(3) },
      lungDelta: [L.c[0] - P.c[0], L.c[1] - P.c[1], L.c[2] - P.c[2]].map(v => +v.toFixed(1)),
      bodyDelta: bodyInit.slice(0, 3).map(v => +v.toFixed(1)),
    };
  });

  if (out.error) { console.error('  ERROR:', out.error, JSON.stringify(out)); process.exitCode = 1; }
  else {
    console.log(`\n  CT: ${out.ctDesc}`);
    console.log(`  PT: ${out.ptDesc}`);
    console.log(`  しきい値 CT: body>${out.thresholds.ctBody} lung<${out.thresholds.ctLung} / ` +
                `PT: body>${out.thresholds.ptBody} lung<${out.thresholds.ptLung}`);
    console.log(`\n  肺マスク             体積(ml)   重心 (x, y, z) mm`);
    console.log(`    CT                ${String(out.ct.volumeMl).padStart(8)}   ${out.ct.c.join(', ')}`);
    console.log(`    PT                ${String(out.pt.volumeMl).padStart(8)}   ${out.pt.c.join(', ')}`);
    console.log(`\n  FOV 端への接触 (0 に近いほど肺が丸ごと入っている)`);
    console.log(`    CT  z下端 ${out.ct.touchZ0Frac}  z上端 ${out.ct.touchZ1Frac}  面内 ${out.ct.touchXYFrac}`);
    console.log(`    PT  z下端 ${out.pt.touchZ0Frac}  z上端 ${out.pt.touchZ1Frac}  面内 ${out.pt.touchXYFrac}`);
    console.log(`\n  推定並進 (PET をこれだけ動かすと CT に合う)`);
    console.log(`    肺 重心合わせ : ${out.lungDelta.join(', ')} mm`);
    console.log(`    体 重心合わせ : ${out.bodyDelta.join(', ')} mm   <- 従来 (視野が違うと破綻)`);
    const mag = Math.hypot(...out.lungDelta);
    console.log(`\n  肺重心合わせの移動量: ${mag.toFixed(1)} mm  (正解が「動かさない」なら 0 に近いほど良い)`);
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
