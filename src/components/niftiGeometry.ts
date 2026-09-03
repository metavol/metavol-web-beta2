import * as THREE from '@/lib/threeMath';

// NIfTI の affine → 本アプリの Volume 幾何 (world = DICOM LPS) への変換。
//
// **ここは過去に 2 回壊れた場所なので、変換は必ずこの 1 関数を通すこと。**
// DicomView の NIfTI 読み込みと、VOI テンプレートの読み込みで共有している。
//
// 1) **方向ベクトルは affine の「列」**。af[r][c] は row-major なので、voxel index c を
//    1 進めたときの world 変位は (af[0][c], af[1][c], af[2][c])。
//    以前は「行」を取っていたため、回転を含む affine で軸が混ざり voxel pitch まで狂った
//    (brain MR/PET の qform データで発覚: PET の実ピッチ 0.53/0.53/3.05 が 0.58/0.65/3.02 に化けた)。
//    軸平行 (対角 affine) のデータでは行と列が一致するため、これまで表面化しなかった。
// 2) **NIfTI は RAS+、本アプリ world は LPS** → x,y 成分の符号を反転 (diag(-1,-1,1))。
//    方向ベクトルだけでなく **原点にも同じ変換が要る**。原点を変換していなかったため、
//    NIfTI 同士 / NIfTI と DICOM を並べると x,y 方向にずれていた。

/** nifti-reader-js の `header.affine` (4x4 row-major, RAS) の最低限の形 */
export type NiftiAffine = number[][];

export interface VolumeGeometry {
    imagePosition: THREE.Vector3;
    vectorX: THREE.Vector3;
    vectorY: THREE.Vector3;
    vectorZ: THREE.Vector3;
}

export const niftiAffineToVolumeGeometry = (af: NiftiAffine): VolumeGeometry => {
    const affCol = (c: number) => new THREE.Vector3(-af[0][c], -af[1][c], af[2][c]);
    return {
        vectorX: affCol(0),
        vectorY: affCol(1),
        vectorZ: affCol(2),
        imagePosition: new THREE.Vector3(-af[0][3], -af[1][3], af[2][3]),
    };
};
