// Rigid 6-DOF transform helpers for image registration.
// 6 parameters: (tx, ty, tz, rx, ry, rz) — translation in mm, rotation in radians.

import * as THREE from '@/lib/threeMath';
import type { Volume } from '../Volume';

export type RigidParams = readonly [number, number, number, number, number, number];

export const IDENTITY_PARAMS: RigidParams = [0, 0, 0, 0, 0, 0];

// Compose 4x4 rigid transform: T = Translate · Rx · Ry · Rz
export const makeRigidMatrix = (p: RigidParams): THREE.Matrix4 => {
    const [tx, ty, tz, rx, ry, rz] = p;
    const e = new THREE.Euler(rx, ry, rz, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    const m = new THREE.Matrix4();
    m.makeRotationFromQuaternion(q);
    m.setPosition(tx, ty, tz);
    return m;
};

export const invertRigidMatrix = (m: THREE.Matrix4): THREE.Matrix4 => {
    return m.clone().invert();
};

// MR の幾何 (imagePosition / vectorX/Y/Z) のオリジナル snapshot を覚えるためのフィールド。
// volume.metadata に格納する extra info。直接型に手を入れず Record<string, any> 拡張。
export interface RegistrationSnapshot {
    originalImagePosition: [number, number, number];
    originalVectorX: [number, number, number];
    originalVectorY: [number, number, number];
    originalVectorZ: [number, number, number];
    currentParams: RigidParams;
}

export const captureRegistrationSnapshot = (vol: Volume): RegistrationSnapshot => ({
    originalImagePosition: [vol.imagePosition.x, vol.imagePosition.y, vol.imagePosition.z],
    originalVectorX: [vol.vectorX.x, vol.vectorX.y, vol.vectorX.z],
    originalVectorY: [vol.vectorY.x, vol.vectorY.y, vol.vectorY.z],
    originalVectorZ: [vol.vectorZ.x, vol.vectorZ.y, vol.vectorZ.z],
    currentParams: [...IDENTITY_PARAMS] as unknown as RigidParams,
});

// 3x3 回転部だけを掛ける。**長さを変えないこと** が肝。
//
// 以前は THREE の `transformDirection` を使っていたが、あれは回転後に **正規化** する。
// vectorX/Y/Z は「voxel を 1 進めたとき world で何 mm 動くか」= 長さが voxel pitch そのもの
// なので、正規化すると **全部 1mm 角の volume に化ける**。
// 実測 (metmri の MR): pitch 6.42mm の軸が 1.00 になっていた。
// applyRigidToVolume は auto-register / 手動調整 / snapshot 復元のすべてが通るため、
// 位置合わせを 1 回でも掛けた時点で幾何が壊れ、以後 MI も表示も当てにならなくなっていた。
const rotateKeepingLength = (v: THREE.Vector3, m: THREE.Matrix4): THREE.Vector3 => {
    const e = m.elements;   // column-major
    return new THREE.Vector3(
        e[0] * v.x + e[4] * v.y + e[8]  * v.z,
        e[1] * v.x + e[5] * v.y + e[9]  * v.z,
        e[2] * v.x + e[6] * v.y + e[10] * v.z,
    );
};

// Apply rigid params to volume: position は full 変換、vec は 3x3 回転のみ
export const applyRigidToVolume = (
    vol: Volume,
    snapshot: RegistrationSnapshot,
    p: RigidParams,
): void => {
    const m = makeRigidMatrix(p);
    const origPos = new THREE.Vector3(...snapshot.originalImagePosition);
    const origVx = new THREE.Vector3(...snapshot.originalVectorX);
    const origVy = new THREE.Vector3(...snapshot.originalVectorY);
    const origVz = new THREE.Vector3(...snapshot.originalVectorZ);
    vol.imagePosition.copy(origPos.applyMatrix4(m));
    // direction は rotation のみ (translation 無関係)。長さ = voxel pitch は保つ。
    vol.vectorX.copy(rotateKeepingLength(origVx, m));
    vol.vectorY.copy(rotateKeepingLength(origVy, m));
    vol.vectorZ.copy(rotateKeepingLength(origVz, m));
    snapshot.currentParams = [...p] as unknown as RigidParams;
};

export const resetRegistration = (vol: Volume, snapshot: RegistrationSnapshot): void => {
    applyRigidToVolume(vol, snapshot, IDENTITY_PARAMS);
};

// ===== 手動調整 (mis-registration の救済) =====
//
// `makeRigidMatrix` の回転は **world 原点まわり**。パラメータの rx/ry/rz に直接
// 角度を足すと、原点から数百 mm 離れた体幹部は大きく飛んでしまい手動調整に使えない。
// そこで手動側は「world 空間の delta 行列を **左から** 掛けて再分解する」形に統一する:
//
//     M_new = Δ · M_old        (Δ = world 空間の剛体変換)
//
// 見えている場所を中心に回したいときは Δ = T(c)·R·T(-c) を渡す (`rotationDeltaAbout`)。
// こうしておけば手動調整の結果も同じ RigidParams 1 本で表現でき、
// そのまま auto-registration の開始姿勢として渡せる。

export const paramsFromMatrix = (m: THREE.Matrix4): RigidParams => {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    return [pos.x, pos.y, pos.z, e.x, e.y, e.z];
};

export const composeWorldDelta = (p: RigidParams, delta: THREE.Matrix4): RigidParams =>
    paramsFromMatrix(delta.clone().multiply(makeRigidMatrix(p)));

export const translationDelta = (v: THREE.Vector3): THREE.Matrix4 =>
    new THREE.Matrix4().makeTranslation(v.x, v.y, v.z);

export const rotationDeltaAbout = (
    axis: THREE.Vector3,
    angleRad: number,
    center: THREE.Vector3,
): THREE.Matrix4 => {
    const r = new THREE.Matrix4().makeRotationAxis(axis.clone().normalize(), angleRad);
    const toOrigin = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    const back = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
    return back.multiply(r).multiply(toOrigin);
};
