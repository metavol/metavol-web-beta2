// VOI テンプレート解析の中核 (テンプレート読込 / リサンプル / 統計) を検証する。
//
// 3 本立て:
//   A) **自己整合**: XML と NIfTI のラベル集合が一致するか (実測 136 種)
//   B) **合成データ**: 「voxel 値 = ラベル ID × 10」の画像を **アプリとは別経路**
//      (voxelToWorld / worldToVoxel を 1 voxel ずつ) で作り、統計が厳密に ID×10 / SD 0 に
//      なるか。これが通れば、高速化した合成アフィンが素直な world 往復と一致している。
//   C) **独立実装との突合**: 同じ統計を **Node 側で NIfTI を直接パースして**計算し、
//      アプリの値と voxel 数まで一致するか。アプリと同じコードで検算しない。
//
// 使い方: node scripts/voi-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { normalizedNiiRel } from './sampleData.mjs';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const PORT = parseInt(opt('port', '3000'), 10);
const BASE = opt('base', '/metavol-web-beta2');
const URL = `http://localhost:${PORT}${BASE}/`;
const ATLAS = 'spm-atlas/labels_Neuromorphometrics.nii';
const XML = 'spm-atlas/labels_Neuromorphometrics.xml';
const IMAGE = opt('image', null) ?? normalizedNiiRel();

// ---------------------------------------------------------------------------
// Node 側の独立実装 (C)
// ---------------------------------------------------------------------------
const readNii = (path) => {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, true) !== 348) throw new Error(`${path}: sizeof_hdr != 348`);
  const dims = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
  const datatype = dv.getInt16(70, true);
  const voxOffset = dv.getFloat32(108, true) || 352;
  const slopeRaw = dv.getFloat32(112, true);
  const inter = dv.getFloat32(116, true);
  const slope = slopeRaw === 0 ? 1 : slopeRaw;
  const srow = [];
  for (let r = 0; r < 3; r++) { const row = []; for (let c = 0; c < 4; c++) row.push(dv.getFloat32(280 + r * 16 + c * 4, true)); srow.push(row); }
  const n = dims[0] * dims[1] * dims[2];
  const get = (i) => {
    switch (datatype) {
      case 2: return dv.getUint8(voxOffset + i);
      case 4: return dv.getInt16(voxOffset + i * 2, true);
      case 8: return dv.getInt32(voxOffset + i * 4, true);
      case 16: return dv.getFloat32(voxOffset + i * 4, true);
      case 64: return dv.getFloat64(voxOffset + i * 8, true);
      case 256: return dv.getInt8(voxOffset + i);
      case 512: return dv.getUint16(voxOffset + i * 2, true);
      default: throw new Error(`${path}: datatype ${datatype} 未対応`);
    }
  };
  const vox = new Float64Array(n);
  for (let i = 0; i < n; i++) vox[i] = get(i) * slope + inter;
  return { dims, srow, vox, datatype };
};

// srow (RAS, row-major 3x4) の逆 3x3。列が voxel 軸。
const inv3 = (S) => {
  const a = [S[0][0], S[1][0], S[2][0]];
  const b = [S[0][1], S[1][1], S[2][1]];
  const c = [S[0][2], S[1][2], S[2][2]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  const id = 1 / det;
  return [
    [(b[1] * c[2] - b[2] * c[1]) * id, (c[0] * b[2] - b[0] * c[2]) * id, (b[0] * c[1] - c[0] * b[1]) * id],
    [(c[1] * a[2] - a[1] * c[2]) * id, (a[0] * c[2] - c[0] * a[2]) * id, (a[1] * c[0] - a[0] * c[1]) * id],
    [(a[1] * b[2] - b[1] * a[2]) * id, (b[0] * a[2] - a[0] * b[2]) * id, (a[0] * b[1] - a[1] * b[0]) * id],
  ];
};

const nodeStats = (imgPath, atlasPath) => {
  const img = readNii(imgPath), atl = readNii(atlasPath);
  const Si = img.srow, Sa = atl.srow;
  const Ia = inv3(Sa);
  const [nx, ny, nz] = img.dims;
  const [tnx, tny, tnz] = atl.dims;
  const acc = new Map();   // id -> {n, sum, min, max, vals?}
  let inside = 0, labeled = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // image voxel -> world (RAS)
    const wx = Si[0][0] * i + Si[0][1] * j + Si[0][2] * k + Si[0][3];
    const wy = Si[1][0] * i + Si[1][1] * j + Si[1][2] * k + Si[1][3];
    const wz = Si[2][0] * i + Si[2][1] * j + Si[2][2] * k + Si[2][3];
    // world -> atlas voxel
    const dx = wx - Sa[0][3], dy = wy - Sa[1][3], dz = wz - Sa[2][3];
    const ti = Math.floor(Ia[0][0] * dx + Ia[0][1] * dy + Ia[0][2] * dz + 0.5);
    const tj = Math.floor(Ia[1][0] * dx + Ia[1][1] * dy + Ia[1][2] * dz + 0.5);
    const tk = Math.floor(Ia[2][0] * dx + Ia[2][1] * dy + Ia[2][2] * dz + 0.5);
    if (ti < 0 || ti >= tnx || tj < 0 || tj >= tny || tk < 0 || tk >= tnz) continue;
    inside++;
    const id = atl.vox[tk * tnx * tny + tj * tnx + ti];
    if (!id) continue;
    labeled++;
    const v = img.vox[k * nx * ny + j * nx + i];
    let a = acc.get(id);
    if (!a) { a = { n: 0, sum: 0, min: Infinity, max: -Infinity, sq: 0 }; acc.set(id, a); }
    a.n++; a.sum += v;
    if (v < a.min) a.min = v;
    if (v > a.max) a.max = v;
  }
  // SD は 2 パス目で
  for (const a of acc.values()) a.mean = a.sum / a.n;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const wx = Si[0][0] * i + Si[0][1] * j + Si[0][2] * k + Si[0][3];
    const wy = Si[1][0] * i + Si[1][1] * j + Si[1][2] * k + Si[1][3];
    const wz = Si[2][0] * i + Si[2][1] * j + Si[2][2] * k + Si[2][3];
    const dx = wx - Sa[0][3], dy = wy - Sa[1][3], dz = wz - Sa[2][3];
    const ti = Math.floor(Ia[0][0] * dx + Ia[0][1] * dy + Ia[0][2] * dz + 0.5);
    const tj = Math.floor(Ia[1][0] * dx + Ia[1][1] * dy + Ia[1][2] * dz + 0.5);
    const tk = Math.floor(Ia[2][0] * dx + Ia[2][1] * dy + Ia[2][2] * dz + 0.5);
    if (ti < 0 || ti >= tnx || tj < 0 || tj >= tny || tk < 0 || tk >= tnz) continue;
    const id = atl.vox[tk * tnx * tny + tj * tnx + ti];
    if (!id) continue;
    const a = acc.get(id);
    const d = img.vox[k * nx * ny + j * nx + i] - a.mean;
    a.sq += d * d;
  }
  const voxMl = Math.abs(
    Math.hypot(Si[0][0], Si[1][0], Si[2][0]) *
    Math.hypot(Si[0][1], Si[1][1], Si[2][1]) *
    Math.hypot(Si[0][2], Si[1][2], Si[2][2])) / 1000;
  const out = new Map();
  for (const [id, a] of acc) {
    out.set(id, { voxels: a.n, volumeMl: a.n * voxMl, mean: a.mean,
                  sd: a.n > 1 ? Math.sqrt(a.sq / (a.n - 1)) : 0, min: a.min, max: a.max });
  }
  return { stats: out, inside, labeled, total: nx * ny * nz };
};

// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });
  console.log('[voi] app loaded');

  const out = await page.evaluate(async ({ atlas, xml, image }) => {
    const B = '/metavol-web-beta2/src/components/';
    const [T, R, S, V] = await Promise.all([
      import(B + 'voi/voiTemplate.ts'),
      import(B + 'voi/voiResample.ts'),
      import(B + 'voi/voiStats.ts'),
      import(B + 'Volume.ts'),
    ]);
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');
    const fetchBytes = async (p) => new Uint8Array(await (await fetch('/samples/' + p)).arrayBuffer());

    // --- A) テンプレート読込と自己整合 ---
    const xmlBytes = await fetchBytes(xml);
    const parsed = T.parseLabelFile(xmlBytes, xml);
    const atlasBuf = (await fetchBytes(atlas)).buffer;
    const tplVol = T.parseNiftiLabelVolume(atlasBuf, atlas);
    const check = T.checkVoiTemplate(tplVol, parsed.labels);

    // --- 実画像 ---
    const imgBuf = (await fetchBytes(image)).buffer;
    const imgVol = T.parseNiftiLabelVolume(imgBuf, image);   // 画像も同じ loader で読める

    const t0 = performance.now();
    const assign = R.assignVoiLabels(imgVol, tplVol);
    const assignMs = +(performance.now() - t0).toFixed(0);
    const diag = R.diagnoseOverlap(imgVol, tplVol, assign);
    const stats = S.computeVoiStats(imgVol, assign, parsed.labels);
    const nonEmpty = stats.filter(s => s.voxels > 0);
    const warns = R.overlapWarnings(diag, nonEmpty.length, parsed.labels.length);

    // --- B) 合成データ: 別経路 (1 voxel ずつ world 往復) でラベルを引いて値を作る ---
    const synth = new Float32Array(imgVol.voxel.length);
    const w = new THREE.Vector3();
    let ad = 0;
    for (let k = 0; k < imgVol.nz; k++) for (let j = 0; j < imgVol.ny; j++) for (let i = 0; i < imgVol.nx; i++, ad++) {
      const wp = V.voxelToWorld(w.set(i, j, k), imgVol);
      const tv = V.worldToVoxel(wp, tplVol);
      const ti = Math.floor(tv.x + 0.5), tj = Math.floor(tv.y + 0.5), tk = Math.floor(tv.z + 0.5);
      if (ti < 0 || ti >= tplVol.nx || tj < 0 || tj >= tplVol.ny || tk < 0 || tk >= tplVol.nz) continue;
      synth[ad] = tplVol.voxel[tk * tplVol.nx * tplVol.ny + tj * tplVol.nx + ti] * 10;
    }
    const synthVol = { ...imgVol, voxel: synth };
    const synthStats = S.computeVoiStats(synthVol, assign, parsed.labels);
    let synthBad = 0, synthWorst = 0;
    for (const s of synthStats) {
      if (s.voxels === 0) continue;
      const err = Math.abs(s.mean - s.id * 10) + Math.abs(s.sd);
      if (err > 1e-9) synthBad++;
      if (err > synthWorst) synthWorst = err;
    }

    return {
      header: parsed.header,
      nLabels: parsed.labels.length,
      check: { ...check, idsInVolume: check.idsInVolume.length },
      tplDims: [tplVol.nx, tplVol.ny, tplVol.nz],
      imgDims: [imgVol.nx, imgVol.ny, imgVol.nz],
      assignMs, diag: { ...diag, imageBoxMm: diag.imageBoxMm, templateBoxMm: diag.templateBoxMm },
      nonEmptyRegions: nonEmpty.length, totalRegions: parsed.labels.length,
      warns,
      synthBad, synthWorst,
      csvHead: S.voiStatsToCsv(stats.slice(0, 2), { image, atlas: parsed.header.name }).split('\n').slice(0, 5),
      stats: stats.map(s => [s.id, s.name, s.voxels, s.volumeMl, s.mean, s.sd, s.min, s.max]),
    };
  }, { atlas: ATLAS, xml: XML, image: IMAGE });

  const P = ok => ok ? 'PASS' : 'FAIL';
  let all = true;
  console.log(`\n--- A) テンプレート ---`);
  console.log(`  atlas: ${out.header.name} v${out.header.version}  座標系 ${out.header.coordinateSystem}  ライセンス ${out.header.licence}`);
  console.log(`  dims ${out.tplDims.join('x')}   画像 dims ${out.imgDims.join('x')}`);
  const aOk = out.check.missingInTable.length === 0 && out.check.missingInVolume.length === 0 && !out.check.hasNonInteger;
  console.log(`  ${P(aOk)}  XML ${out.nLabels} ラベル / volume ${out.check.idsInVolume} 種、欠番 ` +
              `表側 ${out.check.missingInVolume.length} / 画像側 ${out.check.missingInTable.length}、非整数 ${out.check.hasNonInteger}`);
  console.log(`         ラベル付き ${out.check.labeledVoxels} voxel = ${out.check.labeledVolumeMl.toFixed(0)} ml`);
  if (!aOk) all = false;

  console.log(`\n--- B) 合成データ (値 = ラベル ID x 10) ---`);
  const bOk = out.synthBad === 0;
  console.log(`  ${P(bOk)}  mean が ID x 10、SD が 0 でない領域: ${out.synthBad}  最大誤差 ${out.synthWorst}`);
  console.log(`         = 高速な合成アフィンが voxelToWorld/worldToVoxel の素直な往復と一致`);
  if (!bOk) all = false;

  console.log(`\n--- 実画像の診断 ---`);
  const d = out.diag;
  console.log(`  割り当て ${out.assignMs}ms   テンプレート内に落ちた画像 voxel ${(d.insideFraction * 100).toFixed(1)}%   ` +
              `ラベルが付いた ${(d.labeledFraction * 100).toFixed(1)}%`);
  console.log(`  bbox 重なり ${(d.bboxOverlapFraction * 100).toFixed(1)}%   voxel を得た領域 ${out.nonEmptyRegions}/${out.totalRegions}`);
  console.log(`  警告: ${out.warns.length ? JSON.stringify(out.warns) : 'なし'}`);

  console.log(`\n--- C) Node 側の独立実装との突合 ---`);
  const ref = nodeStats(`sample-data/${IMAGE}`, `sample-data/${ATLAS}`);
  let mism = 0, worstMean = 0, worstSd = 0, worstVox = 0, compared = 0;
  for (const [id, , voxels, , mean, sd] of out.stats) {
    const r = ref.stats.get(id);
    if (!r) { if (voxels > 0) { mism++; } continue; }
    compared++;
    worstVox = Math.max(worstVox, Math.abs(voxels - r.voxels));
    if (voxels > 0) {
      worstMean = Math.max(worstMean, Math.abs(mean - r.mean));
      worstSd = Math.max(worstSd, Math.abs(sd - r.sd));
    }
  }
  const cOk = mism === 0 && worstVox === 0 && worstMean < 1e-5 && worstSd < 1e-5;
  console.log(`  照合した領域 ${compared}   voxel 数の最大差 ${worstVox}   mean の最大差 ${worstMean.toExponential(2)}   sd の最大差 ${worstSd.toExponential(2)}`);
  console.log(`  ${P(cOk)}  独立実装と一致 (アプリ側 inside ${(d.insideFraction * out.stats.length ? '' : '')}${''}` +
              `${''}Node 側 inside ${ref.inside} / labeled ${ref.labeled} / total ${ref.total})`);
  if (!cOk) all = false;

  console.log(`\n--- 実画像の上位 8 領域 (体積順) ---`);
  const top = out.stats.filter(s => s[2] > 0).sort((a, b) => b[3] - a[3]).slice(0, 8);
  console.log('  id   領域名                                       voxel   体積ml   mean     SD      max');
  for (const [id, name, vox, ml, mean, sd, , max] of top) {
    console.log(`  ${String(id).padStart(3)}  ${name.slice(0, 42).padEnd(43)} ${String(vox).padStart(6)} ${ml.toFixed(1).padStart(8)} ` +
                `${mean.toFixed(3).padStart(8)} ${sd.toFixed(3).padStart(7)} ${max.toFixed(2).padStart(8)}`);
  }
  console.log(`\n  CSV 冒頭:\n    ${out.csvHead.join('\n    ')}`);
  console.log(`\n  総合: ${all ? 'PASS' : 'FAIL'}`);
  if (!all) process.exitCode = 1;
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
