// Mutual Information for image registration.
// Joint histogram method (32 bins). Sample point set is fixed across iterations
// for reproducibility (avoid noisy optimization landscape).

import * as THREE from '@/lib/threeMath';
import type { Volume } from '../Volume';
import { worldToVoxel } from '../Volume';
import { makeRigidMatrix, type RigidParams } from './transform';

export interface MIStats {
    fixedMin: number; fixedMax: number;
    movingMin: number; movingMax: number;
}

const DEFAULT_BINS = 32;

// 「体内」とみなす下限値を volume 自身の分布から決める。
// CT なら空気 (-1000 付近) が体積の大半を占めるので、単純な分位点では空気を拾ってしまう。
// max 側に寄せた分位点を使い、そこから一定割合下を閾値にする。
const bodyThresholdOf = (vol: Volume): number => {
    const stride = Math.max(1, Math.floor(vol.voxel.length / 40000));
    const vals: number[] = [];
    for (let i = 0; i < vol.voxel.length; i += stride) vals.push(vol.voxel[i]);
    vals.sort((a, b) => a - b);
    const p = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * q)))];
    const lo = p(0.02), hi = p(0.98);
    // lo(≒空気/背景) と hi(≒軟部〜骨/高集積) の間の低め (15%) に線を引く。
    return lo + (hi - lo) * 0.15;
};

// Fixed の world 空間にランダム N 点をサンプリング。再現性のため seedable PRNG を使用。
//
// **背景 (体外の空気) を採らないこと。** 全身 CT では bounding box の大半が体外の空気で、
// そのまま一様サンプルすると同時ヒストグラムが「空気×空気」で占められ、MI が
// 「解剖が合っているか」ではなく「FOV がどれだけ重なっているか」を測る指標に化ける。
// これが全身 PET/CT で auto-register が外れる主因だった。
// fixed の値が体内閾値を超える点だけ採用する (rejection sampling)。
export const generateFixedSamples = (
    fixed: Volume,
    nSamples: number,
    seed = 12345,
    opts?: { bodyOnly?: boolean },
): Float32Array => {
    let s = seed;
    const rng = () => {
        // Mulberry32
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const bodyOnly = opts?.bodyOnly !== false;      // 既定 ON
    const thr = bodyOnly ? bodyThresholdOf(fixed) : -Infinity;
    const nxny = fixed.nx * fixed.ny;
    const out = new Float32Array(nSamples * 3);
    let got = 0;
    // 体内点が見つからない病的ケースで無限ループしないよう試行回数に上限を置く
    const maxTries = nSamples * 60;
    for (let tries = 0; got < nSamples && tries < maxTries; tries++) {
        const u = 0.05 + rng() * 0.9;
        const v = 0.05 + rng() * 0.9;
        const w = 0.05 + rng() * 0.9;
        const vx = u * fixed.nx;
        const vy = v * fixed.ny;
        const vz = w * fixed.nz;
        if (bodyOnly) {
            const i0 = Math.floor(vx), j0 = Math.floor(vy), k0 = Math.floor(vz);
            const val = fixed.voxel[k0 * nxny + j0 * fixed.nx + i0];
            if (!(val > thr)) continue;
        }
        // world = imagePosition + vx*vectorX + vy*vectorY + vz*vectorZ
        out[got*3]   = fixed.imagePosition.x + vx*fixed.vectorX.x + vy*fixed.vectorY.x + vz*fixed.vectorZ.x;
        out[got*3+1] = fixed.imagePosition.y + vx*fixed.vectorX.y + vy*fixed.vectorY.y + vz*fixed.vectorZ.y;
        out[got*3+2] = fixed.imagePosition.z + vx*fixed.vectorX.z + vy*fixed.vectorY.z + vz*fixed.vectorZ.z;
        got++;
    }
    // 体内点が全く採れなかった場合は従来どおり一様サンプルにフォールバック
    if (got === 0 && bodyOnly) return generateFixedSamples(fixed, nSamples, seed, { bodyOnly: false });
    return got === nSamples ? out : out.slice(0, got * 3);
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
// opts.normalized = true で **NMI** (normalized mutual information) を使う。
//
// 素の MI は重なった sample 数 n に依存して増減する。位置がずれて overlap が減ると
// MI も下がるので、一見それらしく見えるが、逆に「overlap さえ増えれば解剖が合っていなくても
// スコアが良くなる」方向のバイアスがあり、全身 PET/CT のように広く均質な領域が多いデータでは
// 解剖の一致より FOV の重なりを優先してしまう。
//   NMI = (H(F) + H(M)) / H(F,M)
// は overlap の大きさに対して安定で、この種の multi-modality registration の標準的な選択。
export const computeNegativeMI = (
    fixed: Volume,
    moving: Volume,
    samples: Float32Array,
    stats: MIStats,
    params: RigidParams,
    bins: number = DEFAULT_BINS,
    opts?: { normalized?: boolean },
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
    let hF = 0, hM = 0, hJ = 0, mi = 0;
    for (let f = 0; f < bins; f++) {
        const pf = histF[f] * inv;
        if (pf > 0) hF -= pf * Math.log(pf);
    }
    for (let m = 0; m < bins; m++) {
        const pm = histM[m] * inv;
        if (pm > 0) hM -= pm * Math.log(pm);
    }
    for (let f = 0; f < bins; f++) {
        const pf = histF[f] * inv;
        if (pf <= 0) continue;
        const fbase = f * bins;
        for (let m = 0; m < bins; m++) {
            const pj = histJ[fbase + m] * inv;
            if (pj <= 0) continue;
            const pm = histM[m] * inv;
            hJ -= pj * Math.log(pj);
            mi += pj * Math.log(pj / (pf * pm));
        }
    }
    if (opts?.normalized) {
        if (hJ <= 0) return 0;
        // NMI は 1 (無相関) 〜 2 (完全一致)。最小化なので符号反転。
        return -((hF + hM) / hJ);
    }
    // Negative because optimizer minimizes
    return -mi;
};
