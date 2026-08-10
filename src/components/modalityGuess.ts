// NIfTI の modality 推定。
//
// NIfTI には DICOM の (0008,0060) Modality に相当するタグが無い。
// 従来はファイル名だけで推定していた (MR00.nii → 'MR') が、
// sample-data/kitty/kitty.nii のように名前にヒントが無いと 'OTHER' に落ち、
// CT 前提の機能 (寝台除去、HU window preset) が使えなくなる。
//
// **値の分布から判定する。** CT だけは物理単位 (HU) が決まっているので、
// 「空気 ≈ -1000 に大きなピークがある」という指紋で高い確度で言い当てられる。
// PT (SUV/Bq/ml) と MR (任意単位) はどちらも非負でスケールが自由なため、
// 分布だけでは互いに区別できない。よってここでは **CT か否か**だけを判定し、
// それ以外は従来どおりファイル名に委ねる (外した推定を返すより無印の方が安全)。

export type GuessedModality = 'PT' | 'CT' | 'MR';

export interface ModalityGuess {
    modality: GuessedModality | null;
    /** 判定根拠 (ログ/デバッグ用) */
    reason: string;
}

/** HU で空気とみなす中心値と許容幅 */
const AIR_HU = -1000;
const AIR_TOLERANCE = 120;
/** 空気ピークがこの割合以上あれば CT とみなす */
const AIR_MIN_SHARE = 0.05;
/** 負値がこの割合以上あることも条件にする (PT/MR は基本非負) */
const NEGATIVE_MIN_SHARE = 0.05;

export const guessModalityFromVoxels = (
    voxel: Float32Array | Int16Array | Int32Array | Uint16Array,
): ModalityGuess => {
    if (!voxel || voxel.length === 0) return { modality: null, reason: 'no voxels' };

    // 大きい volume でも一定コストに収める
    const stride = Math.max(1, Math.floor(voxel.length / 200000));
    let n = 0, negative = 0, air = 0;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < voxel.length; i += stride) {
        const v = voxel[i];
        n++;
        if (v < min) min = v;
        if (v > max) max = v;
        if (v < -100) negative++;
        if (v > AIR_HU - AIR_TOLERANCE && v < AIR_HU + AIR_TOLERANCE) air++;
    }
    if (n === 0) return { modality: null, reason: 'no samples' };

    const airShare = air / n;
    const negShare = negative / n;

    // CT の指紋: 空気ピーク (-1000±120) が十分あり、負値も相応にある。
    // kitty (実測): 空気 35%、負値 74% → CT。
    // PET/MR は負値がほぼ無い (再構成の負値は数 % 程度) ので誤判定しにくい。
    if (airShare >= AIR_MIN_SHARE && negShare >= NEGATIVE_MIN_SHARE) {
        return {
            modality: 'CT',
            reason: `air peak ${(airShare * 100).toFixed(1)}% near ${AIR_HU}HU, `
                  + `${(negShare * 100).toFixed(1)}% negative (range ${min.toFixed(0)}..${max.toFixed(0)})`,
        };
    }
    return {
        modality: null,
        reason: `not CT-like (air ${(airShare * 100).toFixed(1)}%, negative ${(negShare * 100).toFixed(1)}%, `
              + `range ${min.toFixed(0)}..${max.toFixed(0)})`,
    };
};
