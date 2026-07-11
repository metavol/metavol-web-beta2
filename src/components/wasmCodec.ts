// dcmjs-codecs を使った WASM ベースの DICOM 圧縮復号ラッパ。
// JPEG Lossless (.57 / .70) は NativeCodecs.decodeJpeg() で復号する。
// 純 JS の jpeg-lossless-decoder-js より大幅に高速 (期待 5-20x)。
//
// 使い方:
//   await ensureWasmCodecsReady();
//   const decoded = await wasmDecodeJpegLossless(encodedBytes, frameAttrs);
//
// 初期化は `ensureWasmCodecsReady()` を 1 度だけ呼べば良い (内部で one-shot Promise を返す)。

// @ts-expect-error (dcmjs-codecs は型定義あるが namespace 形式で import 困難)
import { NativeCodecs, Context } from 'dcmjs-codecs';
// Vite の ?url import で WASM の最終 URL を取得。HMR / build 両対応。
import wasmUrl from 'dcmjs-codecs/build/dcmjs-native-codecs.wasm?url';

let initPromise: Promise<void> | null = null;
let initFailed = false;

export const ensureWasmCodecsReady = (): Promise<void> => {
    if (initFailed) return Promise.reject(new Error('NativeCodecs init previously failed'));
    if (initPromise) return initPromise;
    initPromise = NativeCodecs.initializeAsync({
        webAssemblyModulePathOrUrl: wasmUrl,
        logCodecsInfo: false,
        logCodecsTrace: false,
    }).catch((err: unknown) => {
        initFailed = true;
        initPromise = null;
        throw err;
    });
    return initPromise;
};

export interface FrameAttrs {
    width: number;
    height: number;
    bitsAllocated: number;
    bitsStored: number;
    samplesPerPixel: number;       // 通常 1 (grayscale) / 3 (RGB)
    pixelRepresentation: number;   // 0=Unsigned, 1=Signed
    planarConfiguration?: number;  // 0=Interleaved, 1=Planar (color のみ意味)
    photometricInterpretation?: string; // 'MONOCHROME2' / 'MONOCHROME1' / 'RGB' / etc
}

export const isWasmCodecsReady = (): boolean => NativeCodecs.isInitialized?.() ?? false;

// JPEG Lossless (.57 / .70) を WASM で復号 (sync)。事前に ensureWasmCodecsReady() を await しておくこと。
// 返り値は raw pixel bytes (Uint8Array)。16-bit 画像なら呼び出し側で
// `new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength/2)` で view する。
export const wasmDecodeJpegLosslessSync = (
    encodedBuffer: Uint8Array,
    attrs: FrameAttrs,
): Uint8Array => {
    if (!isWasmCodecsReady()) {
        throw new Error('WASM codecs not initialized; call ensureWasmCodecsReady() first');
    }
    const ctx = new Context({
        width: attrs.width,
        height: attrs.height,
        bitsAllocated: attrs.bitsAllocated,
        bitsStored: attrs.bitsStored,
        samplesPerPixel: attrs.samplesPerPixel,
        pixelRepresentation: attrs.pixelRepresentation,
        planarConfiguration: attrs.planarConfiguration ?? 0,
        photometricInterpretation: attrs.photometricInterpretation ?? 'MONOCHROME2',
        encodedBuffer,
    });
    const result = NativeCodecs.decodeJpeg(ctx, { convertColorspaceToRgb: false });
    const decoded: Uint8Array | undefined = result.getDecodedBuffer();
    if (!decoded) throw new Error('decodeJpeg returned no decoded buffer');
    return decoded;
};
