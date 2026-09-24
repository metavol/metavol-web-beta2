// モダリティの手動指定 (最終手段) の UI 検査。
//
// 自動判定 (SOP Class → Modality タグ) が外れたときの逃げ道として、シリーズカードの
// 「…」→ Change modality → Set as PT/CT/MR / Auto (from file) を用意した。
// 人と同じ操作で、DICOM シリーズ (cart の "CT AXIAL") を PT にして戻す往復を見る:
//   1) メニューに Change modality → Set as PT/CT/MR / Auto がある
//   2) Set as PT → カードが PT* (手動の印) になり、volume が作り直され petVolumeRef に載る
//   3) Auto → CT に戻り、印が消え、ctVolumeRef に載り、HU 値が元と一致する
//
// 使い方: node scripts/modality-override-check.mjs   (先に npm run dev。要 sample-data/cart)
import { chromium } from 'playwright';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const URL = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/?dev=${opt('case', 'cart')}`;
const TARGET = opt('target', 'CT AXIAL');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const b = await chromium.launch({ headless: true });
try {
  const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errs = [];
  page.on('pageerror', e => { errs.push(e.message); console.error('[pageerror]', e.message); });
  page.on('dialog', d => d.accept());
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
  await page.waitForFunction(
    () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 4) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; }
    await page.waitForTimeout(2500);
  }

  // 対象シリーズの volume を先に作っておく (作り直しを確かめるため) + 元の HU を控える
  const before = await page.evaluate((target) => {
    const ss = document.querySelector('#app').__vue_app__._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const idx = ss.seriesSummariesView.findIndex(s => s.description.trim().startsWith(target));
    if (idx < 0) return null;
    d.ensureVolume_(idx);
    const v = d.seriesList[idx].volume;
    const mid = Math.floor(v.voxel.length / 2);
    window.__mvOldVoxel = v.voxel;   // 作り直しの判定用 (参照比較)
    return { idx, modality: ss.seriesSummariesView[idx].modality, sample: [v.voxel[mid], v.voxel[mid + 1000]], mid };
  }, TARGET);
  if (!before) throw new Error(`target series "${TARGET}" not found`);
  check(before.modality === 'CT', `対象 "${TARGET}" は最初 CT`, before.modality);

  const summary = () => page.evaluate((idx) => {
    const ss = document.querySelector('#app').__vue_app__._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
    const v = d.seriesList[idx].volume;
    const mid = Math.floor(v.voxel.length / 2);
    return {
      modality: ss.seriesSummariesView[idx].modality,
      overridden: !!ss.seriesSummariesView[idx].modalityOverridden,
      volModality: v?.metadata?.modality,
      rebuilt: v.voxel !== window.__mvOldVoxel,
      isPetRef: seg.petVolumeRef?.voxel === v.voxel,
      isCtRef: seg.ctVolumeRef?.voxel === v.voxel,
      sample: [v.voxel[mid], v.voxel[mid + 1000]],
    };
  }, before.idx);

  // --- 1) UI: カードの「…」→ Change modality ---
  const openChangeMenu = async () => {
    const card = page.locator('.series-card').nth(before.idx);
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await card.locator('.card-menu-btn').click();
    await page.waitForTimeout(400);
    // hover せず**クリックだけ**で開けることを見る (タッチ操作・クリック派の経路)。
    // 以前は activator のクリックが親メニューを閉じてしまい、クリックでは開けなかった。
    const item = page.locator('.v-overlay .mv-change-modality').first();
    await item.click({ position: { x: 20, y: 10 } });
    await page.waitForTimeout(600);
  };
  await openChangeMenu();
  const sub = await page.locator('.v-overlay .v-list-item-title').allTextContents();
  check(['Set as PT', 'Set as CT', 'Set as MR', 'Auto (from file)'].every(t => sub.includes(t)),
        '「…」→ Change modality に Set as PT/CT/MR と Auto がある', JSON.stringify(sub.filter(t => /Set as|Auto/.test(t))));

  // --- 2) Set as PT ---
  await page.locator('.v-overlay .v-list-item', { hasText: 'Set as PT' }).first().click();
  await page.waitForTimeout(2500);
  const s1 = await summary();
  check(s1.modality === 'PT' && s1.overridden, 'Set as PT でカードが PT (手動指定の印つき) になる', JSON.stringify({ m: s1.modality, manual: s1.overridden }));
  const chip = await page.locator('.series-card').nth(before.idx).locator('.modality').innerText();
  check(chip.includes('*'), 'カードの modality チップに手動指定の印 (*) が出る', JSON.stringify(chip));
  check(s1.rebuilt && s1.volModality === 'PT', 'volume が作り直され、modality が PT になる');
  check(s1.isPetRef, 'petVolumeRef がこのシリーズに付け替わる (MTV 測定の対象になる)');
  await page.keyboard.press('Escape');

  // --- 3) Auto (from file) で戻す ---
  await page.evaluate((idx) => {
    const ss = document.querySelector('#app').__vue_app__._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    window.__mvOldVoxel = d.seriesList[idx].volume.voxel;
  }, before.idx);
  await openChangeMenu();
  await page.locator('.v-overlay .v-list-item', { hasText: 'Auto (from file)' }).first().click();
  await page.waitForTimeout(2500);
  const s2 = await summary();
  check(s2.modality === 'CT' && !s2.overridden, 'Auto で CT に戻り、手動の印が消える', JSON.stringify({ m: s2.modality, manual: s2.overridden }));
  check(s2.rebuilt && s2.volModality === 'CT' && s2.isCtRef, 'volume が CT として作り直され ctVolumeRef に載る');
  check(s2.sample[0] === before.sample[0] && s2.sample[1] === before.sample[1],
        '往復後の HU 値が元と一致する', `${JSON.stringify(before.sample)} → ${JSON.stringify(s2.sample)}`);

  check(errs.length === 0, 'pageerror なし', errs.slice(0, 2).join(' | '));
  console.log(`\n  総合: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await b.close(); }
