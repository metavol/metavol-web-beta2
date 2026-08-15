// Snapshot (.mvs) の **保存 → 復元** を実データで e2e 検証する。
//
// セッション永続化の要。**ユーザが実際に通る経路をそのまま踏む**:
//   `downloadSnapshotFile()` でファイルを吐かせ、その中身を File にして `loadSnapshotFile(file)` に渡す。
// (`buildSnapshotJson` / `applySnapshotJson` は composable 内部に留まっていて外から呼べない。
//  そもそも download/File の配線ごと確かめたいので、この経路の方が検査範囲が広い。)
//
// マスク往復 (scripts/mask-roundtrip.mjs) と違い、こちらは **view + mask + ROI + registration** が
// まとめて戻るかを見る。特に registration は Volume の幾何 (imagePosition / vectorX,Y,Z) に効くので、
// **復元後に実際の world 幾何が一致するか**まで確認する。store の写しが戻っただけでは画面は
// 動かない (CLAUDE.md 3.57: 実際に掛け直すのは applyStoredRegistrations)。
//
// 確認項目:
//   1. mask (finalMask / thresholdMask / manualEdits) が **差分 0** で戻る
//   2. threshold / unit / labels / currentLabelId が戻る
//   3. registration が store と **volume の幾何の両方**に戻る
//   4. box 数 (tileN) が戻る
//   5. **異常系**: schema 違い / version 違い / 壊れた JSON を拒否する
//
// 使い方: node scripts/snapshot-roundtrip.mjs [--case Hirata20260728]
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[snapshot] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[snapshot] ${prev} series`);

  // ---- ① 状態を作る ----
  const setup = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const dv = ss.dicomViewRef.value ?? ss.dicomViewRef;
    const d = dv.$.setupState;
    const store = d.segStore ?? d.store;
    const pick = (n) => dv[n] ?? dv.$.exposed?.[n] ?? d[n];
    if (typeof pick('downloadSnapshotFile') !== 'function') return { error: 'downloadSnapshotFile not exposed' };
    if (typeof pick('loadSnapshotFile') !== 'function') return { error: 'loadSnapshotFile not exposed' };

    const sum = ss.seriesSummariesView;
    let ptIdx = -1, ptCount = -1, ctIdx = -1;
    sum.forEach((s, i) => {
      const m = (s.modality || '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i;
      if (m !== 'PT' && m !== 'PET') return;
      const n = s.numberOfSlices ?? s.count ?? s.nSlices ?? 0;
      if (n > ptCount) { ptCount = n; ptIdx = i; }
    });
    if (ptIdx < 0) return { error: 'no PT series' };
    d.ensureVolume_(ptIdx);
    if (ctIdx >= 0) d.ensureVolume_(ctIdx);
    await new Promise(r => setTimeout(r, 8000));
    const pet = d.seriesList[ptIdx].volume;
    if (!pet) return { error: 'PET volume build failed' };
    store.setPetVolume(pet);
    d.promoteBoxToVolume(0, ptIdx);
    await new Promise(r => setTimeout(r, 1500));

    store.thresholdUnit = 'SUV';
    store.applyThreshold(2.5);
    if (!store.finalMask) return { error: 'no mask' };
    const nz0 = store.finalMask.reduce((a, v) => a + (v ? 1 : 0), 0);
    if (nz0 < 100) return { error: `mask too small (${nz0})` };

    const REG = [11, -7, 15, 0, 0, 0];
    let regApplied = false;
    if (typeof d.setVolumeRegistration === 'function' && pet.metadata?.seriesUID) {
      d.setVolumeRegistration(pet, REG);
      regApplied = true;
    }
    const geomOf = (v) => [
      +v.imagePosition.x.toFixed(4), +v.imagePosition.y.toFixed(4), +v.imagePosition.z.toFixed(4),
      +v.vectorX.length().toFixed(5), +v.vectorY.length().toFixed(5), +v.vectorZ.length().toFixed(5),
    ];
    // 大きな配列はページ側に残す (Node へ転送しない)
    window.__snap = {
      d, store, pet, geomOf, pick,
      mask: Uint16Array.from(store.finalMask),
      thr: Uint16Array.from(store.thresholdMask),
      man: Uint16Array.from(store.manualEdits),
    };
    return {
      nz0, regApplied, REG,
      before: {
        threshold: store.threshold, unit: store.thresholdUnit,
        labels: store.labels.map(l => `${l.id}:${l.name}`).join(','),
        currentLabelId: store.currentLabelId,
        tileN: d.tileN, regCount: store.registrations.length,
        geom: geomOf(pet),
      },
    };
  });
  if (setup.error) { console.error('\n  ERROR:', setup.error); process.exitCode = 1; }
  else {
    // ---- ② 保存 (実際に download させる) ----
    const dl = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate(() => {
      const h = window.__snap.pick('downloadSnapshotFile');
      h();
    });
    const download = await dl;
    const path = await download.path();
    const text = await readFile(path, 'utf-8');
    console.log(`  保存: ${download.suggestedFilename()}  ${(text.length / 1048576).toFixed(2)} MB`);

    // ---- ③ 状態を壊す ----
    const wiped = await page.evaluate(async () => {
      const S = window.__snap;
      S.store.manualEdits.fill(0); S.store.thresholdMask.fill(0); S.store.recomputeFinalMask();
      S.store.threshold = 99; S.store.currentLabelId = 1;
      if (typeof S.d.setVolumeRegistration === 'function') S.d.setVolumeRegistration(S.pet, [0, 0, 0, 0, 0, 0]);
      S.d.tileN = 1;
      await new Promise(r => setTimeout(r, 800));
      return { nonZero: S.store.finalMask.reduce((a, v) => a + (v ? 1 : 0), 0), geom: S.geomOf(S.pet) };
    });

    // ---- ④ 復元 (File を作って loadSnapshotFile に渡す = UI と同じ) ----
    const after = await page.evaluate(async (json) => {
      const S = window.__snap;
      const file = new File([json], 'test.mvs', { type: 'application/json' });
      const res = await S.pick('loadSnapshotFile')(file);
      if (!res || !res.ok) return { error: 'loadSnapshotFile rejected: ' + (res?.reason ?? 'unknown') };
      await new Promise(r => setTimeout(r, 1500));
      const cmp = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      const bad = async (t) => {
        const f = new File([t], 'bad.mvs', { type: 'application/json' });
        const r = await S.pick('loadSnapshotFile')(f);
        return !r || !r.ok;
      };
      return {
        info: res.info,
        maskDiff: cmp(S.mask, S.store.finalMask),
        thrDiff: cmp(S.thr, S.store.thresholdMask),
        manDiff: cmp(S.man, S.store.manualEdits),
        threshold: S.store.threshold, unit: S.store.thresholdUnit,
        labels: S.store.labels.map(l => `${l.id}:${l.name}`).join(','),
        currentLabelId: S.store.currentLabelId,
        tileN: S.d.tileN, regCount: S.store.registrations.length,
        geom: S.geomOf(S.pet),
        badSchema: await bad(JSON.stringify({ schema: 'nope', v: 1 })),
        badVersion: await bad(JSON.stringify({ schema: 'metavol-snapshot', v: 999 })),
        badJson: await bad('{not json'),
      };
    }, text);

    if (after.error) { console.error('\n  ERROR:', after.error); process.exitCode = 1; }
    else {
      const P = ok => ok ? 'PASS' : 'FAIL';
      const b = setup.before;
      const geomSame = JSON.stringify(b.geom) === JSON.stringify(after.geom);
      const geomMoved = JSON.stringify(b.geom) !== JSON.stringify(wiped.geom);
      console.log(`  mask ${setup.nz0} voxels`);
      console.log(`  復元メッセージ: ${after.info}`);
      console.log('\n  項目                                   結果');
      console.log('  ' + '-'.repeat(62));
      console.log(`  破壊できている (復元前 mask=0)        ${P(wiped.nonZero === 0)}  nonzero=${wiped.nonZero}`);
      console.log(`  finalMask 完全一致                    ${P(after.maskDiff === 0)}  差分 ${after.maskDiff}`);
      console.log(`  thresholdMask 完全一致                ${P(after.thrDiff === 0)}  差分 ${after.thrDiff}`);
      console.log(`  manualEdits 完全一致                  ${P(after.manDiff === 0)}  差分 ${after.manDiff}`);
      console.log(`  threshold / unit                      ${P(after.threshold === b.threshold && after.unit === b.unit)}  ${b.threshold}${b.unit} -> ${after.threshold}${after.unit}`);
      console.log(`  labels                                ${P(after.labels === b.labels)}`);
      console.log(`  currentLabelId                        ${P(after.currentLabelId === b.currentLabelId)}  ${b.currentLabelId} -> ${after.currentLabelId}`);
      console.log(`  box 数 (tileN)                        ${P(after.tileN === b.tileN)}  ${b.tileN} -> ${after.tileN}`);
      if (setup.regApplied) {
        console.log(`  registration 件数                     ${P(after.regCount === b.regCount)}  ${b.regCount} -> ${after.regCount}`);
        console.log(`  破壊で幾何が動いた                    ${P(geomMoved)}`);
        console.log(`  幾何そのものが戻る                    ${P(geomSame)}`);
        console.log(`      保存時 ${JSON.stringify(b.geom)}`);
        console.log(`      破壊後 ${JSON.stringify(wiped.geom)}`);
        console.log(`      復元後 ${JSON.stringify(after.geom)}`);
      } else console.log('  SKIP  registration (setVolumeRegistration が expose されていない)');
      console.log(`  schema 違いを拒否                     ${P(after.badSchema)}`);
      console.log(`  version 違いを拒否                    ${P(after.badVersion)}`);
      console.log(`  壊れた JSON を拒否                    ${P(after.badJson)}`);

      const all = wiped.nonZero === 0 && after.maskDiff === 0 && after.thrDiff === 0 && after.manDiff === 0
        && after.threshold === b.threshold && after.unit === b.unit && after.labels === b.labels
        && after.currentLabelId === b.currentLabelId && after.tileN === b.tileN
        && after.badSchema && after.badVersion && after.badJson
        && (!setup.regApplied || (geomMoved && geomSame && after.regCount === b.regCount));
      console.log(`\n  総合: ${all ? 'PASS' : 'FAIL'}`);
      if (!all) process.exitCode = 1;
    }
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
