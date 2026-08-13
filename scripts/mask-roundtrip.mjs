// マスクの **保存 → 読み戻し (round-trip)** を実データで e2e 検証する。
//
// TODO.md に「niftiReader は実装済だが SegmentationPanel からの読込フローが store に反映されるか
// 未検証」と残っていた項目。ファイル選択ダイアログは自動化できないので、
// **パネルが呼ぶのと同じ関数** (writeNiftiUint16 → readNiftiMask → store.loadMaskFromNifti) を
// 直接叩いて、往復で mask が 1 voxel も変わらないことを確認する。
//
// 確認項目:
//   1. 閾値マスクを作る → voxel 数とラベル分布を記録
//   2. writeNiftiUint16 で Blob 化 → readNiftiMask で読み戻す
//   3. dims / voxel pitch がヘッダ往復で保たれるか
//   4. store.loadMaskFromNifti 後の finalMask が元と **完全一致**するか
//   5. sidecar (threshold / labels) が復元されるか
//   6. **異常系**: dims が違うマスクを拒否するか
//
// 使い方: node scripts/mask-roundtrip.mjs [--case Hirata20260728]
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
  console.log(`[roundtrip] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[roundtrip] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const store = d.segStore ?? d.store;
    const [W, R] = await Promise.all([
      import('/metavol-web-beta2/src/components/segmentation/niftiWriter.ts'),
      import('/metavol-web-beta2/src/components/segmentation/niftiReader.ts'),
    ]);

    // --- PET を用意 ---
    // **スライス数が最大の PT を選ぶ。** 先頭の PT を採ると症例によっては短い局所 PET が当たり、
    // SUV 2.5 で 1 voxel も立たず「空マスクが往復した」だけの無意味な PASS になる (実測あり)。
    const sum = ss.seriesSummariesView;
    let ptIdx = -1, ptCount = -1;
    sum.forEach((s, i) => {
      const m = (s.modality || '').toUpperCase();
      if (m !== 'PT' && m !== 'PET') return;
      const n = s.numberOfSlices ?? s.count ?? s.nSlices ?? 0;
      if (n > ptCount) { ptCount = n; ptIdx = i; }
    });
    if (ptIdx < 0) return { error: 'no PT series', mods: sum.map(s => s.modality) };
    d.ensureVolume_(ptIdx);
    await new Promise(r => setTimeout(r, 6000));
    const pet = d.seriesList[ptIdx].volume;
    if (!pet) return { error: 'PET volume build failed' };
    store.setPetVolume(pet);

    // --- ① 閾値マスクを作る ---
    store.thresholdUnit = 'SUV';
    store.applyThreshold(2.5);
    let fm = store.finalMask;
    if (!fm) return { error: 'threshold produced no mask' };
    // ラベルを 2 種類に散らす。
    // **幾何的な半分 (k >= nz/2) で切ってはいけない。** マスクが片側に偏っている volume では
    // 全部が同じラベルになり、「多ラベル往復」を試したつもりで 1 ラベルしか確認できない
    // (実測: Hirata の PET 256x490x146 で label 1 が 0 個になった)。
    // 立っている voxel を index 順に数えて **ちょうど半数**で切る。
    const nonZero = [];
    for (let i = 0; i < fm.length; i++) if (fm[i] !== 0) nonZero.push(i);
    if (nonZero.length < 100) return { error: `threshold produced too few voxels (${nonZero.length}); pick another series or threshold` };
    // **ラベル ID を決め打ちしないこと。** applyThreshold は `currentLabelId` で塗るので、
    // それが何かは症例/設定次第 (実測 Hirata では 2 だった)。2 を代入したら no-op になり、
    // 1 ラベルのまま「多ラベル往復 PASS」と誤表示した。既存ラベルを読んで別 ID を割り当てる。
    const baseLabel = fm[nonZero[0]];
    const otherLabel = baseLabel === 1 ? 2 : 1;
    const me = store.manualEdits;
    for (let n = Math.floor(nonZero.length / 2); n < nonZero.length; n++) me[nonZero[n]] = otherLabel;
    store.recomputeFinalMask();
    fm = store.finalMask;

    const histOf = (m) => { const h = {}; for (let i = 0; i < m.length; i++) { const v = m[i]; if (v) h[v] = (h[v] || 0) + 1; } return h; };
    const before = histOf(fm);
    const beforeCopy = Uint16Array.from(fm);
    const beforeThreshold = store.threshold;
    const beforeLabels = store.labels.map(l => ({ id: l.id, name: l.name }));

    // --- ② 保存 → 読み戻し ---
    const blob = W.writeNiftiUint16(fm, pet);
    const buf = await blob.arrayBuffer();
    const parsed = R.readNiftiMask(buf);

    const pitch = [pet.vectorX.length(), pet.vectorY.length(), pet.vectorZ.length()];
    const dimsOk = parsed.dims[0] === pet.nx && parsed.dims[1] === pet.ny && parsed.dims[2] === pet.nz;
    const pitchErr = parsed.voxelSizeMm.map((v, i) => Math.abs(v - pitch[i]));

    // --- ③ store へ流し込む (パネルと同じ経路) ---
    // 先に mask を壊しておき、「本当に読み込まれた」ことを確かめる
    store.clearAll ? store.clearAll() : store.manualEdits.fill(0);
    store.thresholdMask.fill(0);
    store.recomputeFinalMask();
    const wipedNonZero = store.finalMask.reduce((a, v) => a + (v ? 1 : 0), 0);

    const sidecar = { threshold: 3.75, thresholdUnit: 'SUV',
                      labels: [{ id: 1, name: 'RT-Tumor', color: [255, 0, 0] },
                               { id: 2, name: 'RT-Physio', color: [0, 255, 0] }] };
    const res = store.loadMaskFromNifti(parsed.mask, parsed.dims, sidecar);
    if (!res.ok) return { error: 'loadMaskFromNifti rejected: ' + res.reason };

    const after = store.finalMask;
    let diff = 0, firstDiff = -1;
    for (let i = 0; i < beforeCopy.length; i++) {
      if (beforeCopy[i] !== after[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
    }

    // --- ④ 異常系: dims 不一致は拒否されるか ---
    const badDims = store.loadMaskFromNifti(new Uint16Array(8), [2, 2, 2], null);

    return {
      petDims: [pet.nx, pet.ny, pet.nz], pitch: pitch.map(v => +v.toFixed(4)),
      before, beforeThreshold, beforeLabels,
      dimsOk, parsedDims: parsed.dims, parsedPitch: parsed.voxelSizeMm.map(v => +v.toFixed(4)),
      pitchErr: pitchErr.map(v => +v.toFixed(6)),
      wipedNonZero,
      after: histOf(after), diff, firstDiff,
      afterThreshold: store.threshold, afterUnit: store.thresholdUnit,
      afterLabels: store.labels.map(l => ({ id: l.id, name: l.name })),
      badDimsRejected: !badDims.ok, badDimsReason: badDims.ok ? null : badDims.reason,
      blobBytes: blob.size,
    };
  });

  if (out.error) { console.error('\n  ERROR:', out.error, JSON.stringify(out.mods ?? '')); process.exitCode = 1; }
  else {
    const P = (ok) => ok ? 'PASS' : 'FAIL';
    console.log(`\nPET ${out.petDims.join('x')}  pitch ${out.pitch.join(' / ')} mm`);
    console.log(`NIfTI ${(out.blobBytes / 1048576).toFixed(1)} MB`);
    console.log('\n  項目                              結果');
    console.log('  ' + '-'.repeat(56));
    console.log(`  dims 往復                         ${P(out.dimsOk)}  ${out.parsedDims.join('x')}`);
    console.log(`  voxel pitch 往復 (誤差<1e-3mm)     ${P(out.pitchErr.every(e => e < 1e-3))}  ±${Math.max(...out.pitchErr)}`);
    console.log(`  読み込み前に mask を消せている      ${P(out.wipedNonZero === 0)}  nonzero=${out.wipedNonZero}`);
    console.log(`  finalMask 完全一致                 ${P(out.diff === 0)}  差分 ${out.diff} voxel`);
    const nLabels = Object.keys(out.before).length;
    console.log(`  多ラベル保持 (2 ラベル必須)         ${P(nLabels >= 2 && JSON.stringify(out.before) === JSON.stringify(out.after))}  ${nLabels} labels`);
    console.log(`  sidecar threshold 復元             ${P(out.afterThreshold === 3.75)}  ${out.beforeThreshold} -> ${out.afterThreshold}`);
    console.log(`  sidecar labels 復元                ${P(out.afterLabels.some(l => l.name === 'RT-Tumor'))}  ${out.afterLabels.map(l => l.name).join(', ')}`);
    console.log(`  dims 不一致を拒否                  ${P(out.badDimsRejected)}`);
    console.log(`\n  ラベル分布 前: ${JSON.stringify(out.before)}`);
    console.log(`             後: ${JSON.stringify(out.after)}`);
    if (out.diff) console.log(`  最初の相違 index: ${out.firstDiff}`);
    if (out.badDimsReason) console.log(`  拒否メッセージ: ${out.badDimsReason}`);
    // **空マスク / 単一ラベルは PASS にしない** (素通りするため)
    const allPass = out.dimsOk && out.pitchErr.every(e => e < 1e-3) && out.wipedNonZero === 0
      && out.diff === 0 && out.badDimsRejected && out.afterThreshold === 3.75
      && nLabels >= 2;
    console.log(`\n  総合: ${allPass ? 'PASS' : 'FAIL'}`);
    if (!allPass) process.exitCode = 1;
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
