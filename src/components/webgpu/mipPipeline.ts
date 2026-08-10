// MIP compute pipeline + 1-call render API。
//
// pipeline / bind group layout / clut buffer / mask texture は cache される。
// output canvas (OffscreenCanvas + webgpu context) は 1 個だけ持ち、サイズが
// 変わったら re-configure する。
//
// Output: rgba8unorm OffscreenCanvas → 呼出元の 2D canvas へ drawImage で転送。
// Mask overlay: optional に渡せる。指定なければ dummy 1×1×1 mask texture でバインド。

import { getGpuDevice } from './gpuContext';
import { getVolumeTexture } from './volumeCache';
import { getMaskTexture, getDummyMaskTexture } from './maskCache';
import { getBodyMaskTexture, getDummyBodyMaskTexture } from './bodyMaskCache';
import { MIP_SHADER_WGSL } from './mipShader';
import { getClutBuffer, ensureOffscreen, getMipBindGroupLayout } from './gpuShared';
import { usePerfStore } from '../../stores/perf';

interface PipelineCache {
    device: any;
    pipeline: any;
    bindLayout: any;
    uniformBuf: any;        // 160 byte uniform (Params struct)
}

let pipelineCache: PipelineCache | null = null;

const ensurePipeline = async (): Promise<PipelineCache | null> => {
    const device = await getGpuDevice();
    if (!device) return null;
    if (pipelineCache && pipelineCache.device === device) return pipelineCache;

    const module = device.createShaderModule({ code: MIP_SHADER_WGSL });
    const bindLayout = getMipBindGroupLayout(device);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'main' },
    });
    const uniformBuf = device.createBuffer({
        size: 160,
        usage: 0x40 | 0x8,  // UNIFORM | COPY_DST
    });
    pipelineCache = { device, pipeline, bindLayout, uniformBuf };
    return pipelineCache;
};

export interface GpuMipOverlay {
    mask: Uint16Array;        // PET 格子と同形 (nx*ny*nz)
    version: number;          // segStore.maskVersion (cache 無効化キー)
    labelClut: number[][];    // 256 RGB
    alpha: number;            // 0..1 ブレンド比
}

export interface GpuMipParams {
    voxel: Float32Array | Int16Array;
    nx: number;
    ny: number;
    nz: number;
    outW: number;
    outH: number;
    p00: { x: number; y: number; z: number };
    v01: { x: number; y: number; z: number };
    v10: { x: number; y: number; z: number };
    angle: number;          // degrees
    wc: number;
    ww: number;
    isSurface: boolean;
    surfThresh: number;
    surfDepth: number;
    // 表面陰影 (shaded surface projection)。isSurface のときだけ効く。
    shadeSurface?: boolean;
    shadeAmbient?: number;    // 0..1  既定 0.25
    shadeSpecular?: number;   // 0..1  既定 0.35
    shadeDepthCue?: number;   // 0..1  既定 0.35 (奥ほど暗く)
    // 勾配の異方性補正用の voxel pitch (mm)。未指定なら等方とみなす。
    voxelPitch?: { x: number; y: number; z: number };
    // 表面と認めるのに必要な「視線方向の連続ヒット数」。1 = 従来 (単発で採用)。
    surfMinRun?: number;
    // CT 寝台除去用 body mask (0=体外)。volume と同じ格子であること。
    bodyMask?: Uint8Array;
    clut: number[][];
    overlay?: GpuMipOverlay;  // 未指定ならマスクなし MIP
    targetCanvas: HTMLCanvasElement;  // 描画先 2D canvas (offscreen キャッシュ key)
}

export const gpuRenderMip = async (
    p: GpuMipParams,
): Promise<OffscreenCanvas | null> => {
    if (p.outW <= 0 || p.outH <= 0) return null;
    // rendererMode='cpu' のときは pipeline 自体起動せず caller を CPU 経路に流す
    if (!usePerfStore().gpuAllowed) return null;
    const cache = await ensurePipeline();
    if (!cache) return null;
    const { device, pipeline, bindLayout, uniformBuf } = cache;

    const volTex = await getVolumeTexture(device, p.voxel, p.nx, p.ny, p.nz);
    const clutBuf = getClutBuffer(device, p.clut);
    const off = ensureOffscreen(device, p.targetCanvas, p.outW, p.outH);
    if (!off) return null;

    // overlay: bind するための mask texture と labelClut buffer を準備。
    // overlay 無しの場合は dummy 1×1×1 mask + 渡された clut を再利用 (どっちでも結果に影響しない)
    let maskTex: any;
    let labelClutBuf: any;
    let overlayAlpha = 0;
    let labelClutLen = 1;
    if (p.overlay) {
        maskTex = getMaskTexture(device, p.overlay.mask, p.nx, p.ny, p.nz, p.overlay.version);
        labelClutBuf = getClutBuffer(device, p.overlay.labelClut);
        overlayAlpha = p.overlay.alpha;
        labelClutLen = p.overlay.labelClut.length;
    } else {
        maskTex = getDummyMaskTexture(device);
        labelClutBuf = clutBuf;       // 使われないので何でも OK
    }

    // 寝台除去 body mask。未指定なら dummy を bind (結果に影響しない)。
    const hasBodyMask = !!p.bodyMask && p.bodyMask.length === p.nx * p.ny * p.nz;
    const bodyMaskTex = hasBodyMask
        ? getBodyMaskTexture(device, p.bodyMask!, p.nx, p.ny, p.nz)
        : getDummyBodyMaskTexture(device);

    // Uniform: Params 160 bytes (shade / aspect / outAndMode2 の vec4 を 3 本追加)
    const ubuf = new ArrayBuffer(160);
    const i32 = new Int32Array(ubuf);
    const f32 = new Float32Array(ubuf);
    i32[0] = p.nx; i32[1] = p.ny; i32[2] = p.nz; i32[3] = 0;
    i32[4] = p.outW; i32[5] = p.outH;
    i32[6] = p.isSurface ? 1 : 0;
    i32[7] = p.overlay ? 1 : 0;
    f32[8] = p.p00.x; f32[9] = p.p00.y; f32[10] = p.p00.z; f32[11] = 0;
    f32[12] = p.v01.x; f32[13] = p.v01.y; f32[14] = p.v01.z; f32[15] = 0;
    f32[16] = p.v10.x; f32[17] = p.v10.y; f32[18] = p.v10.z; f32[19] = 0;
    const rad = (p.angle - 90) * Math.PI / 180;
    f32[20] = Math.cos(rad);
    f32[21] = Math.sin(rad);
    f32[22] = p.wc;
    f32[23] = p.ww;
    f32[24] = p.surfThresh;
    f32[25] = p.surfDepth;
    f32[26] = overlayAlpha;
    f32[27] = labelClutLen;
    f32[28] = p.shadeSurface ? 1 : 0;
    f32[29] = p.shadeAmbient  ?? 0.25;
    f32[30] = p.shadeSpecular ?? 0.35;
    f32[31] = p.shadeDepthCue ?? 0.35;
    // 勾配を mm 基準にするための voxel pitch。kitty は 0.117/0.117/0.5 と z が 4 倍粗く、
    // これを無視すると法線が z 方向に潰れて陰影が横縞になる。
    f32[32] = p.voxelPitch?.x ?? 1;
    f32[33] = p.voxelPitch?.y ?? 1;
    f32[34] = p.voxelPitch?.z ?? 1;
    f32[35] = Math.max(1, Math.round(p.surfMinRun ?? 3));
    i32[36] = hasBodyMask ? 1 : 0;
    device.queue.writeBuffer(uniformBuf, 0, ubuf);

    const swapTex = off.ctx.getCurrentTexture();
    const swapView = swapTex.createView();
    const volView = volTex.createView({ dimension: '3d' });
    const maskView = maskTex.createView({ dimension: '3d' });
    const bindGroup = device.createBindGroup({
        layout: bindLayout,
        entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: volView },
            { binding: 2, resource: { buffer: clutBuf } },
            { binding: 3, resource: swapView },
            { binding: 4, resource: maskView },
            { binding: 5, resource: { buffer: labelClutBuf } },
            { binding: 6, resource: bodyMaskTex.createView({ dimension: '3d' }) },
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
