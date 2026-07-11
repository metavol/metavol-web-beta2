import * as THREE from 'three';
import { solve } from './linalg'
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

export const worldToVoxel = (p: THREE.Vector3, v: Volume) => {
    const right = [p.x - v.imagePosition.x, p.y- v.imagePosition.y, p.z - v.imagePosition.z];
    const left = [[v.vectorX.x,v.vectorX.y,v.vectorX.z],
     [v.vectorY.x,v.vectorY.y, v.vectorY.z, ],
     [v.vectorZ.x,v.vectorZ.y, v.vectorZ.z, ]];
    const ans = solve(left, right)
    return new THREE.Vector3(ans[0],ans[1],ans[2]);
}
  