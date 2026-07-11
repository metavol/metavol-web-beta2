// Fusion MPR slice の compute pipeline + 1-call render API。
// 9 binding (vol0 + clut0 + out + vol1 + clut1 + mask + labelClut + bodyMask)。

import { getGpuDevice } from './gpuContext';
import { getVolumeTexture } from './volumeCache';
import { getMaskTexture, getDummyMaskTexture } from './maskCache';
import { getBodyMaskTexture, getDummyBodyMaskTexture } from './bodyMaskCache';
import { FUSION_SHADER_WGSL } from './fusionShader';
import { getClutBuffer, ensureOffscreen, getFusionBindGroupLayout } from './gpuShared';
import { usePerfStore } from '../../stores/perf';

interface PipelineCache {
    device: any;
    pipeline: any;
    bindLayout: any;
    uniformBuf: any;
}

let pipelineCache: PipelineCache | null = null;

const UNIFORM_SIZE = 240;   // 15 vec4 × 16

const ensurePipeline = async (): Promise<PipelineCache | null> => {
    const device = await getGpuDevice();
    if (!device) return null;
    if (pipelineCache && pipelineCache.device === device) return pipelineCache;

    const module = device.createShaderModule({ code: FUSION_SHADER_WGSL });
    const bindLayout = getFusionBindGroupLayout(device);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'main' },
    });
    const uniformBuf = device.createBuffer({
        size: UNIFORM_SIZE,
        usage: 0x40 | 0x8,
    });
    pipelineCache = { device, pipeline, bindLayout, uniformBuf };
    return pipelineCache;
};

export interface GpuFusionOverlay {
    mask: Uint16Array;
    version: number;
    nx: number; ny: number; nz: number;
    p00: { x: number; y: number; z: number };
    v01: { x: number; y: number; z: number };
    v10: { x: number; y: number; z: number };
    labelClut: number[][];
    alpha: number;
}

export interface GpuFusionParams {
    voxel0: Float32Array | Int16Array;
    nx0: number; ny0: number; nz0: number;
    p00_0: { x: number; y: number; z: number };
    v01_0: { x: number; y: number; z: number };
    v10_0: { x: number; y: number; z: number };
    wc0: number; ww0: number;
    clut0: number[][];
    voxel1: Float32Array | Int16Array;
    nx1: number; ny1: number; nz1: number;
    p00_1: { x: number; y: number; z: number };
    v01_1: { x: number; y: number; z: number };
    v10_1: { x: number; y: number; z: number };
    wc1: number; ww1: number;
    clut1: number[][];
    outW: number; outH: number;
    overlayBlend: number;       // PET 重み (1-baseW)
    overlay?: GpuFusionOverlay;
    bodyMask?: Uint8Array;
    targetCanvas: HTMLCanvasElement;
    interpolation0?: 'nearest' | 'bilinear';   // base layer, default 'bilinear'
    interpolation1?: 'nearest' | 'bilinear';   // overlay layer, default 'bilinear'
}

export const gpuRenderFusion = async (
    p: GpuFusionParams,
): Promise<OffscreenCanvas | null> => {
    if (p.outW <= 0 || p.outH <= 0) return null;
    if (!usePerfStore().gpuAllowed) return null;
    const cache = await ensurePipeline();
    if (!cache) return null;
    const { device, pipeline, bindLayout, uniformBuf } = cache;

    const vol0Tex = await getVolumeTexture(device, p.voxel0, p.nx0, p.ny0, p.nz0);
    const vol1Tex = await getVolumeTexture(device, p.voxel1, p.nx1, p.ny1, p.nz1);
    const clut0Buf = getClutBuffer(device, p.clut0);
    const clut1Buf = getClutBuffer(device, p.clut1);
    const off = ensureOffscreen(device, p.targetCanvas, p.outW, p.outH);
    if (!off) return null;

    let maskTex: any;
    let labelClutBuf: any;
    let overlayAlpha = 0;
    let labelClutLen = 1;
    let mnx = 1, mny = 1, mnz = 1;
    let p00m = { x: 0, y: 0, z: 0 }, v01m = { x: 0, y: 0, z: 0 }, v10m = { x: 0, y: 0, z: 0 };
    if (p.overlay) {
        maskTex = getMaskTexture(device, p.overlay.mask, p.overlay.nx, p.overlay.ny, p.overlay.nz, p.overlay.version);
        labelClutBuf = getClutBuffer(device, p.overlay.labelClut);
        overlayAlpha = p.overlay.alpha;
        labelClutLen = p.overlay.labelClut.length;
        mnx = p.overlay.nx; mny = p.overlay.ny; mnz = p.overlay.nz;
        p00m = p.overlay.p00; v01m = p.overlay.v01; v10m = p.overlay.v10;
    } else {
        maskTex = getDummyMaskTexture(device);
        labelClutBuf = clut0Buf;
    }

    const bodyMaskTex = p.bodyMask
        ? getBodyMaskTexture(device, p.bodyMask, p.nx0, p.ny0, p.nz0)
        : getDummyBodyMaskTexture(device);

    const baseW = 1 - p.overlayBlend;
    const ovlW = p.overlayBlend;

    // Uniform pack (240 bytes = 15 vec4)
    const ubuf = new ArrayBuffer(UNIFORM_SIZE);
    const i32 = new Int32Array(ubuf);
    const f32 = new Float32Array(ubuf);
    // dims0: nx, ny, nz, interp0 (0=nearest, 1=bilinear)
    i32[0] = p.nx0; i32[1] = p.ny0; i32[2] = p.nz0;
    i32[3] = (p.interpolation0 ?? 'bilinear') === 'nearest' ? 0 : 1;
    // dims1: nx, ny, nz, interp1
    i32[4] = p.nx1; i32[5] = p.ny1; i32[6] = p.nz1;
    i32[7] = (p.interpolation1 ?? 'bilinear') === 'nearest' ? 0 : 1;
    // maskDims
    i32[8] = mnx; i32[9] = mny; i32[10] = mnz; i32[11] = 0;
    // outAndFlags
    i32[12] = p.outW; i32[13] = p.outH;
    i32[14] = p.overlay ? 1 : 0;
    i32[15] = p.bodyMask ? 1 : 0;
    // p00_0
    f32[16] = p.p00_0.x; f32[17] = p.p00_0.y; f32[18] = p.p00_0.z; f32[19] = 0;
    f32[20] = p.v01_0.x; f32[21] = p.v01_0.y; f32[22] = p.v01_0.z; f32[23] = 0;
    f32[24] = p.v10_0.x; f32[25] = p.v10_0.y; f32[26] = p.v10_0.z; f32[27] = 0;
    // p00_1
    f32[28] = p.p00_1.x; f32[29] = p.p00_1.y; f32[30] = p.p00_1.z; f32[31] = 0;
    f32[32] = p.v01_1.x; f32[33] = p.v01_1.y; f32[34] = p.v01_1.z; f32[35] = 0;
    f32[36] = p.v10_1.x; f32[37] = p.v10_1.y; f32[38] = p.v10_1.z; f32[39] = 0;
    // p00m
    f32[40] = p00m.x; f32[41] = p00m.y; f32[42] = p00m.z; f32[43] = 0;
    f32[44] = v01m.x; f32[45] = v01m.y; f32[46] = v01m.z; f32[47] = 0;
    f32[48] = v10m.x; f32[49] = v10m.y; f32[50] = v10m.z; f32[51] = 0;
    // wcww: wc0, ww0, wc1, ww1
    f32[52] = p.wc0; f32[53] = p.ww0; f32[54] = p.wc1; f32[55] = p.ww1;
    // blend: baseW, ovlW, overlayAlpha, labelClutLen
    f32[56] = baseW; f32[57] = ovlW; f32[58] = overlayAlpha; f32[59] = labelClutLen;
    device.queue.writeBuffer(uniformBuf, 0, ubuf);

    const swapTex = off.ctx.getCurrentTexture();
    const swapView = swapTex.createView();
    const vol0View = vol0Tex.createView({ dimension: '3d' });
    const vol1View = vol1Tex.createView({ dimension: '3d' });
    const maskView = maskTex.createView({ dimension: '3d' });
    const bodyMaskView = bodyMaskTex.createView({ dimension: '3d' });
    const bindGroup = device.createBindGroup({
        layout: bindLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: vol0View },
            { binding: 2, resource: { buffer: clut0Buf } },
            { binding: 3, resource: swapView },
            { binding: 4, resource: vol1View },
            { binding: 5, resource: { buffer: clut1Buf } },
            { binding: 6, resource: maskView },
            { binding: 7, resource: { buffer: labelClutBuf } },
            { binding: 8, resource: bodyMaskView },
        ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(p.outW / 8), Math.ceil(p.outH / 8), 1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return off.canvas;
};
