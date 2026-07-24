// ガイドツアーが呼ぶ「操作層」。アプリの実 expose / store action を薄く束ねる。
// シナリオ (scenarios/*.ts) はこの API を通じてのみ状態を変える (直接 DOM を叩かない)。

import * as THREE from '@/lib/threeMath';
import { worldToVoxel } from '../Volume';
import { PHANTOM_PETCT_TUMOR_WORLD } from '../phantom';

export interface DemoApi {
    /** 合成 PET/CT ファントムを読み込む (テスト DICOM の代わり)。 */
    loadPhantom: () => void;
    /** CT / PET / Fusion / PET MIP の 4 面レイアウト。 */
    petStandard: () => Promise<void> | void;
    /** 右の Segmentation パネルを開く。 */
    openSegmentation: () => void;
    /** SUV 閾値で高集積域をすべて Physiological として塗る (panel の Apply と同等 + 再描画)。 */
    applyPhysiologicalThreshold: (suv: number) => void;
    /** ファントムの腫瘍位置をシードに、その連結成分だけを Tumor に振り分ける (Assign 相当)。 */
    assignTumor: () => void;
    /** 先頭病変の MTV/SUVmax (ナレーション差し込み用、無ければ null)。 */
    topLesion: () => { mtvMl: number; suvMax: number } | null;
}

export interface DemoApiDeps {
    /** DicomView の defineExpose プロキシ (dicomViewRef.value)。 */
    dicomView: () => any;
    /** segmentation store。 */
    store: any;
    /** 右 Inspector (Segmentation) の開閉。 */
    setInspectorOpen: (open: boolean) => void;
}

const labelIdByName = (store: any, name: string): number | undefined =>
    store.labels?.find((l: any) => String(l.name).toLowerCase() === name.toLowerCase())?.id;

export const buildDemoApi = (deps: DemoApiDeps): DemoApi => {
    const redraw = () => deps.dicomView()?.redraw?.();

    return {
        loadPhantom: () => {
            deps.dicomView()?.phantomWholeBodyPetCt?.();
        },
        petStandard: async () => {
            await deps.dicomView()?.setupPetStandardView?.();
        },
        openSegmentation: () => {
            deps.setInspectorOpen(true);
        },
        applyPhysiologicalThreshold: (suv: number) => {
            const store = deps.store;
            const physio = labelIdByName(store, 'Physiological');
            if (physio != null) store.currentLabelId = physio;
            store.applyThreshold(suv);   // ensureMaskAllocated + beginMaskEdit を内部で行う
            store.findIslands?.();       // panel の Apply と同じく島 (連結成分) を更新
            redraw();                    // ★ これが無いとマスク色が描画されない
        },
        assignTumor: () => {
            const store = deps.store;
            const pet = store.petVolumeRef;
            const tumorId = labelIdByName(store, 'Tumor');
            if (!pet || tumorId == null) return;
            // 腫瘍の world 中心 → PET voxel index。四捨五入して連結成分の seed にする。
            const w = new THREE.Vector3(
                PHANTOM_PETCT_TUMOR_WORLD[0], PHANTOM_PETCT_TUMOR_WORLD[1], PHANTOM_PETCT_TUMOR_WORLD[2],
            );
            const v = worldToVoxel(w, pet);
            const i = Math.round(v.x), j = Math.round(v.y), k = Math.round(v.z);
            store.assignLabelAtVoxel(i, j, k, tumorId);   // 同一ラベルの連結成分を Tumor に
            redraw();
        },
        topLesion: () => {
            const store = deps.store;
            try {
                const rows = store.summarizeLesions?.() ?? null;
                if (!rows || rows.length === 0) return null;
                const top = rows.slice().sort((a: any, b: any) => (b.volume_mm3 ?? 0) - (a.volume_mm3 ?? 0))[0];
                return { mtvMl: (top.volume_mm3 ?? 0) / 1000, suvMax: top.suvMax ?? 0 };
            } catch { return null; }
        },
    };
};
