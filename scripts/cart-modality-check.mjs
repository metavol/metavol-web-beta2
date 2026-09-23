// 匿名化ソフトが (0008,0060) Modality を書き換えた DICOM への対策の検査。
//
// 実例 sample-data/cart: 全シリーズ Modality=RG (匿名化ソフトの仕様)。
// SOP Class UID は無傷なので、dicomModalityOf が SOP Class から PT/CT を復元する。
// これが効かないと Persona HUNTER の MTV measurement が始められない。
//
// 見るもの:
//   1) PET シリーズが PT、CT シリーズが CT として一覧に出る
//   2) fusion のキャプチャ (Secondary Capture) は **RG のまま** (盲目的一括変換をしていない)
//   3) SUV 化が成立する (suvOk / suvFactor — 匿名化後も dose/半減期/体重タグは残っている)
//   4) HUNTER のジャーニーがそのまま通る (MTV measurement → Apply → Lesion table)
//
// 使い方: node scripts/cart-modality-check.mjs   (先に npm run dev。要 sample-data/cart)
import { chromium } from 'playwright';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const URL = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/?dev=cart`;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const b = await chromium.launch({ headless: true });
try {
  const page = await (await b.newContext()).newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
  console.log('[cart] loading 1390 files…');
  await page.waitForFunction(
    () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 4) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; }
    await page.waitForTimeout(3000);
  }
  console.log(`[cart] ${prev} series\n`);

  // --- 1) & 2) 一覧の modality ---
  const sums = await page.evaluate(() => {
    const ss = document.querySelector('#app').__vue_app__._instance.setupState;
    return ss.seriesSummariesView.map(s => ({ modality: s.modality, desc: s.description }));
  });
  for (const s of sums) console.log(`   [${s.modality}] ${s.desc}`);
  const pts = sums.filter(s => s.modality === 'PT');
  const cts = sums.filter(s => s.modality === 'CT');
  const rgs = sums.filter(s => s.modality === 'RG');
  check(pts.length >= 2 && pts.every(s => /PET/i.test(s.desc)),
        'PET シリーズが SOP Class から PT と判定される', `${pts.length} 本`);
  check(cts.length >= 2 && cts.every(s => /CT/i.test(s.desc)),
        'CT シリーズが SOP Class から CT と判定される', `${cts.length} 本`);
  // Secondary Capture (fusion キャプチャ / Patient Protocol) は RG のまま残るのが正しい。
  // 見るべき不変条件は「PET/CT の実画像が RG のまま取り残されていない」こと。
  check(rgs.length >= 1, 'Secondary Capture 系は RG のまま (一括変換ではない)', `${rgs.length} 本`);
  check(!sums.some(s => s.modality === 'RG' && /^(PET|CT)\s/i.test(s.desc)),
        'PET/CT の実画像に RG が残っていない');

  // --- 4) HUNTER ジャーニー ---
  await page.locator('.v-app-bar button', { hasText: 'LAYOUTS' }).first().click();
  await page.waitForTimeout(400);
  const mtvItem = page.locator('.v-overlay .v-list-item', { hasText: 'MTV measurement' });
  const disabled = await mtvItem.first().getAttribute('class');
  check(!(disabled ?? '').includes('v-list-item--disabled'), 'MTV measurement が有効 (PT+CT 検出済み)');
  await mtvItem.first().click();
  await page.waitForTimeout(1000);
  const picker = page.locator('.v-dialog:visible', { hasText: 'Choose PT and CT' });
  if (await picker.count() > 0) {
    await picker.locator('button', { hasText: 'Build' }).first().click();
    console.log('  (PT/CT picker → Build)');
  }
  await page.waitForTimeout(5000);

  // --- 3) SUV 化 ---
  const suv = await page.evaluate(() => {
    const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
    const v = seg.petVolumeRef;
    return v ? { suvOk: v.metadata?.suvOk, suvFactor: v.metadata?.suvFactor,
                 modality: v.metadata?.modality, desc: v.metadata?.seriesDescription } : null;
  });
  check(!!suv && suv.modality === 'PT', 'petVolumeRef に PET が載る', JSON.stringify(suv?.desc));
  check(!!suv && suv.suvOk === true && suv.suvFactor > 0,
        'SUV 化が成立 (匿名化後も dose/半減期/体重が残っている)', `factor ${suv?.suvFactor?.toExponential(3)}`);

  // Apply → Lesion table
  await page.locator('.mv-apply-main').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.mv-lesion-table tbody tr').length > 0,
    null, { timeout: 120000 }).catch(() => {});
  const rows = await page.locator('.mv-lesion-table tbody tr').count();
  check(rows > 0, 'Apply → Lesion table に病変が出る (HUNTER のジャーニー成立)', `${rows} 行`);

  console.log(`\n  総合: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await b.close(); }
