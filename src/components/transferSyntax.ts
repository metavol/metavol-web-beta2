// DICOM transfer syntax UID から、metavol-web で復号可能かどうかを判定する。
// 対応: Implicit/Explicit Little Endian と JPEG Lossless (.57 / .70)。
// その他 (JPEG Baseline / JPEG-LS / JPEG 2000 / RLE / Big Endian) は現状未対応。

import { DataSet } from "dicom-parser";

export interface TransferSyntaxInfo {
    uid: string;
    name: string;
    supported: boolean;
    reason?: string; // 未対応理由 (UI に表示)
}

const TABLE: Record<string, { name: string; supported: boolean; reason?: string }> = {
    '1.2.840.10008.1.2':       { name: 'Implicit VR Little Endian', supported: true },
    '1.2.840.10008.1.2.1':     { name: 'Explicit VR Little Endian', supported: true },
    '1.2.840.10008.1.2.2':     { name: 'Explicit VR Big Endian',    supported: false, reason: 'Big endian byte order not supported' },
    '1.2.840.10008.1.2.4.50':  { name: 'JPEG Baseline (Process 1)',  supported: false, reason: 'JPEG Baseline (lossy) not supported' },
    '1.2.840.10008.1.2.4.51':  { name: 'JPEG Extended (Process 2&4)',supported: false, reason: 'JPEG Extended (lossy) not supported' },
    '1.2.840.10008.1.2.4.57':  { name: 'JPEG Lossless, Non-Hierarchical',                       supported: true },
    '1.2.840.10008.1.2.4.70':  { name: 'JPEG Lossless, Non-Hierarchical, First-Order Prediction', supported: true },
    '1.2.840.10008.1.2.4.80':  { name: 'JPEG-LS Lossless',           supported: false, reason: 'JPEG-LS not supported (consider JPEG-LS WASM codec)' },
    '1.2.840.10008.1.2.4.81':  { name: 'JPEG-LS Near-Lossless',      supported: false, reason: 'JPEG-LS not supported' },
    '1.2.840.10008.1.2.4.90':  { name: 'JPEG 2000 Lossless',         supported: false, reason: 'JPEG 2000 not supported (consider OpenJPEG WASM codec)' },
    '1.2.840.10008.1.2.4.91':  { name: 'JPEG 2000',                  supported: false, reason: 'JPEG 2000 not supported' },
    '1.2.840.10008.1.2.5':     { name: 'RLE Lossless',               supported: false, reason: 'RLE not supported' },
};

export const getTransferSyntaxInfo = (ds: DataSet): TransferSyntaxInfo => {
    const uid = ds.string('x00020010') ?? '';
    const known = TABLE[uid];
    if (known) return { uid, ...known };
    return {
        uid,
        name: uid ? `Unknown (${uid})` : 'Unknown (no transfer syntax)',
        supported: false,
        reason: `Unknown transfer syntax UID: ${uid || '(none)'}`,
    };
};

// シリーズ単位 (=同じ transfer syntax 前提) で判定。最初の dataset を採る。
export const getSeriesTransferSyntaxInfo = (dsList: DataSet[] | null | undefined): TransferSyntaxInfo => {
    if (!dsList || dsList.length === 0) {
        return { uid: '', name: 'No DICOM', supported: true };
    }
    return getTransferSyntaxInfo(dsList[0]);
};
