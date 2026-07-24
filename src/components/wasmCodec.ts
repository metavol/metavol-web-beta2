// dcmjs-codecs を使った WASM ベースの DICOM 圧縮復号ラッパ。
// JPEG Lossless (.57 / .70) は NativeCodecs.decodeJpeg() で復号する。
// 純 JS の jpeg-lossless-decoder-js より大幅に高速 (期待 5-20x)。
//
// dcmjs-codecs (JS ~800KB + WASM ~4MB) は **動的 import で遅延ロード**する。
// これにより、圧縮 DICOM を含むケースを実際に開くまで初期バンドル / ネットワークに
// 載らない (通常起動や NIfTI/非圧縮 DICOM では一切ロードされない)。
//
// 使い方:
//   await ensureWasmCodecsReady();               // 初回のみ実 import + WASM instantiate
//   const decoded = wasmDecodeJpegLosslessSync(encodedBytes, frameAttrs);
//
// 初期化は `ensureWasmCodecsReady()` を 1 度だけ呼べば良い (内部で one-shot Promise を返す)。

// 動的ロードした dcmjs-codecs の参照 (init 完了までは null)。
let NativeCodecs: any = null;
let Context: any = null;

let initPromise: Promise<void> | null = null;
let initFailed = false;

export const ensureWasmCodecsReady = (): Promise<void> => {
    if (initFailed) return Promise.reject(new Error('NativeCodecs init previously failed'));
    if (initPromise) return initPromise;
    initPromise = (async () => {
        // dcmjs-codecs 本体と WASM URL を遅延ロード (Vite が専用チャンクへ分離する)。
        const mod: any = await import('dcmjs-codecs');
        NativeCodecs = mod.NativeCodecs;
        Context = mod.Context;
        const wasmUrl: string = ((await import(
            'dcmjs-codecs/build/dcmjs-native-codecs.wasm?url'
        )) as any).default;
        await NativeCodecs.initializeAsync({
            webAssemblyModulePathOrUrl: wasmUrl,
            logCodecsInfo: false,
            logCodecsTrace: false,
        });
    })().catch((err: unknown) => {
        initFailed = true;
        initPromise = null;
        NativeCodecs = null;
        Context = null;
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

export const isWasmCodecsReady = (): boolean => NativeCodecs?.isInitialized?.() ?? false;

// JPEG Lossless (.57 / .70) を WASM で復号 (sync)。事前に ensureWasmCodecsReady() を await しておくこと。
// 返り値は raw pixel bytes (Uint8Array)。16-bit 画像なら呼び出し側で
// `new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength/2)` で view する。
export const wasmDecodeJpegLosslessSync = (
    encodedBuffer: Uint8Array,
    attrs: FrameAttrs,
): Uint8Array => {
    if (!isWasmCodecsReady() || !Context) {
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
