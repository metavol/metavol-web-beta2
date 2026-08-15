// NIfTI の modality 推定と **手動指定** が store まで届くかを確認する。
//
// CLAUDE.md の既知バグ 4 は「NIfTI のみロード時は modality 不明。Set as PT/CT ボタン **未実装**」と
// 書かれていたが、実際には `SeriesList.vue` に Set as PT/CT/MR があり
// `DicomView.onSetSeriesModality` が store まで配線されている。それを実測で確かめる。
//
// 確認項目:
//   1. `guessModalityFromVoxels` が kitty.nii を CT と当てる (空気 -1000 の指紋)
//   2. 手動指定 (PT) が metadata と segStore.petVolumeRef の両方に反映される
//   3. 指定し直し (CT) で segStore.ctVolumeRef に移る
//   4. seriesUID が無い NIfTI にも sentinel UID が振られる (registration の照合に必要)
//
// 使い方: node scripts/nifti-modality.mjs [--case kitty]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'kitty');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[modality] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 600000 });
  await page.waitForTimeout(6000);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const dv = ss.dicomViewRef.value ?? ss.dicomViewRef;
    const d = dv.$.setupState;
    const store = d.segStore ?? d.store;
    const sum = ss.seriesSummariesView;
    if (!sum.length) return { error: 'no series' };

    // volume を持つ最初のシリーズ
    let idx = -1;
    for (let i = 0; i < d.seriesList.length; i++) { if (d.seriesList[i].volume) { idx = i; break; } }
    if (idx < 0) { d.ensureVolume_(0); await new Promise(r => setTimeout(r, 5000)); idx = 0; }
    const v = d.seriesList[idx].volume;
    if (!v) return { error: 'no volume' };

    const mg = await import('/metavol-web-beta2/src/components/modalityGuess.ts');
    const guess = mg.guessModalityFromVoxels(v.voxel);

    const set = (m) => {
      const h = d.onSetSeriesModality;
      if (typeof h !== 'function') return { error: 'onSetSeriesModality not exposed' };
      h({ index: idx, modality: m });
      return null;
    };
    const sameVoxel = (a) => !!a && a.voxel === v.voxel;

    const initialModality = v.metadata?.modality;
    const e1 = set('PT'); if (e1) return e1;
    const afterPt = { modality: v.metadata?.modality, uid: v.metadata?.seriesUID,
                      petMatches: sameVoxel(store.petVolumeRef), hasPet: !!store.hasPet };
    set('CT');
    const afterCt = { modality: v.metadata?.modality,
                      ctMatches: sameVoxel(store.ctVolumeRef) };
    // 元に戻す
    if (initialModality === 'PT' || initialModality === 'CT' || initialModality === 'MR') set(initialModality);

    return {
      seriesCount: sum.length, idx,
      dims: [v.nx, v.ny, v.nz],
      initialModality,
      guess: { modality: guess.modality, reason: guess.reason },
      afterPt, afterCt,
    };
  });

  if (out.error) { console.error('  ERROR:', out.error); process.exitCode = 1; }
  else {
    const P = ok => ok ? 'PASS' : 'FAIL';
    console.log(`\n  series=${out.seriesCount}  idx=${out.idx}  dims=${out.dims.join('x')}`);
    console.log(`  読み込み時の modality: ${out.initialModality}`);
    console.log(`  voxel 分布からの推定  : ${out.guess.modality}  (${out.guess.reason})`);
    console.log('\n  項目                                   結果');
    console.log('  ' + '-'.repeat(58));
    console.log(`  kitty を CT と推定                    ${P(out.guess.modality === 'CT')}`);
    console.log(`  手動 PT 指定 → metadata 反映          ${P(out.afterPt.modality === 'PT')}`);
    console.log(`  手動 PT 指定 → store.petVolumeRef     ${P(out.afterPt.petMatches)}`);
    console.log(`  store.hasPet が立つ                   ${P(out.afterPt.hasPet)}`);
    console.log(`  seriesUID が振られている              ${P(!!out.afterPt.uid)}  ${out.afterPt.uid}`);
    console.log(`  指定し直し CT → store.ctVolumeRef     ${P(out.afterCt.ctMatches)}`);
    const all = out.guess.modality === 'CT' && out.afterPt.modality === 'PT' && out.afterPt.petMatches
      && out.afterPt.hasPet && !!out.afterPt.uid && out.afterCt.ctMatches;
    console.log(`\n  総合: ${all ? 'PASS' : 'FAIL'}`);
    if (!all) process.exitCode = 1;
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
