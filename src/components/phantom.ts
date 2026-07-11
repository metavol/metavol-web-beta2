import { Volume } from "./Volume.ts";
import * as THREE from 'three';

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
