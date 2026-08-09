// MI 指標そのものの健全性を測る。
//   - 重なりサンプル数 n、各エントロピー、使用ビン数、強度レンジ
//   - 正解姿勢を中心に x/y/z を振ったときのスコア断面 (谷になっているか)
// 使い方: node scripts/reg-profile.mjs   (dev server 起動済み)

import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/?dev=${opt('case','Hirata20260728')}`;
const FIXED = parseInt(opt('fixed', '8'), 10);
const MOVING = parseInt(opt('moving', '14'), 10);

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) > 0,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\nloaded ${prev} series`);

  const out = await page.evaluate(async ({ FIXED, MOVING }) => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    d.ensureVolume_(FIXED); d.ensureVolume_(MOVING);
    await new Promise(r => setTimeout(r, 5000));
    const B = '/metavol-web-beta2/src/components/registration/';
    const [mi, tf] = await Promise.all([import(B + 'mi.ts'), import(B + 'transform.ts')]);
    const F = d.seriesList[FIXED].volume, M = d.seriesList[MOVING].volume;

    // volume の素性
    const describe = (v) => {
      const stride = Math.max(1, Math.floor(v.voxel.length / 50000));
      const a = []; for (let i = 0; i < v.voxel.length; i += stride) a.push(v.voxel[i]);
      a.sort((x, y) => x - y);
      const p = (q) => +a[Math.floor(a.length * q)].toFixed(2);
      const w0 = [v.imagePosition.x, v.imagePosition.y, v.imagePosition.z];
      const w1 = [w0[0] + v.nx*v.vectorX.x + v.ny*v.vectorY.x + v.nz*v.vectorZ.x,
                  w0[1] + v.nx*v.vectorX.y + v.ny*v.vectorY.y + v.nz*v.vectorZ.y,
                  w0[2] + v.nx*v.vectorX.z + v.ny*v.vectorY.z + v.nz*v.vectorZ.z];
      return { dims:[v.nx,v.ny,v.nz], pct:{p1:p(0.01),p25:p(0.25),p50:p(0.5),p75:p(0.75),p99:p(0.99)},
               worldFrom:w0.map(x=>+x.toFixed(0)), worldTo:w1.map(x=>+x.toFixed(0)) };
    };

    // 素の統計を取り直す (mi.ts の内部と同じ手順)
    const probe = (bodyOnly, normalized) => {
      const samples = mi.generateFixedSamples(F, 8000, 12345, { bodyOnly });
      const stats = mi.estimateIntensityRange(F, M, samples);
      // 手作業でヒストグラムを組んで中身を見る
      const bins = 32, N = samples.length / 3;
      const T = tf.makeRigidMatrix([0,0,0,0,0,0]);
      const hF = new Float64Array(bins), hM = new Float64Array(bins), hJ = new Float64Array(bins*bins);
      let n = 0;
      const fLo = stats.fixedMin, fR = (stats.fixedMax - stats.fixedMin) || 1;
      const mLo = stats.movingMin, mR = (stats.movingMax - stats.movingMin) || 1;
      const sample = (vol, x, y, z) => {
        const inv = vol.__inv || (vol.__inv = null);
        return null; // 使わない
      };
      void T; void sample;
      // computeNegativeMI と同じ経路で値だけ取り出すのは難しいので、
      // ここでは overlap 数を worldToVoxel 相当で概算する
      for (let i = 0; i < N; i++) {
        const wx = samples[i*3], wy = samples[i*3+1], wz = samples[i*3+2];
        // moving の voxel 座標へ (affine の逆): 近似として bounding box 判定
        const rel = [wx - M.imagePosition.x, wy - M.imagePosition.y, wz - M.imagePosition.z];
        // 軸平行前提の簡易判定 (この症例は軸平行)
        const vi = rel[0] / M.vectorX.x, vj = rel[1] / M.vectorY.y, vk = rel[2] / M.vectorZ.z;
        if (vi >= 0 && vi < M.nx && vj >= 0 && vj < M.ny && vk >= 0 && vk < M.nz) n++;
      }
      void hF; void hM; void hJ; void fLo; void fR; void mLo; void mR;
      return { bodyOnly, normalized, nSamples: N, overlapApprox: n, stats: {
        fixedMin:+stats.fixedMin.toFixed(2), fixedMax:+stats.fixedMax.toFixed(2),
        movingMin:+stats.movingMin.toFixed(3), movingMax:+stats.movingMax.toFixed(3) } };
    };

    // 正解 (= identity, 装置が合わせた姿勢) を中心にスコア断面
    const profile = (bodyOnly, normalized, axis) => {
      const samples = mi.generateFixedSamples(F, 8000, 12345, { bodyOnly });
      const stats = mi.estimateIntensityRange(F, M, samples);
      const row = [];
      for (let dmm = -60; dmm <= 60; dmm += 10) {
        const p = [0,0,0,0,0,0]; p[axis] = dmm;
        row.push(+mi.computeNegativeMI(F, M, samples, stats, p, undefined, { normalized }).toFixed(4));
      }
      return row;
    };

    return {
      fixed: describe(F), moving: describe(M),
      probes: [probe(false,false), probe(true,false)],
      profiles: {
        'MI  all  x': profile(false,false,0),
        'MI  body x': profile(true, false,0),
        'NMI body x': profile(true, true, 0),
        'NMI body z': profile(true, true, 2),
      },
    };
  }, { FIXED, MOVING });

  console.log('\nfixed  ', JSON.stringify(out.fixed));
  console.log('moving ', JSON.stringify(out.moving));
  console.log('\nprobes:'); for (const p of out.probes) console.log('  ', JSON.stringify(p));
  console.log('\nscore profile (x/z = -60..+60 mm step 10; 0 = 正解姿勢。最小値が中央に来るのが正しい):');
  for (const [k, v] of Object.entries(out.profiles)) {
    const min = Math.min(...v); const at = (v.indexOf(min) - 6) * 10;
    console.log(`  ${k}: ${JSON.stringify(v)}  min@${at}mm`);
  }
} catch (e) { console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
