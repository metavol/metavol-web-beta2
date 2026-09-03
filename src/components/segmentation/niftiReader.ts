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

// ---------------------------------------------------------------------------
// D&D で落ちてきた NIfTI が「ラベルマスク」かどうかの判定 (2026-08)
// ---------------------------------------------------------------------------
//
// 画像もマスクも **同じ d&d** で読み込めるようにするための自動判定。
// ここで true になっても即マスク扱いにはせず、**必ず確認ダイアログを挟む**
// (自動判定 + 手動確認。誤検出のコストは Cancel 1 クリックに抑える)。
//
// 判定基準 (すべて値ベース。datatype では判定しない — SPM はマスクを float で
// 書くことがあり、逆に 8-bit の解剖画像もある):
//   - 全 voxel が 0 以上 65535 以下の整数 (NaN があれば除外 = マスクではない)
//   - 0 以外の値が 1 つ以上ある
//   - 異なり値の数が maxDistinct (既定 512) 以下
//     (Neuromorphometrics 136 / FreeSurfer aseg ~45 は通る。CT/MR の連続値は数千あるので落ちる)
//
// 8-bit 解剖画像 (異なり値 ≤256) は通り抜けるが、dims が既存 volume と一致する
// 場合にしか呼ばれない + 確認ダイアログがあるので実害は小さい。
export const analyzeLabelMaskCandidate = (
    voxel: Float32Array | ArrayLike<number>,
    maxDistinct = 512,
): { labelIds: number[] } | null => {
    const seen = new Set<number>();
    let nonZero = 0;
    const n = voxel.length;
    for (let i = 0; i < n; i++) {
        const v = (voxel as any)[i] as number;
        if (!Number.isFinite(v)) return null;          // NaN/Inf はマスクにあり得ない
        if (v < 0 || v > 65535 || !Number.isInteger(v)) return null;
        if (v !== 0) {
            nonZero++;
            if (!seen.has(v)) {
                seen.add(v);
                if (seen.size > maxDistinct) return null;
            }
        }
    }
    if (nonZero === 0 || seen.size === 0) return null;
    return { labelIds: [...seen].sort((a, b) => a - b) };
};
