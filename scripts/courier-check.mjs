// Persona COURIER (リンク 1 つで見せる) の UI 検査。
//
//   A) ?demo=phantom — データ配布なしで動くデモリンク (ブラウザ内でファントム生成)
//   B) ?mvs=<url>    — データ読み込み後に共有 snapshot (.mvs) を適用して view を復元
//   C) .mvs の d&d   — snapshot も「読み込みの入口は 1 つ」(単独 / 画像と同時の両方)
//
// B/C 用の .mvs は実アプリで保存したものを使う (合成しない)。dev サーバが
// sample-data/ を /samples/ で配信するので、そこに置けば URL で取れる。
//
// 使い方: node scripts/courier-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const BASE = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/`;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const b = await chromium.launch({ headless: true });
const TMP_DIR = path.resolve('sample-data/.tmp-courier');
try {
  const openApp = async (query) => {
    const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    page.on('pageerror', e => console.error('[pageerror]', e.message));
    await page.goto(BASE + (query ?? ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
    return page;
  };
  const litPixels = (page) => page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)[0];
    if (!cv) return 0;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) { if (d[i] + d[i + 1] + d[i + 2] > 30) n++; }
    return n;
  });
  const waitLit = async (page, timeoutMs = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await litPixels(page) > 100) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };
  const dv = (page) => page.evaluate(() => {
    const ss = document.querySelector('#app').__vue_app__._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    return {
      series: ss.seriesSummariesView.map(x => x.modality),
      wc: d.imageBoxInfos[0]?.myWC, ww: d.imageBoxInfos[0]?.myWW,
    };
  });

  // ===== A) ?demo=phantom =====
  {
    const page = await openApp('?demo=phantom');
    const lit = await waitLit(page);
    check(lit, '?demo=phantom で画像が表示される (ファイル配布なし)');
    const st = await dv(page);
    check(st.series.includes('PT') && st.series.includes('CT'),
          'PT + CT のファントムが載る', JSON.stringify(st.series));
    await page.close();
  }

  // ===== B) ?mvs=<url> の準備: 実アプリで .mvs を保存 =====
  mkdirSync(TMP_DIR, { recursive: true });
  {
    const page = await openApp('?dev=spm-normalized');
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 300000 });
    await page.waitForTimeout(5000);
    // 識別しやすい view にしてから保存 (WC/WW を狙った値に)
    await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      d.imageBoxInfos[0].myWC = 7.77;
      d.imageBoxInfos[0].myWW = 3.33;
      d.show();
    });
    await page.waitForTimeout(800);
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      (ss.dicomViewRef.value ?? ss.dicomViewRef).downloadSnapshotFile();
    });
    const download = await dl;
    const saved = path.join(TMP_DIR, 'view.mvs');
    await download.saveAs(saved);
    const text = readFileSync(saved, 'utf-8');
    check(text.includes('7.77'), '保存した .mvs に狙った WC が入っている');
    await page.close();
  }

  // ===== B) ?dev= + ?mvs= で view が復元される =====
  {
    const page = await openApp('?dev=spm-normalized&mvs=/samples/.tmp-courier/view.mvs');
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 300000 });
    // 読み込み完了 + 800ms 後に適用されるので余裕を持って待つ
    await page.waitForFunction(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      return Math.abs((d.imageBoxInfos[0]?.myWC ?? 0) - 7.77) < 1e-6;
    }, null, { timeout: 60000 }).catch(() => {});
    const st = await dv(page);
    check(Math.abs(st.wc - 7.77) < 1e-6 && Math.abs(st.ww - 3.33) < 1e-6,
          '?mvs= で WC/WW が復元される', `WC ${st.wc} / WW ${st.ww}`);
    await page.close();
  }

  // ===== C-1) .mvs 単独の Load files =====
  {
    const page = await openApp('?dev=spm-normalized');
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 300000 });
    await page.waitForTimeout(5000);
    await page.locator('.v-app-bar button').first().click();
    const fc = page.waitForEvent('filechooser');
    await page.locator('.v-overlay .v-list-item', { hasText: 'Load files' }).first().click();
    await (await fc).setFiles([path.join(TMP_DIR, 'view.mvs')]);
    await page.waitForTimeout(2500);
    const st = await dv(page);
    check(Math.abs(st.wc - 7.77) < 1e-6, '.mvs 単独の Load files で view が復元される', `WC ${st.wc}`);
    await page.close();
  }

  // ===== C-2) 画像 + .mvs の同時 drop (空の状態から) =====
  {
    const page = await openApp('');
    await page.waitForTimeout(1500);
    await page.locator('.mv-imagearea-empty button').first().click().catch(() => {});
    // 空状態の LOAD FILES… は filechooser を開く
    const fc = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
    const chooser = await fc;
    if (!chooser) {
      // fallback: ハンバーガー経由
      await page.locator('.v-app-bar button').first().click();
      const fc2 = page.waitForEvent('filechooser');
      await page.locator('.v-overlay .v-list-item', { hasText: 'Load files' }).first().click();
      await (await fc2).setFiles([normalizedNii(), path.join(TMP_DIR, 'view.mvs')]);
    } else {
      await chooser.setFiles([normalizedNii(), path.join(TMP_DIR, 'view.mvs')]);
    }
    await page.waitForFunction(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      return Math.abs((d.imageBoxInfos[0]?.myWC ?? 0) - 7.77) < 1e-6;
    }, null, { timeout: 90000 }).catch(() => {});
    const st = await dv(page);
    check(st.series.length === 1, '画像も読み込まれている', JSON.stringify(st.series));
    check(Math.abs(st.wc - 7.77) < 1e-6, '同時 drop でも .mvs が画像の後に適用される', `WC ${st.wc}`);
    await page.close();
  }

  console.log(`\n  総合: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally {
  await b.close();
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}
