import { Volume } from "./Volume.ts";
import * as THREE from '@/lib/threeMath';

// NEMA IEC Body Phantom — 6 hot spheres of decreasing diameter inside a warm
// elliptical body cylinder, with a cold central lung insert. The standard PET
// QC phantom for testing recovery coefficients, partial-volume effects, and
// MTV/SUVpeak workflows.
//
// Activity ratios (SUV-like): background = 1, spheres = 8, lung = 0.
// Sphere diameters (mm): 10, 13, 17, 22, 28, 37 (per NEMA NU 2 spec).
// 2 mm voxel pitch → 240 × 180 × 160 mm volume.
export const generatePhantomNema = (): Volume => {
  const [nx, ny, nz] = [120, 90, 80];
  const pitch = 2;  // mm/voxel
  const voxel = new Float32Array(nx * ny * nz);

  const cxMm = (nx * pitch) / 2;
  const cyMm = (ny * pitch) / 2;
  const czMm = (nz * pitch) / 2;
  const bodyRxMm = 110;     // body ellipse semi-axis (lateral)
  const bodyRyMm = 75;      // body ellipse semi-axis (anterior-posterior)
  const lungRMm  = 24;      // central cold cylinder radius
  const sphereRingMm = 57;  // ring radius of sphere centers
  const sphereCzMm   = czMm + 6;  // shift spheres a bit cranial of mid-axial
  const diameters = [37, 28, 22, 17, 13, 10];   // largest first, going clockwise

  const spheres = diameters.map((d, i) => {
    const ang = (i / diameters.length) * Math.PI * 2 - Math.PI / 2;
    return {
      cx: cxMm + sphereRingMm * Math.cos(ang),
      cy: cyMm + sphereRingMm * Math.sin(ang) * 0.7,  // squashed to fit elliptical body
      cz: sphereCzMm,
      r: d / 2,
    };
  });

  const sphereR2 = spheres.map(s => s.r * s.r);

  for (let z = 0; z < nz; z++) {
    const zMm = z * pitch;
    const dz = zMm - czMm;
    // Cap top/bottom to leave a few empty slices (so the box isn't filled to the edges)
    if (Math.abs(dz) > nz * pitch / 2 - 6) continue;
    for (let y = 0; y < ny; y++) {
      const yMm = y * pitch;
      const dy = yMm - cyMm;
      for (let x = 0; x < nx; x++) {
        const xMm = x * pitch;
        const dx = xMm - cxMm;
        // Outside body ellipse → background air (left as 0)
        const ellipseTest = (dx * dx) / (bodyRxMm * bodyRxMm) + (dy * dy) / (bodyRyMm * bodyRyMm);
        if (ellipseTest > 1) continue;
        // Cold lung cylinder (axis = z)
        const r2_axial = dx * dx + dy * dy;
        if (r2_axial < lungRMm * lungRMm) continue;
        let value = 1.0;
        for (let i = 0; i < spheres.length; i++) {
          const s = spheres[i];
          const sdx = xMm - s.cx, sdy = yMm - s.cy, sdz = zMm - s.cz;
          if (sdx * sdx + sdy * sdy + sdz * sdz <= sphereR2[i]) {
            value = 8.0;
            break;
          }
        }
        voxel[z * nx * ny + y * nx + x] = value;
      }
    }
  }

  return {
    voxel,
    nx, ny, nz,
    imagePosition: new THREE.Vector3(0, 0, 0),
    vectorX: new THREE.Vector3(pitch, 0, 0),
    vectorY: new THREE.Vector3(0, pitch, 0),
    vectorZ: new THREE.Vector3(0, 0, pitch),
    metadata: {
      modality: 'PT',
      seriesDescription: 'NEMA IEC Body Phantom (demo)',
      suvOk: true,
      suvFactor: 1,
      suvSource: 'units_already_SUV',
    },
  };
};

// Whole-body PET — anatomically inspired demo with realistic background contrast,
// physiologic uptake (brain, heart, liver, kidneys, bladder), and several scattered
// metastases. Designed for trying the full MTV workflow: threshold → find islands
// → assign labels → SUVpeak / TLG. Less of a QC instrument than NEMA, more of a
// clinical-feeling sandbox.
//
// SUV-like activities (background = 1):
//   brain         8     (cortical FDG uptake)
//   heart muscle  6     (myocardial uptake)
//   liver         2.5   (PERCIST reference reservoir)
//   kidney cortex 4
//   bladder      18     (excreted FDG, very hot)
//   spleen        1.8
//   muscle / soft 1.0
//   lung          0.5
//   bone marrow   1.5
//   air / outside 0
//   metastases  3..15  (varying)
//
// Volume: 100 × 60 × 220 voxels at 4 mm pitch → 400 × 240 × 880 mm (head-to-pelvis).
export const generatePhantomWholeBody = (): Volume => {
  const [nx, ny, nz] = [100, 60, 220];
  const pitch = 4;
  const voxel = new Float32Array(nx * ny * nz);

  const cxMm = (nx * pitch) / 2;
  const cyMm = (ny * pitch) / 2;

  // Anatomy is laid out along Z (slice axis). zMm = 0 at the very top (head),
  // increasing inferiorly to the pelvis. Approximate landmarks (mm from top):
  const zHeadTop = 30, zHeadBot = 200;       // brain volume
  const zNeck    = 230;                       // tapered neck
  const zShoulder = 280;
  const zChestTop = 290, zChestBot = 530;     // thorax
  const zHeart   = 360;                       // myocardium center
  const zLungTop = 320, zLungBot = 510;
  const zLiverTop = 500, zLiverBot = 640;
  const zSpleenTop = 510, zSpleenBot = 600;
  const zKidneyTop = 580, zKidneyBot = 680;
  const zBladderTop = 800, zBladderBot = 850;
  const zSpine0 = 220;                        // spine extends from upper neck to pelvis

  // Body cross-section: changes between head/torso/pelvis. Use semi-axes ax(z), ay(z).
  const bodyAxes = (zMm: number): [number, number] => {
    if (zMm < zHeadBot)        return [80, 60];     // head (smaller ellipse)
    if (zMm < zNeck)           return [60, 50];     // neck taper
    if (zMm < zChestTop)       return [120, 100];   // shoulder span
    if (zMm < zChestBot)       return [160, 110];   // thorax (wider)
    if (zMm < zBladderTop - 60)return [150, 110];   // abdomen
    return [140, 100];                              // pelvis
  };

  // Helper: distance from sphere center, squared
  const inSphere = (x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): boolean => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    return dx * dx + dy * dy + dz * dz <= r * r;
  };
  const inEllipsoid = (x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): boolean => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz) <= 1;
  };

  // Metastases: scattered hot foci of various sizes / SUVs. Coordinates in mm
  // from the (left, anterior, top) corner. Sized 4..15 mm radius for partial-volume
  // fun.
  const metastases: { cx: number; cy: number; cz: number; r: number; suv: number; name: string }[] = [
    { cx: cxMm + 60, cy: cyMm + 0,   cz: 380, r:  6, suv:  9, name: 'lung-RUL' },
    { cx: cxMm - 50, cy: cyMm - 10,  cz: 470, r:  4, suv:  7, name: 'lung-LLL' },
    { cx: cxMm + 25, cy: cyMm - 30,  cz: 560, r: 10, suv: 12, name: 'liver-S5' },
    { cx: cxMm - 40, cy: cyMm + 25,  cz: 600, r:  8, suv:  6, name: 'liver-S2' },
    { cx: cxMm - 70, cy: cyMm + 30,  cz: 750, r:  5, suv:  8, name: 'iliac-bone' },
    { cx: cxMm + 0,  cy: cyMm - 40,  cz: 320, r:  7, suv: 11, name: 'mediastinal-LN' },
    { cx: cxMm + 10, cy: cyMm + 35,  cz: 720, r: 12, suv: 15, name: 'sacral-bone' },
    { cx: cxMm - 95, cy: cyMm - 5,   cz: 290, r:  4, suv:  5, name: 'axillary-LN' },
  ];

  for (let z = 0; z < nz; z++) {
    const zMm = z * pitch;
    const [ax, ay] = bodyAxes(zMm);
    for (let y = 0; y < ny; y++) {
      const yMm = y * pitch;
      const dy = yMm - cyMm;
      for (let x = 0; x < nx; x++) {
        const xMm = x * pitch;
        const dx = xMm - cxMm;
        // Outside body envelope → air (left as 0)
        if ((dx * dx) / (ax * ax) + (dy * dy) / (ay * ay) > 1) continue;

        let value = 1.0;  // soft tissue / muscle background

        // Brain
        if (inEllipsoid(xMm, yMm, zMm, cxMm, cyMm, (zHeadTop + zHeadBot) / 2, 75, 55, (zHeadBot - zHeadTop) / 2)) {
          value = 8.0;
        }
        // Heart (myocardium): a thick-walled ellipsoid ~ ant-left-superior of mid-thorax
        else if (inEllipsoid(xMm, yMm, zMm, cxMm - 25, cyMm - 15, zHeart, 35, 30, 35)) {
          value = 6.0;
        }
        // Lungs (cold) — two ellipsoids overriding background
        else if (inEllipsoid(xMm, yMm, zMm, cxMm - 50, cyMm + 0, (zLungTop + zLungBot) / 2, 55, 70, (zLungBot - zLungTop) / 2)) {
          value = 0.5;
        }
        else if (inEllipsoid(xMm, yMm, zMm, cxMm + 50, cyMm + 0, (zLungTop + zLungBot) / 2, 55, 70, (zLungBot - zLungTop) / 2)) {
          value = 0.5;
        }
        // Liver — large right-sided
        else if (inEllipsoid(xMm, yMm, zMm, cxMm + 35, cyMm + 5, (zLiverTop + zLiverBot) / 2, 90, 70, (zLiverBot - zLiverTop) / 2)) {
          value = 2.5;
        }
        // Spleen — left-sided, smaller
        else if (inEllipsoid(xMm, yMm, zMm, cxMm - 75, cyMm + 10, (zSpleenTop + zSpleenBot) / 2, 35, 30, (zSpleenBot - zSpleenTop) / 2)) {
          value = 1.8;
        }
        // Kidneys
        else if (inEllipsoid(xMm, yMm, zMm, cxMm - 50, cyMm + 35, (zKidneyTop + zKidneyBot) / 2, 25, 20, (zKidneyBot - zKidneyTop) / 2)) {
          value = 4.0;
        }
        else if (inEllipsoid(xMm, yMm, zMm, cxMm + 50, cyMm + 35, (zKidneyTop + zKidneyBot) / 2, 25, 20, (zKidneyBot - zKidneyTop) / 2)) {
          value = 4.0;
        }
        // Bladder
        else if (inEllipsoid(xMm, yMm, zMm, cxMm, cyMm + 15, (zBladderTop + zBladderBot) / 2, 35, 30, (zBladderBot - zBladderTop) / 2)) {
          value = 18.0;
        }
        // Spine — vertebral marrow, narrow cylinder along z
        else if (zMm > zSpine0 && (dx * dx + (dy - 35) * (dy - 35)) <= 14 * 14) {
          value = 1.5;
        }

        // Metastases override organs
        for (const m of metastases) {
          if (inSphere(xMm, yMm, zMm, m.cx, m.cy, m.cz, m.r)) {
            value = m.suv;
            break;
          }
        }

        voxel[z * nx * ny + y * nx + x] = value;
      }
    }
  }

  return {
    voxel,
    nx, ny, nz,
    imagePosition: new THREE.Vector3(0, 0, 0),
    vectorX: new THREE.Vector3(pitch, 0, 0),
    vectorY: new THREE.Vector3(0, pitch, 0),
    vectorZ: new THREE.Vector3(0, 0, pitch),
    metadata: {
      modality: 'PT',
      seriesDescription: 'Whole-body PET (synthetic, with metastases)',
      suvOk: true,
      suvFactor: 1,
      suvSource: 'units_already_SUV',
    },
  };
};

// ===========================================================================
// Whole-body PET/CT digital phantom — paired CT + PET built from geometric
// primitives (ellipsoids / cylinders / spheres), with a geometry deliberately
// matched to the sample-data `cervicalca` case so it behaves like a real
// whole-body FDG PET/CT (head→thigh) in the viewer. CT and PET are sampled on
// their own grids but from the SAME world-space anatomy, so Fusion aligns.
//
// Grids (mirroring cervicalca):
//   CT : 512×512×345 @ 0.98×0.98×5.0 mm, origin (-249.5,-420.5,-23.5), z↓
//   PET: 168×168×849 @ 4.07×4.07×2.03 mm, origin (-338.1,-513.1,-24.4), z↓
// The head vertex is at world z ≈ -23.5 (slice 0); z decreases toward the feet.
//
// Tissue labels → (CT HU, PET SUV). Distributions are geometric shapes only.
type Tissue =
  | 'air' | 'soft' | 'fat' | 'lung' | 'bone' | 'marrow'
  | 'brain' | 'heart' | 'liver' | 'spleen' | 'kidney' | 'bladder'
  | 'tumor' | 'node';

const TISSUE_HU: Record<Tissue, number> = {
  air: -1000, soft: 40, fat: -95, lung: -780, bone: 700, marrow: 180,
  brain: 35, heart: 45, liver: 55, spleen: 48, kidney: 32, bladder: 8,
  tumor: 42, node: 38,
};
const TISSUE_SUV: Record<Tissue, number> = {
  air: 0, soft: 0.9, fat: 0.4, lung: 0.45, bone: 0.6, marrow: 1.6,
  brain: 8, heart: 3.5, liver: 2.2, spleen: 1.9, kidney: 4.5, bladder: 22,
  tumor: 14, node: 8,
};

// Anatomy is a pure function of world (mm). Head vertex at HEAD_TOP_Z; the body
// is centred at (BCX,BCY) in-plane. All landmarks are given as "distance below
// the head vertex" (dHead, mm) and converted to world z on the fly.
const HEAD_TOP_Z = -23.5;
const BCX = 0.9;
const BCY = -170;
const cz = (dHead: number): number => HEAD_TOP_Z - dHead;   // world z at a landmark

const ellip = (dx: number, dy: number, dz: number, rx: number, ry: number, rz: number): number =>
  (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);

// Return the tissue at a world point. Precedence: lesions > bone > organs > fat > soft.
const tissueAtWorld = (wx: number, wy: number, wz: number): Tissue => {
  const dHead = HEAD_TOP_Z - wz;                 // 0 at vertex, +ve toward feet
  if (dHead < 0 || dHead > 1720) return 'air';
  const x = wx - BCX;
  const y = wy - BCY;

  // ---- Body envelope (varies head→pelvis; legs are two thigh cylinders) ----
  let inBody = false;
  let ax = 0, ay = 0;
  let inLeg = false;
  if (dHead < 210)      { ax = 78;  ay = 98; }   // head
  else if (dHead < 275) { ax = 62;  ay = 72; }   // neck
  else if (dHead < 300) { ax = 132; ay = 102; }  // shoulders
  else if (dHead < 520) { ax = 156; ay = 112; }  // thorax
  else if (dHead < 760) { ax = 146; ay = 110; }  // abdomen
  else if (dHead < 955) { ax = 150; ay = 112; }  // pelvis
  else {
    // Legs: two thighs tapering toward the knees
    const legR = 60 - (dHead - 955) * 0.02;
    const dl = (x + 62) * (x + 62) + y * y;
    const dr = (x - 62) * (x - 62) + y * y;
    if (dl <= legR * legR || dr <= legR * legR) inLeg = true;
    else return 'air';
    // Femur shaft: a bone cylinder inside each thigh, marrow core
    const fdl = (x + 62) * (x + 62) + y * y;
    const fdr = (x - 62) * (x - 62) + y * y;
    const fem = Math.min(fdl, fdr);
    if (fem <= 9 * 9) return 'marrow';
    if (fem <= 16 * 16) return 'bone';
    // subcutaneous fat rim on the thigh
    const rimR = legR - 8;
    if (dl > rimR * rimR && dr > rimR * rimR) return 'fat';
    return 'soft';
  }

  if (!inLeg) {
    const e = (x * x) / (ax * ax) + (y * y) / (ay * ay);
    if (e > 1) return 'air';
    inBody = true;
  }
  if (!inBody) return 'air';

  // ---- Lesions (highest precedence) ----
  // Cervical-cancer primary: hot midline mass low in the pelvis.
  // 膀胱 (cz(820)±42) より十分下 (cz(910)) に置き、SUV 閾値マスクで独立した
  // 連結成分になるようにする (デモの assign で腫瘍だけを Tumor に振り分けられる)。
  if (ellip(x, y - 28, wz - cz(910), 24, 22, 24) <= 1) return 'tumor';
  // Nodal metastases (spheres): para-aortic + left external-iliac.
  if (ellip(x - 4, y + 40, wz - cz(650), 10, 10, 10) <= 1) return 'node';
  if (ellip(x + 46, y + 38, wz - cz(806), 9, 9, 9) <= 1) return 'node';

  // ---- Bone (overrides organs where it passes through) ----
  // Spine: posterior cylinder (cortical shell + marrow core), neck→sacrum.
  if (dHead > 235 && dHead < 905) {
    const sr = (x) * (x) + (y - 58) * (y - 58);
    if (sr <= 9 * 9) return 'marrow';
    if (sr <= 15 * 15) return 'bone';
  }
  // Iliac bones: two blocks in the pelvis.
  if (ellip(x - 92, y + 30, wz - cz(838), 34, 46, 55) <= 1) return 'bone';
  if (ellip(x + 92, y + 30, wz - cz(838), 34, 46, 55) <= 1) return 'bone';

  // ---- Organs (first match wins) ----
  if (ellip(x, y, wz - cz(120), 60, 74, 82) <= 1) return 'brain';
  if (ellip(x - 30, y - 12, wz - cz(372), 46, 40, 58) <= 1) return 'heart';
  // Lungs (two cold ellipsoids); heart already claimed the central region.
  if (ellip(x - 66, y - 6, wz - cz(400), 58, 82, 130) <= 1) return 'lung';
  if (ellip(x + 66, y - 6, wz - cz(400), 58, 82, 130) <= 1) return 'lung';
  if (ellip(x + 56, y + 4, wz - cz(580), 96, 74, 82) <= 1) return 'liver';
  if (ellip(x - 82, y + 8, wz - cz(560), 40, 34, 56) <= 1) return 'spleen';
  if (ellip(x - 62, y + 44, wz - cz(632), 28, 22, 46) <= 1) return 'kidney';
  if (ellip(x + 62, y + 44, wz - cz(632), 28, 22, 46) <= 1) return 'kidney';
  if (ellip(x, y + 24, wz - cz(820), 40, 34, 42) <= 1) return 'bladder';

  // ---- Fat rim then soft-tissue default ----
  const e = (x * x) / (ax * ax) + (y * y) / (ay * ay);
  if (e > 0.86) return 'fat';
  return 'soft';
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// 腫瘍の primary の world 中心 (デモの assign 用に export)。
export const PHANTOM_PETCT_TUMOR_WORLD: [number, number, number] = [BCX, BCY + 28, cz(910)];

// CT の値 (HU): tissue ごとに一様。
const ctHuAtWorld = (wx: number, wy: number, wz: number): number =>
  TISSUE_HU[tissueAtWorld(wx, wy, wz)];

// PET の値 (SUV): tissue の base に「病変内グラデーション」と「臓器/背景の弱いテクスチャ」を
// 掛けて、実画像のように不均一にする (均一なフラット SUV を避ける)。
const petSuvAtWorld = (wx: number, wy: number, wz: number): number => {
  const t = tissueAtWorld(wx, wy, wz);
  const base = TISSUE_SUV[t];
  if (base === 0) return 0;
  const x = wx - BCX, y = wy - BCY;
  if (t === 'tumor') {
    // 中心ほど高集積 → 辺縁は低下 (0=中心 .. 1=辺縁の ellip 値を使う)。内部リップルで不均一に。
    const e = ellip(x, y - 28, wz - cz(910), 24, 22, 24);
    const core = clamp01(1 - e);
    const ripple = 1 + 0.10 * Math.sin(wx * 0.55) * Math.sin(wz * 0.42);
    return Math.max(0, base * (0.42 + 0.58 * core) * ripple);
  }
  if (t === 'node') {
    const e = Math.min(
      ellip(x - 4, y + 40, wz - cz(650), 10, 10, 10),
      ellip(x + 46, y + 38, wz - cz(806), 9, 9, 9),
    );
    return Math.max(0, base * (0.5 + 0.5 * clamp01(1 - e)));
  }
  // 臓器 / 背景: 低周波の空間テクスチャ (±~8%) を掛けてフラットさを崩す。
  const tex = 1
    + 0.06 * Math.sin(wx * 0.09) * Math.cos(wy * 0.08)
    + 0.04 * Math.sin(wz * 0.06);
  return Math.max(0, base * tex);
};

// Fill an axis-aligned grid by sampling a per-voxel value function.
const fillGrid = (
  nx: number, ny: number, nz: number,
  ox: number, oy: number, oz: number,
  px: number, py: number, pz: number,   // pz already signed (z decreases downward)
  valueAt: (wx: number, wy: number, wz: number) => number,
): Float32Array => {
  const voxel = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const wz = oz + z * pz;
    const zBase = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const wy = oy + y * py;
      const rowBase = zBase + y * nx;
      for (let x = 0; x < nx; x++) {
        const wx = ox + x * px;
        voxel[rowBase + x] = valueAt(wx, wy, wz);
      }
    }
  }
  return voxel;
};

export interface PetCtPhantom {
  ct: Volume;
  pet: Volume;
}

export const generatePhantomWholeBodyPetCt = (): PetCtPhantom => {
  // CT grid (mirrors cervicalca Fusion CT)
  const ctNx = 512, ctNy = 512, ctNz = 345;
  const ctPx = 0.98, ctPy = 0.98, ctPz = -5.0;
  const ctOx = -249.5, ctOy = -420.5, ctOz = -23.5;
  const t0 = performance.now();
  const ctVoxel = fillGrid(ctNx, ctNy, ctNz, ctOx, ctOy, ctOz, ctPx, ctPy, ctPz, ctHuAtWorld);

  // PET grid (mirrors cervicalca PET WB)
  const ptNx = 168, ptNy = 168, ptNz = 849;
  const ptPx = 4.07, ptPy = 4.07, ptPz = -2.03;
  const ptOx = -338.1, ptOy = -513.1, ptOz = -24.4;
  const petVoxel = fillGrid(ptNx, ptNy, ptNz, ptOx, ptOy, ptOz, ptPx, ptPy, ptPz, petSuvAtWorld);
  console.log(`[phantom] WB PET/CT generated in ${(performance.now() - t0).toFixed(0)}ms`);

  const ct: Volume = {
    voxel: ctVoxel,
    nx: ctNx, ny: ctNy, nz: ctNz,
    imagePosition: new THREE.Vector3(ctOx, ctOy, ctOz),
    vectorX: new THREE.Vector3(ctPx, 0, 0),
    vectorY: new THREE.Vector3(0, ctPy, 0),
    vectorZ: new THREE.Vector3(0, 0, ctPz),
    metadata: {
      modality: 'CT',
      seriesDescription: 'Whole-body CT (synthetic phantom)',
    },
  };

  const pet: Volume = {
    voxel: petVoxel,
    nx: ptNx, ny: ptNy, nz: ptNz,
    imagePosition: new THREE.Vector3(ptOx, ptOy, ptOz),
    vectorX: new THREE.Vector3(ptPx, 0, 0),
    vectorY: new THREE.Vector3(0, ptPy, 0),
    vectorZ: new THREE.Vector3(0, 0, ptPz),
    metadata: {
      modality: 'PT',
      seriesDescription: 'Whole-body PET (synthetic phantom)',
      suvOk: true,
      suvFactor: 1,
      suvSource: 'units_already_SUV',
    },
  };

  return { ct, pet };
};
