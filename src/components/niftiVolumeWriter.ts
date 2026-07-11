import type { Volume } from './Volume';

// NIfTI-1 single-file (.nii) writer for image volumes (Float32 voxels).
// PT は SUV 値、CT は HU、MR は raw 値で書き出す (volume.voxel そのまま)。
// niftiWriter.ts (mask 用 Uint16) と対をなす。

const HEADER_SIZE = 348;

export const writeNiftiFloat32 = (vol: Volume, intentName: string = 'image'): Blob => {
    const nx = vol.nx, ny = vol.ny, nz = vol.nz;
    const expected = nx * ny * nz;
    if (vol.voxel.length !== expected) {
        throw new Error(`voxel length ${vol.voxel.length} != ${expected}`);
    }

    // voxel を Float32 で書き出す。元が Float32Array ならそのまま使える。
    const voxF32 = vol.voxel instanceof Float32Array
        ? vol.voxel
        : Float32Array.from(vol.voxel);

    const totalSize = HEADER_SIZE + 4 + voxF32.byteLength;
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
    // datatype = 16 (FLOAT32), bitpix = 32
    dv.setInt16(70, 16, true);
    dv.setInt16(72, 32, true);
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
    // qoffset = imagePosition
    dv.setFloat32(268, vol.imagePosition.x, true);
    dv.setFloat32(272, vol.imagePosition.y, true);
    dv.setFloat32(276, vol.imagePosition.z, true);
    // srow_x / srow_y / srow_z
    const vx = vol.vectorX, vy = vol.vectorY, vz = vol.vectorZ, p0 = vol.imagePosition;
    dv.setFloat32(280, vx.x, true);
    dv.setFloat32(284, vy.x, true);
    dv.setFloat32(288, vz.x, true);
    dv.setFloat32(292, p0.x, true);
    dv.setFloat32(296, vx.y, true);
    dv.setFloat32(300, vy.y, true);
    dv.setFloat32(304, vz.y, true);
    dv.setFloat32(308, p0.y, true);
    dv.setFloat32(312, vx.z, true);
    dv.setFloat32(316, vy.z, true);
    dv.setFloat32(320, vz.z, true);
    dv.setFloat32(324, p0.z, true);
    // intent_name
    writeAscii(u8, 328, intentName, 16);
    // magic "n+1\0"
    u8[344] = 0x6e; u8[345] = 0x2b; u8[346] = 0x31; u8[347] = 0x00;

    // Voxel data
    const out = new Float32Array(buf, HEADER_SIZE + 4, voxF32.length);
    out.set(voxF32);

    return new Blob([buf], { type: 'application/octet-stream' });
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
