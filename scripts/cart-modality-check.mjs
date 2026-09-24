// 匿名化ソフトが (0008,0060) Modality を書き換えた DICOM への対策の検査。
//
// 実例 (どちらも SOP Class UID は無傷):
//   - cart: 全シリーズ Modality=RG
//   - ac76: 全シリーズ Modality=PT (CT も fusion の Secondary Capture も)。4 study 入り
// dicomModalityOf が SOP Class を優先して PT/CT を復元する。
// これが効かないと Persona HUNTER の MTV measurement が組めない。
//
// 見るもの (症例ごと):
//   1) PET 画像は PT、CT 画像は CT として一覧に出る (description と SOP Class を独立に照合)
//   2) Secondary Capture (fusion キャプチャ等) は PT/CT を名乗らない
//   3) MTV measurement で組まれる PT と CT が **同じ study** から選ばれる
//   4) SUV 化が成立し、Apply → Lesion table まで通る
//
// 使い方: node scripts/cart-modality-check.mjs [--case cart|ac76|all]   (先に npm run dev)
import { chromium } from 'playwright';

const opt = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; };
const BASE = `http://localhost:${opt('port', '3000')}${opt('base', '/metavol-web-beta2')}/`;
const which = opt('case', 'all');
const CASES = which === 'all' ? ['cart', 'ac76'] : [which];

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const SOP_PET = '1.2.840.10008.5.1.4.1.1.128';
const SOP_CT = '1.2.840.10008.5.1.4.1.1.2';
const SOP_SC = '1.2.840.10008.5.1.4.1.1.7';

const b = await chromium.launch({ headless: true });
try {
  for (const cas of CASES) {
    console.log(`\n===== ${cas} =====`);
    const page = await (await b.newContext()).newPage();
    page.on('pageerror', e => console.error('[pageerror]', e.message));
    await page.goto(`${BASE}?dev=${cas}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
    await page.waitForFunction(
      () => ((document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1),
      null, { timeout: 900000 });
    let prev = -1, stable = 0;
    while (stable < 4) {
      const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
      if (n === prev) stable++; else { stable = 0; prev = n; }
      await page.waitForTimeout(3000);
    }

    // --- 1) 2) 一覧の modality を、DICOM 自身の SOP Class と突き合わせる ---
    const rows = await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      return ss.seriesSummariesView.map((s, i) => {
        const ds = d.seriesList[i]?.myDicom?.[0];
        return {
          modality: s.modality, desc: s.description,
          raw: ds?.string('x00080060') ?? '', sop: ds?.string('x00080016') ?? '',
          study: ds?.string('x0020000d') ?? '',
        };
      });
    });
    console.log(`  ${rows.length} series (raw Modality: ${[...new Set(rows.map(r => r.raw))].join(', ')})`);
    const pets = rows.filter(r => r.sop === SOP_PET);
    const cts = rows.filter(r => r.sop === SOP_CT);
    const scs = rows.filter(r => r.sop === SOP_SC);
    check(pets.length > 0 && pets.every(r => r.modality === 'PT'),
          'PET Image Storage は全部 PT', `${pets.length} 本`);
    check(cts.length > 0 && cts.every(r => r.modality === 'CT'),
          'CT Image Storage は全部 CT (Modality が PT と嘘をついていても)',
          `${cts.length} 本 / 誤判定 ${cts.filter(r => r.modality !== 'CT').map(r => r.desc).join(', ') || 'なし'}`);
    check(scs.every(r => r.modality !== 'PT' && r.modality !== 'CT'),
          'Secondary Capture は PT/CT を名乗らない',
          `${scs.length} 本 → ${[...new Set(scs.map(r => r.modality))].join(', ')}`);

    // --- 3a) 全 PET について「その PET に選ばれる CT が同じ study か」 ---
    // 既定ペアの一致は先頭 study が両方の最上位なら偶然でも成立するので、
    // 仕組み (bestCtIndexForPet) を全 PET に対して直接確かめる。
    const perPet = await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const dvp = (ss.dicomViewRef.value ?? ss.dicomViewRef);
      const d = dvp.$.setupState;
      const st = (i) => d.seriesList[i]?.myDicom?.[0]?.string('x0020000d') ?? '';
      const cands = dvp.getPetCtSeriesCandidates();
      return cands.pt.map(c => {
        const ct = dvp.bestCtIndexForPet(c.idx);
        return { pt: c.label, ptStudy: st(c.idx), ct: ct >= 0 ? cands.ct.find(x => x.idx === ct)?.label : null, ctStudy: ct >= 0 ? st(ct) : '' };
      });
    });
    const studies = new Set(perPet.map(p => p.ptStudy));
    const mism = perPet.filter(p => p.ctStudy && p.ctStudy !== p.ptStudy);
    check(mism.length === 0,
          `どの PET を選んでも CT は同じ study から選ばれる (${perPet.length} PET / ${studies.size} study)`,
          mism.length ? `不一致: ${mism.map(m => m.pt).join(', ')}` : '');

    // --- 3b) ピッカーで PT を別 study に選び直すと CT が追従する ---
    if (studies.size > 1) {
      await page.locator('.v-app-bar button', { hasText: 'LAYOUTS' }).first().click();
      await page.waitForTimeout(400);
      await page.locator('.v-overlay .v-list-item', { hasText: 'MTV measurement' }).first().click();
      await page.waitForTimeout(1000);
      const follow = await page.evaluate(async () => {
        const ss = document.querySelector('#app').__vue_app__._instance.setupState;
        const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
        const st = (i) => d.seriesList[i]?.myDicom?.[0]?.string('x0020000d') ?? '';
        const cands = ss.petPickerCandidates;
        if (!cands) return { skipped: true };
        const cur = ss.petPickerSelectedPt;
        const other = cands.pt.find(c => st(c.idx) !== st(cur));
        if (!other) return { skipped: true };
        ss.petPickerSelectedPt = other.idx;
        await new Promise(r => setTimeout(r, 300));
        return { skipped: false, ptStudy: st(other.idx), ctStudy: st(ss.petPickerSelectedCt) };
      });
      if (!follow.skipped) {
        check(follow.ptStudy === follow.ctStudy, 'ピッカーで PT を別 study に変えると CT が追従する',
              `${follow.ptStudy.slice(-8)} / ${follow.ctStudy.slice(-8)}`);
      }
      // ピッカーは閉じて以降の既定 Build 検査に影響させない
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }

    // --- 3) MTV measurement → 組まれた PT/CT が同じ study か ---
    await page.locator('.v-app-bar button', { hasText: 'LAYOUTS' }).first().click();
    await page.waitForTimeout(400);
    const mtvItem = page.locator('.v-overlay .v-list-item', { hasText: 'MTV measurement' });
    const cls = await mtvItem.first().getAttribute('class');
    check(!(cls ?? '').includes('v-list-item--disabled'), 'MTV measurement が有効 (PT+CT 検出済み)');
    await mtvItem.first().click();
    await page.waitForTimeout(1000);
    const picker = page.locator('.v-dialog:visible', { hasText: 'Choose PT and CT' });
    if (await picker.count() > 0) {
      await picker.locator('button', { hasText: 'Build' }).first().click();
      console.log('  (PT/CT picker → 既定のまま Build)');
    }
    await page.waitForTimeout(5000);
    const pair = await page.evaluate(() => {
      const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      const studyOf = (v) => {
        if (!v) return null;
        for (const s of d.seriesList) {
          if (s.volume && s.volume.voxel === v.voxel) return s.myDicom?.[0]?.string('x0020000d') ?? null;
        }
        return null;
      };
      const pet = seg.petVolumeRef, ct = seg.ctVolumeRef;
      return {
        pet: pet ? { desc: pet.metadata?.seriesDescription, modality: pet.metadata?.modality,
                     suvOk: pet.metadata?.suvOk, suvFactor: pet.metadata?.suvFactor, study: studyOf(pet) } : null,
        ct: ct ? { desc: ct.metadata?.seriesDescription, modality: ct.metadata?.modality, study: studyOf(ct) } : null,
      };
    });
    console.log(`  PT: "${pair.pet?.desc}"  CT: "${pair.ct?.desc}"`);
    check(!!pair.pet && pair.pet.modality === 'PT', 'petVolumeRef に PET が載る');
    check(!!pair.ct && pair.ct.modality === 'CT', 'ctVolumeRef に CT が載る');
    check(!!pair.pet?.study && pair.pet.study === pair.ct?.study,
          '既定で組まれる PT と CT が同じ study', `${pair.pet?.study?.slice(-8)} / ${pair.ct?.study?.slice(-8)}`);
    check(!!pair.pet && pair.pet.suvOk === true && pair.pet.suvFactor > 0,
          'SUV 化が成立', `factor ${pair.pet?.suvFactor?.toExponential(3)}`);

    // --- 4) Apply → Lesion table ---
    // PET が store に載り Apply ボタンが有効になってから押す (早すぎると無効ボタンを押して
    // 何も起きず「0 行」と誤判定する。実測: cart で 1 回踏んだ。単独再現では 8 秒で 257 行)。
    await page.waitForFunction(() => {
      const seg = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('segmentation');
      const btn = document.querySelector('.mv-apply-main');
      return !!seg.petVolumeRef && !!btn && !btn.hasAttribute('disabled') && !btn.classList.contains('v-btn--disabled');
    }, null, { timeout: 60000 }).catch(() => {});
    await page.locator('.mv-apply-main').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.mv-lesion-table tbody tr').length > 0,
      null, { timeout: 120000 }).catch(() => {});
    const n = await page.locator('.mv-lesion-table tbody tr').count();
    check(n > 0, 'Apply → Lesion table に病変が出る (HUNTER のジャーニー成立)', `${n} 行`);
    await page.close();
  }

  console.log(`\n  総合: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await b.close(); }
