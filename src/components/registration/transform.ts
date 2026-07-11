// Rigid 6-DOF transform helpers for image registration.
// 6 parameters: (tx, ty, tz, rx, ry, rz) — translation in mm, rotation in radians.

import * as THREE from 'three';
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
    // direction は rotation のみ (translation 無関係)
    vol.vectorX.copy(origVx.transformDirection(m));
    vol.vectorY.copy(origVy.transformDirection(m));
    vol.vectorZ.copy(origVz.transformDirection(m));
    snapshot.currentParams = [...p] as unknown as RigidParams;
};

export const resetRegistration = (vol: Volume, snapshot: RegistrationSnapshot): void => {
    applyRigidToVolume(vol, snapshot, IDENTITY_PARAMS);
};
