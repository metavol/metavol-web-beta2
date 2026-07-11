// metavol-web Snapshot (.mvs) format
//
// 1 つのケースの作業状態 (mask + labels + reference spheres + tracer + box state)
// を 1 つの zip にまとめて download / upload できる。
// GitHub Pages のような backend-less 環境でも「途中保存して数日後に再開」が可能。
//
// .mvs (= zip) 構造:
//   manifest.json         - スキーマバージョン + メタ
//   mask.nii              - finalMask (Uint16, PET grid)
//   sidecar.json          - labels / threshold / threshold method / pet metadata
//   reference_spheres.json - liver / blood pool reference (任意)
//   box_state.json        - imageBoxInfos のシリアライズ (Vector3 等は plain object 化)
//
// セキュリティ: voxel data は含めない (元 PT 画像が無いと意味が無い)。
// load 時に PT seriesUID 一致確認 → 不一致なら警告して中止 or 強制 load。

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { writeNiftiUint16 } from './niftiWriter';
import { readNiftiMask } from './niftiReader';

const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotManifest {
    schemaVersion: number;
    createdAt: string;       // ISO timestamp
    appVersion?: string;     // metavol-web 自身の version
    petSeriesUID?: string;   // 復元時のターゲット PT 識別
    petSeriesDescription?: string;
    petDims: [number, number, number];
    petVoxelSizeMm: [number, number, number];
}

// シリアライズ可能な box state (Vector3 を plain object にする)
export interface SerializedBoxInfo {
    kind: 'dicom' | 'volume' | 'fusion';
    currentSeriesNumber: number;
    currentSliceNumber?: number;
    description?: string;
    myWC?: number | null;
    myWW?: number | null;
    myWC1?: number | null;
    myWW1?: number | null;
    centerX?: number;
    centerY?: number;
    zoom?: number | null;
    centerInWorld?: [number, number, number];
    vecx?: [number, number, number];
    vecy?: [number, number, number];
    vecz?: [number, number, number];
    clut?: number;
    clut1?: number;
    isMip?: boolean;
    mipAngle?: number;
    isVr?: boolean;
    currentSeriesNumber1?: number;
    overlayAlpha?: number;
    activeWindowLayer?: 'base' | 'overlay';
}

export interface SnapshotPayload {
    manifest: SnapshotManifest;
    maskNifti: Uint8Array;       // .nii bytes
    sidecar: any;                // labels / threshold / thresholdMethod / etc.
    referenceSpheres: any;       // liver / bloodPool (centerWorld → [x,y,z])
    boxState: SerializedBoxInfo[];
    tileN: number;
    activeTracerId?: string | null;
}

// PET volume と 現在の state から zip blob を生成 (async)
export const buildSnapshotZip = async (input: {
    pet: import('../Volume').Volume;
    mask: Uint16Array;
    labels: Array<{ id: number; name: string; color: [number, number, number] }>;
    threshold: number;
    thresholdUnit: 'SUV' | 'CNTS';
    thresholdMethod: string;
    thresholdPct: number;
    referenceSpheres: { liver: any; bloodPool: any };
    boxState: SerializedBoxInfo[];
    tileN: number;
    activeTracerId?: string | null;
}): Promise<Blob> => {
    const { pet, mask, labels, threshold, thresholdUnit, thresholdMethod,
            thresholdPct, referenceSpheres, boxState, tileN, activeTracerId } = input;

    const manifest: SnapshotManifest = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        petSeriesUID: pet.metadata?.seriesUID,
        petSeriesDescription: pet.metadata?.seriesDescription,
        petDims: [pet.nx, pet.ny, pet.nz],
        petVoxelSizeMm: [
            pet.vectorX.length(),
            pet.vectorY.length(),
            pet.vectorZ.length(),
        ],
    };

    // Reference spheres の Vector3 を plain array 化
    const refSerialized = {
        liver: referenceSpheres.liver ? {
            centerWorld: [
                referenceSpheres.liver.centerWorld.x,
                referenceSpheres.liver.centerWorld.y,
                referenceSpheres.liver.centerWorld.z,
            ],
            radiusMm: referenceSpheres.liver.radiusMm,
            suvMean: referenceSpheres.liver.suvMean,
            suvStd: referenceSpheres.liver.suvStd,
            voxelCount: referenceSpheres.liver.voxelCount,
        } : null,
        bloodPool: referenceSpheres.bloodPool ? {
            centerWorld: [
                referenceSpheres.bloodPool.centerWorld.x,
                referenceSpheres.bloodPool.centerWorld.y,
                referenceSpheres.bloodPool.centerWorld.z,
            ],
            radiusMm: referenceSpheres.bloodPool.radiusMm,
            suvMean: referenceSpheres.bloodPool.suvMean,
            suvStd: referenceSpheres.bloodPool.suvStd,
            voxelCount: referenceSpheres.bloodPool.voxelCount,
        } : null,
    };

    const sidecar = {
        labels,
        threshold,
        thresholdUnit,
        thresholdMethod,
        thresholdPct,
        petMetadata: {
            seriesUID: pet.metadata?.seriesUID,
            seriesDescription: pet.metadata?.seriesDescription,
            modality: pet.metadata?.modality,
            suvFactor: pet.metadata?.suvFactor,
        },
    };

    const maskNiftiBlob = writeNiftiUint16(mask, pet);
    const maskBytes = new Uint8Array(await maskNiftiBlob.arrayBuffer());
    const files: Record<string, Uint8Array> = {
        'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
        'mask.nii': maskBytes,
        'sidecar.json': strToU8(JSON.stringify(sidecar, null, 2)),
        'reference_spheres.json': strToU8(JSON.stringify(refSerialized, null, 2)),
        'box_state.json': strToU8(JSON.stringify({ tileN, activeTracerId, boxState }, null, 2)),
    };
    const zipBytes = zipSync(files, { level: 6 });
    return new Blob([zipBytes as BlobPart], { type: 'application/zip' });
};

// .mvs zip を解凍して payload を返す
export const parseSnapshotZip = async (blob: Blob): Promise<SnapshotPayload | null> => {
    const ab = await blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    let unzipped: Record<string, Uint8Array>;
    try {
        unzipped = unzipSync(u8);
    } catch {
        throw new Error('File is not a valid .mvs (zip) snapshot.');
    }
    const get = (name: string): Uint8Array | null => unzipped[name] ?? null;
    const getJson = <T>(name: string): T | null => {
        const b = get(name);
        if (!b) return null;
        try { return JSON.parse(strFromU8(b)) as T; } catch { return null; }
    };

    const manifest = getJson<SnapshotManifest>('manifest.json');
    if (!manifest || manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        throw new Error(`Snapshot schema version mismatch (expected ${SNAPSHOT_SCHEMA_VERSION}, got ${manifest?.schemaVersion}).`);
    }
    const maskNifti = get('mask.nii');
    if (!maskNifti) throw new Error('Missing mask.nii in snapshot.');
    const sidecar = getJson<any>('sidecar.json');
    const referenceSpheres = getJson<any>('reference_spheres.json') ?? { liver: null, bloodPool: null };
    const boxStateWrap = getJson<{ tileN: number; activeTracerId?: string | null; boxState: SerializedBoxInfo[] }>('box_state.json');

    return {
        manifest,
        maskNifti,
        sidecar: sidecar ?? {},
        referenceSpheres,
        boxState: boxStateWrap?.boxState ?? [],
        tileN: boxStateWrap?.tileN ?? 1,
        activeTracerId: boxStateWrap?.activeTracerId ?? null,
    };
};

// マスクのみ展開 (PET 復元検証用)
export const extractMaskFromSnapshot = (payload: SnapshotPayload): { mask: Uint16Array; dims: [number, number, number] } => {
    const blob = new Blob([payload.maskNifti.buffer.slice(
        payload.maskNifti.byteOffset,
        payload.maskNifti.byteOffset + payload.maskNifti.byteLength
    )]);
    void blob;
    // readNiftiMask takes ArrayBuffer
    const ab = payload.maskNifti.buffer.slice(
        payload.maskNifti.byteOffset,
        payload.maskNifti.byteOffset + payload.maskNifti.byteLength
    );
    const parsed = readNiftiMask(ab);
    return { mask: parsed.mask, dims: parsed.dims };
};
