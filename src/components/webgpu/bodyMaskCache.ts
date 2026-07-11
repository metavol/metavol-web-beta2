// CT body mask (Uint8Array, 0=外/1=内) → r8uint 3D texture cache。
// CT 寝台除去用。segStore.ctBodyMask は計算後ほぼ静的 (再計算は ON/OFF 切替時のみ)
// なので Uint8Array 参照同一性で十分。

interface CachedTex {
    nx: number;
    ny: number;
    nz: number;
    texture: any;
}

const cache = new WeakMap<Uint8Array, CachedTex>();

export const getBodyMaskTexture = (
    device: any,
    mask: Uint8Array,
    nx: number,
    ny: number,
    nz: number,
): any => {
    const cached = cache.get(mask);
    if (cached && cached.nx === nx && cached.ny === ny && cached.nz === nz) {
        return cached.texture;
    }
    const tex = device.createTexture({
        size: [nx, ny, nz],
        dimension: '3d',
        format: 'r8uint',
        usage: 0x4 | 0x2,   // TEXTURE_BINDING | COPY_DST
    });
    device.queue.writeTexture(
        { texture: tex },
        mask.buffer,
        { offset: mask.byteOffset, bytesPerRow: nx, rowsPerImage: ny },
        [nx, ny, nz],
    );
    console.log(`[gpu] body-mask upload ${nx}×${ny}×${nz}: ${(mask.byteLength/1024/1024).toFixed(1)} MB`);
    cache.set(mask, { nx, ny, nz, texture: tex });
    return tex;
};

// Dummy 1×1×1 body mask (value=1, "always inside body") — overlay 無し相当
let dummy: any | null = null;
let dummyDev: any | null = null;
export const getDummyBodyMaskTexture = (device: any): any => {
    if (dummy && dummyDev === device) return dummy;
    const tex = device.createTexture({
        size: [1, 1, 1], dimension: '3d', format: 'r8uint',
        usage: 0x4 | 0x2,
    });
    device.queue.writeTexture({ texture: tex }, new Uint8Array([1]).buffer,
        { offset: 0, bytesPerRow: 1, rowsPerImage: 1 }, [1, 1, 1]);
    dummy = tex; dummyDev = device;
    return tex;
};
