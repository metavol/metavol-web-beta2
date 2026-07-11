import type { Volume } from '../Volume';

// NIfTI-1 single-file (.nii) writer for Uint16 mask volumes.
// Writes a 348-byte header + 4 magic bytes ("n+1\0") + raw voxel data.
//
// Reference: https://nifti.nimh.nih.gov/nifti-1/

const HEADER_SIZE = 348;

export const writeNiftiUint16 = (mask: Uint16Array, pet: Volume): Blob => {
    const nx = pet.nx, ny = pet.ny, nz = pet.nz;
    if (mask.length !== nx * ny * nz) {
        throw new Error(`mask length ${mask.length} != ${nx*ny*nz}`);
    }

    const totalSize = HEADER_SIZE + 4 + mask.byteLength;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // sizeof_hdr: 348
    dv.setInt32(0, 348, true);
    // dim_info: 0 (offset 39)
    // dim[8]: number of dims followed by sizes (offset 40)
    dv.setInt16(40, 3, true);     // dim[0] = 3
    dv.setInt16(42, nx, true);    // dim[1]
    dv.setInt16(44, ny, true);    // dim[2]
    dv.setInt16(46, nz, true);    // dim[3]
    dv.setInt16(48, 1, true);     // dim[4]
    dv.setInt16(50, 1, true);     // dim[5]
    dv.setInt16(52, 1, true);     // dim[6]
    dv.setInt16(54, 1, true);     // dim[7]
    // intent_p1/p2/p3 (offset 56,60,64): 0
    // intent_code (72): 0
    // datatype (70): UINT16 = 512
    dv.setInt16(70, 512, true);
    // bitpix (72): 16
    dv.setInt16(72, 16, true);
    // slice_start (74): 0
    // pixdim[8] (76..107): pixdim[0]=qfac, then voxel sizes
    dv.setFloat32(76, 1.0, true);                                // qfac
    dv.setFloat32(80, pet.vectorX.length(), true);               // dx
    dv.setFloat32(84, pet.vectorY.length(), true);               // dy
    dv.setFloat32(88, pet.vectorZ.length(), true);               // dz
    dv.setFloat32(92, 0, true);
    dv.setFloat32(96, 0, true);
    dv.setFloat32(100, 0, true);
    dv.setFloat32(104, 0, true);
    // vox_offset (108): start of voxel data
    dv.setFloat32(108, HEADER_SIZE + 4, true);
    // scl_slope (112) / scl_inter (116): 0/0 (no rescaling)
    dv.setFloat32(112, 0, true);
    dv.setFloat32(116, 0, true);
    // slice_end (120) i16: 0
    // slice_code (122) u8: 0
    // xyzt_units (123) u8: mm + sec = 2 | 8
    dv.setUint8(123, 2 | 8);
    // cal_max/min (124,128): 0
    dv.setFloat32(124, 0, true);
    dv.setFloat32(128, 0, true);
    // slice_duration (132) f32: 0
    // toffset (136) f32: 0
    // glmax/glmin (140,144) i32: 0
    // descrip (148, 80 bytes): "metavol|sUID=<short>|<nx>x<ny>x<nz>"
    // 80B しかないので seriesUID は末尾 24 文字に切り詰める。完全 UID は sidecar JSON に。
    const uid = (pet.metadata?.seriesUID ?? '').slice(-24);
    const descrip = `metavol|sUID=${uid}|${nx}x${ny}x${nz}`;
    writeAscii(u8, 148, descrip, 80);
    // aux_file (228, 24 bytes): empty
    // qform_code (252) i16: 0  (use sform)
    dv.setInt16(252, 0, true);
    // sform_code (254) i16: 1 (scanner anatomical)
    dv.setInt16(254, 1, true);
    // quatern_b/c/d (256,260,264) and qoffset_x/y/z (268,272,276)
    dv.setFloat32(256, 0, true);
    dv.setFloat32(260, 0, true);
    dv.setFloat32(264, 0, true);
    dv.setFloat32(268, pet.imagePosition.x, true);
    dv.setFloat32(272, pet.imagePosition.y, true);
    dv.setFloat32(276, pet.imagePosition.z, true);
    // srow_x (280..292) f32 x4
    const vx = pet.vectorX, vy = pet.vectorY, vz = pet.vectorZ, p0 = pet.imagePosition;
    dv.setFloat32(280, vx.x, true);
    dv.setFloat32(284, vy.x, true);
    dv.setFloat32(288, vz.x, true);
    dv.setFloat32(292, p0.x, true);
    // srow_y (296..308)
    dv.setFloat32(296, vx.y, true);
    dv.setFloat32(300, vy.y, true);
    dv.setFloat32(304, vz.y, true);
    dv.setFloat32(308, p0.y, true);
    // srow_z (312..324)
    dv.setFloat32(312, vx.z, true);
    dv.setFloat32(316, vy.z, true);
    dv.setFloat32(320, vz.z, true);
    dv.setFloat32(324, p0.z, true);
    // intent_name (328, 16 bytes)
    writeAscii(u8, 328, "label", 16);
    // magic (344, 4 bytes): "n+1\0"
    u8[344] = 0x6e;
    u8[345] = 0x2b;
    u8[346] = 0x31;
    u8[347] = 0x00;

    // Voxel data starts at offset HEADER_SIZE+4 = 352
    const out = new Uint16Array(buf, HEADER_SIZE + 4, mask.length);
    out.set(mask);

    return new Blob([buf], { type: 'application/octet-stream' });
};

const writeAscii = (u8: Uint8Array, offset: number, s: string, maxLen: number) => {
    for (let i = 0; i < maxLen; i++) {
        u8[offset + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
    }
};

export const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
