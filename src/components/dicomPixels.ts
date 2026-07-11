// DICOM PixelData (7FE0,0010) を、BitsAllocated / PixelRepresentation に従って
// 正しい型付き配列として読み出すヘルパ。
//
// 背景: 旧コードは常に `new Int16Array(buf, offset, length/2)` で読んでいた。
// これは 16-bit grayscale (CT/MR/PET の大半) では正しいが、
// 8-bit の DX / Secondary Capture (BitsAllocated=8) では 2 バイトを 1 サンプルに
// 合成してしまい画素数も値も壊れる。BitsAllocated を見て分岐する必要がある。
//
// 対応: 8-bit (signed/unsigned) と 16-bit (signed/unsigned)。
// 32-bit integer pixel は稀なので未対応 (必要になったら追加)。

import { DataSet } from "dicom-parser";

export interface DicomPixelInfo {
    /** 数値添字でサンプル値を取り出せる型付き配列 (row*cols + col でアクセス) */
    pixels: Uint8Array | Int8Array | Uint16Array | Int16Array;
    bitsAllocated: number;
    signed: boolean;
    /** 1 サンプルあたりのバイト数 (1 または 2) */
    bytesPerPixel: number;
}

/**
 * DataSet から PixelData を正しい datatype で取り出す。
 * decompressed (JPEG Lossless 復号済み) があればそちらを優先する。
 *
 * 注意: PixelData 要素が無い DICOM (SR / PS など) では呼び出し側で
 * elements.x7fe00010 の有無を先に確認すること。ここでは throw する。
 */
export const readDicomPixels = (ds: DataSet): DicomPixelInfo => {
    const pde = ds.elements.x7fe00010;
    if (!pde) throw new Error("DICOM has no PixelData element (7FE0,0010)");

    // BitsAllocated (0028,0100): 1 サンプルのビット幅。欠落時は 16 と仮定 (CT/MR/PET 既定)。
    const bitsAllocated = ds.uint16("x00280100") ?? 16;
    // PixelRepresentation (0028,0103): 0 = unsigned, 1 = signed (2's complement)
    const signed = (ds.uint16("x00280103") ?? 0) === 1;

    const decompressed = (ds as { decompressed?: ArrayBuffer }).decompressed;
    const buf: ArrayBuffer = decompressed == null
        ? (ds.byteArray.buffer as ArrayBuffer)
        : decompressed;
    const offset = decompressed == null ? pde.dataOffset : 0;
    const length = decompressed == null ? pde.length : buf.byteLength;

    if (bitsAllocated <= 8) {
        const pixels = signed
            ? new Int8Array(buf, offset, length)
            : new Uint8Array(buf, offset, length);
        return { pixels, bitsAllocated: 8, signed, bytesPerPixel: 1 };
    }
    // 16-bit (BitsAllocated 9..16 を 16-bit 扱い)
    const pixels = signed
        ? new Int16Array(buf, offset, length / 2)
        : new Uint16Array(buf, offset, length / 2);
    return { pixels, bitsAllocated: 16, signed, bytesPerPixel: 2 };
};

/**
 * PixelData を Int16Array として取り出す。
 * 8-bit pixel は 16-bit に lossless 拡張する (0..255 / -128..127 は Int16 に収まる)。
 * `ImageBox.show()` など Int16Array を期待する既存 API への橋渡し用。
 */
export const readDicomPixelsAsInt16 = (ds: DataSet): Int16Array => {
    const info = readDicomPixels(ds);
    if (info.pixels instanceof Int16Array) return info.pixels;
    // Uint16Array はそのまま Int16Array view にすると 32768 以上が負になるため、
    // 値域が衝突しない範囲 (CT/MR の実値は通常 Int16 範囲) は再ラップで十分だが、
    // 安全のため要素コピーで Int16Array を作る。
    const out = new Int16Array(info.pixels.length);
    out.set(info.pixels);
    return out;
};

/**
 * WindowCenter/WindowWidth タグを持たない DICOM (DX や Secondary Capture に多い)
 * 向けに、pixel データの実際の値域から表示ウィンドウを概算する。
 *
 * intercept/slope 適用後の min/max を窓に採り、min===max の退化ケースは
 * 幅 1 にフォールバックする (0 除算回避)。
 */
export const autoWindowFromPixels = (ds: DataSet): { wc: number; ww: number } => {
    const info = readDicomPixels(ds);
    const intercept = Number(ds.string("x00281052") ?? "0");
    const slope = Number(ds.string("x00281053") ?? "1");
    const px = info.pixels;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < px.length; i++) {
        const v = px[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
    }
    if (!isFinite(mn) || !isFinite(mx)) return { wc: 0, ww: 1 };
    const lo = mn * slope + intercept;
    const hi = mx * slope + intercept;
    const ww = hi > lo ? hi - lo : 1;
    return { wc: (lo + hi) / 2, ww };
};
