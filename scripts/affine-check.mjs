// Volume の world↔voxel 変換の健全性チェック (DICOM ロード不要、数秒で終わる)。
//
// registration の MI は mi.ts の sampleTrilinear → worldToVoxel(w, vol) で標本化する。
// 一方、画面表示は ImageBox が p00/v01/v10 を組んで別経路でサンプルしている。
// ここが食い違っていると「表示は合っているのに MI は無相関」になり、
// auto-register が破綻する。まずこの往復を検算する。
//
// 使い方: node scripts/affine-check.mjs   (dev server 起動済み)

import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const URL = `http://localhost:${parseInt(opt('port','3000'),10)}${opt('base','/metavol-web-beta2')}/`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[browser]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const out = await page.evaluate(async () => {
    const V = await import('/metavol-web-beta2/src/components/Volume.ts');
    const THREE = await import('/metavol-web-beta2/src/lib/threeMath.ts');

    // Hirata の PET TRANSAXIAL 相当の幾何 (軸平行 + z 降順) と、
    // 回転を含む幾何 (NIfTI 等で実在) の 2 通りで検算する。
    const makeVol = (nx, ny, nz, vx, vy, vz, org) => ({
      voxel: new Float32Array(nx*ny*nz), nx, ny, nz,
      imagePosition: new THREE.Vector3(...org),
      vectorX: new THREE.Vector3(...vx),
      vectorY: new THREE.Vector3(...vy),
      vectorZ: new THREE.Vector3(...vz),
      metadata: {},
    });
    const cases = {
      'axis-aligned (PET-like)': makeVol(256,256,413, [2.34,0,0], [0,2.34,0], [0,0,-2.78], [-298.8,-298.8,700]),
      'axis-aligned (CT-like)':  makeVol(512,512,413, [0.98,0,0], [0,0.98,0], [0,0,-2.78], [-250.0,-250.0,700]),
      'rotated':                 makeVol(128,128,64,  [0.9,0.1,0.05], [-0.1,0.88,0.02], [0.03,-0.04,2.9], [10,-20,30]),
    };

    const res = {};
    for (const [name, vol] of Object.entries(cases)) {
      let maxErr = 0, worst = null;
      for (const t of [[0,0,0],[1,2,3],[vol.nx*0.5,vol.ny*0.37,vol.nz*0.81],[vol.nx-1,vol.ny-1,vol.nz-1]]) {
        const vin = new THREE.Vector3(t[0], t[1], t[2]);
        const w = V.voxelToWorld(vin, vol);
        const back = V.worldToVoxel(w, vol);
        const e = Math.hypot(back.x-vin.x, back.y-vin.y, back.z-vin.z);
        if (e > maxErr) { maxErr = e; worst = { voxel:t, world:[+w.x.toFixed(2),+w.y.toFixed(2),+w.z.toFixed(2)],
                                                back:[+back.x.toFixed(4),+back.y.toFixed(4),+back.z.toFixed(4)] }; }
      }
      res[name] = { maxRoundTripErr: +maxErr.toFixed(6), worst };
    }

    // 2 つの volume が同じ world 点をそれぞれの voxel 系で正しく指すか
    // (PET と CT の対応が取れているかの実体的チェック)
    const pet = cases['axis-aligned (PET-like)'], ct = cases['axis-aligned (CT-like)'];
    const wpt = V.voxelToWorld(new THREE.Vector3(128, 128, 200), pet);
    const inCt = V.worldToVoxel(wpt, ct);
    const backPet = V.worldToVoxel(wpt, pet);
    return { res, crossCheck: {
      worldOfPetCenter: [+wpt.x.toFixed(2), +wpt.y.toFixed(2), +wpt.z.toFixed(2)],
      petVoxelBack: [+backPet.x.toFixed(3), +backPet.y.toFixed(3), +backPet.z.toFixed(3)],
      ctVoxel: [+inCt.x.toFixed(3), +inCt.y.toFixed(3), +inCt.z.toFixed(3)],
      ctInBounds: inCt.x >= 0 && inCt.x < ct.nx && inCt.y >= 0 && inCt.y < ct.ny && inCt.z >= 0 && inCt.z < ct.nz,
    } };
  });

  console.log('world↔voxel round-trip:');
  for (const [k, v] of Object.entries(out.res)) {
    const ok = v.maxRoundTripErr < 1e-3 ? 'OK  ' : 'FAIL';
    console.log(`  ${ok} ${k.padEnd(26)} maxErr=${v.maxRoundTripErr}`);
    if (v.maxRoundTripErr >= 1e-3) console.log('       worst:', JSON.stringify(v.worst));
  }
  console.log('\ncross volume check:', JSON.stringify(out.crossCheck, null, 1));
} catch (e) { console.error('failed:', e?.stack ?? e); }
finally { await browser.close(); }
