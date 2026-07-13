// Mask Uint16Array → r16uint 3D texture cache。
// segStore.maskVersion を invalidation key に使う:
//   recomputeFinalMask / applyThreshold / polygon edit 等で version が bump されるので、
//   GPU 側はその差分を見て texture を up-to-date に保つ。
//
// 注意: マスクはユーザが頻繁に編集するため、version 更新ごとに ~50MB を再 upload する。
// 将来の最適化として「変更スライス範囲だけ部分 update」にできるが、Phase 1.5 では full re-upload。

interface CachedMaskTex {
    version: number;
    nx: number;
    ny: number;
    nz: number;
    texture: any;
}

const cache = new Map<Uint16Array, CachedMaskTex>();

export const getMaskTexture = (
    device: any,
    mask: Uint16Array,
    nx: number,
    ny: number,
    nz: number,
    version: number,
): any => {
    const cached = cache.get(mask);
    if (cached && cached.version === version
        && cached.nx === nx && cached.ny === ny && cached.nz === nz) {
        return cached.texture;
    }
    if (cached) {
        try { cached.texture.destroy?.(); } catch { /* ignore */ }
    }

    const tex = device.createTexture({
        size: [nx, ny, nz],
        dimension: '3d',
        format: 'r16uint',          // Uint16 → R16Uint (sample as u32 in shader)
        usage: 0x4 | 0x2,           // TEXTURE_BINDING | COPY_DST
    });

    const bytesPerRow = nx * 2;     // r16uint = 2 byte/voxel
    const t0 = performance.now();
    device.queue.writeTexture(
        { texture: tex },
        mask.buffer,
        { offset: mask.byteOffset, bytesPerRow, rowsPerImage: ny },
        [nx, ny, nz],
    );
    const ms = performance.now() - t0;
    console.log(`[gpu] mask upload v${version} ${nx}×${ny}×${nz}: ${(mask.byteLength/1024/1024).toFixed(1)} MB in ${ms.toFixed(0)}ms`);

    cache.set(mask, { version, nx, ny, nz, texture: tex });
    return tex;
};

// 1 スライス分だけ mask texture を部分更新する (voxel brush の即時反映用)。
// full re-upload (数十 MB) を避け、変更のあった 1 スライス (数十〜数百 KB) だけを
// writeTexture する。既にキャッシュ済み texture が無い/dims が違う場合は full upload に委譲。
// 更新後 cached.version を newVersion に進めるので、直後の getMaskTexture(mask, newVersion)
// は cache hit してこの texture をそのまま使う (再 upload されない)。
//
// sliceAxis: 0=x 固定 (sagittal) / 1=y 固定 (coronal) / 2=z 固定 (axial)。
// mask.buffer の layout は x 最速 (stride 2) → y (nx*2) → z (nx*ny*2)。
// writeTexture は bytesPerRow/rowsPerImage を full-volume の stride に設定すれば、
// origin + copySize で任意の 1 スライス部分ボックスを直接切り出してアップロードできる。
export const updateMaskTextureSlice = (
    device: any,
    mask: Uint16Array,
    nx: number, ny: number, nz: number,
    version: number,
    sliceAxis: 0 | 1 | 2,
    sliceIndex: number,
): any => {
    const cached = cache.get(mask);
    if (!cached || cached.nx !== nx || cached.ny !== ny || cached.nz !== nz) {
        // texture 未生成 or dims 変化 → full upload (これで生成 & version 同期される)
        return getMaskTexture(device, mask, nx, ny, nz, version);
    }

    let origin: [number, number, number];
    let size: [number, number, number];
    let offsetVox: number;
    if (sliceAxis === 2) {
        if (sliceIndex < 0 || sliceIndex >= nz) return cached.texture;
        origin = [0, 0, sliceIndex]; size = [nx, ny, 1]; offsetVox = sliceIndex * nx * ny;
    } else if (sliceAxis === 1) {
        if (sliceIndex < 0 || sliceIndex >= ny) return cached.texture;
        origin = [0, sliceIndex, 0]; size = [nx, 1, nz]; offsetVox = sliceIndex * nx;
    } else {
        if (sliceIndex < 0 || sliceIndex >= nx) return cached.texture;
        origin = [sliceIndex, 0, 0]; size = [1, ny, nz]; offsetVox = sliceIndex;
    }

    device.queue.writeTexture(
        { texture: cached.texture, origin },
        mask.buffer,
        { offset: mask.byteOffset + offsetVox * 2, bytesPerRow: nx * 2, rowsPerImage: ny },
        size,
    );
    cached.version = version;
    return cached.texture;
};

// 未 overlay 時用 1×1×1 ダミー mask texture (label=0)。
// 「常に 6 binding」にして bind layout を分けない設計のための placeholder。
let dummyMaskTex: any | null = null;
let dummyMaskDevice: any | null = null;

export const getDummyMaskTexture = (device: any): any => {
    if (dummyMaskTex && dummyMaskDevice === device) return dummyMaskTex;
    const tex = device.createTexture({
        size: [1, 1, 1],
        dimension: '3d',
        format: 'r16uint',
        usage: 0x4 | 0x2,
    });
    const data = new Uint16Array([0]);
    device.queue.writeTexture(
        { texture: tex },
        data.buffer,
        { offset: 0, bytesPerRow: 2, rowsPerImage: 1 },
        [1, 1, 1],
    );
    dummyMaskTex = tex;
    dummyMaskDevice = device;
    return tex;
};
