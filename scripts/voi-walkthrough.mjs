// **ユーザ手順そのものを実行して各段階を記録する。**
// 手順書をコードの読みだけで書くと外すので、実際に押して確かめた結果だけを書く。
//   ハンバーガー → Load files… → 正規化済み nii → (Set as PT) → 画像を出す →
//   VOI analysis… → テンプレート読込 → Run → overlay → CSV
// 各段階でスクリーンショットと状態を残す。
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const URL = `http://localhost:${opt('port','3000')}${opt('base','/metavol-web-beta2')}/`;
const IMG = normalizedNii();
const A_NII = path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.nii');
const A_XML = path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.xml');
mkdirSync('.screenshots', { recursive: true });

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('[pageerror]', e.message));
const shot = async (n) => writeFileSync(`.screenshots/wt_${n}.png`, await page.screenshot());
const state = async () => await page.evaluate(() => {
  const ss = document.querySelector('#app').__vue_app__._instance.setupState;
  const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
  const sum = ss.seriesSummariesView ?? [];
  const info = d.imageBoxInfos?.[0];
  return {
    series: sum.map(s => `${s.modality} ${s.description ?? ''}`),
    tileN: d.tileN,
    box0: info ? { hasVolume: 'centerInWorld' in info, series: info.currentSeriesNumber,
                   wc: info.myWC, ww: info.myWW } : null,
    canvases: [...document.querySelectorAll('canvas')].filter(c => c.width > 64).length,
  };
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
await page.waitForTimeout(1500);
console.log('■ 起動直後:', JSON.stringify(await state()));
await shot('0_start');

// --- 手順 1: ハンバーガー → Load files… ---
await page.locator('.v-app-bar button').first().click();
await page.waitForTimeout(500);
const items = await page.locator('.v-overlay .v-list-item-title').allTextContents();
console.log('■ ハンバーガーの項目:', JSON.stringify(items.slice(0, 8)));
await page.locator('.v-overlay .v-list-item', { hasText: 'Load files' }).first().click();
await page.waitForTimeout(300);
await page.setInputFiles('input[accept*=".dcm"]', [IMG]);
await page.waitForTimeout(6000);
console.log('■ 読み込み後:', JSON.stringify(await state()));
await shot('1_loaded');

// --- 手順 2: シリーズカードの Set as PT ---
const ptBtn = page.locator('.series-card button', { hasText: /^PT$/ });
console.log('■ "Set as: PT" ボタン:', await ptBtn.count() > 0 ? 'あり' : '無し');
if (await ptBtn.count() > 0) { await ptBtn.first().click(); await page.waitForTimeout(2500); }
console.log('■ PT 指定後:', JSON.stringify(await state()));
await shot('2_setpt');

// --- 手順 3: 画像を box に出す (カードのサムネをクリック) ---
await page.locator('.series-card .thumb').first().click();
await page.waitForTimeout(3500);
console.log('■ サムネをクリック後:', JSON.stringify(await state()));
await shot('3_shown');

// --- 手順 3b: Fit to window (表示設定メニュー) ---
// 読み込み直後は 1 voxel = 1 画素なので 79x95 の脳は小さく出る。拡大手段が効くか確かめる。
const sizeOfBrain = async () => await page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)[0];
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) lit++;
  return { canvas: [cv.width, cv.height], lit };
});
console.log('■ Fit 前:', JSON.stringify(await sizeOfBrain()));
const dispBtns = page.locator('.v-app-bar button');
const nBtn = await dispBtns.count();
// 表示設定メニュー (スライダーアイコン) を総当たりで開いて "Fit to window" を探す
let fitDone = false;
for (let i = nBtn - 5; i < nBtn && !fitDone; i++) {
  await dispBtns.nth(i).click().catch(() => {});
  await page.waitForTimeout(400);
  const it = page.locator('.v-overlay .v-list-item', { hasText: 'Fit to window' });
  if (await it.count() > 0) { await it.first().click(); fitDone = true; }
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}
await page.waitForTimeout(2000);
console.log('■ Fit to window を押せた:', fitDone, ' 後:', JSON.stringify(await sizeOfBrain()));
await shot('3b_fit');

// --- 手順 4: VOI analysis ---
await page.locator('.v-app-bar button').first().click();
await page.waitForTimeout(500);
await page.locator('.v-overlay .v-list-item', { hasText: 'VOI analysis' }).first().click();
await page.waitForTimeout(700);
await page.setInputFiles('input[accept*=".xml"]', [A_NII, A_XML]);
await page.waitForTimeout(3000);
await shot('4_template');
const dlg = page.locator('.mv-voi-card');
await dlg.locator('button', { hasText: 'Run' }).first().click();
await page.waitForTimeout(3000);
console.log('■ Run 後の行数:', await dlg.locator('.mv-voi-table tbody tr').count());
await shot('5_result');

// --- 手順 5: ダイアログを閉じて overlay を見る ---
await page.keyboard.press('Escape');
await page.waitForTimeout(2000);
console.log('■ overlay 表示:', JSON.stringify(await state()));
await shot('6_overlay');
await b.close();
console.log('\nスクリーンショット: .screenshots/wt_*.png');
