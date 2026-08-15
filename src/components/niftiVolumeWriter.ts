import { gzipSync } from 'fflate';
import type { Volume } from './Volume';

// NIfTI-1 single-file (.nii / .nii.gz) writer for image volumes (Float32 voxels).
// PT は SUV 値、CT は HU、MR は raw 値で書き出す (volume.voxel そのまま)。
// niftiWriter.ts (mask 用 Uint16) と対をなす。
//
// **既定は .nii.gz にすること。** Float32 で書くので CT 512x512x345 だと **362MB** になり、
// 素の .nii ではダウンロードも受け渡しも現実的でない。gzip すると CT/PET とも大きく縮む
// (背景が一定値で埋まっているため)。.nii.gz は TotalSegmentator など下流ツールの標準入力でもある。

const HEADER_SIZE = 348;

/**
 * **可逆な範囲で Int16 を選ぶ。** CT の HU は整数なので Int16 で厳密に表せる。
 * Float32 で書くと値は同じでも仮数部にノイズが乗らないぶん…ではなく、
 * **バイト列の冗長性が失われて gzip が効かなくなる** (実測 CT 512x512x165:
 * Float32 165MB -> gz 51.7MB / 3.2 倍にしかならない)。Int16 なら生サイズが半分になり、
 * かつ同じ値が同じバイト列になるので圧縮も効く。
 * PET の SUV は小数なので Float32 のまま。**値が 1 つでも整数でない / 範囲外なら Float32**。
 */
// **判定は voxel 配列ごとに 1 回だけにすること。** 43M voxel の全走査は数百 ms かかるので、
// writer と sidecar で二重に走らせない。voxel の中身が書き換わる経路 (SUV mode 切替など) は
// 参照ごと差し替えるか evict するので、参照をキーにしたキャッシュで十分。
const int16Cache = new WeakMap<object, boolean>();
const canUseInt16 = (voxel: ArrayLike<number>): boolean => {
    const cached = int16Cache.get(voxel as unknown as object);
    if (cached !== undefined) return cached;
    let ok = true;
    for (let i = 0; i < voxel.length; i++) {
        const v = voxel[i];
        // Number.isInteger より (v | 0) === v の方が速いが、範囲外で壊れるので範囲を先に見る。
        if (v < -32768 || v > 32767 || !Number.isInteger(v)) { ok = false; break; }
    }
    int16Cache.set(voxel as unknown as object, ok);
    return ok;
};

/** 非圧縮の .nii を作る。圧縮版は `writeNiftiVolumeAsync`。 */
export const writeNiftiFloat32 = (vol: Volume, intentName: string = 'image'): Blob => {
    const nx = vol.nx, ny = vol.ny, nz = vol.nz;
    const expected = nx * ny * nz;
    if (vol.voxel.length !== expected) {
        throw new Error(`voxel length ${vol.voxel.length} != ${expected}`);
    }

    const useInt16 = canUseInt16(vol.voxel);
    // voxel を書き出す。Int16 で表せるなら Int16 (可逆かつ小さい)、でなければ Float32。
    //
    // **`Int16Array.from(typedArray)` を使わないこと。** iterator 経由になり桁違いに遅い
    // (実測 CT 43.3M voxel: 書き出しが 84ms -> 9305ms に悪化した)。
    // 事前確保して素の for で詰める。
    let voxOut: Int16Array | Float32Array;
    if (useInt16) {
        const a = new Int16Array(expected);
        const src = vol.voxel;
        for (let i = 0; i < expected; i++) a[i] = src[i];
        voxOut = a;
    } else {
        voxOut = vol.voxel instanceof Float32Array ? vol.voxel : Float32Array.from(vol.voxel);
    }

    const totalSize = HEADER_SIZE + 4 + voxOut.byteLength;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // sizeof_hdr
    dv.setInt32(0, 348, true);
    // dim[8] = [3, nx, ny, nz, 1, 1, 1, 1]
    dv.setInt16(40, 3, true);
    dv.setInt16(42, nx, true);
    dv.setInt16(44, ny, true);
    dv.setInt16(46, nz, true);
    dv.setInt16(48, 1, true);
    dv.setInt16(50, 1, true);
    dv.setInt16(52, 1, true);
    dv.setInt16(54, 1, true);
    // datatype: 4 = INT16 / 16 = FLOAT32
    dv.setInt16(70, useInt16 ? 4 : 16, true);
    dv.setInt16(72, useInt16 ? 16 : 32, true);
    // pixdim[0]=qfac, pixdim[1..3] = voxel sizes (mm)
    dv.setFloat32(76, 1.0, true);
    dv.setFloat32(80, vol.vectorX.length(), true);
    dv.setFloat32(84, vol.vectorY.length(), true);
    dv.setFloat32(88, vol.vectorZ.length(), true);
    // vox_offset
    dv.setFloat32(108, HEADER_SIZE + 4, true);
    // scl_slope=0, scl_inter=0 (no rescaling — voxel is already final)
    dv.setFloat32(112, 0, true);
    dv.setFloat32(116, 0, true);
    // xyzt_units = mm | sec
    dv.setUint8(123, 2 | 8);
    // descrip (148, 80B): "metavol|<modality>|<NxxNyxNz>"
    const mod = vol.metadata?.modality ?? '';
    const descrip = `metavol|${mod}|${nx}x${ny}x${nz}`;
    writeAscii(u8, 148, descrip, 80);
    // qform=0, sform=1 (scanner anatomical, srow ベースの affine 採用)
    dv.setInt16(252, 0, true);
    dv.setInt16(254, 1, true);
    // 本アプリの world は DICOM LPS、NIfTI は RAS+。書き出し時は x,y 成分を反転して
    // RAS に戻す (reader 側の逆変換と対。これを省くと save→load で x,y が反転する)。
    const vx = vol.vectorX, vy = vol.vectorY, vz = vol.vectorZ, p0 = vol.imagePosition;
    // qoffset = imagePosition (RAS)
    dv.setFloat32(268, -p0.x, true);
    dv.setFloat32(272, -p0.y, true);
    dv.setFloat32(276,  p0.z, true);
    // srow_x / srow_y / srow_z (row-major, 各列が voxel 軸の world 変位)
    dv.setFloat32(280, -vx.x, true);
    dv.setFloat32(284, -vy.x, true);
    dv.setFloat32(288, -vz.x, true);
    dv.setFloat32(292, -p0.x, true);
    dv.setFloat32(296, -vx.y, true);
    dv.setFloat32(300, -vy.y, true);
    dv.setFloat32(304, -vz.y, true);
    dv.setFloat32(308, -p0.y, true);
    dv.setFloat32(312,  vx.z, true);
    dv.setFloat32(316,  vy.z, true);
    dv.setFloat32(320,  vz.z, true);
    dv.setFloat32(324,  p0.z, true);
    // intent_name
    writeAscii(u8, 328, intentName, 16);
    // magic "n+1\0"
    u8[344] = 0x6e; u8[345] = 0x2b; u8[346] = 0x31; u8[347] = 0x00;

    // Voxel data
    if (useInt16) {
        new Int16Array(buf, HEADER_SIZE + 4, voxOut.length).set(voxOut as Int16Array);
    } else {
        new Float32Array(buf, HEADER_SIZE + 4, voxOut.length).set(voxOut as Float32Array);
    }

    return new Blob([buf], { type: 'application/octet-stream' });
};

/**
 * **変換の入口**。既定で gzip し `.nii.gz` を返す。`gzip: false` なら素の `.nii`。
 * gzip は volume サイズに比例して時間がかかるので async にしてある
 * (実測は `node scripts/dicom2nifti-check.mjs`)。
 */
export const writeNiftiVolumeAsync = async (
    vol: Volume,
    opts?: { gzip?: boolean; intentName?: string },
): Promise<{ blob: Blob; ext: '.nii' | '.nii.gz' }> => {
    const raw = writeNiftiFloat32(vol, opts?.intentName ?? 'image');
    if (opts?.gzip === false) return { blob: raw, ext: '.nii' };
    // **native CompressionStream を優先すること。** fflate の `gzipSync` は同期なので
    // CT 512x512x165 で **12 秒 UI が固まった** (実測)。CompressionStream はブラウザ内部の
    // background thread で走るので固まらない。無い環境 (古い browser) だけ fflate に落とす。
    if (typeof CompressionStream === 'function') {
        const cs = new CompressionStream('gzip');
        const blob = await new Response(raw.stream().pipeThrough(cs)).blob();
        return { blob: new Blob([blob], { type: 'application/gzip' }), ext: '.nii.gz' };
    }
    const buf = await raw.arrayBuffer();
    const gz = gzipSync(new Uint8Array(buf));
    return { blob: new Blob([gz as BlobPart], { type: 'application/gzip' }), ext: '.nii.gz' };
};

/** 出力ファイル名の共通規則。series description と UID 末尾から安全な名前を作る。 */
export const niftiBaseName = (vol: Volume, fallback: string): string => {
    const meta = vol.metadata;
    const desc = (meta?.seriesDescription ?? '').trim();
    const uidTail = (meta?.seriesUID ?? fallback).slice(-16);
    const mod = meta?.modality ?? '';
    const parts = [mod, desc, uidTail].filter(Boolean).join('_');
    return (parts || fallback).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
};

// Volume metadata + dim/voxel/affine をまとめた sidecar JSON。
// modality / suvFactor / 単位 / 患者重量 / 取得時刻 / SUV 計算の透明性情報を含む。
export const buildVolumeSidecarJson = (vol: Volume): string => {
    const meta = vol.metadata;
    const sidecar: Record<string, unknown> = {
        nx: vol.nx, ny: vol.ny, nz: vol.nz,
        voxelSizeMm: [vol.vectorX.length(), vol.vectorY.length(), vol.vectorZ.length()],
        imagePositionPatient: [vol.imagePosition.x, vol.imagePosition.y, vol.imagePosition.z],
        srow: [
            [vol.vectorX.x, vol.vectorY.x, vol.vectorZ.x, vol.imagePosition.x],
            [vol.vectorX.y, vol.vectorY.y, vol.vectorZ.y, vol.imagePosition.y],
            [vol.vectorX.z, vol.vectorY.z, vol.vectorZ.z, vol.imagePosition.z],
        ],
        // PT で SUV mode なら voxel は SUV 単位。CT は HU、MR は raw。
        unit: meta?.modality === 'PT' ? 'SUV' : (meta?.modality === 'CT' ? 'HU' : 'raw'),
        // 書き出しに使った NIfTI datatype。Int16 で厳密に表せるときだけ Int16 になる。
        niftiDatatype: canUseInt16(vol.voxel) ? 'INT16' : 'FLOAT32',
        modality: meta?.modality,
        seriesUID: meta?.seriesUID,
        seriesDescription: meta?.seriesDescription,
        suvFactor: meta?.suvFactor,
        patientWeightKg: meta?.patientWeightKg,
        radionuclideHalfLifeSec: meta?.radionuclideHalfLifeSec,
        radionuclideTotalDoseBq: meta?.radionuclideTotalDoseBq,
        doseStartTimeSec: meta?.doseStartTimeSec,
        acquisitionTimeSec: meta?.acquisitionTimeSec,
        units: meta?.units,
        suvOk: meta?.suvOk,
        suvSource: meta?.suvSource,
        suvReason: meta?.suvReason,
        acquisitionDateTimeIso: meta?.acquisitionDateTimeIso,
        injectionDateTimeIso: meta?.injectionDateTimeIso,
        decayCorrection: meta?.decayCorrection,
        exporter: 'metavol-web',
        exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(sidecar, null, 2);
};

const writeAscii = (u8: Uint8Array, offset: number, s: string, maxLen: number) => {
    for (let i = 0; i < maxLen; i++) {
        u8[offset + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
    }
};
