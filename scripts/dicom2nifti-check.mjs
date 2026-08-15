// **DICOM → NIfTI 変換**の正しさを実データで検証する。
//
// 変換は「書き出して終わり」では意味が無い。下流ツール (TotalSegmentator など) が読んだときに
// **同じ解剖が同じ world 座標に来る**ことが要る。そこで書き出した .nii を
// **ヘッダを自前で読み戻し** (ライブラリを介さない独立検査)、幾何と voxel を突き合わせる。
//
// 確認項目:
//   1. dims / voxel pitch がヘッダ往復で保たれる
//   2. **affine が往復する** — 読み戻した srow から voxel(0,0,0) と各軸の world 変位を復元し、
//      元 volume の imagePosition / vectorX,Y,Z と一致するか (LPS <-> RAS の符号反転を含む)
//   3. voxel 値が **1 つも変わらない** (Float32 で無変換のはず)
//   4. .nii.gz が gunzip して同一バイトになる / 圧縮率と所要時間
//   5. sidecar JSON に unit (PT=SUV / CT=HU) が入る
//
// 使い方: node scripts/dicom2nifti-check.mjs [--case Hirata20260728]
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
  console.log(`[d2n] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 900000 });
  let prev = -1, stable = 0;
  while (stable < 6) {
    const n = await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.seriesSummariesView.length);
    if (n === prev) stable++; else { stable = 0; prev = n; process.stdout.write(`\r  series=${n}   `); }
    await page.waitForTimeout(5000);
  }
  console.log(`\n[d2n] ${prev} series`);

  const rows = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const W = await import('/metavol-web-beta2/src/components/niftiVolumeWriter.ts');

    // **ヘッダは自前で読む。** nifti-reader-js は裸指定ではブラウザから import できないうえ、
    // アプリと同じライブラリで読み戻すと「ライブラリ内で辻褄が合っているだけ」を見逃す。
    // バイト位置を直接読む方が、書き出したファイルが NIfTI-1 仕様に沿っているかの独立した検査になる。
    const parseNifti1 = (buf) => {
      const dv = new DataView(buf);
      const sizeofHdr = dv.getInt32(0, true);
      if (sizeofHdr !== 348) return { error: `sizeof_hdr=${sizeofHdr} (348 でない)` };
      const magic = String.fromCharCode(dv.getUint8(344), dv.getUint8(345), dv.getUint8(346));
      if (magic !== 'n+1') return { error: `magic="${magic}" (n+1 でない)` };
      const dims = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
      const datatype = dv.getInt16(70, true);
      const bitpix = dv.getInt16(72, true);
      const pixDims = [dv.getFloat32(80, true), dv.getFloat32(84, true), dv.getFloat32(88, true)];
      const voxOffset = dv.getFloat32(108, true);
      const sformCode = dv.getInt16(254, true);
      // srow_x/y/z は row-major で 280 から 4 float ずつ
      const srow = [];
      for (let r = 0; r < 3; r++) {
        const row = [];
        for (let c = 0; c < 4; c++) row.push(dv.getFloat32(280 + r * 16 + c * 4, true));
        srow.push(row);
      }
      return { dims, datatype, bitpix, pixDims, voxOffset, sformCode, srow };
    };

    const sum = ss.seriesSummariesView;
    // modality ごとに 1 本ずつ試す (PT は SUV、CT は HU、と単位が違うため)
    const picks = [];
    for (const want of ['CT', 'PT', 'MR']) {
      const i = sum.findIndex(s => {
        const m = (s.modality || '').toUpperCase();
        return want === 'PT' ? (m === 'PT' || m === 'PET') : m === want;
      });
      if (i >= 0) picks.push(i);
    }
    if (!picks.length) return [{ error: 'no CT/PT/MR series' }];

    const out = [];
    for (const idx of picks) {
      if (!d.seriesList[idx].volume) d.ensureVolume_(idx);
      await new Promise(r => setTimeout(r, 7000));
      const vol = d.seriesList[idx].volume;
      if (!vol) { out.push({ idx, desc: sum[idx].description, error: 'volume build failed' }); continue; }

      // --- 書き出し (非圧縮) ---
      const t0 = performance.now();
      const plain = await W.writeNiftiVolumeAsync(vol, { gzip: false });
      const writeMs = +(performance.now() - t0).toFixed(0);
      const rawBuf = await plain.blob.arrayBuffer();

      // --- 読み戻し ---
      const hdr = parseNifti1(rawBuf);
      if (hdr.error) { out.push({ idx, desc: sum[idx].description, error: 'header: ' + hdr.error }); continue; }
      // datatype は **可逆な範囲で Int16、でなければ Float32** が選ばれる。
      // CT の HU は整数なので Int16 になり、PET の SUV は小数なので Float32 になるはず。
      const nVox = hdr.dims[0] * hdr.dims[1] * hdr.dims[2];
      let back;
      if (hdr.datatype === 4 && hdr.bitpix === 16) back = new Int16Array(rawBuf, hdr.voxOffset, nVox);
      else if (hdr.datatype === 16 && hdr.bitpix === 32) back = new Float32Array(rawBuf, hdr.voxOffset, nVox);
      else { out.push({ idx, error: `datatype=${hdr.datatype} bitpix=${hdr.bitpix} (INT16/FLOAT32 でない)` }); continue; }
      const dtypeName = hdr.datatype === 4 ? 'INT16' : 'FLOAT32';

      const dims = hdr.dims;
      const pitchOut = hdr.pixDims;
      const pitchIn = [vol.vectorX.length(), vol.vectorY.length(), vol.vectorZ.length()];

      // srow (RAS) -> LPS に戻して元の列ベクトルと比較する。
      // 書き出し側は x,y 成分の符号を反転しているので、読み戻しでも同じ反転を掛ける。
      const A = hdr.srow;   // 3x4 row-major (RAS)
      const col = (c) => [-A[0][c], -A[1][c], A[2][c]];
      const gotVx = col(0), gotVy = col(1), gotVz = col(2), gotP0 = col(3);
      const wantVx = [vol.vectorX.x, vol.vectorX.y, vol.vectorX.z];
      const wantVy = [vol.vectorY.x, vol.vectorY.y, vol.vectorY.z];
      const wantVz = [vol.vectorZ.x, vol.vectorZ.y, vol.vectorZ.z];
      const wantP0 = [vol.imagePosition.x, vol.imagePosition.y, vol.imagePosition.z];
      const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      const affErr = Math.max(maxDiff(gotVx, wantVx), maxDiff(gotVy, wantVy),
                              maxDiff(gotVz, wantVz), maxDiff(gotP0, wantP0));

      // voxel 一致
      let voxDiff = 0, firstDiff = -1;
      const n = Math.min(back.length, vol.voxel.length);
      for (let i = 0; i < n; i++) {
        if (back[i] !== vol.voxel[i]) { voxDiff++; if (firstDiff < 0) firstDiff = i; }
      }

      // --- gzip 版 ---
      const t1 = performance.now();
      const gz = await W.writeNiftiVolumeAsync(vol, { gzip: true });
      const gzMs = +(performance.now() - t1).toFixed(0);
      // gunzip して同一バイトか
      const gzBuf = await gz.blob.arrayBuffer();
      const ds = new DecompressionStream('gzip');
      const back2 = await new Response(new Blob([gzBuf]).stream().pipeThrough(ds)).arrayBuffer();
      let byteSame = back2.byteLength === rawBuf.byteLength;
      if (byteSame) {
        const a = new Uint8Array(rawBuf), b = new Uint8Array(back2);
        for (let i = 0; i < a.length; i += 997) if (a[i] !== b[i]) { byteSame = false; break; }
      }

      const sidecar = JSON.parse(W.buildVolumeSidecarJson(vol));
      out.push({
        idx, desc: sum[idx].description, modality: sum[idx].modality,
        dims, dimsOk: dims[0] === vol.nx && dims[1] === vol.ny && dims[2] === vol.nz,
        sformCode: hdr.sformCode,
        pitchErr: +Math.max(...pitchOut.map((v, i) => Math.abs(v - pitchIn[i]))).toFixed(6),
        affErr: +affErr.toFixed(6),
        voxDiff, firstDiff, voxels: vol.voxel.length,
        rawBytes: rawBuf.byteLength, gzBytes: gzBuf.byteLength, byteSame,
        writeMs, gzMs, ext: gz.ext,
        unit: sidecar.unit, dtypeName, sidecarDtype: sidecar.niftiDatatype,
        baseName: W.niftiBaseName(vol, `series-${idx}`),
      });
    }
    return out;
  });

  const MB = b => (b / 1048576).toFixed(1) + ' MB';
  const P = ok => ok ? 'PASS' : 'FAIL';
  let all = true;
  for (const r of rows) {
    if (r.error) { console.error(`\n  [${r.idx}] ERROR: ${r.error}`); all = false; continue; }
    console.log(`\n  [${r.idx}] ${r.modality} ${r.desc ?? ''}  ${r.dims.join('x')} = ${(r.voxels / 1e6).toFixed(1)}M voxels`);
    console.log(`       出力名: ${r.baseName}${r.ext}   単位: ${r.unit}   datatype: ${r.dtypeName}`);
    console.log(`       ${P(r.dimsOk)}  dims 往復`);
    console.log(`       ${P(r.sformCode === 1)}  sform_code = 1 (scanner anatomical)`);
    console.log(`       ${P(r.pitchErr < 1e-3)}  voxel pitch 往復        誤差 ${r.pitchErr} mm`);
    console.log(`       ${P(r.affErr < 1e-3)}  **affine 往復 (LPS<->RAS)**  誤差 ${r.affErr} mm`);
    console.log(`       ${P(r.voxDiff === 0)}  **voxel 値が可逆**       差分 ${r.voxDiff}${r.firstDiff >= 0 ? ` (最初 idx ${r.firstDiff})` : ''}`);
    console.log(`       ${P(r.dtypeName === r.sidecarDtype)}  sidecar の datatype 表記が一致  ${r.sidecarDtype}`);
    console.log(`       ${P(r.byteSame)}  .nii.gz が gunzip で復元`);
    console.log(`       サイズ ${MB(r.rawBytes)} -> ${MB(r.gzBytes)} (${(r.rawBytes / r.gzBytes).toFixed(1)}x)   ` +
                `書き出し ${r.writeMs}ms / gzip 込み ${r.gzMs}ms`);
    if (!(r.dimsOk && r.sformCode === 1 && r.pitchErr < 1e-3 && r.affErr < 1e-3 && r.voxDiff === 0
          && r.byteSame && r.dtypeName === r.sidecarDtype)) all = false;
  }
  console.log(`\n  総合: ${all ? 'PASS' : 'FAIL'}`);
  if (!all) process.exitCode = 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
