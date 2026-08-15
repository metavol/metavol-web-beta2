// **自動保存 1 回のコスト**を実測する。
//
// `useAutoSave` は maskVersion の変化を 2 秒 debounce して `serializeForPersistence()` →
// IndexedDB へ書く。serializeForPersistence は 3 本の mask を **それぞれ丸ごとコピー**する
// (`cloneBuf`)。Hirata の PET 256x490x146 なら 36.6MB × 3 = 110MB。
// これがブラシ 1 ストロークごとに走るので、Persona 1 (MTV 測定) の編集操作に直接効く。
//
// 測るもの:
//   1. serializeForPersistence() の所要時間とバイト数
//   2. IndexedDB への書き込み (saveSession) の所要時間
//   3. **gzip した場合**のバイト数と所要時間 (圧縮した方が速いか / 小さいか)
//   4. finalMask を除いた場合のバイト数 (finalMask は recomputeFinalMask で導出できる)
//
// 使い方: node scripts/autosave-cost.mjs [--case Hirata20260728]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'Hirata20260728');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[autosave] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[autosave] ${prev} series`);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const store = d.segStore ?? d.store;

    const sum = ss.seriesSummariesView;
    let ptIdx = -1;
    sum.forEach((s, i) => { const m = (s.modality || '').toUpperCase(); if ((m === 'PT' || m === 'PET') && ptIdx < 0) ptIdx = i; });
    if (ptIdx < 0) return { error: 'no PT' };
    d.ensureVolume_(ptIdx);
    await new Promise(r => setTimeout(r, 8000));
    const pet = d.seriesList[ptIdx].volume;
    if (!pet) return { error: 'no volume' };
    store.setPetVolume(pet);
    store.thresholdUnit = 'SUV';
    store.applyThreshold(2.5);
    if (!store.finalMask) return { error: 'no mask' };
    const nz = store.finalMask.reduce((a, v) => a + (v ? 1 : 0), 0);

    const persistence = await import('/metavol-web-beta2/src/stores/persistence.ts');
    // **ブラウザからは裸の 'fflate' を import できない** (bare specifier は解決されない)。
    // Vite dev が実ファイルを配る経路を順に試し、駄目なら native CompressionStream で代用する。
    let gzipSync = null;
    for (const path of ['/metavol-web-beta2/node_modules/fflate/esm/browser.js',
                        '/node_modules/fflate/esm/browser.js',
                        '/metavol-web-beta2/node_modules/.vite/deps/fflate.js']) {
      try { const m = await import(/* @vite-ignore */ path); if (m?.gzipSync) { gzipSync = m.gzipSync; break; } }
      catch { /* 次を試す */ }
    }

    const med = (f, n = 5) => {
      const ts = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); }
      ts.sort((a, b) => a - b); return +ts[Math.floor(n / 2)].toFixed(1);
    };

    // ① serializeForPersistence
    let payload = null;
    const serMs = med(() => { payload = store.serializeForPersistence(); });
    if (!payload) return { error: 'serializeForPersistence returned null' };
    const bytesOf = (p) => (p.thresholdMask?.byteLength ?? 0) + (p.manualEdits?.byteLength ?? 0) + (p.finalMask?.byteLength ?? 0);
    const rawBytes = bytesOf(payload);

    // ② IndexedDB 書き込み
    const tw = performance.now();
    await persistence.saveSession(payload);
    const writeMs = +(performance.now() - tw).toFixed(1);

    // ③ gzip したら
    let gzBytes = 0, gzMs = 0, gzHow = 'fflate';
    if (gzipSync) {
      const gz = (a) => gzipSync(new Uint8Array(a));
      gzMs = med(() => {
        gzBytes = gz(payload.thresholdMask).length + gz(payload.manualEdits).length + gz(payload.finalMask).length;
      }, 3);
    } else if (typeof CompressionStream === 'function') {
      gzHow = 'CompressionStream (native, 参考値)';
      const gzOne = async (buf) => {
        const cs = new CompressionStream('gzip');
        const blob = await new Response(new Blob([buf]).stream().pipeThrough(cs)).blob();
        return blob.size;
      };
      const t = performance.now();
      gzBytes = (await gzOne(payload.thresholdMask)) + (await gzOne(payload.manualEdits)) + (await gzOne(payload.finalMask));
      gzMs = +(performance.now() - t).toFixed(1);
    } else {
      gzHow = 'unavailable';
    }

    // ④ finalMask を除いたら
    const withoutFinal = rawBytes - (payload.finalMask?.byteLength ?? 0);

    return {
      dims: [pet.nx, pet.ny, pet.nz], voxels: pet.nx * pet.ny * pet.nz, nz,
      serMs, rawBytes, writeMs, gzMs, gzBytes, gzHow, withoutFinal,
    };
  });

  if (out.error) { console.error('  ERROR:', out.error); process.exitCode = 1; }
  else {
    const MB = b => (b / 1048576).toFixed(2) + ' MB';
    console.log(`\n  PET ${out.dims.join('x')} = ${(out.voxels / 1e6).toFixed(1)}M voxels、mask 非ゼロ ${out.nz} (${(100 * out.nz / out.voxels).toFixed(2)}%)`);
    console.log('\n  自動保存 1 回あたり (マスク編集のたびに 2 秒 debounce で走る)');
    console.log('  ' + '-'.repeat(62));
    console.log(`  serializeForPersistence (3 本コピー)   ${String(out.serMs).padStart(7)} ms   ${MB(out.rawBytes)}`);
    console.log(`  IndexedDB への書き込み                 ${String(out.writeMs).padStart(7)} ms`);
    console.log(`  合計                                   ${String((out.serMs + out.writeMs).toFixed(1)).padStart(7)} ms`);
    console.log('\n  改善案の効果');
    console.log('  ' + '-'.repeat(62));
    if (out.gzBytes > 0) {
      console.log(`  gzip する                              ${String(out.gzMs).padStart(7)} ms   ${MB(out.gzBytes)}  (${(out.rawBytes / out.gzBytes).toFixed(0)}x 縮小)  [${out.gzHow}]`);
    } else console.log(`  gzip する                              計測できず (${out.gzHow})`);
    // **finalMask の除外は 2026-08 に適用済み** (serializeForPersistence が undefined を返す)。
    // なのでこの行は通常 0% になる。0% でないなら「また finalMask を保存し始めた」ということ。
    const cut = 100 * (1 - out.withoutFinal / out.rawBytes);
    console.log(`  finalMask を除く                                   ${MB(out.withoutFinal)}  ` +
                (cut < 1 ? '(適用済み)' : `(${cut.toFixed(0)}% 削減できる — 退行の疑い)`));
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
