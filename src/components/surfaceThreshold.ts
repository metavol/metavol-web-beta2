// 表面投影 (surface projection) の閾値を volume の分布から自動決定する。
//
// **なぜ固定値ではだめか**
// 体表の値はモダリティにも被写体にも依る。人体 CT の皮膚は概ね -100〜0HU だが、
// sample-data/kitty (小動物 CT) は毛と脂肪で体表が **-900HU 付近**しかない。
// 旧既定 0.3 は PET の SUV 前提で、HU データでは骨だけ、あるいは何も拾えない。
//
// **方針**: 「背景 (空気/FOV 外) のピークの上端」を境界とみなす。
// 背景は必ず体積の大半を占め、狭い値域に集中するので、ヒストグラムの最頻ビンを
// 背景ピークとして掴み、そこから度数が十分下がった位置を閾値にする。
// これは modality に依らず成立する (PET なら背景 ≒ 0、CT なら空気 ≒ -1000)。

import type { Volume } from './Volume';

export interface SurfaceThresholdResult {
    threshold: number;
    /** 背景ピークの中心値 (診断用) */
    backgroundPeak: number;
    /** 走査に使った値域 */
    range: [number, number];
}

const BINS = 256;
/** 背景ピークとみなす最低シェア (UI の参考表示用) */
const PEAK_MIN_SHARE = 0.03;

export const computeSurfaceThreshold = (vol: Volume): SurfaceThresholdResult => {
    const vox = vol.voxel;
    // 大きい volume でも一定コストに収める (~200k サンプル)
    const stride = Math.max(1, Math.floor(vox.length / 200000));
    const vals: number[] = [];
    for (let i = 0; i < vox.length; i += stride) vals.push(vox[i]);
    if (vals.length === 0) return { threshold: 0, backgroundPeak: 0, range: [0, 1] };
    vals.sort((a, b) => a - b);
    const P = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * q)))];

    const lo = P(0);
    // 上端の外れ値 (金属・飽和値。kitty は 4000 が 0.9% ある) にレンジを引かれると
    // 空気ピークが数ビンに潰れて境界が読めなくなるので、97 パーセンタイルで頭を抑える。
    const top = P(0.97) > lo ? P(0.97) : (P(1) > lo ? P(1) : lo + 1);

    const hist = new Float64Array(BINS);
    const scale = (BINS - 1) / (top - lo);
    let n = 0;
    for (const v of vals) {
        if (v > top) continue;
        hist[Math.max(0, Math.min(BINS - 1, Math.round((v - lo) * scale)))]++;
        n++;
    }
    if (n === 0) return { threshold: lo, backgroundPeak: lo, range: [lo, top] };

    // **Otsu 法**で背景と被写体を分ける閾値を決める。
    //
    // 当初は「背景ピークから度数が一定割合まで落ちた位置」を境界にしていたが、
    // これは **ビン幅に依存して結果が動く**。kitty (256 ビン) では -915 になり、
    // 実際に綺麗に見える -700〜-600 に届かなかった (閾値を振って目視で確認)。
    // Otsu はクラス間分散を最大化する原理的な方法で、同じデータで -672 を返す。
    // 手で係数を合わせ込む必要がない分、他のモダリティにも移りやすい。
    let total = 0, sumAll = 0;
    for (let b = 0; b < BINS; b++) { total += hist[b]; sumAll += b * hist[b]; }
    let w0 = 0, s0 = 0, bestVar = -1, bestBin = 0;
    for (let t = 0; t < BINS - 1; t++) {
        w0 += hist[t]; s0 += t * hist[t];
        const w1 = total - w0;
        if (w0 === 0 || w1 === 0) continue;
        const m0 = s0 / w0;
        const m1 = (sumAll - s0) / w1;
        const between = w0 * w1 * (m0 - m1) * (m0 - m1);
        if (between > bestVar) { bestVar = between; bestBin = t; }
    }

    // 背景ピーク: UI に「何を背景とみなしたか」を出すための参考値。
    // 低値側の支配的ピークのうち最も値が大きいもの (kitty は FOV 外パディング -1500 と
    // 空気 -1000 の 2 群があり、最頻ビンだけ見るとパディングを掴んでしまう)。
    const half = Math.floor(BINS / 2);
    const minCount = n * PEAK_MIN_SHARE;
    let peak = -1;
    for (let b = 0; b <= half; b++) {
        if (hist[b] < minCount) continue;
        const l = b > 0 ? hist[b - 1] : 0;
        const r = b < BINS - 1 ? hist[b + 1] : 0;
        if (hist[b] >= l && hist[b] >= r) peak = b;
    }
    if (peak < 0) {
        peak = 0;
        for (let b = 1; b <= half; b++) if (hist[b] > hist[peak]) peak = b;
    }

    return {
        threshold: lo + bestBin / scale,
        backgroundPeak: lo + peak / scale,
        range: [lo, top],
    };
};

// volume ごとに 1 度だけ計算して使い回す (voxel 参照をキーにする)。
const cache = new WeakMap<Float32Array | Int16Array, SurfaceThresholdResult>();

export const surfaceThresholdFor = (vol: Volume): SurfaceThresholdResult => {
    const hit = cache.get(vol.voxel);
    if (hit) return hit;
    const r = computeSurfaceThreshold(vol);
    cache.set(vol.voxel, r);
    return r;
};
