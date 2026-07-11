// Volume.voxel (Float32Array | Int16Array) → 3D r32float texture。
// Volume identity は voxel TypedArray の参照同一性 (Pinia Proxy 不変)
// で判定し、同じ Volume が来たら GPU upload を skip する。
//
// メモリ目安:
//   144³ PET (Float32) = 11.4 MB → GPU 3D texture 同サイズ
//   512²×400 CT (Float32 化後) = 419 MB → 大型 GPU だが許容範囲。WebGPU の
//   maxBufferSize / maxTextureDimension3D に注意 (実装依存だが大概 2048)。

interface CachedTex {
    voxelRef: Float32Array | Int16Array;  // identity key
    nx: number;
    ny: number;
    nz: number;
    texture: any;
}

const cache = new WeakMap<Float32Array | Int16Array, CachedTex>();

export const getVolumeTexture = async (
    device: any,
    voxel: Float32Array | Int16Array,
    nx: number,
    ny: number,
    nz: number,
): Promise<any> => {
    const cached = cache.get(voxel);
    if (cached && cached.nx === nx && cached.ny === ny && cached.nz === nz) {
        return cached.texture;
    }

    // texture: r32float, dim 3d, COPY_DST | TEXTURE_BINDING
    const tex = device.createTexture({
        size: [nx, ny, nz],
        dimension: '3d',
        format: 'r32float',
        usage: 0x4 | 0x2,  // TEXTURE_BINDING (4) | COPY_DST (2)
        // ↑ webgpu/types がない環境でも動くよう数値で書く。
        //   実際の定数: GPUTextureUsage.TEXTURE_BINDING = 0x4, COPY_DST = 0x2
    });

    // Int16 は Float32 化してアップロード（r32float は float のみ受付）
    let f32: Float32Array;
    if (voxel instanceof Float32Array) {
        f32 = voxel;
    } else {
        f32 = new Float32Array(voxel.length);
        for (let i = 0; i < voxel.length; i++) f32[i] = voxel[i];
    }

    const bytesPerRow = nx * 4;     // r32float = 4 byte/voxel
    const rowsPerImage = ny;
    const t0 = performance.now();
    device.queue.writeTexture(
        { texture: tex },
        f32.buffer,
        { offset: f32.byteOffset, bytesPerRow, rowsPerImage },
        [nx, ny, nz],
    );
    const ms = performance.now() - t0;
    const mb = (f32.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[gpu] volume upload ${nx}×${ny}×${nz}: ${mb} MB in ${ms.toFixed(0)}ms`);

    cache.set(voxel, { voxelRef: voxel, nx, ny, nz, texture: tex });
    return tex;
};

// Volume が破棄されたとき手動で GPU メモリを解放したい場合に使う。
// 通常は WeakMap + GC + texture.destroy 暗黙で十分。
export const evictVolumeTexture = (voxel: Float32Array | Int16Array): void => {
    const c = cache.get(voxel);
    if (c) {
        try { c.texture.destroy?.(); } catch { /* ignore */ }
        cache.delete(voxel);
    }
};
