import type { Volume } from './Volume';

// volume の値域から表示 window (WC/WW) を決める。
//
// CT の HU や PET の SUV と違い、**MR や素性の分からない NIfTI には絶対的な基準が無い**ので
// 分位点から決めるしかない。SPM で正規化した画像もここに該当する。
//
// **NaN を必ず除くこと。** SPM の正規化出力は視野外を **NaN** で埋める
// (実測 w00r.nii: 592,895 voxel 中 4,379 = 0.74% が NaN)。
// NaN を含んだまま sort すると比較が常に false になり並びが壊れて、分位点が出鱈目になる。

export interface AutoWindow {
    wc: number;
    ww: number;
    lo: number;
    hi: number;
    /** 標本のうち NaN だった数 (呼び出し側の診断用) */
    nanCount: number;
    sampled: number;
}

/**
 * `pct` は下側/上側の切り落とし率。0.01 なら 1〜99 パーセンタイル。
 * 全 voxel を舐めると大きい volume で重いので、およそ 2 万点に間引いて標本化する。
 */
export const autoWindowFromVolume = (v: Volume, pct = 0.01): AutoWindow | null => {
    const n = v.voxel.length;
    if (n === 0) return null;
    const stride = Math.max(1, Math.floor(n / 20000));
    const vals: number[] = [];
    let nanCount = 0;
    for (let i = 0; i < n; i += stride) {
        const x = v.voxel[i];
        if (Number.isFinite(x)) vals.push(x);
        else nanCount++;
    }
    if (vals.length < 8) return null;
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * pct)] ?? vals[0];
    const hi = vals[Math.floor(vals.length * (1 - pct))] ?? vals[vals.length - 1];
    // hi <= lo は定数 volume。潰れた window を返すと真っ白/真っ黒になるので幅を持たせる。
    const width = hi > lo ? hi - lo : Math.max(1, Math.abs(hi) || 1);
    return { wc: (lo + width / 2), ww: width, lo, hi: lo + width, nanCount, sampled: vals.length };
};
