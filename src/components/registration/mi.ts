// Mutual Information for image registration.
// Joint histogram method (32 bins). Sample point set is fixed across iterations
// for reproducibility (avoid noisy optimization landscape).

import * as THREE from 'three';
import type { Volume } from '../Volume';
import { worldToVoxel } from '../Volume';
import { makeRigidMatrix, type RigidParams } from './transform';

export interface MIStats {
    fixedMin: number; fixedMax: number;
    movingMin: number; movingMax: number;
}

const DEFAULT_BINS = 32;

// Fixed の world 空間にランダム N 点をサンプリング。再現性のため seedable PRNG を使用。
// PT bounding box から 5%-95% の中央領域を採るので、empty area を避けやすい。
export const generateFixedSamples = (
    fixed: Volume,
    nSamples: number,
    seed = 12345,
): Float32Array => {
    let s = seed;
    const rng = () => {
        // Mulberry32
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = new Float32Array(nSamples * 3);
    for (let i = 0; i < nSamples; i++) {
        const u = 0.05 + rng() * 0.9;
        const v = 0.05 + rng() * 0.9;
        const w = 0.05 + rng() * 0.9;
        // voxel coord → world
        const vx = u * fixed.nx;
        const vy = v * fixed.ny;
        const vz = w * fixed.nz;
        const wp = new THREE.Vector3(vx, vy, vz);
        // world = imagePosition + vx*vectorX + vy*vectorY + vz*vectorZ
        const wx = fixed.imagePosition.x + vx*fixed.vectorX.x + vy*fixed.vectorY.x + vz*fixed.vectorZ.x;
        const wy = fixed.imagePosition.y + vx*fixed.vectorX.y + vy*fixed.vectorY.y + vz*fixed.vectorZ.y;
        const wz = fixed.imagePosition.z + vx*fixed.vectorX.z + vy*fixed.vectorY.z + vz*fixed.vectorZ.z;
        out[i*3]   = wx;
        out[i*3+1] = wy;
        out[i*3+2] = wz;
        void wp;
    }
    return out;
};

// 1D trilinear sample
const sampleTrilinear = (vol: Volume, w: THREE.Vector3): number | null => {
    const v = worldToVoxel(w, vol);
    const vx = v.x, vy = v.y, vz = v.z;
    const nx = vol.nx, ny = vol.ny, nz = vol.nz;
    if (vx < 0 || vy < 0 || vz < 0 || vx >= nx || vy >= ny || vz >= nz) return null;
    const x0 = Math.floor(vx); const x1 = x0 + 1 < nx ? x0 + 1 : x0; const fx = vx - x0;
    const y0 = Math.floor(vy); const y1 = y0 + 1 < ny ? y0 + 1 : y0; const fy = vy - y0;
    const z0 = Math.floor(vz); const z1 = z0 + 1 < nz ? z0 + 1 : z0; const fz = vz - z0;
    const pix = vol.voxel;
    const nxny = nx * ny;
    const c000 = pix[z0*nxny + y0*nx + x0], c100 = pix[z0*nxny + y0*nx + x1];
    const c010 = pix[z0*nxny + y1*nx + x0], c110 = pix[z0*nxny + y1*nx + x1];
    const c001 = pix[z1*nxny + y0*nx + x0], c101 = pix[z1*nxny + y0*nx + x1];
    const c011 = pix[z1*nxny + y1*nx + x0], c111 = pix[z1*nxny + y1*nx + x1];
    const c00 = c000 + (c100 - c000) * fx;
    const c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx;
    const c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
};

// fixed と moving 両方の intensity range を推定 (5%-95% percentile)。
// 最初に 1 度計算して使い回す。
export const estimateIntensityRange = (
    fixed: Volume,
    moving: Volume,
    samples: Float32Array,
): MIStats => {
    const fVals: number[] = [];
    const mVals: number[] = [];
    const tmp = new THREE.Vector3();
    const nSamples = samples.length / 3;
    for (let i = 0; i < nSamples; i++) {
        tmp.set(samples[i*3], samples[i*3+1], samples[i*3+2]);
        const fv = sampleTrilinear(fixed, tmp);
        if (fv != null) fVals.push(fv);
        const mv = sampleTrilinear(moving, tmp);
        if (mv != null) mVals.push(mv);
    }
    fVals.sort((a, b) => a - b);
    mVals.sort((a, b) => a - b);
    const pct = (arr: number[], q: number) => arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))];
    return {
        fixedMin: pct(fVals, 0.05),
        fixedMax: pct(fVals, 0.95),
        movingMin: pct(mVals, 0.05),
        movingMax: pct(mVals, 0.95),
    };
};

// Compute negative MI (we minimize this in optimizer; equivalent to maximizing MI).
// rigid 6 params で moving の coords を「pt-aligned」に変換 (T)。
// MR voxel sample location for fixed point p = T⁻¹ · p (もし T が moving → fixed の transform なら)。
export const computeNegativeMI = (
    fixed: Volume,
    moving: Volume,
    samples: Float32Array,
    stats: MIStats,
    params: RigidParams,
    bins: number = DEFAULT_BINS,
): number => {
    const T = makeRigidMatrix(params);
    const Tinv = T.clone().invert();
    const fLo = stats.fixedMin, fRange = stats.fixedMax - stats.fixedMin || 1;
    const mLo = stats.movingMin, mRange = stats.movingMax - stats.movingMin || 1;

    const histF = new Float32Array(bins);
    const histM = new Float32Array(bins);
    const histJ = new Float32Array(bins * bins);
    let n = 0;
    const wp = new THREE.Vector3();
    const wpMov = new THREE.Vector3();
    const nSamples = samples.length / 3;
    for (let i = 0; i < nSamples; i++) {
        wp.set(samples[i*3], samples[i*3+1], samples[i*3+2]);
        const fv = sampleTrilinear(fixed, wp);
        if (fv == null) continue;
        wpMov.copy(wp).applyMatrix4(Tinv);
        const mv = sampleTrilinear(moving, wpMov);
        if (mv == null) continue;
        let fb = Math.floor((fv - fLo) / fRange * bins);
        let mb = Math.floor((mv - mLo) / mRange * bins);
        if (fb < 0) fb = 0; else if (fb >= bins) fb = bins - 1;
        if (mb < 0) mb = 0; else if (mb >= bins) mb = bins - 1;
        histF[fb]++;
        histM[mb]++;
        histJ[fb * bins + mb]++;
        n++;
    }
    if (n < 100) return 0;  // too few overlap, return neutral
    const inv = 1 / n;
    let mi = 0;
    for (let f = 0; f < bins; f++) {
        const pf = histF[f] * inv;
        if (pf <= 0) continue;
        const fbase = f * bins;
        for (let m = 0; m < bins; m++) {
            const pj = histJ[fbase + m] * inv;
            if (pj <= 0) continue;
            const pm = histM[m] * inv;
            mi += pj * Math.log(pj / (pf * pm));
        }
    }
    // Negative because optimizer minimizes
    return -mi;
};
