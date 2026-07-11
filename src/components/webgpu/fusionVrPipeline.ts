// Fusion VR compute pipeline。Fusion MIP と同じ 6 binding 構成 (vol0/clut0/out + vol1/clut1)。

import { getGpuDevice } from './gpuContext';
import { getVolumeTexture } from './volumeCache';
import { FUSION_VR_SHADER_WGSL } from './fusionVrShader';
import { getClutBuffer, ensureOffscreen, getFusionMipBindGroupLayout } from './gpuShared';
import { usePerfStore } from '../../stores/perf';

interface PipelineCache {
    device: any;
    pipeline: any;
    bindLayout: any;
    uniformBuf: any;
}

let pipelineCache: PipelineCache | null = null;
const UNIFORM_SIZE = 192;   // 12 vec4

const ensurePipeline = async (): Promise<PipelineCache | null> => {
    const device = await getGpuDevice();
    if (!device) return null;
    if (pipelineCache && pipelineCache.device === device) return pipelineCache;

    const module = device.createShaderModule({ code: FUSION_VR_SHADER_WGSL });
    const bindLayout = getFusionMipBindGroupLayout(device);    // 同じ 6-binding layout を再利用
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'main' },
    });
    const uniformBuf = device.createBuffer({ size: UNIFORM_SIZE, usage: 0x40 | 0x8 });
    pipelineCache = { device, pipeline, bindLayout, uniformBuf };
    return pipelineCache;
};

export interface GpuFusionVrParams {
    voxel0: Float32Array | Int16Array;
    nx0: number; ny0: number; nz0: number;
    p00_0: { x: number; y: number; z: number };
    v01_0: { x: number; y: number; z: number };
    v10_0: { x: number; y: number; z: number };
    wc0: number; ww0: number; clut0: number[][];
    voxel1: Float32Array | Int16Array;
    nx1: number; ny1: number; nz1: number;
    p00_1: { x: number; y: number; z: number };
    v01_1: { x: number; y: number; z: number };
    v10_1: { x: number; y: number; z: number };
    wc1: number; ww1: number; clut1: number[][];
    outW: number; outH: number;
    angle: number;
    overlayBlend: number;
    alphaScale0?: number;       // default 0.06 (CT)
    alphaScale1?: number;       // default 0.06 (PET)
    targetCanvas: HTMLCanvasElement;
}

export const gpuRenderFusionVr = async (
    p: GpuFusionVrParams,
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

    const baseW = 1 - p.overlayBlend;
    const ovlW = p.overlayBlend;
    const rad = (p.angle - 90) * Math.PI / 180;

    const ubuf = new ArrayBuffer(UNIFORM_SIZE);
    const i32 = new Int32Array(ubuf);
    const f32 = new Float32Array(ubuf);
    i32[0] = p.nx0; i32[1] = p.ny0; i32[2] = p.nz0; i32[3] = 0;
    i32[4] = p.nx1; i32[5] = p.ny1; i32[6] = p.nz1; i32[7] = 0;
    i32[8] = p.outW; i32[9] = p.outH; i32[10] = 0; i32[11] = 0;
    f32[12] = p.p00_0.x; f32[13] = p.p00_0.y; f32[14] = p.p00_0.z; f32[15] = 0;
    f32[16] = p.v01_0.x; f32[17] = p.v01_0.y; f32[18] = p.v01_0.z; f32[19] = 0;
    f32[20] = p.v10_0.x; f32[21] = p.v10_0.y; f32[22] = p.v10_0.z; f32[23] = 0;
    f32[24] = p.p00_1.x; f32[25] = p.p00_1.y; f32[26] = p.p00_1.z; f32[27] = 0;
    f32[28] = p.v01_1.x; f32[29] = p.v01_1.y; f32[30] = p.v01_1.z; f32[31] = 0;
    f32[32] = p.v10_1.x; f32[33] = p.v10_1.y; f32[34] = p.v10_1.z; f32[35] = 0;
    f32[36] = Math.cos(rad); f32[37] = Math.sin(rad);
    f32[38] = p.wc0; f32[39] = p.ww0;
    f32[40] = p.wc1; f32[41] = p.ww1;
    f32[42] = baseW; f32[43] = ovlW;
    f32[44] = p.alphaScale0 ?? 0.06;
    f32[45] = p.alphaScale1 ?? 0.06;
    f32[46] = 0; f32[47] = 0;
    device.queue.writeBuffer(uniformBuf, 0, ubuf);

    const swapTex = off.ctx.getCurrentTexture();
    const bindGroup = device.createBindGroup({
        layout: bindLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: vol0Tex.createView({ dimension: '3d' }) },
            { binding: 2, resource: { buffer: clut0Buf } },
            { binding: 3, resource: swapTex.createView() },
            { binding: 4, resource: vol1Tex.createView({ dimension: '3d' }) },
            { binding: 5, resource: { buffer: clut1Buf } },
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
