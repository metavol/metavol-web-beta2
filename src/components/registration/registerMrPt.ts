// Auto-register MR to PT via Mutual Information + Nelder-Mead simplex.
// 多重解像度ピラミッド (4x → 2x → 1x) で粗→細の最適化。

import * as THREE from '@/lib/threeMath';
import type { Volume } from '../Volume';
import type { RigidParams } from './transform';
import { generateFixedSamples, estimateIntensityRange, computeNegativeMI, type MIStats } from './mi';
import { optimizeNelderMead } from './optimize';

export interface RegistrationProgress {
    level: number;          // 0 = coarsest
    nLevels: number;
    iter: number;
    bestNegMI: number;
    params: RigidParams;
}

export interface RegistrationResult {
    params: RigidParams;
    finalNegMI: number;
    elapsedMs: number;
    iterationsTotal: number;
}

// Volume を整数倍 downsample (平均なし、stride sampling) — 速度優先
const downsampleVolume = (vol: Volume, factor: number): Volume => {
    if (factor <= 1) return vol;
    const nx = Math.max(1, Math.floor(vol.nx / factor));
    const ny = Math.max(1, Math.floor(vol.ny / factor));
    const nz = Math.max(1, Math.floor(vol.nz / factor));
    const out = new Float32Array(nx * ny * nz);
    const srcNxNy = vol.nx * vol.ny;
    let ad = 0;
    for (let k = 0; k < nz; k++) {
        const sk = k * factor;
        for (let j = 0; j < ny; j++) {
            const sj = j * factor;
            const baseRow = sk * srcNxNy + sj * vol.nx;
            for (let i = 0; i < nx; i++) {
                out[ad++] = vol.voxel[baseRow + i * factor];
            }
        }
    }
    return {
        voxel: out,
        nx, ny, nz,
        imagePosition: vol.imagePosition.clone(),
        vectorX: vol.vectorX.clone().multiplyScalar(factor),
        vectorY: vol.vectorY.clone().multiplyScalar(factor),
        vectorZ: vol.vectorZ.clone().multiplyScalar(factor),
        metadata: vol.metadata,
    };
};

// 強度重心 (centre of mass) を world 座標で求める。
// MI 最適化は局所探索なので、FOV がまるごとズレている症例 (別スキャナで撮った脳 MR と脳 PET など。
// 実データで FOV 中心が 195mm、解剖重心が 151mm 離れていた) では初期値ゼロから収束しない。
// そこで「まず重心を合わせる」初期化に使う。
//   threshold = (サンプリングした最大値) * frac  で背景を落とす。MR/PET とも強度スケールが
//   違うため絶対値ではなく最大値比で決める。
export const computeCentroidWorld = (vol: Volume, frac = 0.15): THREE.Vector3 | null => {
    // 大きい volume でも一定コストに収まるよう stride を決める (~64^3 サンプル程度)
    const target = 64;
    const sx = Math.max(1, Math.floor(vol.nx / target));
    const sy = Math.max(1, Math.floor(vol.ny / target));
    const sz = Math.max(1, Math.floor(vol.nz / target));

    let max = -Infinity;
    for (let k = 0; k < vol.nz; k += sz) {
        for (let j = 0; j < vol.ny; j += sy) {
            const base = k * vol.nx * vol.ny + j * vol.nx;
            for (let i = 0; i < vol.nx; i += sx) {
                const v = vol.voxel[base + i];
                if (v > max) max = v;
            }
        }
    }
    if (!Number.isFinite(max) || max <= 0) return null;
    const thr = max * frac;

    let sw = 0, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < vol.nz; k += sz) {
        for (let j = 0; j < vol.ny; j += sy) {
            const base = k * vol.nx * vol.ny + j * vol.nx;
            for (let i = 0; i < vol.nx; i += sx) {
                const w = vol.voxel[base + i];
                if (!(w > thr)) continue;
                sw += w;
                cx += w * (vol.imagePosition.x + vol.vectorX.x * i + vol.vectorY.x * j + vol.vectorZ.x * k);
                cy += w * (vol.imagePosition.y + vol.vectorX.y * i + vol.vectorY.y * j + vol.vectorZ.y * k);
                cz += w * (vol.imagePosition.z + vol.vectorX.z * i + vol.vectorY.z * j + vol.vectorZ.z * k);
            }
        }
    }
    if (sw <= 0) return null;
    return new THREE.Vector3(cx / sw, cy / sw, cz / sw);
};

// 重心合わせの並進だけを返す (回転は 0)。
export const centroidInitParams = (fixed: Volume, moving: Volume): RigidParams => {
    const cf = computeCentroidWorld(fixed);
    const cm = computeCentroidWorld(moving);
    if (!cf || !cm) return [0, 0, 0, 0, 0, 0];
    return [cf.x - cm.x, cf.y - cm.y, cf.z - cm.z, 0, 0, 0];
};

// base の周りを粗いグリッドで総当たりし、MI が最良の並進を返す。
//
// **なぜ重心合わせだけでは足りないか**: 重心は「撮影範囲に何が入っているか」に依存する。
// 実データ (brain MR + brain PET) では、MR が頸部まで含み明るい脂肪に重心を引かれるため
// 重心が FOV 中心より 44.7mm 下、PET は逆に 9.2mm 上で、合わせると z が 70〜80mm ずれた。
// その状態から Nelder-Mead (最粗レベルでも 1 歩 20mm) を回しても脱出できず、
// 「大きくずれた局所解」に落ちる (MI -0.45 で停止。真の解は -0.76)。
// そこで z を広め (±120mm)、x/y を控えめ (±40mm) に粗探索してから最適化に渡す。
// 評価は sample 数を絞った MI なので数百点でも 1 秒未満。
// volume 全体から強度レンジを取る (1〜99 パーセンタイル)。
// **estimateIntensityRange は moving を identity 位置でサンプルする**ため、初期ずれが大きい
// 段階では moving のレンジが背景だらけになり、MI の binning が壊れて評価が不安定になる
// (粗探索が偽の最適を選ぶ原因だった)。粗探索では alignment に依存しないこの推定を使う。
const globalRange = (vol: Volume): [number, number] => {
    const stride = Math.max(1, Math.floor(vol.voxel.length / 20000));
    const vals: number[] = [];
    for (let i = 0; i < vol.voxel.length; i += stride) vals.push(vol.voxel[i]);
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.01)] ?? vals[0];
    const hi = vals[Math.floor(vals.length * 0.99)] ?? vals[vals.length - 1];
    return [lo, hi > lo ? hi : lo + 1];
};

export const coarseTranslationSearch = (
    fixed: Volume,
    moving: Volume,
    base: RigidParams,
    opts?: { zRange?: number; zStep?: number; xyRange?: number; xyStep?: number;
             nSamples?: number; passes?: number },
): RigidParams => {
    const zRange = opts?.zRange ?? 120;
    const zStep = opts?.zStep ?? 10;
    const xyRange = opts?.xyRange ?? 40;
    const xyStep = opts?.xyStep ?? 10;

    // **downsample しないこと**。factor 4 で試したところ PET の z が 55→13 スライスまで潰れ
    // (downsampleVolume は平均でなく stride 抽出なのでエイリアシングも乗る)、MI の地形が壊れて
    // 全解像度では明確に劣る点 (実測 -0.31 vs -0.51) を「最良」と誤判定した。
    // 代わりに 3D 総当たりをやめ、軸ごとの逐次探索 (z→y→x) を 2 パス回す。
    // 実データでは x/y の MI ピークが鋭く単峰なので逐次で十分に当たり、評価回数は
    // 25+9+9 の 2 パス ≒ 86 回で済む。
    const samples = generateFixedSamples(fixed, opts?.nSamples ?? 4000, 20250727);
    const [fLo, fHi] = globalRange(fixed);
    const [mLo, mHi] = globalRange(moving);
    const stats: MIStats = { fixedMin: fLo, fixedMax: fHi, movingMin: mLo, movingMax: mHi };
    const evalAt = (p: number[]) => computeNegativeMI(fixed, moving, samples, stats, p as unknown as RigidParams);

    let best: number[] = [...base];
    let bestVal = evalAt(best);
    const passes = opts?.passes ?? 2;
    for (let pass = 0; pass < passes; pass++) {
        // z を最初に振る: 撮影範囲 (頸部の入り方など) の差で最も大きくずれる軸。
        for (const axis of [2, 1, 0]) {
            const range = axis === 2 ? zRange : xyRange;
            const step = axis === 2 ? zStep : xyStep;
            let localBest = best, localVal = bestVal;
            for (let d = -range; d <= range; d += step) {
                if (d === 0) continue;
                const p = [...best];
                p[axis] += d;
                const v = evalAt(p);
                if (v < localVal) { localVal = v; localBest = p; }
            }
            best = localBest; bestVal = localVal;
        }
    }
    return best as unknown as RigidParams;
};

// 位置合わせの初期値: 重心合わせ → 粗グリッド探索。registerMrToPt に渡す。
export const estimateInitialParams = (fixed: Volume, moving: Volume): RigidParams =>
    coarseTranslationSearch(fixed, moving, centroidInitParams(fixed, moving));

export const registerMrToPt = (
    fixed: Volume,        // PT
    moving: Volume,       // MR (現在の世界座標、すでに変換が適用されていてもよい)
    initialParams: RigidParams = [0, 0, 0, 0, 0, 0],
    onProgress?: (info: RegistrationProgress) => void,
    abortSignal?: { aborted: boolean },
): RegistrationResult => {
    const t0 = performance.now();
    const factors = [4, 2, 1];
    const samplesPerLevel = [3000, 5000, 8000];
    const maxIterPerLevel = [120, 150, 100];
    const tolFx = 1e-4;
    const tolX = 0.5; // simplex 直径 mm/deg

    let params: RigidParams = [...initialParams] as unknown as RigidParams;
    let finalNeg = 0;
    let totalIter = 0;

    for (let level = 0; level < factors.length; level++) {
        if (abortSignal?.aborted) break;
        const factor = factors[level];
        const f = downsampleVolume(fixed, factor);
        const m = downsampleVolume(moving, factor);
        const samples = generateFixedSamples(f, samplesPerLevel[level], 12345 + level);
        const stats: MIStats = estimateIntensityRange(f, m, samples);

        // scales: 粗いレベルほど大きく動かす
        const tStep = factor * 5;     // mm
        const rStep = factor * 0.05;  // rad (~3°)
        const scales = [tStep, tStep, tStep, rStep, rStep, rStep];

        const objective = (x: number[]): number => {
            return computeNegativeMI(f, m, samples, stats, x as unknown as RigidParams);
        };

        const result = optimizeNelderMead(objective, params as unknown as number[], scales, {
            maxIter: maxIterPerLevel[level],
            tolFx,
            tolX,
            onIter: (iter, fx, x) => {
                onProgress?.({
                    level, nLevels: factors.length,
                    iter, bestNegMI: fx,
                    params: x as unknown as RigidParams,
                });
            },
            abortSignal,
        });
        params = result.x as unknown as RigidParams;
        finalNeg = result.fx;
        totalIter += result.iterations;
    }

    return {
        params,
        finalNegMI: finalNeg,
        elapsedMs: performance.now() - t0,
        iterationsTotal: totalIter,
    };
};
