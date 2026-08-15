// **肺を解剖ランドマークにした指標**が hirata2 の正解を指すかを確かめる。
//
// これまで失敗した 5 指標 (MI / NMI / それぞれ体内限定 / 体断面積プロファイル) は、
// いずれも「z 方向に鋭い特徴」を持たなかった。胸部 CT は体断面積の変化が乏しいため。
// 一方 **肺は CT では空気 (HU -800 前後)、PET では集積の抜け** として、どちらにも
// 「肺尖で始まり横隔膜で終わる」鋭い境界を作る。ここを合わせれば z が決まるはず。
//
// 指標 2 種を同時に評価する (どちらも modality 非依存になるよう正規化してから相関を取る):
//   A) lung fraction プロファイル … 体シルエット内で「抜けている」面積の割合 vs world z
//   B) mean-in-body プロファイル  … 体シルエット内の平均値 vs world z
//      (肺で下がり肝で上がる。CT/PET とも同じ向きに動くので z スコア化すれば比較できる)
//
// **自己試験を必ず先に通す** (CLAUDE.md 3.59 の教訓)。既知量 tz を足した moving を作り、
// 指標のピークがその量ぶん動くかを見る。動かない指標は識別力が無いので、掃引結果も信用しない。
//
// 使い方: node scripts/reg-lung-sweep.mjs [--case hirata2]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${opt('case', 'hirata2')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[lung] loading…');
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 2,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[lung] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const tf = await import('/metavol-web-beta2/src/components/registration/transform.ts');
    const V = await import('/metavol-web-beta2/src/components/Volume.ts');
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');

    const sum = app._instance.setupState.seriesSummariesView;
    let ctIdx = -1, ptIdx = -1;
    sum.forEach((s, i) => { const m = (s.modality || '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i; if ((m === 'PT' || m === 'PET') && ptIdx < 0) ptIdx = i; });
    d.ensureVolume_(ctIdx); d.ensureVolume_(ptIdx);
    await new Promise(r => setTimeout(r, 6000));
    const F = d.seriesList[ctIdx].volume, M = d.seriesList[ptIdx].volume;

    // --- しきい値 ---
    // **肺のしきい値を強度の絶対値で決めてはいけない。**
    // 最初 PET 側を「p97.5 の 4%」= 0.041 にしたが、肺の SUV は 0.4〜0.6 なので
    // まるごと「体」に分類され、肺の面積プロファイルが雑音になった (実測: tz=0 で相関 -0.11)。
    // **順位で決める**: 体内 voxel の下位 25% を「抜けている」とみなす。
    // 肺は CT でも PET でも体内で最も低信号なので、これなら modality に依らず同じ解剖を拾う。
    const pctl = (vol, p) => {
      const st = Math.max(1, Math.floor(vol.voxel.length / 60000));
      const a = []; for (let i = 0; i < vol.voxel.length; i += st) a.push(vol.voxel[i]);
      a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))];
    };
    // 体のしきい値: CT は HU で決め打ち、PET は「体内の代表値」に対する比で決める。
    // PET の体しきい値も低すぎると体外の雑音を体に含めてしまうので p97.5 の 25% にする。
    const PT_HI = pctl(M, 0.975);
    const TH = { ct: { body: -300, air: -400 }, pt: { body: PT_HI * 0.25, air: 0 } };

    // 体内 voxel の下位 25% 点を volume ごとに求め、それを「抜け」のしきい値にする。
    const inBodyQuantile = (vol, bodyThr, q) => {
      const st = Math.max(1, Math.floor(vol.voxel.length / 200000));
      const a = [];
      for (let i = 0; i < vol.voxel.length; i += st) { const v = vol.voxel[i]; if (v > bodyThr) a.push(v); }
      if (a.length < 100) return bodyThr;
      a.sort((x, y) => x - y);
      return a[Math.floor(a.length * q)];
    };
    // **CT は物理値で決めること。順位で決めてはいけない。**
    // 体内 voxel の下位 25% を採ると -118HU になり、これは肺ではなく **脂肪** (-100HU 前後)。
    // 全身 CT では脂肪の分布が肺と全く違うので、PET の「集積の抜け」とは別物を測ってしまう
    // (実測 Hirata20260728: 正解 tz=0 での相関 -0.07 = 無相関)。
    // 肺実質は -700〜-900HU なので -400HU なら脂肪と明確に分かれる。
    // PET には対応する物理値が無い (SUV スケールは症例依存) ので順位で決めるしかない。
    TH.ct.air = -400;
    void inBodyQuantile(F, TH.ct.body, 0.25);   // 参考値 (使わない)
    TH.pt.air = inBodyQuantile(M, TH.pt.body, 0.25);

    const sampleNN = (vol, w) => {
      const v = V.worldToVoxel(w, vol);
      const x = Math.round(v.x), y = Math.round(v.y), z = Math.round(v.z);
      if (x < 0 || y < 0 || z < 0 || x >= vol.nx || y >= vol.ny || z >= vol.nz) return null;
      return vol.voxel[z * vol.nx * vol.ny + y * vol.nx + x];
    };

    // CT の world bbox を走査範囲にする (fixed 側の視野が共通領域)
    const corners = (v, f) => { const a = [];
      for (const i of [0, v.nx]) for (const j of [0, v.ny]) for (const k of [0, v.nz]) a.push(f(i, j, k)); return a; };
    const zz = corners(F, (i, j, k) => F.imagePosition.z + i * F.vectorX.z + j * F.vectorY.z + k * F.vectorZ.z);
    const xx = corners(F, (i, j, k) => F.imagePosition.x + i * F.vectorX.x + j * F.vectorY.x + k * F.vectorZ.x);
    const yy = corners(F, (i, j, k) => F.imagePosition.y + i * F.vectorX.y + j * F.vectorY.y + k * F.vectorZ.y);
    const zs = []; for (let z = Math.min(...zz); z <= Math.max(...zz); z += 4) zs.push(z);
    const x0 = Math.min(...xx), x1 = Math.max(...xx), y0 = Math.min(...yy), y1 = Math.max(...yy);
    const XY = 4;

    // 1 つの volume について z ごとの (lungFrac, meanInBody) を返す。
    //
    // 体シルエットは **行と列の両方で体に挟まれている** ことを要求する。
    // 当初は行 (x 方向) の左右端の内側だけを体内としていたが、これは**全身 CT で破綻する**。
    // 脚の間の空気は左右の脚に挟まれているので「体内」と判定され、HU < -400 なので
    // まるごと「肺」に数えられる。腕と体幹の隙間も同じ。
    // 実測 (cervicalca, 全身 CT 1725mm): CT の肺マスクが **36,181ml** に膨れた
    // (実際の肺は 5,000ml 程度)。これで肺の信号が埋もれ、指標が正解を指さなくなった。
    // 列 (y 方向) にも同じ条件を課すと、脚の間を通る列には体がまったく無いので除外される。
    // 肺は胸壁 (x) と胸骨・脊椎 (y) の両方に挟まれるので残る。
    const nxs = Math.floor((x1 - x0) / XY) + 1;
    const nys = Math.floor((y1 - y0) / XY) + 1;
    const val = new Float32Array(nxs * nys);
    const has = new Uint8Array(nxs * nys);
    const profile = (vol, th, params) => {
      const Tinv = params ? tf.makeRigidMatrix(params).clone().invert() : null;
      const w = new THREE.Vector3(), w2 = new THREE.Vector3();
      const lungFrac = [], meanBody = [];
      for (const z of zs) {
        // ① 1 スライスぶんを一度サンプルして 2D 格子に貯める
        val.fill(0); has.fill(0);
        for (let jy = 0; jy < nys; jy++) {
          const y = y0 + jy * XY, rb = jy * nxs;
          for (let ix = 0; ix < nxs; ix++) {
            w.set(x0 + ix * XY, y, z);
            let v;
            if (Tinv) { w2.copy(w).applyMatrix4(Tinv); v = sampleNN(vol, w2); } else v = sampleNN(vol, w);
            if (v == null) continue;
            val[rb + ix] = v; has[rb + ix] = 1;
          }
        }
        // ② 行ごと / 列ごとの体の端を求める
        const rowLo = new Int32Array(nys).fill(-1), rowHi = new Int32Array(nys).fill(-1);
        for (let jy = 0; jy < nys; jy++) {
          const rb = jy * nxs;
          for (let ix = 0; ix < nxs; ix++) {
            if (has[rb + ix] && val[rb + ix] > th.body) { if (rowLo[jy] < 0) rowLo[jy] = ix; rowHi[jy] = ix; }
          }
        }
        const colLo = new Int32Array(nxs).fill(-1), colHi = new Int32Array(nxs).fill(-1);
        for (let ix = 0; ix < nxs; ix++) {
          for (let jy = 0; jy < nys; jy++) {
            const p = jy * nxs + ix;
            if (has[p] && val[p] > th.body) { if (colLo[ix] < 0) colLo[ix] = jy; colHi[ix] = jy; }
          }
        }
        // ③ 行と列の**両方**の内側だけを体内とみなす
        let inside = 0, gas = 0, sum = 0;
        for (let jy = 0; jy < nys; jy++) {
          if (rowLo[jy] < 0) continue;
          const rb = jy * nxs;
          for (let ix = rowLo[jy]; ix <= rowHi[jy]; ix++) {
            if (!has[rb + ix]) continue;
            if (colLo[ix] < 0 || jy < colLo[ix] || jy > colHi[ix]) continue;
            const v = val[rb + ix];
            inside++; sum += v;
            if (v < th.air) gas++;
          }
        }
        lungFrac.push(inside ? gas / inside : 0);
        meanBody.push(inside ? sum / inside : 0);
      }
      return { lungFrac, meanBody };
    };

    const zscore = (v) => {
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length) || 1;
      return v.map(x => (x - m) / sd);
    };
    const corr = (a, b) => { const A = zscore(a), B = zscore(b);
      let c = 0; for (let i = 0; i < A.length; i++) c += A[i] * B[i]; return c / A.length; };

    const ct = profile(F, TH.ct, null);
    const snap = tf.captureRegistrationSnapshot(M);

    const evalAt = (tz) => {
      const p = profile(M, TH.pt, [0, 0, tz, 0, 0, 0]);
      return { lung: +corr(ct.lungFrac, p.lungFrac).toFixed(4),
               mean: +corr(ct.meanBody, p.meanBody).toFixed(4) };
    };

    // --- 掃引 ---
    const sweep = [];
    for (let z = -60; z <= 80; z += 5) sweep.push({ tz: z, ...evalAt(z) });

    // --- 自己試験: ピークに既知量を足して、その量ぶん動くか ---
    const argmax = (key) => { let bi = 0; for (let i = 1; i < sweep.length; i++) if (sweep[i][key] > sweep[bi][key]) bi = i; return sweep[bi]; };
    const peakLung = argmax('lung'), peakMean = argmax('mean');
    const selfTest = [];
    for (const dz of [-20, 15]) {
      // moving 全体を dz ずらした状態で掃引し直す → ピークが (peak - dz) に来るはず
      const sub = [];
      for (let z = -60; z <= 80; z += 5) {
        const p = profile(M, TH.pt, [0, 0, z + dz, 0, 0, 0]);
        sub.push({ tz: z, lung: corr(ct.lungFrac, p.lungFrac), mean: corr(ct.meanBody, p.meanBody) });
      }
      const am = (key) => { let bi = 0; for (let i = 1; i < sub.length; i++) if (sub[i][key] > sub[bi][key]) bi = i; return sub[bi].tz; };
      selfTest.push({ appliedDz: dz, expectedPeakLung: peakLung.tz - dz, gotLung: am('lung'),
                      expectedPeakMean: peakMean.tz - dz, gotMean: am('mean') });
    }

    tf.applyRigidToVolume(M, snap, [0, 0, 0, 0, 0, 0]);
    return { zBins: zs.length, thresholds: TH, sweep, peakLung, peakMean,
             atZero: sweep.find(s => s.tz === 0), selfTest };
  });

  console.log(`\nprofile bins (4mm): ${out.zBins}`);
  console.log(`しきい値: CT body>${out.thresholds.ct.body} lung<${out.thresholds.ct.air.toFixed(1)} / ` +
              `PT body>${out.thresholds.pt.body.toFixed(3)} lung<${out.thresholds.pt.air.toFixed(3)}`);

  console.log('\n--- 自己試験 (これが通らなければ以下の数値は無意味) ---');
  let selfOk = true;
  for (const t of out.selfTest) {
    const okL = Math.abs(t.gotLung - t.expectedPeakLung) <= 10;
    const okM = Math.abs(t.gotMean - t.expectedPeakMean) <= 10;
    if (!okL) selfOk = false;
    console.log(`  dz=${String(t.appliedDz).padStart(4)}mm  lung: 期待 ${t.expectedPeakLung} → 実測 ${t.gotLung} ${okL ? 'OK' : 'NG'}` +
                `   mean: 期待 ${t.expectedPeakMean} → 実測 ${t.gotMean} ${okM ? 'OK' : 'NG'}`);
  }

  // **合成指標**: lung と mean は別の解剖を測っている。単純和で偏りが打ち消せるかを見る。
  const comb = out.sweep.map(s => ({ tz: s.tz, v: +(s.lung + s.mean).toFixed(4) }));
  let ci = 0; for (let i = 1; i < comb.length; i++) if (comb[i].v > comb[ci].v) ci = i;
  const combPeak = comb[ci], combZero = comb.find(c => c.tz === 0);

  console.log('\n--- 掃引結果 (正解は tz = 0) ---');
  console.log(`  lung fraction  最大 tz=${String(out.peakLung.tz).padStart(4)}mm (corr ${out.peakLung.lung})   tz=0 では ${out.atZero.lung}`);
  console.log(`  mean-in-body   最大 tz=${String(out.peakMean.tz).padStart(4)}mm (corr ${out.peakMean.mean})   tz=0 では ${out.atZero.mean}`);
  console.log(`  lung+mean 合成 最大 tz=${String(combPeak.tz).padStart(4)}mm (${combPeak.v})   tz=0 では ${combZero.v}`);
  const verdict = (tz) => Math.abs(tz) <= 15 ? 'OK' : 'NG';
  console.log(`\n  lung fraction : ${verdict(out.peakLung.tz)}`);
  console.log(`  mean-in-body  : ${verdict(out.peakMean.tz)}`);
  console.log(`  lung+mean     : ${verdict(combPeak.tz)}`);
  if (!selfOk) console.log('\n  ※ 自己試験が通っていないので、上の判定は信用できない');

  console.log('\n掃引 (tz: lung / mean / 合成):');
  const parts = out.sweep.map((s, i) => `${s.tz}:${s.lung}/${s.mean}/${comb[i].v}`);
  for (let i = 0; i < parts.length; i += 4) console.log('  ' + parts.slice(i, i + 4).join('  '));
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
