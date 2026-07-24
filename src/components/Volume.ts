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

export const voxelToWorld = (p: THREE.Vector3, v: Volume) => {
    const worldx = v.imagePosition.x + p.x * v.vectorX.x + p.y * v.vectorX.y + p.z * v.vectorX.z;
    const worldy = v.imagePosition.y + p.x * v.vectorY.x + p.y * v.vectorY.y + p.z * v.vectorY.z;
    const worldz = v.imagePosition.z + p.x * v.vectorZ.x + p.y * v.vectorZ.y + p.z * v.vectorZ.z;
    return new THREE.Vector3(worldx,worldy,worldz);
}

// worldToVoxel は voxelToWorld の逆: world = imagePosition + M·voxel, M の行 = vectorX/Y/Z。
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
    const a = v.vectorX.x, b = v.vectorX.y, c = v.vectorX.z;
    const d = v.vectorY.x, e = v.vectorY.y, f = v.vectorY.z;
    const g = v.vectorZ.x, h = v.vectorZ.y, i = v.vectorZ.z;
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
  