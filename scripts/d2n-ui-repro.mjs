// **実際の UI 操作**で DICOM → NIfTI 変換を試す (ユーザ報告の再現用)。
//
// 内部関数を直接叩く scripts/dicom2nifti-check.mjs は PASS するのに
// 「ファイル生成ができない」と報告されたので、**人と同じ経路**を踏む:
//   左サイドバーのシリーズカード → "…" メニュー → Export as NIfTI (.nii.gz)
// メニューが出るか / 項目があるか / クリックで download が起きるか / 例外が出るかを見る。
//
// 使い方: node scripts/d2n-ui-repro.mjs [--case Hirata20260728]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.error('[browser]', m.text()); } });
  page.on('pageerror', e => { errors.push('pageerror: ' + e.message); console.error('[pageerror]', e.message); });
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[repro] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[repro] ${prev} series`);

  // --- ① シリーズカードと "…" ボタンが見えるか ---
  const cards = await page.locator('.series-card').count();
  const menuBtns = await page.locator('.card-menu-btn').count();
  console.log(`\n  シリーズカード ${cards} 枚 / "…" ボタン ${menuBtns} 個`);
  if (menuBtns === 0) {
    console.error('  FAIL: "…" ボタンが 1 つも無い。左サイドバーが閉じている可能性');
    process.exitCode = 1;
  } else {
    // --- ② メニューを開く ---
    await page.locator('.card-menu-btn').first().click();
    await page.waitForTimeout(800);
    const items = await page.locator('.v-overlay .v-list-item-title').allTextContents();
    console.log(`  メニュー項目: ${JSON.stringify(items)}`);

    const exportItem = page.locator('.v-overlay .v-list-item-title', { hasText: 'Export as NIfTI (.nii.gz)' });
    const found = await exportItem.count();
    console.log(`  "Export as NIfTI (.nii.gz)" 項目: ${found > 0 ? 'あり' : '**無し**'}`);
    if (found === 0) {
      console.error('  FAIL: メニュー項目が出ていない。dev サーバが古いコードを配っている可能性 (Ctrl+Shift+R)');
      process.exitCode = 1;
    } else {
      // --- ③ クリックして download が起きるか ---
      const dl = page.waitForEvent('download', { timeout: 180000 }).catch(() => null);
      await exportItem.first().click();
      console.log('  クリックした。download を待機中 (最大 180 秒)…');
      const download = await dl;
      if (!download) {
        console.error('  FAIL: download イベントが来なかった');
        process.exitCode = 1;
      } else {
        const path = await download.path();
        const { statSync, readFileSync } = await import('node:fs');
        const size = path ? statSync(path).size : 0;
        console.log(`  PASS: ${download.suggestedFilename()}  ${(size / 1048576).toFixed(2)} MB`);
        if (size === 0) { console.error('  FAIL: 0 バイト'); process.exitCode = 1; }
        // **1 ファイル (.zip) に image + sidecar が両方入っていること。**
        // 2 回に分けて落とすとブラウザが 2 件目を捨てる (実測)。
        if (!/\.zip$/.test(download.suggestedFilename())) {
          console.error('  FAIL: .zip ではない'); process.exitCode = 1;
        } else if (path) {
          const { unzipSync } = await import('fflate');
          const names = Object.keys(unzipSync(new Uint8Array(readFileSync(path))));
          const hasImg = names.some(n => /\.nii(\.gz)?$/.test(n));
          const hasJson = names.some(n => /\.json$/.test(n));
          console.log(`  zip の中身: ${JSON.stringify(names)}`);
          console.log(`  ${hasImg ? 'PASS' : 'FAIL'}: 画像が入っている / ${hasJson ? 'PASS' : 'FAIL'}: sidecar が入っている`);
          if (!hasImg || !hasJson) process.exitCode = 1;
        }
      }
    }
  }

  if (dialogs.length) console.log(`\n  出たダイアログ: ${JSON.stringify(dialogs)}`);
  if (errors.length) console.log(`\n  console error ${errors.length} 件 (上に出力済み)`);
  else console.log('\n  console error なし');
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
