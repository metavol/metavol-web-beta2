// Volume MPR slice の compute pipeline + 1-call render API。
// MIP / VR と同じ構成で 7 binding (volume + clut + output + mask + labelClut + bodyMask)。

import { getGpuDevice } from './gpuContext';
import { getVolumeTexture } from './volumeCache';
import { getMaskTexture, getDummyMaskTexture } from './maskCache';
import { getBodyMaskTexture, getDummyBodyMaskTexture } from './bodyMaskCache';
import { SLICE_SHADER_WGSL } from './sliceShader';
import { getClutBuffer, ensureOffscreen, getSliceBindGroupLayout } from './gpuShared';
import { usePerfStore } from '../../stores/perf';

interface PipelineCache {
    device: any;
    pipeline: any;
    bindLayout: any;
    uniformBuf: any;
}

let pipelineCache: PipelineCache | null = null;

const UNIFORM_SIZE = 176;   // 11 vec4 × 16 (struct Params の合計)

const ensurePipeline = async (): Promise<PipelineCache | null> => {
    const device = await getGpuDevice();
    if (!device) return null;
    if (pipelineCache && pipelineCache.device === device) return pipelineCache;

    const module = device.createShaderModule({ code: SLICE_SHADER_WGSL });
    const bindLayout = getSliceBindGroupLayout(device);
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

export interface GpuSliceOverlay {
    mask: Uint16Array;
    version: number;
    nx: number; ny: number; nz: number;
    p00: { x: number; y: number; z: number };
    v01: { x: number; y: number; z: number };
    v10: { x: number; y: number; z: number };
    labelClut: number[][];
    alpha: number;
}

export interface GpuSliceParams {
    voxel: Float32Array | Int16Array;
    nx: number; ny: number; nz: number;
    outW: number; outH: number;
    p00: { x: number; y: number; z: number };
    v01: { x: number; y: number; z: number };
    v10: { x: number; y: number; z: number };
    wc: number; ww: number;
    clut: number[][];
    overlay?: GpuSliceOverlay;
    bodyMask?: Uint8Array;
    targetCanvas: HTMLCanvasElement;
    interpolation?: 'nearest' | 'bilinear';   // default 'bilinear'
}

export const gpuRenderSlice = async (
    p: GpuSliceParams,
): Promise<OffscreenCanvas | null> => {
    if (p.outW <= 0 || p.outH <= 0) return null;
    if (!usePerfStore().gpuAllowed) return null;
    const cache = await ensurePipeline();
    if (!cache) return null;
    const { device, pipeline, bindLayout, uniformBuf } = cache;

    const volTex = await getVolumeTexture(device, p.voxel, p.nx, p.ny, p.nz);
    const clutBuf = getClutBuffer(device, p.clut);
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
        labelClutBuf = clutBuf;
    }

    let bodyMaskTex: any;
    if (p.bodyMask) {
        bodyMaskTex = getBodyMaskTexture(device, p.bodyMask, p.nx, p.ny, p.nz);
    } else {
        bodyMaskTex = getDummyBodyMaskTexture(device);
    }

    // Uniform pack (160 bytes = 10 vec4)
    const ubuf = new ArrayBuffer(UNIFORM_SIZE);
    const i32 = new Int32Array(ubuf);
    const f32 = new Float32Array(ubuf);
    // dims
    i32[0] = p.nx; i32[1] = p.ny; i32[2] = p.nz; i32[3] = 0;
    // outAndFlags: outW, outH, hasOverlay, hasBodyMask
    i32[4] = p.outW; i32[5] = p.outH;
    i32[6] = p.overlay ? 1 : 0;
    i32[7] = p.bodyMask ? 1 : 0;
    // maskDims
    i32[8] = mnx; i32[9] = mny; i32[10] = mnz; i32[11] = 0;
    // p00
    f32[12] = p.p00.x; f32[13] = p.p00.y; f32[14] = p.p00.z; f32[15] = 0;
    // v01
    f32[16] = p.v01.x; f32[17] = p.v01.y; f32[18] = p.v01.z; f32[19] = 0;
    // v10
    f32[20] = p.v10.x; f32[21] = p.v10.y; f32[22] = p.v10.z; f32[23] = 0;
    // p00m
    f32[24] = p00m.x; f32[25] = p00m.y; f32[26] = p00m.z; f32[27] = 0;
    // v01m
    f32[28] = v01m.x; f32[29] = v01m.y; f32[30] = v01m.z; f32[31] = 0;
    // v10m
    f32[32] = v10m.x; f32[33] = v10m.y; f32[34] = v10m.z; f32[35] = 0;
    // rotWC: _, _, wc, ww
    f32[36] = 0; f32[37] = 0;
    f32[38] = p.wc; f32[39] = p.ww;
    // surf: overlayAlpha, labelClutLen, interpolation, _
    f32[40] = overlayAlpha;
    f32[41] = labelClutLen;
    f32[42] = (p.interpolation ?? 'bilinear') === 'nearest' ? 0 : 1;
    f32[43] = 0;
    device.queue.writeBuffer(uniformBuf, 0, ubuf);

    const swapTex = off.ctx.getCurrentTexture();
    const swapView = swapTex.createView();
    const volView = volTex.createView({ dimension: '3d' });
    const maskView = maskTex.createView({ dimension: '3d' });
    const bodyMaskView = bodyMaskTex.createView({ dimension: '3d' });
    const bindGroup = device.createBindGroup({
        layout: bindLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: volView },
            { binding: 2, resource: { buffer: clutBuf } },
            { binding: 3, resource: swapView },
            { binding: 4, resource: maskView },
            { binding: 5, resource: { buffer: labelClutBuf } },
            { binding: 6, resource: bodyMaskView },
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
