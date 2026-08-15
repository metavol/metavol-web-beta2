// CT 体マスクの **crop box (オプション B)** を実測で検証する。
//
// オプション A (下から N mm カット) は「world -Z 面から削る」特殊形。
// B はそれを 6 面に一般化したもの。台座が下でない場合 (kitty の背板など) に要る。
//
// 確認項目:
//   1. crop 無しの体マスクの voxel 数と world bbox
//   2. 各面に 20mm を単独で入れると、その面の bbox が **20mm ぶん縮む**
//      他の面は **内側にしか動かない** (削った層に他軸の最外郭 voxel が含まれていれば縮む。
//      外側へ動いたら異常)
//   3. voxel が実際に減る
//   4. `setCtBedCutBottomMm` と `ctCropMarginsMm.zMin` が同期する
//   5. `clearCtCropMargins` で元に戻る
//
// 使い方: node scripts/ct-crop-check.mjs [--case kitty]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const CASE = opt('case', 'kitty');
const URL = `http://localhost:${parseInt(opt('port', '3000'), 10)}${opt('base', '/metavol-web-beta2')}/?dev=${CASE}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[ct-crop] loading ${CASE}…`);
  await page.waitForFunction(
    () => (document.querySelector('#app')?.__vue_app__?._instance?.setupState?.seriesSummariesView?.length ?? 0) >= 1,
    null, { timeout: 600000 });
  await page.waitForTimeout(8000);

  const out = await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const ss = app._instance.setupState;
    const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
    const store = d.segStore ?? d.store;

    // CT を用意
    let idx = -1;
    for (let i = 0; i < d.seriesList.length; i++) { if (d.seriesList[i].volume) { idx = i; break; } }
    if (idx < 0) { d.ensureVolume_(0); await new Promise(r => setTimeout(r, 6000)); idx = 0; }
    const ct = d.seriesList[idx].volume;
    if (!ct) return { error: 'no volume' };
    store.setCtVolume(ct);

    // マスクの world bbox と voxel 数を測る
    const stat = () => {
      const m = store.ctBodyMask;
      if (!m) return null;
      const { nx, ny, nz } = ct, p0 = ct.imagePosition, vx = ct.vectorX, vy = ct.vectorY, vz = ct.vectorZ;
      let n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < nz; k++) {
        const x0 = p0.x + vz.x * k, y0 = p0.y + vz.y * k, z0 = p0.z + vz.z * k;
        for (let j = 0; j < ny; j++) {
          const base = k * nx * ny + j * nx;
          let x = x0 + vy.x * j, y = y0 + vy.y * j, z = z0 + vy.z * j;
          for (let i = 0; i < nx; i++, x += vx.x, y += vx.y, z += vx.z) {
            if (m[base + i] === 0) continue;
            n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
        }
      }
      const r = v => +v.toFixed(2);
      return { n, box: [r(minX), r(maxX), r(minY), r(maxY), r(minZ), r(maxZ)] };
    };

    store.clearCtCropMargins();
    if (!store.computeCtBodyMask()) return { error: 'computeCtBodyMask failed' };
    const base = stat();
    if (!base || base.n === 0) return { error: 'empty body mask' };

    // 各面に 20mm を単独で入れる
    const MM = 20;
    const faces = ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'];
    // bbox 配列の index と、その面を削ったとき動くべき向き (+1 = 増える, -1 = 減る)
    const faceInfo = { xMin: [0, +1], xMax: [1, -1], yMin: [2, +1], yMax: [3, -1], zMin: [4, +1], zMax: [5, -1] };
    const rows = [];
    for (const f of faces) {
      store.clearCtCropMargins();
      store.setCtCropMargin(f, MM);
      store.computeCtBodyMask();
      const st = stat();
      const [bi, dir] = faceInfo[f];
      const moved = st.box[bi] - base.box[bi];
      // **他の面は「動かない」ではなく「内側にしか動かない」が正しい不変条件。**
      // ある面を削ると、削った層に他軸の最外郭 voxel が含まれていれば bbox は他軸でも縮む
      // (実測 kitty: yMax を 20mm 削ると別軸が 2.93mm 内側へ動いた。これは正常)。
      // min 面は増える方向、max 面は減る方向が「内側」。
      const inwardSign = [+1, -1, +1, -1, +1, -1];
      const outward = st.box.map((v, i) => {
        if (i === bi) return 0;
        const delta = (v - base.box[i]) * inwardSign[i];   // 正 = 内側
        return delta < 0 ? +(-delta).toFixed(2) : 0;       // 外側へ動いた量だけを拾う
      });
      rows.push({ face: f, n: st.n, removed: base.n - st.n, moved: +moved.toFixed(2), expected: dir * MM,
                  othersMoved: outward });
    }

    // zMin と ctBedCutBottomMm の同期
    store.clearCtCropMargins();
    store.setCtBedCutBottomMm(33);
    const syncA = { bed: store.ctBedCutBottomMm, zMin: store.ctCropMarginsMm.zMin };
    store.setCtCropMargin('zMin', 7);
    const syncB = { bed: store.ctBedCutBottomMm, zMin: store.ctCropMarginsMm.zMin };

    // clear で戻るか
    store.clearCtCropMargins();
    store.computeCtBodyMask();
    const cleared = stat();

    return { dims: [ct.nx, ct.ny, ct.nz], base, rows, syncA, syncB, cleared, MM };
  });

  if (out.error) { console.error('  ERROR:', out.error); process.exitCode = 1; }
  else {
    const P = ok => ok ? 'PASS' : 'FAIL';
    console.log(`\n  CT ${out.dims.join('x')}`);
    console.log(`  crop 無し: ${out.base.n} voxels  bbox x[${out.base.box[0]}, ${out.base.box[1]}] ` +
                `y[${out.base.box[2]}, ${out.base.box[3]}] z[${out.base.box[4]}, ${out.base.box[5]}]`);
    console.log(`\n  各面に ${out.MM}mm を単独で適用`);
    console.log('  面     削れた voxel   その面の移動   期待   他面の外側移動  判定');
    console.log('  ' + '-'.repeat(66));
    let allFaces = true;
    for (const r of out.rows) {
      // voxel 格子 (kitty は ~0.6mm 等方) を考えると 1 voxel 未満のずれは許容
      const tol = 2.0;
      const okMove = Math.abs(r.moved - r.expected) <= tol;
      // 他面が **外側** へ動いていたら異常 (削って広がることはあり得ない)
      const maxOther = Math.max(...r.othersMoved.map(Math.abs));
      const okOthers = maxOther <= tol;
      const okRemoved = r.removed > 0;
      const ok = okMove && okOthers && okRemoved;
      if (!ok) allFaces = false;
      console.log(`  ${r.face.padEnd(6)} ${String(r.removed).padStart(11)} ${String(r.moved).padStart(13)} ` +
                  `${String(r.expected).padStart(7)} ${String(maxOther).padStart(14)}  ${P(ok)}`);
    }
    const syncOk = out.syncA.bed === 33 && out.syncA.zMin === 33 && out.syncB.bed === 7 && out.syncB.zMin === 7;
    const clearedOk = out.cleared.n === out.base.n;
    console.log(`\n  ${P(syncOk)}  下面カットと zMin の同期  setBed(33)->${JSON.stringify(out.syncA)}  setMargin(7)->${JSON.stringify(out.syncB)}`);
    console.log(`  ${P(clearedOk)}  clear で元に戻る          ${out.cleared.n} vs ${out.base.n}`);
    const all = allFaces && syncOk && clearedOk;
    console.log(`\n  総合: ${all ? 'PASS' : 'FAIL'}`);
    if (!all) process.exitCode = 1;
  }
} catch (e) { console.error('failed:', e?.stack ?? e); process.exitCode = 1; }
finally { await browser.close(); }
