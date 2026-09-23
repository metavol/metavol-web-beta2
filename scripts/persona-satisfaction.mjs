// ペルソナ満足度の計測 (合否ではなく数値を見る計測スクリプト)。
// 各ペルソナの中核ジャーニーを人と同じ UI 操作でなぞり、
// クリック数・所要時間・到達できたかを出力する。
//
//   HUNTER : Hirata20260728 を読み込み → Layouts→MTV measurement → Apply → Lesion table → CSV
//   MINER  : (HUNTER の続きで) Radiomics CSV を書き出す
//   ATLAS  : spm-normalized を読み込み → VOI analysis → テンプレート読込 (自動解析) → CSV
//   COURIER: 読み込み開始 → 最初に画像が見えるまでの時間 (nii 1 個 / DICOM 778 個)
//
// 使い方: node scripts/persona-satisfaction.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const BASE = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/`;
const sec = (ms) => (ms / 1000).toFixed(1) + 's';

const b = await chromium.launch({ headless: true });
try {
  const openApp = async (query) => {
    const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    page.on('pageerror', e => console.error('[pageerror]', e.message));
    const t0 = Date.now();
    await page.goto(BASE + (query ?? ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
    return { page, t0 };
  };
  const waitSeriesStable = async (page, stableRounds = 3) => {
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 900000 });
    let prev = -1, stable = 0;
    while (stable < stableRounds) {
      const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
      if (n === prev) stable++; else { stable = 0; prev = n; }
      await page.waitForTimeout(2500);
    }
    return prev;
  };
  // 最大 canvas の点灯画素数 (描画されたかの判定)
  const litPixels = (page) => page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)
      .sort((a, b2) => b2.width * b2.height - a.width * a.height)[0];
    if (!cv) return 0;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) { if (d[i] + d[i + 1] + d[i + 2] > 30) n++; }
    return n;
  });
  const waitLit = async (page, timeoutMs = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await litPixels(page) > 100) return Date.now() - t0;
      await page.waitForTimeout(500);
    }
    return -1;
  };

  // ================= HUNTER (+ MINER の radiomics) =================
  {
    console.log('\n===== HUNTER: 読み込み → MTV measurement → Apply → Lesion table → CSV =====');
    const { page, t0 } = await openApp('?dev=Hirata20260728');
    const nSeries = await waitSeriesStable(page);
    const tLoad = Date.now() - t0;
    console.log(`  読み込み (dev 経由 ${nSeries} series): ${sec(tLoad)}  ※実運用は d&d 1 操作に相当`);

    let clicks = 0;
    // 1-2. Layouts → MTV measurement
    const t1 = Date.now();
    await page.locator('.v-app-bar button', { hasText: 'LAYOUTS' }).first().click(); clicks++;
    console.log(`  click ${clicks}: LAYOUTS メニュー`);
    await page.waitForTimeout(400);
    await page.locator('.v-overlay .v-list-item', { hasText: 'MTV measurement' }).first().click(); clicks++;
    console.log(`  click ${clicks}: MTV measurement`);
    await page.waitForTimeout(800);
    // PT/CT が複数ある study では選択ピッカーが出る (これも実クリックとして数える)
    const picker = page.locator('.v-dialog:visible', { hasText: 'Choose PT and CT' });
    if (await picker.count() > 0) {
      await picker.locator('button', { hasText: 'Build' }).first().click(); clicks++;
      console.log(`  click ${clicks}: PT/CT picker 確定 (16 series で曖昧なため表示された)`);
    }
    const tLitLayout = await waitLit(page);
    console.log(`  PET Standard 表示まで: ${sec(Date.now() - t1)} (点灯 ${tLitLayout >= 0 ? 'OK' : 'タイムアウト'})`);
    await page.waitForTimeout(2000);

    // 3. Apply (既定 threshold)
    const t2 = Date.now();
    await page.locator('.mv-apply-main').first().click(); clicks++;
    console.log(`  click ${clicks}: Apply threshold`);
    // Lesions 件数バッジが出るまで (集計完了の合図)
    await page.waitForFunction(() => document.querySelectorAll('.mv-lesion-count').length > 0,
      null, { timeout: 120000 }).catch(() => {});
    console.log(`  Apply → 病変集計完了: ${sec(Date.now() - t2)}`);
    // Apply で Lesions 表は自動展開される (2026-09 改善)。開いていなければ摩擦として数える。
    await page.waitForTimeout(1000);
    let rows = await page.locator('.mv-lesion-table tbody tr').count();
    if (rows === 0) {
      await page.locator('.mv-section-title', { hasText: 'Lesions' }).first().click(); clicks++;
      console.log(`  click ${clicks}: Lesions expander を開く (自動展開されなかった)`);
      await page.waitForTimeout(1000);
      rows = await page.locator('.mv-lesion-table tbody tr').count();
    } else {
      console.log('  Lesions 表は Apply で自動展開 (クリック不要)');
    }
    console.log(`  Lesion table ${rows} 行`);

    // 4-5. Others → Lesions CSV
    const t3 = Date.now();
    await page.locator('.mv-save-others').click(); clicks++;
    console.log(`  click ${clicks}: Others メニュー`);
    await page.waitForTimeout(400);
    const dl1 = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('.v-overlay .v-list-item', { hasText: 'Lesions CSV' }).first().click(); clicks++;
    console.log(`  click ${clicks}: Lesions CSV`);
    const gotCsv = await dl1.then(() => true).catch(() => false);
    console.log(`  CSV ダウンロード: ${gotCsv ? 'OK' : '失敗'} (${sec(Date.now() - t3)})`);
    console.log(`  ★ HUNTER 合計: 読み込み操作を除き ${clicks} クリックで CSV まで`);

    // ---- MINER: radiomics CSV (mask がある状態で) ----
    console.log('\n===== MINER: Radiomics CSV (同じマスクから) =====');
    const t4 = Date.now();
    try {
      const radBtn = page.locator('button[title*="radiomics" i], [title*="Radiomics"]').first();
      const dl2 = page.waitForEvent('download', { timeout: 300000 });
      await radBtn.click({ timeout: 10000 });
      const ok = await dl2.then(() => true).catch(() => false);
      console.log(`  Radiomics CSV: ${ok ? 'OK' : '失敗'}  所要 ${sec(Date.now() - t4)}`);
    } catch (e) {
      console.log(`  Radiomics ボタンに到達できず: ${String(e).split('\n')[0]}`);
    }
    await page.close();
  }

  // ================= ATLAS =================
  {
    console.log('\n===== ATLAS: 正規化済み nii → VOI analysis → テンプレート読込 → CSV =====');
    const { page } = await openApp('?dev=spm-normalized');
    await waitSeriesStable(page, 2);
    let clicks = 0;
    await page.locator('.v-app-bar button').first().click(); clicks++;
    await page.waitForTimeout(400);
    await page.locator('.v-overlay .v-list-item', { hasText: 'VOI analysis' }).first().click(); clicks++;
    await page.waitForTimeout(500);
    const dlg = page.locator('.v-dialog:visible');
    const t1 = Date.now();
    const fc = page.waitForEvent('filechooser');
    await dlg.locator('button', { hasText: 'Load VOI template' }).first().click(); clicks++;
    await (await fc).setFiles([
      path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.nii'),
      path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.xml'),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.mv-voi-table tbody tr').length >= 100,
      null, { timeout: 60000 });
    const tRun = Date.now() - t1;
    const runMs = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      return pinia._s.get('voi').lastRunMs;
    });
    console.log(`  テンプレート読込 → 136 領域の表 (自動解析込み): ${sec(tRun)} (解析本体 ${runMs}ms)`);
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await dlg.locator('button', { hasText: 'Export CSV' }).first().click(); clicks++;
    const ok = await dl.then(() => true).catch(() => false);
    console.log(`  CSV: ${ok ? 'OK' : '失敗'}`);
    console.log(`  ★ ATLAS 合計: ファイル選択を除き ${clicks} クリックで 136 領域 CSV まで`);
    console.log('  (SPM 往復は別途: Export as NIfTI (.nii) 2 クリック + 各自の MATLAB 作業)');
    await page.close();
  }

  // ================= COURIER =================
  {
    console.log('\n===== COURIER: 開いて見えるまでの時間 =====');
    {
      const { page, t0 } = await openApp('?dev=spm-normalized');
      const t = await waitLit(page, 120000);
      console.log(`  NIfTI 1 ファイル (wFDG.nii): 開始 → 画像表示 ${sec(Date.now() - t0)}`);
      await page.close();
    }
    {
      const { page, t0 } = await openApp('?dev=dicom');
      const t = await waitLit(page, 300000);
      console.log(`  DICOM 778 ファイル (PET/CT): 開始 → 画像表示 ${sec(Date.now() - t0)}`);
      await page.close();
    }
  }

  console.log('\n計測終了');
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await b.close(); }
