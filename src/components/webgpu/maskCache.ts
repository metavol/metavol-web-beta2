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
