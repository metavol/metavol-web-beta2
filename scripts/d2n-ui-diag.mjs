// UI から変換できない件の**切り分け**。
//   A) ハンドラ `onExportSeriesNifti` を直接呼ぶ → download が起きるか (ハンドラ側の検査)
//   B) メニュー項目の **v-list-item の root** をクリック → download が起きるか (配線の検査)
// どちらが落ちているかで原因が決まる。
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('dialog', async d => { console.log(`  [dialog] ${d.type()}: ${d.message()}`); await d.accept(); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[diag] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[diag] ${prev} series`);

  // ---- A) ハンドラを直接呼ぶ ----
  const exists = await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const dv = ss.dicomViewRef.value ?? ss.dicomViewRef;
    const d = dv.$.setupState;
    return {
      onExportSeriesNifti: typeof d.onExportSeriesNifti,
      exportSeriesAsNifti: typeof d.exportSeriesAsNifti,
      exportAllSeriesAsNifti: typeof d.exportAllSeriesAsNifti,
      onSetSeriesModality: typeof d.onSetSeriesModality,
    };
  });
  console.log(`\n  A) setupState 上の関数: ${JSON.stringify(exists)}`);

  const dlA = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);
  const callErr = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    try { await d.onExportSeriesNifti({ index: 0, gzip: true }); return null; }
    catch (e) { return String(e?.stack ?? e); }
  });
  if (callErr) console.error(`  A) 例外: ${callErr}`);
  const a = await dlA;
  console.log(`  A) 直接呼び出し → download: ${a ? 'PASS ' + a.suggestedFilename() : '**来ない**'}`);

  // ---- B) メニュー項目の root をクリック ----
  await page.locator('.card-menu-btn').first().click();
  await page.waitForTimeout(800);
  // title ではなく v-list-item 自体を掴む
  const item = page.locator('.v-overlay .v-list-item').filter({ hasText: 'Export as NIfTI (.nii.gz)' });
  const cnt = await item.count();
  console.log(`\n  B) v-list-item (root) の一致数: ${cnt}`);
  if (cnt > 0) {
    const dlB = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    await item.first().click();
    const b = await dlB;
    console.log(`  B) クリック → download: ${b ? 'PASS ' + b.suggestedFilename() : '**来ない**'}`);
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
