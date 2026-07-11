// JPEG Lossless transfer syntax の DICOM ピクセルを decompress する。
// 対応 transfer syntax UID:
//   - 1.2.840.10008.1.2.4.57  JPEG Lossless, Non-Hierarchical
//   - 1.2.840.10008.1.2.4.70  JPEG Lossless, Non-Hierarchical, First-Order Prediction
//
// 復号バックエンド:
//   - 第一選択: dcmjs-codecs WASM (NativeCodecs.decodeJpeg)。純 JS 比 5-20x 高速。
//   - フォールバック: jpeg-lossless-decoder-js (純 JS、low and slow)。WASM 初期化失敗時。
//
// `ensureWasmCodecsReady()` をアプリ起動時に await して WASM をプリウォームしておくこと。
// 未初期化時は decode() が自動で純 JS 版にフォールバックする (ログ出力)。

import { Decoder } from 'jpeg-lossless-decoder-js';
import { DataSet } from "dicom-parser";
import { isWasmCodecsReady, wasmDecodeJpegLosslessSync } from "./wasmCodec";

const fallbackDecoder = new Decoder();

export const check = (dataSet: DataSet): boolean => {
    const ts = dataSet.string("x00020010") ?? "";
    return ts.endsWith("4.70") || ts.endsWith("4.57");
}

// 純 JS フォールバック (jpeg-lossless-decoder-js)。返り値は ArrayBuffer 互換 (DataView/TypedArray)。
const decodeWithJs = (dataSet: DataSet): ArrayBuffer => {
    const pixelDataElement = dataSet.elements.x7fe00010;
    const k = pixelDataElement.fragments![0].position;
    const output: any = fallbackDecoder.decompress(dataSet.byteArray.buffer, k);
    return (output && output.buffer) ? output.buffer as ArrayBuffer : output as ArrayBuffer;
};

// WASM 経路。ensureWasmCodecsReady() 後でないと throw する。
// 注: single-fragment per frame の DICOM のみ対応 (medical CT/PT は通常これ)。
// multi-fragment はフラグメント間に 8B の item header が挟まるためそのまま結合できない。
const decodeWithWasm = (dataSet: DataSet): ArrayBuffer => {
    const pixelDataElement = dataSet.elements.x7fe00010;
    const frag0 = pixelDataElement.fragments![0];
    const encoded = new Uint8Array(dataSet.byteArray.buffer, frag0.position, frag0.length);

    const decoded = wasmDecodeJpegLosslessSync(encoded, {
        width:  dataSet.uint16('x00280011') ?? 0,
        height: dataSet.uint16('x00280010') ?? 0,
        bitsAllocated: dataSet.uint16('x00280100') ?? 16,
        bitsStored:    dataSet.uint16('x00280101') ?? 16,
        samplesPerPixel: dataSet.uint16('x00280002') ?? 1,
        pixelRepresentation: dataSet.uint16('x00280103') ?? 0,
        planarConfiguration: dataSet.uint16('x00280006') ?? 0,
        photometricInterpretation: dataSet.string('x00280004') ?? 'MONOCHROME2',
    });
    // dcmjs-codecs は Uint8Array.buffer を返す。Vue/main 側で Int16Array で view 可能。
    // sliced view なので buffer 全体を切り出して返す。
    return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
};

let wasmFailedOnce = false;

export const decode = (dataSet: DataSet): ArrayBuffer => {
    if (isWasmCodecsReady() && !wasmFailedOnce) {
        try {
            return decodeWithWasm(dataSet);
        } catch (err) {
            wasmFailedOnce = true;
            console.warn('[jpeg-lossless] WASM decode failed; falling back to JS for the rest of session', err);
        }
    }
    return decodeWithJs(dataSet);
}
