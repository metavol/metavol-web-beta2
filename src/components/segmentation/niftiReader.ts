import * as nifti from 'nifti-reader-js';

// NIfTI-1 mask reader. Pairs with niftiWriter.ts:
// expects the same Uint16 multi-label volume layout that saveMaskAsNifti() produces,
// but is also tolerant of UINT8 (=2) masks (binary or low-cardinality multi-label).
// Internal storage is always Uint16Array (matches segStore.finalMask shape).
//
// Throws Error with a user-readable English message if the buffer is not a valid
// supported NIfTI-1 mask — callers can surface the message in an alert().

export interface MaskNifti {
    mask: Uint16Array;
    dims: [number, number, number];
    voxelSizeMm: [number, number, number];
}

export const readNiftiMask = (buf: ArrayBuffer): MaskNifti => {
    let raw: ArrayBuffer = buf;
    if (nifti.isCompressed(raw)) {
        raw = nifti.decompress(raw);
    }
    if (!nifti.isNIFTI(raw)) {
        throw new Error('File is not a valid NIfTI-1 volume.');
    }

    const hdr = nifti.readHeader(raw) as nifti.NIFTI1;
    const datatype = (hdr as any).datatypeCode ?? (hdr as any).datatype;
    // 対応 datatype: 512 = Uint16 (saveMaskAsNifti が出力する標準), 2 = Uint8 (binary mask)
    // それ以外 (Int16=4, Float32=16 等) は label id の意味づけが曖昧になるため拒否
    if (datatype !== 512 && datatype !== 2) {
        throw new Error(
            `Unsupported NIfTI mask datatype (${datatype}). Mask must be UINT16 (=512) or UINT8 (=2).`
        );
    }

    const dimsArr = (hdr as any).dims as number[];
    const nx = dimsArr[1] | 0;
    const ny = dimsArr[2] | 0;
    const nz = dimsArr[3] | 0;
    if (nx <= 0 || ny <= 0 || nz <= 0) {
        throw new Error(`Invalid NIfTI dims: ${nx} x ${ny} x ${nz}.`);
    }

    const px = nifti.readImage(hdr, raw);
    const expected = nx * ny * nz;
    // datatype に応じて TypedArray を構築 → 内部用 Uint16Array にコピー (segStore.finalMask 互換)
    const mask = new Uint16Array(expected);
    if (datatype === 512) {
        const view = new Uint16Array(px);
        if (view.length < expected) {
            throw new Error(`NIfTI image data truncated: got ${view.length} voxels, expected ${expected}.`);
        }
        mask.set(view.subarray(0, expected));
    } else {
        // datatype === 2 (Uint8)
        const view = new Uint8Array(px);
        if (view.length < expected) {
            throw new Error(`NIfTI image data truncated: got ${view.length} voxels, expected ${expected}.`);
        }
        // Uint8 → Uint16 を 1 voxel ずつ widening copy
        for (let i = 0; i < expected; i++) mask[i] = view[i];
    }

    const pix = (hdr as any).pixDims as number[];
    const dx = pix?.[1] ?? 1;
    const dy = pix?.[2] ?? 1;
    const dz = pix?.[3] ?? 1;

    return {
        mask,
        dims: [nx, ny, nz],
        voxelSizeMm: [dx, dy, dz],
    };
};
