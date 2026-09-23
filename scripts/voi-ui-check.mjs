// VOI analysis を **人と同じ UI 操作** で通す検証。
//
// 内部関数を直接叩く scripts/voi-check.mjs とは別に要る。DICOM→NIfTI で
// 「内部は PASS なのに UI は無反応 (Sidebar のイベント中継漏れ)」を出した反省から、
// **UI から足した機能は UI から検証する**。
//
// 経路: ハンバーガー → VOI analysis… → Load VOI template… (ファイル選択) →
//       シリーズ選択 → Run → 表を確認 → Export CSV → 落ちてきた CSV を検算
//
// 使い方: node scripts/voi-ui-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const PORT = parseInt(opt('port', '3000'), 10);
const BASE = opt('base', '/metavol-web-beta2');
// spm-normalized/ を dev ケースとして読ませると正規化済み nii が 1 シリーズで入る
const URL = `http://localhost:${PORT}${BASE}/?dev=${opt('case', 'spm-normalized')}`;
const ATLAS_NII = path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.nii');
const ATLAS_XML = path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.xml');

const P = ok => ok ? 'PASS' : 'FAIL';
let failed = false;
const check = (ok, label, extra = '') => {
  if (!ok) failed = true;
  console.log(`  ${P(ok)}  ${label}${extra ? '  ' + extra : ''}`);
};

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
  console.log('[voi-ui] loading the normalised image…');
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 300000 });
  await page.waitForTimeout(4000);
  const nSeries = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
  console.log(`[voi-ui] ${nSeries} series\n`);

  // --- ① ハンバーガー → VOI analysis… ---
  await page.locator('.v-app-bar button').first().click();     // ☰
  await page.waitForTimeout(600);
  const menuItem = page.locator('.v-overlay .v-list-item', { hasText: 'VOI analysis' });
  check(await menuItem.count() > 0, 'ハンバーガーに "VOI analysis…" がある');
  if (await menuItem.count() === 0) throw new Error('menu item missing');
  await menuItem.first().click();
  await page.waitForTimeout(700);
  const dlg = page.locator('.mv-voi-card');
  check(await dlg.count() > 0, 'ダイアログが開く');

  // --- ② テンプレート読み込み (実際にファイル選択させる) ---
  const loadBtn = page.locator('.mv-voi-card button', { hasText: 'Load VOI template' });
  check(await loadBtn.count() > 0, '"Load VOI template…" ボタンがある');
  // hidden input へ直接ファイルを渡す (ネイティブのファイルダイアログは自動化できないため)
  await page.setInputFiles('input[accept*=".nii"][multiple]', [ATLAS_NII, ATLAS_XML]);
  await page.waitForTimeout(2500);
  const info = await dlg.locator('.mv-voi-info').innerText().catch(() => '');
  check(/Neuromorphometrics/.test(info), 'テンプレート情報が表示される', info.split('\n')[0] ?? '');
  check(/136 regions/.test(info), '136 領域と表示される');
  check(/CC BY-NC/.test(info), 'ライセンス表示が出る');

  // --- ②b **Run を押していない時点で**もう解析済みか ---
  // テンプレート読み込み = そのまま解析まで走る、が仕様。overlay は labelOf が無いと
  // 描けないので、ここが走っていないと **step 5 でテンプレートの一致を目視できない**。
  const rowsBeforeRun = await dlg.locator('.mv-voi-table tbody tr').count();
  check(rowsBeforeRun === 136, 'テンプレート読込だけで表が出る (Run 不要)', `実際 ${rowsBeforeRun} 行`);
  const diagBeforeRun = await dlg.locator('.mv-voi-diag').count();
  check(diagBeforeRun > 0, 'テンプレート読込だけで位置合わせ診断が出る');

  // --- ③ Run を押しても壊れないこと (明示的な再実行) ---
  const runBtn = page.locator('.mv-voi-card button', { hasText: 'Run' });
  check(await runBtn.count() > 0, 'Run ボタンがある');
  await runBtn.first().click();
  await page.waitForTimeout(2500);

  const diag = await dlg.locator('.mv-voi-diag').innerText().catch(() => '');
  check(/100.0%/.test(diag), '診断に「テンプレート内 100%」が出る', diag.replace(/\n/g, ' | ').slice(0, 120));
  const rowCount = await dlg.locator('.mv-voi-table tbody tr').count();
  check(rowCount === 136, `表に 136 行出る`, `実際 ${rowCount}`);

  // 警告が出ていないこと (正しい組み合わせなので)
  const warn = await dlg.locator('.v-alert').count();
  check(warn === 0, '警告アラートが出ていない');

  // --- ④ 絞り込みが効く ---
  await dlg.locator('input[placeholder*="Filter"]').fill('hippocampus');
  await page.waitForTimeout(400);
  const filtered = await dlg.locator('.mv-voi-table tbody tr').count();
  check(filtered === 2, '"hippocampus" で 2 行 (左右) に絞れる', `実際 ${filtered}`);
  await dlg.locator('input[placeholder*="Filter"]').fill('');
  await page.waitForTimeout(300);

  // --- ④b overlay が実際に描かれているか ---
  // **「トグルがある」ではなく「画素が変わる」ことを見る。** overlay は既存のマスク描画
  // (MaskOverlay) を流用しているので、配線が外れていても UI 上は何も起きず気付けない。
  // 画像 box を 1 枚出し、overlay ON / OFF で canvas の彩度を比較する。
  const paintStats = async () => await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 1200));
    const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)[0];
    if (!cv) return null;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let colored = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (r + gg + b < 30) continue;      // 背景の黒は数えない
      lit++;
      // グレースケールなら R=G=B。差があれば着色されている = overlay が乗っている
      if (Math.max(r, gg, b) - Math.min(r, gg, b) > 24) colored++;
    }
    return { lit, colored, frac: lit ? colored / lit : 0 };
  });

  // **読み込み直後の box をそのまま使う** (?dev= で読むと volume box として既に出ている)。
  // 以前はここで promoteBoxToVolume + Run し直していたが、それだと
  // 「実際の利用者が見る状態」ではなくなる。
  await page.waitForTimeout(1500);

  // **描画が落ち着くまで待ってから測ること。** promoteBoxToVolume の描画は非同期で、
  // 待たずに測ると描きかけの canvas を拾う (実測: 点灯画素 4588 → 安定後 7505 で、
  // overlay ON なのに着色 0% と誤判定した)。点灯画素数が 2 回続けて同じになるまで待つ。
  const waitStablePaint = async () => {
    let prev = -1;
    for (let t = 0; t < 20; t++) {
      const st = await paintStats();
      if (st && st.lit === prev && st.lit > 0) return st;
      prev = st?.lit ?? -1;
      await page.waitForTimeout(700);
    }
    return await paintStats();
  };

  const onStats = await waitStablePaint();
  // overlay を切る
  await dlg.locator('.mv-voi-overlay input[type="checkbox"]').first().click();
  const offStats = await waitStablePaint();
  // 戻す
  await dlg.locator('.mv-voi-overlay input[type="checkbox"]').first().click();
  const onAgain = await waitStablePaint();

  if (!onStats || !offStats || !onAgain) {
    check(false, 'canvas を取得できた');
  } else {
    console.log(`  overlay ON  着色画素 ${(onStats.frac * 100).toFixed(1)}% (${onStats.colored}/${onStats.lit})`);
    console.log(`  overlay OFF 着色画素 ${(offStats.frac * 100).toFixed(1)}% (${offStats.colored}/${offStats.lit})`);
    check(onStats.frac > 0.10, 'overlay ON で画像が着色される', `${(onStats.frac * 100).toFixed(1)}%`);
    check(offStats.frac < 0.02, 'overlay OFF でグレースケールに戻る', `${(offStats.frac * 100).toFixed(1)}%`);
    check(onAgain.frac > 0.10, '再度 ON で戻る', `${(onAgain.frac * 100).toFixed(1)}%`);
  }

  // --- ④c 透過度スライダが実際に効くか (segmentation store 統一の回帰) ---
  // ユーザ報告「maskの透過性を上げ下げできない」から。VOI overlay は MTV マスクと
  // 同じ segStore.overlayAlpha を使う設計に統一した。**スライダを動かして画素が
  // 変わる**ことまで見る (store に書けても再描画されなければ人には効いていない)。
  // 着色率ではなく **着色画素の彩度合計** を比べる。alpha を下げると色は薄くなるが
  // 「彩度 > 24」の画素数はほぼ変わらないため、率では検出できない。
  const saturationSum = async () => await page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)[0];
    if (!cv) return null;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (r + gg + b < 30) continue;
      sum += Math.max(r, gg, b) - Math.min(r, gg, b);
    }
    return sum;
  });
  const setAlpha = async (v) => {
    await page.evaluate((val) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const seg = pinia._s.get('segmentation');
      seg.overlayAlpha = val;
    }, v);
    // スライダ操作と同じ経路の再描画 (dialog は overlayChanged → refreshVoiOverlay)
    await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__;
      const ss = app._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef);
      d.refreshVoiOverlay();
    });
    await page.waitForTimeout(1200);
  };
  await setAlpha(0.9);
  const satHigh = await saturationSum();
  await setAlpha(0.15);
  const satLow = await saturationSum();
  await setAlpha(0.5);
  console.log(`  彩度合計: alpha 0.9 → ${satHigh}   alpha 0.15 → ${satLow}`);
  check(satHigh != null && satLow != null && satLow < satHigh * 0.6,
        '透過度スライダで overlay の濃さが変わる',
        `0.15/0.9 比 ${satHigh ? (satLow / satHigh).toFixed(2) : '?'}`);

  // --- ④d per-label 表示切替が VOI 領域にも効くか ---
  // マスク基盤統一の恩恵: 領域単位の eye toggle。id 44 (Right Cerebral White Matter,
  // 最大領域) を非表示にすると着色画素が**減る**こと、戻すと復元することを見る。
  const setLabelVisible = async (id, vis) => {
    await page.evaluate(({ id, vis }) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const seg = pinia._s.get('segmentation');
      const l = seg.labels.find(x => x.id === id);
      if (l) l.visible = vis;
      seg.maskVersion++;
    }, { id, vis });
    await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__;
      const ss = app._instance.setupState;
      (ss.dicomViewRef.value ?? ss.dicomViewRef).refreshVoiOverlay();
    });
    await page.waitForTimeout(1200);
  };
  const beforeHide = await paintStats();
  await setLabelVisible(44, false);
  const afterHide = await paintStats();
  await setLabelVisible(44, true);
  const afterShow = await paintStats();
  console.log(`  着色画素: 全表示 ${beforeHide?.colored} → id44 非表示 ${afterHide?.colored} → 再表示 ${afterShow?.colored}`);
  check(!!beforeHide && !!afterHide && afterHide.colored < beforeHide.colored * 0.9,
        'per-label 非表示で該当領域が消える', `${beforeHide?.colored} → ${afterHide?.colored}`);
  check(!!afterShow && !!beforeHide && Math.abs(afterShow.colored - beforeHide.colored) <= beforeHide.colored * 0.05,
        '再表示で戻る', `${afterShow?.colored}`);

  // --- ④e 左サイドバーの MASK カード ---
  // マスク層は 1 枚で VOI/MTV が置き換え合うため、「いま何が載っているか」を
  // スクロール無しで見せるカード。VOI 実行後は出自 (VOI: <atlas>) が出ること、
  // カードの目アイコンが overlay を実際に消すことまで見る。
  // ダイアログの scrim がサイドバーへのクリックを遮るので、いったん閉じて操作する
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const maskCard = page.locator('[data-testid="mask-card"]');
  check(await maskCard.count() === 1, 'MASK カードが左サイドバーに出る');
  const cardText = await maskCard.innerText().catch(() => '');
  check(/VOI:/.test(cardText), 'カードに出自 (VOI: <atlas>) が出る', JSON.stringify(cardText.replace(/\s+/g, ' ').slice(0, 60)));
  await maskCard.locator('.eye-btn').click();
  const cardOff = await waitStablePaint();
  await maskCard.locator('.eye-btn').click();
  const cardOn = await waitStablePaint();
  check(!!cardOff && cardOff.frac < 0.02, 'カードの目アイコンで overlay が消える', `${((cardOff?.frac ?? 1) * 100).toFixed(1)}%`);
  check(!!cardOn && cardOn.frac > 0.10, 'カードの目アイコンで overlay が戻る', `${((cardOn?.frac ?? 0) * 100).toFixed(1)}%`);
  // 以降の検査 (Export CSV) のためにダイアログを開き直す
  await page.locator('.v-app-bar button').first().click();
  await page.waitForTimeout(400);
  await page.locator('.v-overlay .v-list-item', { hasText: 'VOI analysis' }).first().click();
  await page.waitForTimeout(600);

  // --- ④c modality 不明でも「見える」window になっているか ---
  // 以前は CT/PT 以外を一律 WC0/WW1000 にしていたため、値域 0〜11 の正規化脳画像が
  // **ほぼ真っ黒**になった。分位点から決めているか、box の WC/WW と点灯画素で確かめる。
  const win = await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    const d = (app._instance.setupState.dicomViewRef.value ?? app._instance.setupState.dicomViewRef).$.setupState;
    const info = d.imageBoxInfos[0];
    const v = d.seriesList[info?.currentSeriesNumber ?? 0]?.volume;
    let lo = Infinity, hi = -Infinity, nan = 0;
    for (let i = 0; i < v.voxel.length; i += 7) {
      const x = v.voxel[i];
      if (!Number.isFinite(x)) { nan++; continue; }
      if (x < lo) lo = x; if (x > hi) hi = x;
    }
    return { wc: info?.myWC, ww: info?.myWW, lo, hi, nan };
  });
  console.log(`  box の window: WC ${win.wc?.toFixed(3)} / WW ${win.ww?.toFixed(3)}   データ値域 ${win.lo.toFixed(3)}〜${win.hi.toFixed(3)} (NaN ${win.nan})`);
  check(Number.isFinite(win.wc) && Number.isFinite(win.ww), 'WC/WW が有限値 (NaN 混入で壊れていない)');
  check(win.ww > 0 && win.ww < (win.hi - win.lo) * 3, 'WW がデータ値域に見合っている', `WW ${win.ww?.toFixed(2)} vs 値域幅 ${(win.hi - win.lo).toFixed(2)}`);
  check(win.wc > win.lo && win.wc < win.hi, 'WC がデータ値域の内側');

  // --- ⑤ CSV 出力 ---
  const dl = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  await dlg.locator('button', { hasText: 'Export CSV' }).first().click();
  const download = await dl;
  check(!!download, 'Export CSV でダウンロードが起きる');
  if (download) {
    const p = await download.path();
    const text = readFileSync(p, 'utf-8').replace(/^﻿/, '');
    const lines = text.split('\n');
    const header = lines.find(l => l.startsWith('id,'));
    check(header === 'id,name,voxels,nan_voxels,volume_ml,mean,sd,min,max', 'CSV ヘッダが期待どおり', header ?? '(なし)');
    const dataLines = lines.filter(l => /^\d+,/.test(l));
    check(dataLines.length === 136, 'CSV に 136 行', `実際 ${dataLines.length}`);
    check(text.includes('# atlas,Neuromorphometrics'), 'CSV に出典行が入る');

    // 中身の検算: 右大脳白質 (id 44) を独立に計算して突き合わせる
    const row = dataLines.find(l => l.startsWith('44,'));
    check(!!row, 'id 44 (Right Cerebral White Matter) の行がある');
    if (row) {
      const f = row.split(',');
      const csvVox = Number(f[2]), csvMean = Number(f[5]);
      const ref = refFor44();
      check(csvVox === ref.voxels, 'CSV の voxel 数が独立計算と一致', `${csvVox} vs ${ref.voxels}`);
      check(Math.abs(csvMean - ref.mean) < 1e-5, 'CSV の mean が独立計算と一致',
            `${csvMean} vs ${ref.mean.toFixed(6)}`);
    }
  }

  // --- ⑥ SUVR (参照領域比) ---
  // 参照に Brain Stem (id 35) を UI の autocomplete で選び、表に SUVR 列が出ること、
  // CSV の suvr 列 = mean / 参照 mean になっていること (id 44 で検算) を見る。
  {
    const ac = dlg.locator('.mv-voi-suvr input').first();
    await ac.click();
    await ac.fill('Brain Stem');
    await page.waitForTimeout(800);
    await page.locator('.v-overlay .v-list-item', { hasText: 'Brain Stem' }).first().click();
    await page.waitForTimeout(800);
    check(await dlg.locator('.mv-voi-table thead th', { hasText: 'SUVR' }).count() === 1,
          'SUVR 参照を選ぶと表に SUVR 列が出る');

    const dlS = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await dlg.locator('button', { hasText: 'Export CSV' }).first().click();
    const downloadS = await dlS;
    check(!!downloadS, 'SUVR 選択後の Export CSV でダウンロードが起きる');
    if (downloadS) {
      const text = readFileSync(await downloadS.path(), 'utf-8').replace(/^\ufeff/, '');
      const lines = text.split('\n');
      const header = lines.find(l => l.startsWith('id,'));
      check(header === 'id,name,voxels,nan_voxels,volume_ml,mean,sd,min,max,suvr',
            'CSV に suvr 列が付く', header ?? '(なし)');
      check(lines.some(l => l.startsWith('# suvr_reference,35,')),
            'メタ行に参照領域 (id 35) が記録される');
      const pick = (idWant) => {
        const l = lines.find(x => x.startsWith(idWant + ','));
        if (!l) return null;
        const f = l.split(',');
        return { mean: Number(f[5]), suvr: Number(f[9]) };
      };
      const refRow = pick(35), row44 = pick(44);
      const expected = refRow && row44 ? row44.mean / refRow.mean : NaN;
      check(!!row44 && Math.abs(row44.suvr - expected) < 1e-5,
            'suvr = mean / 参照 mean (id 44 で検算)', `${row44?.suvr} vs ${expected.toFixed(6)}`);
      check(!!refRow && Math.abs(refRow.suvr - 1) < 1e-6, '参照領域自身の suvr = 1');
    }
  }

  console.log(`\n  ダイアログ: ${dialogs.length ? JSON.stringify(dialogs) : 'なし'}`);
  console.log(`  console error: ${errors.length ? errors.length + ' 件' : 'なし'}`);
  if (errors.length) failed = true;
  console.log(`\n  総合: ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) process.exitCode = 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }

// --- 独立計算 (アプリのコードを一切使わない) ---
function refFor44() {
  const rd = (p) => {
    const buf = readFileSync(p);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dims = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
    const dt = dv.getInt16(70, true);
    const off = dv.getFloat32(108, true) || 352;
    const sl = dv.getFloat32(112, true) || 1, it = dv.getFloat32(116, true);
    const S = []; for (let r = 0; r < 3; r++) { const w = []; for (let c = 0; c < 4; c++) w.push(dv.getFloat32(280 + r * 16 + c * 4, true)); S.push(w); }
    const n = dims[0] * dims[1] * dims[2];
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const raw = dt === 2 ? dv.getUint8(off + i) : dt === 16 ? dv.getFloat32(off + i * 4, true)
                : dt === 4 ? dv.getInt16(off + i * 2, true) : NaN;
      v[i] = raw * sl + it;
    }
    return { dims, S, v };
  };
  const img = rd(normalizedNii());
  const atl = rd(ATLAS_NII);
  const Sa = atl.S;
  // 対角 affine 前提でなく一般に解く (3x3 逆行列)
  const a = [Sa[0][0], Sa[1][0], Sa[2][0]], b = [Sa[0][1], Sa[1][1], Sa[2][1]], c = [Sa[0][2], Sa[1][2], Sa[2][2]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  const I = [
    [(b[1] * c[2] - b[2] * c[1]) / det, (c[0] * b[2] - b[0] * c[2]) / det, (b[0] * c[1] - c[0] * b[1]) / det],
    [(c[1] * a[2] - a[1] * c[2]) / det, (a[0] * c[2] - c[0] * a[2]) / det, (a[1] * c[0] - a[0] * c[1]) / det],
    [(a[1] * b[2] - b[1] * a[2]) / det, (b[0] * a[2] - a[0] * b[2]) / det, (a[0] * b[1] - a[1] * b[0]) / det],
  ];
  const [nx, ny, nz] = img.dims, [tnx, tny, tnz] = atl.dims;
  let cnt = 0, sum = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const wx = img.S[0][0] * i + img.S[0][1] * j + img.S[0][2] * k + img.S[0][3] - Sa[0][3];
    const wy = img.S[1][0] * i + img.S[1][1] * j + img.S[1][2] * k + img.S[1][3] - Sa[1][3];
    const wz = img.S[2][0] * i + img.S[2][1] * j + img.S[2][2] * k + img.S[2][3] - Sa[2][3];
    const ti = Math.floor(I[0][0] * wx + I[0][1] * wy + I[0][2] * wz + 0.5);
    const tj = Math.floor(I[1][0] * wx + I[1][1] * wy + I[1][2] * wz + 0.5);
    const tk = Math.floor(I[2][0] * wx + I[2][1] * wy + I[2][2] * wz + 0.5);
    if (ti < 0 || ti >= tnx || tj < 0 || tj >= tny || tk < 0 || tk >= tnz) continue;
    if (atl.v[tk * tnx * tny + tj * tnx + ti] !== 44) continue;
    cnt++; sum += img.v[k * nx * ny + j * nx + i];
  }
  return { voxels: cnt, mean: sum / cnt };
}
