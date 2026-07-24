// VR auto-play demo controller (CT + PET volume rendering を自動カメラ + パラメータ
// アニメーションでシネマ的に見せる)。
//
// 設計:
//   - 開始時に対象 box の vecx/vecy/vecz と他の主要パラメータを snapshot。
//     アニメーション中はこれらを起点に毎フレーム再計算して drift を防ぐ。
//   - 各 scene には duration + update(t01) を持たせる。t01 は scene 内 0..1。
//   - update が box info / overlayAlpha / TF preset / alphaScale / yaw / pitch 等を書き換え、
//     最後に show callback を呼んで 1 フレーム描画。
//   - 全 scene 通算で ~30s。停止は外部から stop()。
//
// 対象 box の type:
//   - 単独 VR (volume): yaw + TF preset cycle + alphaScale 振り + shading on/off
//   - Fusion VR     : yaw + overlayAlpha 振り (CT ↔ PET) + pitch 揺れ

import * as THREE from '@/lib/threeMath';
import { type VolumeImageBoxInfo, type FusedVolumeImageBoxInfo, makeMipState } from './DicomImageBoxInfo';

export interface VrDemoCallbacks {
    /** box info を変更したあと呼ぶ。`showImage(i)` をトリガする。 */
    onFrame: () => void;
    /** デモ完全終了時 (last scene の最後 or stop()) */
    onStop?: () => void;
}

interface SceneCtx {
    info: VolumeImageBoxInfo;             // 対象 box の info (mutate される)
    initVecx: THREE.Vector3;
    initVecy: THREE.Vector3;
    initVecz: THREE.Vector3;
    initOverlayAlpha?: number;            // Fusion only
    initAlphaScale: number;
    initPresetId?: string;
    initShadingEnabled: boolean;
    isFusion: boolean;
}

type SceneFn = (ctx: SceneCtx, t01: number) => void;

interface Scene {
    name: string;
    duration: number;     // seconds
    fn: SceneFn;
}

// イージング: ease-in-out (smoothstep 同様、0..1 → 0..1)
const ease = (t: number): number => t * t * (3 - 2 * t);

// yaw / pitch を rotation 起点 vec に適用 (drift しない、絶対角)
const applyOrientation = (
    info: VolumeImageBoxInfo,
    init: { vecx: THREE.Vector3; vecy: THREE.Vector3; vecz: THREE.Vector3 },
    yaw: number,
    pitch: number,
) => {
    info.vecx.copy(init.vecx);
    info.vecy.copy(init.vecy);
    info.vecz.copy(init.vecz);
    if (yaw !== 0) {
        const upAxis = init.vecy.clone().normalize();
        info.vecx.applyAxisAngle(upAxis, yaw);
        info.vecz.applyAxisAngle(upAxis, yaw);
    }
    if (pitch !== 0) {
        const rightAxis = info.vecx.clone().normalize();   // already yaw-rotated
        info.vecy.applyAxisAngle(rightAxis, pitch);
        info.vecz.applyAxisAngle(rightAxis, pitch);
    }
};

// 単独 VR 用のシーン群 (3 場面 ≈ 30s)
const SCENES_SINGLE_VR: Scene[] = [
    {
        // Scene 1: yaw 360° 回転 + alphaScale ゆっくり強→弱→強
        name: 'rotate-360',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = t01 * Math.PI * 2;
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, 0);
            // alphaScale を 1 → 1.5 → 1 倍に振る (相対)
            const factor = 1 + 0.5 * Math.sin(t01 * Math.PI);
            if (ctx.info.mip) ctx.info.mip.alphaScale = ctx.initAlphaScale * factor;
        },
    },
    {
        // Scene 2: TF preset cycle (Bone → PET hot → Soft) + yaw 続行 (continuous, 360→720°)
        name: 'tf-cycle',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = (1 + t01) * Math.PI * 2;  // continuous from scene 1
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, 0);
            // 3 区間に分けて preset を切替
            if (ctx.info.mip) {
                const presetIds = ['bone', 'pet-hot', 'soft'];
                const seg = Math.min(2, Math.floor(t01 * 3));
                ctx.info.mip.vrOpacityPresetId = presetIds[seg];
                // tf 自体は DicomView の onSetVrTfPreset と同じロジックで変更したい
                // → preset の TF を直接設定 (TF_PRESETS は別ファイルなので caller が事前に設定)
            }
        },
    },
    {
        // Scene 3: pitch wobble + Phong shading on で立体感、yaw 720→1080°
        name: 'tilt-shading',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = (2 + t01) * Math.PI * 2;
            const pitch = Math.sin(t01 * Math.PI * 2) * (Math.PI / 8);   // ±22.5°
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, pitch);
            // shading on (前半) → off (後半) で対比
            if (ctx.info.mip?.vrShading) ctx.info.mip.vrShading.enabled = (t01 < 0.7);
        },
    },
];

// Fusion VR 用シーン群 (CT base + PET overlay の blend ratio を演出)
const SCENES_FUSION_VR: Scene[] = [
    {
        // Scene 1: yaw 360°, blend 一定 (0.4 = CT 強め)
        name: 'fusion-rotate',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = t01 * Math.PI * 2;
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, 0);
            (ctx.info as FusedVolumeImageBoxInfo).overlayAlpha = 0.4;
        },
    },
    {
        // Scene 2: blend 0.4 → 1.0 (CT 消えて PET のみ) → 0.4
        name: 'fusion-fade',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = (1 + t01) * Math.PI * 2;
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, 0);
            // 0.4 → 1.0 → 0.4 の山形
            const blend = 0.4 + 0.6 * Math.sin(t01 * Math.PI);
            (ctx.info as FusedVolumeImageBoxInfo).overlayAlpha = blend;
        },
    },
    {
        // Scene 3: yaw + pitch、blend 0.5 fixed
        name: 'fusion-tilt',
        duration: 10,
        fn: (ctx, t01) => {
            const yaw = (2 + t01) * Math.PI * 2;
            const pitch = Math.sin(t01 * Math.PI * 2) * (Math.PI / 8);
            applyOrientation(ctx.info, { vecx: ctx.initVecx, vecy: ctx.initVecy, vecz: ctx.initVecz }, yaw, pitch);
            (ctx.info as FusedVolumeImageBoxInfo).overlayAlpha = 0.5;
        },
    },
];

export interface StartDemoOptions {
    info: VolumeImageBoxInfo | FusedVolumeImageBoxInfo;
    isFusion: boolean;
    /** TF preset id を name で指定したとき、preset の tf 配列を返す lookup */
    resolvePresetTF: (id: string) => { v: number; a: number }[] | null;
}

export class VrDemo {
    private rafId: number | null = null;
    private startTime = 0;
    private scenes: Scene[] = [];
    private ctx: SceneCtx | null = null;
    private callbacks: VrDemoCallbacks;
    private resolvePresetTF: (id: string) => { v: number; a: number }[] | null;
    private snapshot: {
        vecx: THREE.Vector3; vecy: THREE.Vector3; vecz: THREE.Vector3;
        overlayAlpha?: number; alphaScale: number; presetId?: string; shadingEnabled: boolean;
        tf?: { v: number; a: number }[];
    } | null = null;
    private restoreInfo: VolumeImageBoxInfo | FusedVolumeImageBoxInfo | null = null;

    constructor(callbacks: VrDemoCallbacks, resolvePresetTF: (id: string) => { v: number; a: number }[] | null) {
        this.callbacks = callbacks;
        this.resolvePresetTF = resolvePresetTF;
    }

    start(opt: StartDemoOptions) {
        if (this.rafId !== null) return;     // already running
        const info = opt.info;
        if (!info.mip) info.mip = makeMipState();
        // snapshot for restore on stop
        this.restoreInfo = info;
        this.snapshot = {
            vecx: info.vecx.clone(),
            vecy: info.vecy.clone(),
            vecz: info.vecz.clone(),
            overlayAlpha: opt.isFusion ? (info as FusedVolumeImageBoxInfo).overlayAlpha : undefined,
            alphaScale: info.mip.alphaScale ?? 0.06,
            presetId: info.mip.vrOpacityPresetId,
            shadingEnabled: info.mip.vrShading?.enabled ?? false,
            tf: info.mip.vrOpacityTF ? info.mip.vrOpacityTF.map(p => ({ ...p })) : undefined,
        };
        this.ctx = {
            info: info as VolumeImageBoxInfo,
            initVecx: info.vecx.clone(),
            initVecy: info.vecy.clone(),
            initVecz: info.vecz.clone(),
            initOverlayAlpha: this.snapshot.overlayAlpha,
            initAlphaScale: this.snapshot.alphaScale,
            initPresetId: this.snapshot.presetId,
            initShadingEnabled: this.snapshot.shadingEnabled,
            isFusion: opt.isFusion,
        };
        // shading 有効化 (Phase B 効果を見せる)。終了時に snapshot から戻す。
        if (info.mip.vrShading) info.mip.vrShading.enabled = true;
        else info.mip.vrShading = { enabled: true, ambient: 0.3, diffuse: 0.7, specularInt: 0.4, specularPower: 16 };
        this.scenes = opt.isFusion ? SCENES_FUSION_VR : SCENES_SINGLE_VR;
        this.startTime = performance.now();
        this.rafId = requestAnimationFrame(this.tick);
    }

    stop() {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        // 元状態に戻す
        if (this.restoreInfo && this.snapshot) {
            const info = this.restoreInfo;
            info.vecx.copy(this.snapshot.vecx);
            info.vecy.copy(this.snapshot.vecy);
            info.vecz.copy(this.snapshot.vecz);
            if (info.mip) {
                info.mip.alphaScale = this.snapshot.alphaScale;
                info.mip.vrOpacityPresetId = this.snapshot.presetId;
                info.mip.vrOpacityTF = this.snapshot.tf;
                if (info.mip.vrShading) info.mip.vrShading.enabled = this.snapshot.shadingEnabled;
            }
            if (this.snapshot.overlayAlpha !== undefined) {
                (info as FusedVolumeImageBoxInfo).overlayAlpha = this.snapshot.overlayAlpha;
            }
            this.callbacks.onFrame();
        }
        this.callbacks.onStop?.();
    }

    isRunning(): boolean {
        return this.rafId !== null;
    }

    private tick = (now: number) => {
        if (!this.ctx) { this.stop(); return; }
        const elapsed = (now - this.startTime) / 1000;
        let t = 0;
        let scene: Scene | null = null;
        let sceneT = 0;
        for (const s of this.scenes) {
            if (elapsed < t + s.duration) {
                scene = s;
                sceneT = (elapsed - t) / s.duration;
                break;
            }
            t += s.duration;
        }
        if (!scene) { this.stop(); return; }
        scene.fn(this.ctx, ease(sceneT));
        // preset id が変わってたら tf を更新 (DicomView の onSetVrTfPreset と同じ責務)
        if (this.ctx.info.mip?.vrOpacityPresetId) {
            const tf = this.resolvePresetTF(this.ctx.info.mip.vrOpacityPresetId);
            if (tf) this.ctx.info.mip.vrOpacityTF = tf;
        }
        this.callbacks.onFrame();
        this.rafId = requestAnimationFrame(this.tick);
    };
}
