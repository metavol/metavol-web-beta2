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

// Volume を整数倍 downsample。
//
// **必ず箱平均 (anti-alias) にすること。** 以前は stride 抽出 (factor 個おきに 1 voxel を
// そのまま採る) だったが、これは低域通過を伴わないので折り返しが乗り、MI の地形が壊れる。
// 粗探索では既にこの理由で downsample を止めていた (下の coarseTranslationSearch のコメント)
// が、**registerMrToPt の 4→2→1 ピラミッドは stride のまま残っていた**。
// 最粗レベル (factor 4) で偽の最適に落ちると、以降のレベルはその周りしか探さないので
// 二度と正解へ戻れない。実測 (Hirata, CT TRANSAXIAL+ × PET TRANSAXIAL):
// 正解姿勢から最適化を始めても 64.5mm 離れていった。
const downsampleVolume = (vol: Volume, factor: number): Volume => {
    if (factor <= 1) return vol;
    const nx = Math.max(1, Math.floor(vol.nx / factor));
    const ny = Math.max(1, Math.floor(vol.ny / factor));
    const nz = Math.max(1, Math.floor(vol.nz / factor));
    const out = new Float32Array(nx * ny * nz);
    const srcNxNy = vol.nx * vol.ny;
    const invN = 1 / (factor * factor * factor);
    let ad = 0;
    for (let k = 0; k < nz; k++) {
        const k0 = k * factor;
        for (let j = 0; j < ny; j++) {
            const j0 = j * factor;
            for (let i = 0; i < nx; i++) {
                const i0 = i * factor;
                let s = 0;
                for (let dk = 0; dk < factor; dk++) {
                    const zb = (k0 + dk) * srcNxNy;
                    for (let dj = 0; dj < factor; dj++) {
                        const rb = zb + (j0 + dj) * vol.nx + i0;
                        for (let di = 0; di < factor; di++) s += vol.voxel[rb + di];
                    }
                }
                out[ad++] = s * invN;
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
// 「写っている体の重心」を返す。
//
// **voxel 値を重みにしてはいけない。** 旧実装は `sw += w; cx += w * pos` と強度重み付き
// 重心を取っていたが、
//   - CT の HU は空気が -1000 の **負値**で、重みとして意味を成さない
//   - 閾値 (max*0.15) は CT では骨だけ、PET では高集積だけを残すので、
//     「骨の重心」と「集積の重心」という **別物同士**を突き合わせることになる
// 実測 (Hirata, CT TRANSAXIAL+ × PET TRANSAXIAL) では重心合わせだけで 464mm ずれた。
// modality に依らず比較できるよう、体内判定は **二値**にして幾何重心を取る。
const bodyThresholdFor = (vol: Volume): number => {
    const stride = Math.max(1, Math.floor(vol.voxel.length / 40000));
    let hasNegative = false;
    const vals: number[] = [];
    for (let i = 0; i < vol.voxel.length; i += stride) {
        const v = vol.voxel[i];
        if (v < -200) hasNegative = true;
        vals.push(v);
    }
    // HU スケール (空気が大きく負) なら CT とみなして -300HU 固定。
    // 体/空気の境として標準的で、肺も体内に含められる。
    if (hasNegative) return -300;
    vals.sort((a, b) => a - b);
    const p99 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] ?? 1;
    return p99 * 0.10;   // PET/MR: 高集積の 10% を体内の目安に
};

export const computeCentroidWorld = (vol: Volume, frac = 0.15): THREE.Vector3 | null => {
    // 大きい volume でも一定コストに収まるよう stride を決める (~64^3 サンプル程度)
    const target = 64;
    const sx = Math.max(1, Math.floor(vol.nx / target));
    const sy = Math.max(1, Math.floor(vol.ny / target));
    const sz = Math.max(1, Math.floor(vol.nz / target));

    void frac;   // 旧 API 互換のため引数は残す (強度比の閾値はもう使わない)
    const thr = bodyThresholdFor(vol);

    // 二値 (体内かどうか) の幾何重心。強度では重み付けしない。
    let n = 0, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < vol.nz; k += sz) {
        for (let j = 0; j < vol.ny; j += sy) {
            const base = k * vol.nx * vol.ny + j * vol.nx;
            for (let i = 0; i < vol.nx; i += sx) {
                if (!(vol.voxel[base + i] > thr)) continue;
                n++;
                cx += vol.imagePosition.x + vol.vectorX.x * i + vol.vectorY.x * j + vol.vectorZ.x * k;
                cy += vol.imagePosition.y + vol.vectorX.y * i + vol.vectorY.y * j + vol.vectorZ.y * k;
                cz += vol.imagePosition.z + vol.vectorX.z * i + vol.vectorY.z * j + vol.vectorZ.z * k;
            }
        }
    }
    if (n <= 0) return null;
    return new THREE.Vector3(cx / n, cy / n, cz / n);
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
             nSamples?: number; passes?: number } & RegOptions,
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
    const samples = generateFixedSamples(fixed, opts?.nSamples ?? 4000, 20250727,
        { bodyOnly: opts?.bodyOnly ?? DEFAULT_REG_OPTIONS.bodyOnly });
    const [fLo, fHi] = globalRange(fixed);
    const [mLo, mHi] = globalRange(moving);
    const stats: MIStats = { fixedMin: fLo, fixedMax: fHi, movingMin: mLo, movingMax: mHi };
    const normalized = opts?.normalized ?? DEFAULT_REG_OPTIONS.normalized;
    const evalAt = (p: number[]) => computeNegativeMI(fixed, moving, samples, stats,
        p as unknown as RigidParams, undefined, { normalized });

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
export const estimateInitialParams = (fixed: Volume, moving: Volume, regOpts?: RegOptions): RigidParams =>
    coarseTranslationSearch(fixed, moving, centroidInitParams(fixed, moving), regOpts);

// 位置合わせの既定パラメータ。**評価スクリプト (scripts/reg-eval.mjs) から切り替えられるよう
// 1 か所にまとめてある**。既定値は Hirata20260728 (CT TRANSAXIAL+ × PET TRANSAXIAL) を
// 既知量ずらして戻す実験で決めた。
export interface RegOptions {
    normalized?: boolean;   // NMI を使うか
    bodyOnly?: boolean;     // fixed の体内だけをサンプリングするか
    factors?: number[];     // 多重解像度の縮小率。[1] にすると単一解像度 (診断用)
    samples?: number[];     // 各レベルの sample 数 (factors と同じ長さ)
}
// Hirata20260728 (CT TRANSAXIAL+ × PET TRANSAXIAL、同一 FoR を正解として既知量ずらして戻す)
// での実測 (平均 mTRE、開始誤差 26.9〜70.8mm)。**2026-08 に幾何を壊す 2 つのバグを直した後**の値:
//   重心 + pyramid[2,1]      1.6mm   ← 最良 (既定)
//   重心 + pyramid[4,2,1]    2.3mm
//   初期値なし + pyramid     3.9mm
//   重心 + 単一解像度        6.8mm
//   初期値なし + 単一解像度  11.6mm
// 多重解像度は **有効**。初期値 (重心合わせ) も有効。所要 1 秒前後。
//
// 注意: これ以前の測定 (旧 CLAUDE.md 3.58 の「MI は全身 PET/CT で成立しない」320mm 等) は
// applyRigidToVolume の正規化バグ (voxel pitch 破壊) と estimateIntensityRange の
// 姿勢依存バグ (MI が恒等的に 0) の上で取ったもので、**すべて無効**。
// 再測定は scripts/reg-eval.mjs。
export const DEFAULT_REG_OPTIONS: Required<RegOptions> = {
    normalized: false, bodyOnly: false, factors: [2, 1], samples: [8000, 10000],
};

export const registerMrToPt = (
    fixed: Volume,        // PT
    moving: Volume,       // MR (現在の世界座標、すでに変換が適用されていてもよい)
    initialParams: RigidParams = [0, 0, 0, 0, 0, 0],
    onProgress?: (info: RegistrationProgress) => void,
    abortSignal?: { aborted: boolean },
    regOpts: RegOptions = DEFAULT_REG_OPTIONS,
): RegistrationResult => {
    const t0 = performance.now();
    const factors = regOpts.factors ?? [4, 2, 1];
    const samplesPerLevel = regOpts.samples ?? [3000, 5000, 8000];
    const maxIterPerLevel = factors.map((_, i) => [120, 150, 100][i] ?? 150);
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
        const samples = generateFixedSamples(f, samplesPerLevel[level], 12345 + level,
            { bodyOnly: regOpts.bodyOnly });
        const stats: MIStats = estimateIntensityRange(f, m, samples);

        // scales: 粗いレベルほど大きく動かす
        const tStep = factor * 5;     // mm
        const rStep = factor * 0.05;  // rad (~3°)
        const scales = [tStep, tStep, tStep, rStep, rStep, rStep];

        const objective = (x: number[]): number => {
            return computeNegativeMI(f, m, samples, stats, x as unknown as RigidParams,
                undefined, { normalized: regOpts.normalized });
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
