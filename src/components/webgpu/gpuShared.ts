// MIP / VR pipeline 共通の utility:
//   - CLUT storage buffer cache (key: clut配列の identity)
//   - Output OffscreenCanvas + webgpu context (size 変更時のみ reconfigure)
//   - Bind group layout (両 shader で同 layout: uniform / texture3d / clut buf / storage tex2d)

// CLUT cache: clut 配列 (number[][]) → array<vec4<f32>> 256 entries (R,G,B,1) GPU buffer
const clutBufCache = new WeakMap<number[][], any>();

export const getClutBuffer = (device: any, clut: number[][]): any => {
    let buf = clutBufCache.get(clut);
    if (buf) return buf;
    const data = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        const c = clut[i] ?? clut[clut.length - 1];
        data[i * 4]     = (c[0] ?? 0) / 255;
        data[i * 4 + 1] = (c[1] ?? 0) / 255;
        data[i * 4 + 2] = (c[2] ?? 0) / 255;
        data[i * 4 + 3] = 1.0;
    }
    buf = device.createBuffer({
        size: data.byteLength,
        usage: 0x80 | 0x8,  // STORAGE (0x80) | COPY_DST (0x8)
    });
    device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    clutBufCache.set(clut, buf);
    return buf;
};

// Output OffscreenCanvas: 各 box 独立にキャッシュ。
//   key = 描画先の 2D canvas (HTMLCanvasElement)。各 box の cv1 を渡す。
//   並列に複数 box が gpu pipeline を走らせても干渉しないように。
//   サイズ変更時は同じ key の OffscreenCanvas を resize + reconfigure。
//   key が GC されたら entry も自動消滅 (WeakMap)。
interface OffEntry { canvas: OffscreenCanvas; ctx: any; w: number; h: number; }
const offCache = new WeakMap<HTMLCanvasElement, OffEntry>();

export const ensureOffscreen = (
    device: any,
    key: HTMLCanvasElement,
    w: number,
    h: number,
): { canvas: OffscreenCanvas; ctx: any } | null => {
    const cached = offCache.get(key);
    if (cached && cached.w === w && cached.h === h) {
        return { canvas: cached.canvas, ctx: cached.ctx };
    }
    if (typeof OffscreenCanvas === 'undefined') {
        console.warn('[gpu] OffscreenCanvas not supported');
        return null;
    }
    let canvas: OffscreenCanvas;
    if (cached) {
        canvas = cached.canvas;
        canvas.width = w;
        canvas.height = h;
    } else {
        canvas = new OffscreenCanvas(w, h);
    }
    const ctx = (canvas as any).getContext('webgpu');
    if (!ctx) {
        console.warn('[gpu] could not get webgpu context from OffscreenCanvas');
        return null;
    }
    ctx.configure({
        device,
        format: 'rgba8unorm',
        usage: 0x8 | 0x10,   // STORAGE_BINDING | RENDER_ATTACHMENT
        alphaMode: 'opaque',
    });
    offCache.set(key, { canvas, ctx, w, h });
    return { canvas, ctx };
};

// VR bind layout (5 bindings): uniform / volume f32 / clut / output / opacityLut
let cachedVrLayout: any | null = null;
let cachedVrLayoutDev: any | null = null;
export const getVrBindGroupLayout = (device: any): any => {
    if (cachedVrLayout && cachedVrLayoutDev === device) return cachedVrLayout;
    cachedVrLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 2, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: 0x4, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
            { binding: 4, visibility: 0x4, buffer: { type: 'read-only-storage' } },
        ],
    });
    cachedVrLayoutDev = device;
    return cachedVrLayout;
};

// MIP bind layout (6 bindings): VR の 4 + mask u32 + labelClut storage
let cachedMipLayout: any | null = null;
let cachedMipLayoutDev: any | null = null;
export const getMipBindGroupLayout = (device: any): any => {
    if (cachedMipLayout && cachedMipLayoutDev === device) return cachedMipLayout;
    cachedMipLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 2, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: 0x4, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
            { binding: 4, visibility: 0x4, texture: { sampleType: 'uint', viewDimension: '3d' } },
            { binding: 5, visibility: 0x4, buffer: { type: 'read-only-storage' } },
        ],
    });
    cachedMipLayoutDev = device;
    return cachedMipLayout;
};

// Slice bind layout (7 bindings): MIP の 6 + bodyMask u8 (binding 6)
let cachedSliceLayout: any | null = null;
let cachedSliceLayoutDev: any | null = null;
export const getSliceBindGroupLayout = (device: any): any => {
    if (cachedSliceLayout && cachedSliceLayoutDev === device) return cachedSliceLayout;
    cachedSliceLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 2, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: 0x4, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
            { binding: 4, visibility: 0x4, texture: { sampleType: 'uint', viewDimension: '3d' } },
            { binding: 5, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 6, visibility: 0x4, texture: { sampleType: 'uint', viewDimension: '3d' } },
        ],
    });
    cachedSliceLayoutDev = device;
    return cachedSliceLayout;
};

// Fusion MIP / VR bind layout (6 bindings): vol0/clut0/out + vol1/clut1
let cachedFusionMipLayout: any | null = null;
let cachedFusionMipLayoutDev: any | null = null;
export const getFusionMipBindGroupLayout = (device: any): any => {
    if (cachedFusionMipLayout && cachedFusionMipLayoutDev === device) return cachedFusionMipLayout;
    cachedFusionMipLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 2, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: 0x4, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
            { binding: 4, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 5, visibility: 0x4, buffer: { type: 'read-only-storage' } },
        ],
    });
    cachedFusionMipLayoutDev = device;
    return cachedFusionMipLayout;
};

// Fusion bind layout (9 bindings): vol0/clut0/out + vol1/clut1 + mask/labelClut + bodyMask
let cachedFusionLayout: any | null = null;
let cachedFusionLayoutDev: any | null = null;
export const getFusionBindGroupLayout = (device: any): any => {
    if (cachedFusionLayout && cachedFusionLayoutDev === device) return cachedFusionLayout;
    cachedFusionLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 0x4, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 2, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: 0x4, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
            { binding: 4, visibility: 0x4, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
            { binding: 5, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 6, visibility: 0x4, texture: { sampleType: 'uint', viewDimension: '3d' } },
            { binding: 7, visibility: 0x4, buffer: { type: 'read-only-storage' } },
            { binding: 8, visibility: 0x4, texture: { sampleType: 'uint', viewDimension: '3d' } },
        ],
    });
    cachedFusionLayoutDev = device;
    return cachedFusionLayout;
};
