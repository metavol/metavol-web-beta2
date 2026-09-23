// 2026-09 のメモ消化 5 項目の UI 検査 (人と同じ操作で見る):
//   A) Voxel probe が debug モード無しで使える (View options メニューの toggle)。
//      probe では DEBUG バッジ・Shift+Click 編集が **出ない** ことまで見る。
//   B) ラベル色の手動変更 (swatch クリック → v-color-picker) が store と canvas に届く。
//   C) beforeunload ガード: データ読込済みならタブを閉じる時に確認が出る。未読込なら出ない。
//   D) native (DICOM slice) box にもカラースケール legend が出る。
//
// 使い方: node scripts/ui-misc-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const BASE = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/`;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const b = await chromium.launch({ headless: true });
try {
  const openApp = async (query) => {
    const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    page.on('pageerror', e => console.error('[pageerror]', e.message));
    await page.goto(BASE + (query ?? ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    return page;
  };
  const waitSeriesStable = async (page) => {
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 900000 });
    let prev = -1, stable = 0;
    while (stable < 3) {
      const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
      if (n === prev) stable++; else { stable = 0; prev = n; }
      await page.waitForTimeout(3000);
    }
    return prev;
  };
  const canvasCenter = async (page) => {
    // 最大の canvas の画面座標中心 (hover / click 用)
    return await page.evaluate(() => {
      const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)
        .sort((a, b2) => b2.width * b2.height - a.width * a.height)[0];
      if (!cv) return null;
      const r = cv.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  };

  // ============ A + B + C(データあり): spm-normalized ============
  {
    const page = await openApp('?dev=spm-normalized');
    await page.waitForTimeout(6000);

    // --- A) Voxel probe (通常機能) ---
    // View options メニュー (mdi-tune-variant) → "Voxel inspector OFF" をクリックして ON にする
    await page.locator('.v-app-bar .mdi-tune-variant').first().click();
    await page.waitForTimeout(400);
    const item = page.locator('.v-overlay .v-list-item', { hasText: 'Voxel inspector' });
    check(await item.count() > 0, 'View options に Voxel inspector トグルがある');
    await item.first().click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.move(c.x + 4, c.y + 4);   // mousemove を確実に発火させる
    await page.waitForTimeout(600);
    const insp = page.locator('.mv-debug-inspector');
    check(await insp.count() === 1, 'probe ON + hover で voxel inspector が出る');
    const inspText = await insp.innerText().catch(() => '');
    // 表示は CSS の text-transform で大文字化されるので、照合は大文字小文字を無視する
    check(/world/i.test(inspText) && /mm/i.test(inspText), 'inspector に world (mm) 行がある',
          JSON.stringify(inspText.replace(/\s+/g, ' ').slice(0, 100)));
    check(!/Shift\+Click to edit/.test(inspText), 'probe では編集ヒントが出ない (debug 専用)');
    check(await page.locator('.mv-debug-badge').count() === 0, 'probe では DEBUG バッジが出ない');
    // Shift+Click しても prompt (編集) は出ない。
    // dialog handler は 1 ページ 1 つ (二重 accept は Playwright が例外を投げる)。
    let promptFired = false;
    let unloadDialog = false;
    page.on('dialog', d => {
      if (d.type() === 'prompt') { promptFired = true; d.dismiss(); return; }
      if (d.type() === 'beforeunload') { unloadDialog = true; }
      d.accept();
    });
    await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(600);
    check(!promptFired, 'probe では Shift+Click 編集が発動しない');

    // --- B) ラベル色の手動変更 ---
    // マスクを作る (threshold) → Inspector を開く → ラベル行の swatch をクリック → 色を選ぶ
    await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__;
      const ss = app._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      const seg = app.config.globalProperties.$pinia._s.get('segmentation');
      const vol = d.seriesList[0].volume;
      seg.setPetVolume(vol);
      seg.thresholdUnit = 'SUV';
      seg.applyThreshold(2.5);
      d.inspector = true;
      d.show();
    });
    await page.waitForTimeout(2500);

    // **voxel を持つラベルの色を変えること。** applyThreshold は currentLabelId (既定 2 =
    // Non-tumor, labels の 2 行目) で塗るので、1 行目 (Tumor) を変えても画面は変わらない
    // (最初のテストはこれを踏んで「再描画されない」と誤判定した)。
    const colorAt = () => page.evaluate(() => {
      const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
      return [...seg.labels.find(l => l.id === seg.currentLabelId).color];
    });
    const before = await colorAt();
    const swatchBtn = page.locator('.mv-color-swatch--btn').nth(1);
    check(await swatchBtn.count() === 1, 'ラベル行の swatch がボタンになっている');
    await swatchBtn.click();
    await page.waitForTimeout(600);
    const picker = page.locator('.v-color-picker');
    check(await picker.count() === 1, 'swatch クリックで color picker が開く');
    // swatches の中から before と十分違う色を選ぶ (先頭グループの末尾寄り)
    const swatches = picker.locator('.v-color-picker-swatches__color');
    const n = await swatches.count();
    check(n > 10, 'picker に swatches が並ぶ', `count ${n}`);
    await swatches.nth(Math.min(20, n - 1)).click();
    await page.waitForTimeout(1500);
    const after = await colorAt();
    const changed = before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2];
    check(changed, 'ラベル色が store に反映される', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    // canvas に新色系統の画素が出ているか: 彩度のある画素のうち、チャンネル順位が
    // 新色と一致するものを数える (overlay は 50% ブレンドでも順位は保たれる)
    const hueMatch = await page.evaluate((rgb) => {
      const cv = [...document.querySelectorAll('canvas')].filter(x => x.width > 64)[0];
      const dd = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const rank = (a, b2, c2) => (a >= b2 ? (b2 >= c2 ? 'abc' : (a >= c2 ? 'acb' : 'cab')) : (a >= c2 ? 'bac' : (b2 >= c2 ? 'bca' : 'cba')));
      const want = rank(rgb[0], rgb[1], rgb[2]);
      let colored = 0, match = 0;
      for (let i = 0; i < dd.length; i += 4) {
        const r = dd[i], g = dd[i + 1], b3 = dd[i + 2];
        if (r + g + b3 < 30) continue;
        if (Math.max(r, g, b3) - Math.min(r, g, b3) <= 24) continue;
        colored++;
        if (rank(r, g, b3) === want) match++;
      }
      return { colored, match };
    }, after);
    check(hueMatch.colored > 50 && hueMatch.match / Math.max(1, hueMatch.colored) > 0.5,
          '画像の overlay が新しい色で描き直される',
          `着色 ${hueMatch.colored} 中 一致 ${hueMatch.match}`);

    // --- B2) Apply で Lesions 表が自動展開する (満足度計測で見つけた +1 クリックの解消) ---
    // 色ピッカーの v-menu は close-on-content-click=false なので Escape で閉じてから進む
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.locator('.mv-apply-main').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.mv-lesion-table tbody tr').length > 0,
      null, { timeout: 60000 }).catch(() => {});
    const lesRows = await page.locator('.mv-lesion-table tbody tr').count();
    check(lesRows > 0, 'Apply 後に Lesions 表が展開クリック無しで見える', `${lesRows} 行`);

    // --- B3) 病変行の選別操作 (ラベル付け替え / 削除 / undo) ---
    const nonZero = () => page.evaluate(() => {
      const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
      const m = seg.finalMask; let n = 0; if (m) { for (let i = 0; i < m.length; i++) if (m[i]) n++; }
      return n;
    });
    const firstRowLabel = () => page.locator('.mv-lesion-table tbody tr').first()
      .locator('.mv-lesion-label-name').innerText();
    const labelBefore = await firstRowLabel();
    await page.locator('.mv-lesion-act-btn').first().click();
    await page.waitForTimeout(400);
    await page.locator('.v-overlay .v-list-item', { hasText: 'Set label: Other' }).first().click();
    await page.waitForTimeout(1200);
    const labelAfter = await firstRowLabel();
    check(labelBefore !== labelAfter && labelAfter === 'Other',
          '行メニューでラベル付け替えができる', `${labelBefore} → ${labelAfter}`);

    const nzBefore = await nonZero();
    const rowsBefore = await page.locator('.mv-lesion-table tbody tr').count();
    await page.locator('.mv-lesion-act-btn').first().click();
    await page.waitForTimeout(400);
    await page.locator('.v-overlay .v-list-item', { hasText: 'Delete lesion' }).first().click();
    await page.waitForTimeout(1500);
    const nzAfterDel = await nonZero();
    const rowsAfterDel = await page.locator('.mv-lesion-table tbody tr').count();
    check(nzAfterDel < nzBefore && rowsAfterDel < rowsBefore,
          '行メニューで病変を削除できる', `voxel ${nzBefore}→${nzAfterDel}, 行 ${rowsBefore}→${rowsAfterDel}`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1500);
    const nzUndo = await nonZero();
    check(nzUndo === nzBefore, '削除は Ctrl+Z で戻る', `${nzAfterDel} → ${nzUndo} (期待 ${nzBefore})`);

    // --- C-1) beforeunload: データありなら確認が出る ---
    // (ダイアログはユーザ操作のあったタブでのみ出る。上でクリック済み = sticky activation あり)
    await page.close({ runBeforeUnload: true });
    await new Promise(r => setTimeout(r, 1500));
    check(unloadDialog, 'データ読込済みタブを閉じると確認ダイアログが出る');
  }

  // --- C-2) beforeunload: データ無しなら出ない ---
  {
    const page = await openApp('');
    await page.mouse.click(400, 400);   // sticky activation を作っても出ないことを見る
    let unloadDialog = false;
    page.on('dialog', d => { if (d.type() === 'beforeunload') { unloadDialog = true; d.accept(); } });
    await page.close({ runBeforeUnload: true });
    await new Promise(r => setTimeout(r, 1200));
    check(!unloadDialog, 'データ未読込なら閉じても確認は出ない');
  }

  // ============ D) native box のカラースケール (?dev=dicom) ============
  {
    const page = await openApp('?dev=dicom');
    const nSeries = await waitSeriesStable(page);
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      const n = d.tileN ?? 0;
      let natives = 0;
      for (let i = 0; i < n; i++) if (!('centerInWorld' in (d.imageBoxInfos[i] ?? {}))) natives++;
      return { tileN: n, natives };
    });
    check(state.natives > 0, 'native (DICOM slice) box が表示されている', `series ${nSeries}, native ${state.natives}/${state.tileN}`);
    const legends = await page.locator('.mv-clut-legend').count();
    check(legends >= state.natives, 'native box にカラースケール legend が出る', `legend ${legends}`);
    const legendText = await page.locator('.mv-clut-legend').first().innerText().catch(() => '');
    check(legendText.trim().length > 0, 'legend に min/max ラベルが入っている', JSON.stringify(legendText.replace(/\s+/g, ' ')));
    await page.close();
  }

  console.log(`\n  総合: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await b.close(); }
