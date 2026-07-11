// Auto-register MR to PT via Mutual Information + Nelder-Mead simplex.
// 多重解像度ピラミッド (4x → 2x → 1x) で粗→細の最適化。

import * as THREE from 'three';
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
