import * as THREE from '@/lib/threeMath';
import type { VolumeMetadata, Modality } from '../types/VolumeMetadata';

export type Volume = {
    voxel: Float32Array;
    nx: number;
    ny: number;
    nz: number;
    imagePosition: THREE.Vector3;
    vectorX: THREE.Vector3;
    vectorY: THREE.Vector3;
    vectorZ: THREE.Vector3;
    metadata?: VolumeMetadata;
}

export interface SeriesEntry {
    myDicom: any[] | null;
    volume: Volume | null;
}

export const findVolumeBySeries = (
    seriesList: SeriesEntry[],
    modality: Modality
): { volume: Volume; index: number } | null => {
    for (let i = 0; i < seriesList.length; i++) {
        const v = seriesList[i].volume;
        if (v && v.metadata && v.metadata.modality === modality) {
            return { volume: v, index: i };
        }
    }
    return null;
}

// vectorX/Y/Z は「voxel index を 1 進めたときの world 変位」= affine の **列**
// (dicom2volume は ImageOrientationPatient の方向余弦 × pixel spacing をそのまま入れる)。
// したがって world = imagePosition + i·vectorX + j·vectorY + k·vectorZ。
//
// 以前はこれを **行** として (worldx = pos.x + i·vx.x + j·vx.y + k·vx.z) 計算しており、
// 実質 affine の転置を使っていた。対角 affine (軸平行) では行と列が一致するため長く表面化せず、
// 回転を含む症例 (脳 MR/PET の NIfTI qform) で初めて破綻した:
// world→voxel が全く別の場所を指し、MR のサンプルが 1 点も取れず MI が常に 0 になっていた。
export const voxelToWorld = (p: THREE.Vector3, v: Volume) => {
    const worldx = v.imagePosition.x + p.x * v.vectorX.x + p.y * v.vectorY.x + p.z * v.vectorZ.x;
    const worldy = v.imagePosition.y + p.x * v.vectorX.y + p.y * v.vectorY.y + p.z * v.vectorZ.y;
    const worldz = v.imagePosition.z + p.x * v.vectorX.z + p.y * v.vectorY.z + p.z * v.vectorZ.z;
    return new THREE.Vector3(worldx,worldy,worldz);
}

// worldToVoxel は voxelToWorld の逆: world = imagePosition + M·voxel, M の列 = vectorX/Y/Z。
// これを毎回 Gaussian elimination (solve) で解くと、レンダ毎に box あたり 3〜6 回、
// 行列組み立て + 配列確保が走る。M は volume ごとに一定なので、解析的 3×3 逆行列
// (M⁻¹) を volume に紐づけてキャッシュし、行列ベクトル積 1 回に落とす。
// キャッシュは M の 9 成分が変わったら再計算する (in-place 変更にも安全)。
interface InvAffine {
    a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number; i: number;
    inv: number[]; // M⁻¹ を row-major 9 要素で保持
}
const invAffineCache = new WeakMap<Volume, InvAffine>();

const inverseAffineOf = (v: Volume): number[] => {
    // M の **列** が vectorX/Y/Z (voxelToWorld と対。転置にしないこと)。
    const a = v.vectorX.x, b = v.vectorY.x, c = v.vectorZ.x;
    const d = v.vectorX.y, e = v.vectorY.y, f = v.vectorZ.y;
    const g = v.vectorX.z, h = v.vectorY.z, i = v.vectorZ.z;
    const cached = invAffineCache.get(v);
    if (cached && cached.a === a && cached.b === b && cached.c === c
        && cached.d === d && cached.e === e && cached.f === f
        && cached.g === g && cached.h === h && cached.i === i) {
        return cached.inv;
    }
    // 解析的 3×3 逆行列 (adjugate / det)。
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const s = det !== 0 ? 1 / det : 0;
    const inv = [
        A * s, (c * h - b * i) * s, (b * f - c * e) * s,
        B * s, (a * i - c * g) * s, (c * d - a * f) * s,
        C * s, (b * g - a * h) * s, (a * e - b * d) * s,
    ];
    invAffineCache.set(v, { a, b, c, d, e, f, g, h, i, inv });
    return inv;
};

export const worldToVoxel = (p: THREE.Vector3, v: Volume) => {
    const m = inverseAffineOf(v);
    const rx = p.x - v.imagePosition.x, ry = p.y - v.imagePosition.y, rz = p.z - v.imagePosition.z;
    return new THREE.Vector3(
        m[0] * rx + m[1] * ry + m[2] * rz,
        m[3] * rx + m[4] * ry + m[5] * rz,
        m[6] * rx + m[7] * ry + m[8] * rz,
    );
}

// volume の中心 (voxel (0,0,0) と (nx,ny,nz) の world 中点)。同一イディオムが各所に
// 散在していたため集約。THREE の .add() は in-place なので新規 Vector3 を返す。
export const volumeCenterWorld = (v: Volume): THREE.Vector3 =>
    voxelToWorld(new THREE.Vector3(0, 0, 0), v)
        .add(voxelToWorld(new THREE.Vector3(v.nx, v.ny, v.nz), v))
        .divideScalar(2);
  