import { defineStore } from 'pinia';
import * as THREE from 'three';
import type { Volume } from '../components/Volume';
import { connectedComponents26, assignLabelToComponent, extractCtBodyMask, sphereStatsInPet } from '../components/segmentation/maskOps';
import { writeNiftiUint16, triggerDownload } from '../components/segmentation/niftiWriter';

export interface LabelEntry {
    id: number;
    name: string;
    color: [number, number, number];
}

export interface SphereROI {
    centerWorld: THREE.Vector3;
    radiusMm: number;
    suvMax: number;
    suvMean: number;
    suvStd: number;
    voxelCount: number;
}

export interface PolygonROIState {
    plane: 'axial' | 'coronal' | 'sagittal' | 'unknown';
    sliceIndexInPet: number;
    sliceAxis: 0 | 1 | 2;
    screenVertices: Array<[number, number]>;
    mode: 'add' | 'erase';
    inProgress: boolean;
    imageBoxId: number;
}

export interface UndoEntry {
    sliceAxis: 0 | 1 | 2;
    sliceIndex: number;
    before: Uint16Array;
}

// 統合 undo: ROI 操作とマスク編集を 1 本のスタックで時系列管理する。
// Ctrl+Z / Undo ボタンはこのスタックを pop して直前操作を巻き戻す。
//   - maskSlice : polygon add/erase。manualEdits の 1 スライス分の before 状態
//   - rectAdd   : 矩形 ROI 追加。undo で当該 ROI を削除する
//   - rectRemove: 矩形 ROI 削除。undo で当該 ROI を復元する
export type UndoAction =
    | { kind: 'maskSlice'; sliceAxis: 0 | 1 | 2; sliceIndex: number; before: Uint16Array }
    | { kind: 'rectAdd'; roiId: number }
    | { kind: 'rectRemove'; roi: RectROI };

// 矩形 ROI。ドラッグした対角線の 2 隅を voxel 座標で保持する。
// topLeft / bottomRight は当該 series の voxel index 空間 (= ワールド座標ではない)。
// volume box 上で配置した場合は through-plane の voxel index も保持する。
export interface RectROI {
    id: number;                   // 安定識別子 (単調増加、削除・並べ替えに不変)。表示番号とは別物
    seriesIndex: number;          // どの series の voxel 空間か (seriesList の index)
    // voxel 座標 (min = 左上, max = 右下)。第3軸 (slice) は volume box のときのみ意味を持つ。
    topLeft: [number, number, number];
    bottomRight: [number, number, number];
    // ユーザがリネームで明示的に付けた名前。未命名なら undefined。
    // 表示名は label があればそれ、無ければ rectRois 配列内の位置から `#(index+1)` を算出する
    // (= rectRoiDisplayName getter)。
    label?: string;
}

const ERASE_SENTINEL = 0xFFFF;

const DEFAULT_LABEL_PALETTE: Array<[number, number, number]> = [
    [255, 90, 90],     // red
    [90, 200, 90],     // green
    [90, 130, 255],    // blue
    [255, 200, 70],    // yellow
    [220, 90, 220],    // magenta
    [70, 220, 220],    // cyan
    [255, 140, 60],    // orange
    [180, 110, 255],   // purple
];

// 既定ラベルセット (id は 1 から連番)。
// CLAUDE.md の UI ポリシーに従い英語表記。順序は臨床的によく使う優先度。
// Persona 1 の運用上 Tumor の次に Physiological (生理的集積の除外) を置く。
// color はラベルごとに明示指定 (palette index には依存しない)。Physiological は水色。
const DEFAULT_LABELS: Array<{ name: string; color: [number, number, number] }> = [
    { name: 'Tumor',           color: [255, 90, 90] },    // red
    { name: 'Physiological',   color: [120, 200, 255] },  // light blue (水色)
    { name: 'Lymph node',      color: [90, 200, 90] },    // green
    { name: 'Bone metastasis', color: [90, 130, 255] },   // blue
    { name: 'Inflammation',    color: [220, 90, 220] },   // magenta
    { name: 'Other',           color: [70, 220, 220] },   // cyan
];

interface State {
    petVolumeRef: Volume | null;
    ctVolumeRef: Volume | null;
    mrVolumeRef: Volume | null;     // MRI fusion 用 (PET + MR の base layer)

    thresholdMask: Uint16Array | null;
    manualEdits: Uint16Array | null;
    finalMask: Uint16Array | null;

    threshold: number;
    thresholdUnit: 'SUV' | 'CNTS';

    labels: LabelEntry[];
    currentLabelId: number;

    sphere: SphereROI | null;
    polygon: PolygonROIState | null;

    // 矩形 ROI のリスト。tool=rectROI のドラッグで追加され、JSON 書き出し対象。
    rectRois: RectROI[];
    nextRectRoiId: number;

    undoStack: UndoEntry[];
    // 統合 undo スタック (ROI 操作 + マスク編集を時系列で 1 本に)
    undoLog: UndoAction[];

    overlayAlpha: number;
    overlayEnabled: boolean;

    panelOpen: boolean;
    maskVersion: number;

    defaultPolygonMode: 'add' | 'erase';

    // Voxel brush ツール設定。半径は物理寸法 (mm) で保持し、描画時に PET voxel pitch で
    // voxel 半径へ換算する (anisotropic voxel でも物理的に円形になる)。
    brushRadiusMm: number;
    brushMode: 'add' | 'erase';

    componentMap: Uint16Array | null;
    componentCount: number;
    componentMapValid: boolean;

    lastAutoSavedAt: number | null;  // epoch ms (auto-save 完了時刻)

    // CT 寝台除去 (体マスク) — 1=体内、0=体外。CT volume と同じ次元。
    ctBodyMask: Uint8Array | null;
    ctBodyMaskEnabled: boolean;     // 表示時に適用するか (toggle)
    ctBodyMaskVersion: number;      // 表示更新トリガ用

    // Crosshair: 全 Box で共有する焦点位置 (world 座標)。null = 表示しない。
    crosshairWorld: THREE.Vector3 | null;
    crosshairVersion: number;       // ImageBox 再描画トリガ

    // MR-PET registration 状態
    mrRegistrationParams: [number, number, number, number, number, number] | null;
    mrRegistrationSnapshot: import('../components/registration/transform').RegistrationSnapshot | null;
    mrRegistrationVersion: number;
    mrRegistrationInProgress: boolean;
    mrRegistrationProgress: { level: number; nLevels: number; iter: number; mi: number } | null;

    // 選択中の tracer preset id (null = 未選択 = 自動判定 or デフォルト).
    // 個別 PT volume でなく "現在のセッション" 単位で保持する。
    activeTracerId: string | null;

    // PT 表示単位。'SUV' (既定、voxel そのまま) / 'BqMl' (voxel / suvFactor で表示)。
    // 内部 voxel は常に SUV (dicom2volume.ts で × suvFactor 済み)。toggle は legend / 入力値変換のみに影響。
    petDisplayUnit: 'SUV' | 'BqMl';

    // Threshold method (PERCIST/Deauville サポート用)。'fixed' は従来の SUV/CNTS 直接指定。
    //   - fixed       : threshold (SUV) 値そのまま
    //   - pctMax      : threshold = thresholdPct × VOI 内 SUVmax
    //   - liverPercist: threshold = 1.5 × liver SUVmean + 2 × liver SD (PERCIST 1.0)
    //   - liverPct    : threshold = thresholdPct × liver SUVmean (free-form)
    thresholdMethod: 'fixed' | 'pctMax' | 'liverPercist' | 'liverPct';
    thresholdPct: number;  // 0..1 (pctMax / liverPct 用、例: 0.41 = 41%)

    // Reference spheres for PERCIST/Deauville scoring
    //   liver       : 通常 right liver lobe 内 3cm 球 (PERCIST: 1.5+2σ で background 推定)
    //   bloodPool   : 通常 mediastinal blood pool / aorta 内 1cm 球 (Deauville: tumor vs blood pool)
    referenceSpheres: {
        liver: { centerWorld: THREE.Vector3; radiusMm: number; suvMean: number; suvStd: number; voxelCount: number } | null;
        bloodPool: { centerWorld: THREE.Vector3; radiusMm: number; suvMean: number; suvStd: number; voxelCount: number } | null;
    };
    // Reference sphere 配置モード: 次クリックの sphere 配置先 ('liver' | 'bloodPool' | null=normal SphereROI)
    referencePlacementMode: 'liver' | 'bloodPool' | null;
}

export const useSegmentationStore = defineStore('segmentation', {
    state: (): State => ({
        petVolumeRef: null,
        ctVolumeRef: null,
        mrVolumeRef: null,

        thresholdMask: null,
        manualEdits: null,
        finalMask: null,

        threshold: 2.5,
        thresholdUnit: 'SUV',

        labels: DEFAULT_LABELS.map((l, i) => ({
            id: i + 1,
            name: l.name,
            color: l.color,
        })),
        currentLabelId: 1,

        sphere: null,
        polygon: null,

        rectRois: [],
        nextRectRoiId: 1,

        undoStack: [],
        undoLog: [],

        overlayAlpha: 0.4,
        overlayEnabled: true,

        panelOpen: false,
        maskVersion: 0,

        defaultPolygonMode: 'add',

        brushRadiusMm: 6,
        brushMode: 'add',

        componentMap: null,
        componentCount: 0,
        componentMapValid: false,

        lastAutoSavedAt: null,

        ctBodyMask: null,
        ctBodyMaskEnabled: false,
        ctBodyMaskVersion: 0,

        crosshairWorld: null,
        crosshairVersion: 0,

        mrRegistrationParams: null,
        mrRegistrationSnapshot: null,
        mrRegistrationVersion: 0,
        mrRegistrationInProgress: false,
        mrRegistrationProgress: null,

        activeTracerId: null,

        petDisplayUnit: 'SUV',

        thresholdMethod: 'fixed',
        thresholdPct: 0.41,   // PERCIST 派生 (typical 41% of SUVmax)
        referenceSpheres: { liver: null, bloodPool: null },
        referencePlacementMode: null,
    }),

    getters: {
        hasPet(state): boolean {
            return state.petVolumeRef != null;
        },
        // 統合 undo スタックに巻き戻せる操作があるか (Undo ボタン / Ctrl+Z の活性判定)
        canUndo(state): boolean {
            return state.undoLog.length > 0;
        },
        labelById: (state) => (id: number): LabelEntry | undefined => {
            return state.labels.find(l => l.id === id);
        },
        // 矩形 ROI の表示名: ユーザ命名 (label) があればそれ、無ければ配列位置から `#N`。
        // 一覧パネル・リネーム既定値・canvas overlay の 3 箇所で同一ルールを使うため getter 化。
        rectRoiDisplayName: (state) => (index: number): string => {
            const r = state.rectRois[index];
            if (!r) return '';
            return (r.label && r.label.length > 0) ? r.label : `#${index + 1}`;
        },
        petVoxelVolumeMm3(state): number {
            const v = state.petVolumeRef;
            if (!v) return 0;
            return v.vectorX.length() * v.vectorY.length() * v.vectorZ.length();
        },
        volumesByLabel(state): Map<number, number> {
            const out = new Map<number, number>();
            const m = state.finalMask;
            if (!m || !state.petVolumeRef) return out;
            const vox = this.petVoxelVolumeMm3;
            const counts = new Map<number, number>();
            for (let i = 0; i < m.length; i++) {
                const id = m[i];
                if (id === 0) continue;
                counts.set(id, (counts.get(id) ?? 0) + 1);
            }
            for (const [id, c] of counts) {
                out.set(id, c * vox);
            }
            return out;
        },
        // ラベルごとの voxel 数 (Labels テーブルの "個数" 表示用)。
        voxelCountsByLabel(state): Map<number, number> {
            const out = new Map<number, number>();
            const m = state.finalMask;
            if (!m) return out;
            for (let i = 0; i < m.length; i++) {
                const id = m[i];
                if (id === 0) continue;
                out.set(id, (out.get(id) ?? 0) + 1);
            }
            return out;
        },
    },

    actions: {
        invalidateComponentMap() {
            this.componentMapValid = false;
            this.componentMap = null;
            this.componentCount = 0;
        },

        setPetVolume(v: Volume | null) {
            // 同一 PET (seriesUID または voxel 同一性) ならマスク state は保持
            const same = !!(v && this.petVolumeRef && (
                v.voxel === this.petVolumeRef.voxel ||
                (v.metadata?.seriesUID && this.petVolumeRef.metadata?.seriesUID
                    && v.metadata.seriesUID === this.petVolumeRef.metadata.seriesUID)
            ));
            this.petVolumeRef = v;
            if (!same) {
                this.thresholdMask = null;
                this.manualEdits = null;
                this.finalMask = null;
                this.clearMaskUndo();
                this.sphere = null;
                this.polygon = null;
                this.invalidateComponentMap();
                this.maskVersion++;
            }
        },
        setCtVolume(v: Volume | null) {
            this.ctVolumeRef = v;
        },
        setMrVolume(v: Volume | null) {
            this.mrVolumeRef = v;
        },

        ensureMaskAllocated(): boolean {
            if (!this.petVolumeRef) return false;
            const n = this.petVolumeRef.nx * this.petVolumeRef.ny * this.petVolumeRef.nz;
            if (!this.thresholdMask || this.thresholdMask.length !== n) {
                this.thresholdMask = new Uint16Array(n);
                this.manualEdits = new Uint16Array(n);
                this.finalMask = new Uint16Array(n);
            }
            return true;
        },

        recomputeFinalMask() {
            const t = this.thresholdMask;
            const e = this.manualEdits;
            const f = this.finalMask;
            if (!t || !e || !f) return;
            for (let i = 0; i < f.length; i++) {
                const ev = e[i];
                if (ev === ERASE_SENTINEL) {
                    f[i] = 0;
                } else if (ev !== 0) {
                    f[i] = ev;
                } else {
                    f[i] = t[i];
                }
            }
            this.maskVersion++;
        },

        applyThreshold(threshold: number) {
            this.threshold = threshold;
            if (!this.ensureMaskAllocated()) return;
            const v = this.petVolumeRef!;
            const t = this.thresholdMask!;
            const pet = v.voxel;
            const id = this.currentLabelId;
            for (let i = 0; i < pet.length; i++) {
                t[i] = pet[i] >= threshold ? id : 0;
            }
            this.recomputeFinalMask();
            this.invalidateComponentMap();
        },

        // PERCIST/Deauville 派生の threshold method を解決して effective threshold (SUV) を返す。
        // Caller は applyThreshold(value) に渡す前にこれを呼ぶ。
        // 戻り値が null なら必要な reference sphere や VOI が無く計算不可。
        resolveEffectiveThreshold(): { value: number; rationale: string } | null {
            const m = this.thresholdMethod;
            if (m === 'fixed') {
                return { value: this.threshold, rationale: `Fixed SUV ${this.threshold.toFixed(2)}` };
            }
            if (m === 'pctMax') {
                // VOI 内 SUVmax を取得 (sphere ROI または既存 mask から)
                let suvMax = 0;
                if (this.sphere) {
                    suvMax = this.sphere.suvMax;
                } else if (this.finalMask && this.petVolumeRef) {
                    const pet = this.petVolumeRef.voxel;
                    const m2 = this.finalMask;
                    for (let i = 0; i < m2.length; i++) {
                        if (m2[i] !== 0 && pet[i] > suvMax) suvMax = pet[i];
                    }
                } else if (this.petVolumeRef) {
                    // VOI なし → volume 全体の max
                    const pet = this.petVolumeRef.voxel;
                    for (let i = 0; i < pet.length; i++) if (pet[i] > suvMax) suvMax = pet[i];
                }
                if (suvMax <= 0) return null;
                const v = suvMax * this.thresholdPct;
                return { value: v, rationale: `${(this.thresholdPct * 100).toFixed(0)}% of SUVmax (${suvMax.toFixed(2)}) = ${v.toFixed(2)}` };
            }
            if (m === 'liverPercist') {
                const liver = this.referenceSpheres.liver;
                if (!liver) return null;
                const v = 1.5 * liver.suvMean + 2 * liver.suvStd;
                return { value: v, rationale: `PERCIST: 1.5 × liver SUVmean (${liver.suvMean.toFixed(2)}) + 2 × σ (${liver.suvStd.toFixed(2)}) = ${v.toFixed(2)}` };
            }
            if (m === 'liverPct') {
                const liver = this.referenceSpheres.liver;
                if (!liver) return null;
                const v = liver.suvMean * this.thresholdPct;
                return { value: v, rationale: `${(this.thresholdPct * 100).toFixed(0)}% of liver SUVmean (${liver.suvMean.toFixed(2)}) = ${v.toFixed(2)}` };
            }
            return null;
        },

        clearThresholdMask() {
            if (this.thresholdMask) this.thresholdMask.fill(0);
            this.recomputeFinalMask();
            this.invalidateComponentMap();
        },

        clearManualEdits() {
            if (this.manualEdits) this.manualEdits.fill(0);
            this.clearMaskUndo();
            this.recomputeFinalMask();
            this.invalidateComponentMap();
        },

        // Polygon 確定後など外部から手動編集が入った直後に呼ぶ
        markManualEditsChanged() {
            this.invalidateComponentMap();
        },

        // ===== 統合 Undo =====
        // マスクが置き換わったとき: マスク編集の undo は無効化するが、矩形 ROI の
        // undo 履歴 (rectAdd / rectRemove) は独立なので残す。
        clearMaskUndo() {
            this.undoStack = [];
            this.undoLog = this.undoLog.filter(a => a.kind !== 'maskSlice');
        },

        // polygon add/erase 確定前に呼ぶ。manualEdits の 1 スライス分 before を記録。
        pushMaskSliceUndo(sliceAxis: 0 | 1 | 2, sliceIndex: number, before: Uint16Array) {
            const entry: UndoEntry = { sliceAxis, sliceIndex, before };
            this.undoStack.push(entry);
            if (this.undoStack.length > 50) this.undoStack.shift();
            this.undoLog.push({ kind: 'maskSlice', sliceAxis, sliceIndex, before });
            if (this.undoLog.length > 100) this.undoLog.shift();
        },

        // 直前操作を 1 つ巻き戻す。戻り値はどの種別を undo したか (null = 履歴なし)。
        // maskSlice の実際のスライス復元は呼び出し側 (DicomView) が担当する
        // (PET grid 上の voxel index 計算を持っているため)。ここでは履歴管理のみ。
        undo(): UndoAction | null {
            const action = this.undoLog.pop();
            if (!action) return null;
            if (action.kind === 'rectAdd') {
                // 追加を取り消す = その ROI を消す
                this.rectRois = this.rectRois.filter(r => r.id !== action.roiId);
            } else if (action.kind === 'rectRemove') {
                // 削除を取り消す = その ROI を復元 (id 含めそのまま戻す)
                this.rectRois.push(action.roi);
            } else if (action.kind === 'maskSlice') {
                // undoStack 側の対応エントリも 1 つ取り除いて整合させる
                this.undoStack.pop();
            }
            return action;
        },

        addLabel(name: string): LabelEntry {
            const nextId = this.labels.length === 0
                ? 1
                : Math.max(...this.labels.map(l => l.id)) + 1;
            const color = DEFAULT_LABEL_PALETTE[(nextId - 1) % DEFAULT_LABEL_PALETTE.length];
            const entry: LabelEntry = { id: nextId, name, color };
            this.labels.push(entry);
            return entry;
        },

        removeLabel(id: number) {
            this.labels = this.labels.filter(l => l.id !== id);
            if (this.currentLabelId === id && this.labels.length > 0) {
                this.currentLabelId = this.labels[0].id;
            }
        },

        renameLabel(id: number, name: string) {
            const l = this.labels.find(x => x.id === id);
            if (l) l.name = name;
        },

        setSphere(centerWorld: THREE.Vector3, radiusMm: number) {
            this.sphere = {
                centerWorld: centerWorld.clone(),
                radiusMm,
                suvMax: 0,
                suvMean: 0,
                suvStd: 0,
                voxelCount: 0,
            };
        },

        clearSphere() {
            this.sphere = null;
        },

        // ===== 矩形 ROI =====
        // voxel 座標の 2 隅を受け取り、min/max に正規化して 1 件追加する。
        // recordUndo=false のとき undo 履歴を積まない (JSON import / snapshot 復元用)。
        addRectRoi(
            seriesIndex: number,
            cornerA: [number, number, number],
            cornerB: [number, number, number],
            label?: string,
            recordUndo: boolean = true,
        ): RectROI {
            const topLeft: [number, number, number] = [
                Math.min(cornerA[0], cornerB[0]),
                Math.min(cornerA[1], cornerB[1]),
                Math.min(cornerA[2], cornerB[2]),
            ];
            const bottomRight: [number, number, number] = [
                Math.max(cornerA[0], cornerB[0]),
                Math.max(cornerA[1], cornerB[1]),
                Math.max(cornerA[2], cornerB[2]),
            ];
            const roi: RectROI = {
                id: this.nextRectRoiId++,
                seriesIndex,
                topLeft,
                bottomRight,
                label,
            };
            this.rectRois.push(roi);
            if (recordUndo) {
                this.undoLog.push({ kind: 'rectAdd', roiId: roi.id });
                if (this.undoLog.length > 100) this.undoLog.shift();
            }
            return roi;
        },

        removeRectRoi(id: number) {
            const roi = this.rectRois.find(r => r.id === id);
            if (!roi) return;
            this.rectRois = this.rectRois.filter(r => r.id !== id);
            // 削除を undo できるよう ROI 実体を保持
            this.undoLog.push({ kind: 'rectRemove', roi });
            if (this.undoLog.length > 100) this.undoLog.shift();
        },

        // 矩形 ROI を配列内で fromIndex → toIndex に移動 (一覧の並べ替え)。
        // 配列順がそのまま表示順・表示番号・overlay 描画順なので、splice で順序を変えるだけ。
        // undo 対象外 (要求外。index ベースで delete と相性が悪いため意図的に非対応)。
        reorderRectRoi(fromIndex: number, toIndex: number) {
            const n = this.rectRois.length;
            if (fromIndex < 0 || fromIndex >= n) return;
            if (toIndex < 0 || toIndex >= n) return;
            if (fromIndex === toIndex) return;
            const [moved] = this.rectRois.splice(fromIndex, 1);
            this.rectRois.splice(toIndex, 0, moved);
        },

        // 全削除。undo 履歴からも矩形 ROI 関連エントリを除去する
        // (履歴に残しても復元先の整合が取れないため)。
        clearRectRois() {
            this.rectRois = [];
            this.undoLog = this.undoLog.filter(
                a => a.kind !== 'rectAdd' && a.kind !== 'rectRemove',
            );
        },

        // Reference sphere (liver / bloodPool) を配置 + 内部 SUV stats 計算
        setReferenceSphere(kind: 'liver' | 'bloodPool', centerWorld: THREE.Vector3, radiusMm: number, stats: { suvMean: number; suvStd: number; voxelCount: number }) {
            this.referenceSpheres[kind] = {
                centerWorld: centerWorld.clone(),
                radiusMm,
                suvMean: stats.suvMean,
                suvStd: stats.suvStd,
                voxelCount: stats.voxelCount,
            };
            this.referencePlacementMode = null;
        },
        clearReferenceSphere(kind: 'liver' | 'bloodPool') {
            this.referenceSpheres[kind] = null;
        },
        setReferencePlacementMode(mode: 'liver' | 'bloodPool' | null) {
            this.referencePlacementMode = mode;
        },

        bumpMaskVersion() {
            this.maskVersion++;
        },

        findIslands() {
            const pet = this.petVolumeRef;
            const m = this.finalMask;
            if (!pet || !m) return 0;
            const { components, count } = connectedComponents26(m, pet.nx, pet.ny, pet.nz);
            this.componentMap = components;
            this.componentCount = count;
            this.componentMapValid = true;
            this.maskVersion++;
            return count;
        },

        ensureComponentMap() {
            // 必要時に最新の componentMap を保証する。古い／無いなら再計算。
            if (!this.componentMapValid || !this.componentMap) {
                this.findIslands();
            }
        },

        clearIslands() {
            this.componentMap = null;
            this.componentCount = 0;
            this.componentMapValid = false;
        },

        assignLabelAtVoxel(i: number, j: number, k: number, labelId: number) {
            const pet = this.petVolumeRef;
            const m = this.finalMask;
            if (!pet || !m) return 0;
            // 古い componentMap で操作すると意図しない領域に波及するため、
            // 必ず最新状態に基づいて計算する。
            this.ensureComponentMap();
            const cm = this.componentMap;
            if (!cm) return 0;

            const seedIdx = k * pet.nx * pet.ny + j * pet.nx + i;
            const compId = cm[seedIdx];
            if (compId === 0) return 0;

            const n = assignLabelToComponent(cm, m, { i, j, k }, pet.nx, pet.ny, labelId);
            // 確定後はその領域を manualEdits にも反映（再計算で消えないように）
            const me = this.manualEdits;
            if (me) {
                for (let p = 0; p < cm.length; p++) {
                    if (cm[p] === compId) me[p] = labelId;
                }
            }
            this.maskVersion++;
            return n;
        },

        // ===== Tracer preset =====
        // SUV threshold + label preset を一括差し替え。
        // 注意: PET window WC/WW と CLUT は ImageBox 単位なので DicomView 側で適用する。
        // ここでは store が責任を持つ部分 (threshold + labels + activeTracerId) のみ更新。
        applyTracerLabelsAndThreshold(tracerId: string, threshold: number, labels: Array<{ name: string }>) {
            this.activeTracerId = tracerId;
            this.threshold = threshold;
            this.thresholdUnit = 'SUV';
            // Existing mask voxels の id がそのまま無効化されないよう、
            // labels 数が以前と同じなら既存 id を維持して name のみ書き換える方が安全。
            const oldLen = this.labels.length;
            const newLen = labels.length;
            const palette = DEFAULT_LABEL_PALETTE;
            if (oldLen === newLen) {
                for (let i = 0; i < newLen; i++) {
                    this.labels[i].name = labels[i].name;
                    this.labels[i].color = palette[i % palette.length];
                }
            } else {
                // 数が違う → 新しい id を割り振り直す。Mask は invalidate.
                this.labels = labels.map((l, i) => ({
                    id: i + 1,
                    name: l.name,
                    color: palette[i % palette.length],
                }));
                this.currentLabelId = 1;
                if (this.thresholdMask) this.thresholdMask.fill(0);
                if (this.manualEdits) this.manualEdits.fill(0);
                if (this.finalMask) this.finalMask.fill(0);
                this.clearMaskUndo();
                this.invalidateComponentMap();
                this.maskVersion++;
            }
        },

        // ===== 自動保存 (IndexedDB persistence) 用シリアライズ =====
        // 戻り値は persistence.ts の SessionPayload と互換 (サンドボックスで型を共有しないため
        // 構造的に一致させて受け渡す)。呼び出し側 (composable) で saveSession に渡す。
        serializeForPersistence(): {
            seriesUID: string;
            seriesDescription?: string;
            savedAt: number;
            thresholdMask?: ArrayBuffer;
            manualEdits?: ArrayBuffer;
            finalMask?: ArrayBuffer;
            dims: [number, number, number];
            voxelSizeMm?: [number, number, number];
            threshold: number;
            thresholdUnit: 'SUV' | 'CNTS';
            labels: LabelEntry[];
            currentLabelId: number;
            sphere: { centerWorld: [number, number, number]; radiusMm: number } | null;
        } | null {
            const pet = this.petVolumeRef;
            if (!pet || !pet.metadata?.seriesUID) return null;
            // typed array を ArrayBuffer に展開して clone (主スレッド参照とは独立)
            const cloneBuf = (a: Uint16Array | null): ArrayBuffer | undefined => {
                if (!a) return undefined;
                return a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength);
            };
            return {
                seriesUID: pet.metadata.seriesUID,
                seriesDescription: pet.metadata.seriesDescription,
                savedAt: Date.now(),
                thresholdMask: cloneBuf(this.thresholdMask),
                manualEdits:   cloneBuf(this.manualEdits),
                finalMask:     cloneBuf(this.finalMask),
                dims: [pet.nx, pet.ny, pet.nz],
                voxelSizeMm: [pet.vectorX.length(), pet.vectorY.length(), pet.vectorZ.length()],
                threshold: this.threshold,
                thresholdUnit: this.thresholdUnit,
                labels: this.labels.map(l => ({ id: l.id, name: l.name, color: [...l.color] as [number,number,number] })),
                currentLabelId: this.currentLabelId,
                sphere: this.sphere
                    ? { centerWorld: [this.sphere.centerWorld.x, this.sphere.centerWorld.y, this.sphere.centerWorld.z], radiusMm: this.sphere.radiusMm }
                    : null,
            };
        },

        // 永続化された session payload を現在 PT volume に対して復元する。
        // dims が一致しなければ何もしない (誤った PT に当てるのを避ける)。
        restoreFromPersistence(payload: {
            thresholdMask?: ArrayBuffer;
            manualEdits?: ArrayBuffer;
            finalMask?: ArrayBuffer;
            dims: [number, number, number];
            threshold: number;
            thresholdUnit: 'SUV' | 'CNTS';
            labels: LabelEntry[];
            currentLabelId: number;
            sphere: { centerWorld: [number, number, number]; radiusMm: number } | null;
            savedAt: number;
        }): { ok: true } | { ok: false; reason: string } {
            const pet = this.petVolumeRef;
            if (!pet) return { ok: false, reason: 'No PET volume loaded.' };
            const [dx, dy, dz] = payload.dims;
            if (dx !== pet.nx || dy !== pet.ny || dz !== pet.nz) {
                return {
                    ok: false,
                    reason: `Saved session dims (${dx}×${dy}×${dz}) don't match current PET (${pet.nx}×${pet.ny}×${pet.nz}).`,
                };
            }
            this.ensureMaskAllocated();
            const expectedLen = dx * dy * dz;
            const restoreInto = (target: Uint16Array | null, src?: ArrayBuffer) => {
                if (!target || !src) return;
                const view = new Uint16Array(src);
                if (view.length !== expectedLen) return;
                target.set(view);
            };
            restoreInto(this.thresholdMask, payload.thresholdMask);
            restoreInto(this.manualEdits,   payload.manualEdits);
            restoreInto(this.finalMask,     payload.finalMask);
            this.threshold = payload.threshold;
            this.thresholdUnit = payload.thresholdUnit;
            if (Array.isArray(payload.labels) && payload.labels.length > 0) {
                this.labels = payload.labels.map(l => ({
                    id: l.id, name: l.name,
                    color: [l.color[0], l.color[1], l.color[2]] as [number, number, number],
                }));
            }
            this.currentLabelId = payload.currentLabelId ?? (this.labels[0]?.id ?? 1);
            // sphere は world 座標で復元
            if (payload.sphere) {
                this.sphere = {
                    centerWorld: new THREE.Vector3(...payload.sphere.centerWorld),
                    radiusMm: payload.sphere.radiusMm,
                    suvMax: 0, suvMean: 0, suvStd: 0, voxelCount: 0,
                };
            }
            this.clearMaskUndo();
            this.invalidateComponentMap();
            this.maskVersion++;
            this.lastAutoSavedAt = payload.savedAt;
            return { ok: true };
        },

        markAutoSaved(at: number) {
            this.lastAutoSavedAt = at;
        },

        // ===== CT 寝台除去 =====
        // 現在の ctVolumeRef から体マスクを抽出して保存。toggle ON で表示適用。
        computeCtBodyMask(threshold: number = -300): boolean {
            const ct = this.ctVolumeRef;
            if (!ct) return false;
            const t0 = performance.now();
            this.ctBodyMask = extractCtBodyMask(ct.voxel, ct.nx, ct.ny, ct.nz, threshold);
            this.ctBodyMaskEnabled = true;
            this.ctBodyMaskVersion++;
            const t1 = performance.now();
            console.log(`[ct-bed-removal] body mask computed in ${(t1 - t0).toFixed(0)}ms (threshold=${threshold} HU)`);
            return true;
        },

        toggleCtBodyMaskEnabled() {
            this.ctBodyMaskEnabled = !this.ctBodyMaskEnabled;
            this.ctBodyMaskVersion++;
        },

        clearCtBodyMask() {
            this.ctBodyMask = null;
            this.ctBodyMaskEnabled = false;
            this.ctBodyMaskVersion++;
        },

        // ===== Crosshair (focus position synced across boxes) =====
        // 設定すると sphere ROI が定義済みなら sphere center も同位置へ移動し stats 再計算
        setCrosshairWorld(p: THREE.Vector3 | null) {
            this.crosshairWorld = p ? p.clone() : null;
            this.crosshairVersion++;
            if (this.sphere && p) {
                this.sphere.centerWorld.copy(p);
                this.recomputeSphereStatsInline();
            }
        },

        // 現在の sphere に対し PET から SUVmax/mean/std/voxelCount を計算し直す
        recomputeSphereStatsInline() {
            if (!this.sphere || !this.petVolumeRef) return;
            const stats = sphereStatsInPet(this.petVolumeRef, this.sphere.centerWorld, this.sphere.radiusMm);
            this.sphere.suvMax = stats.suvMax;
            this.sphere.suvMean = stats.suvMean;
            this.sphere.suvStd = stats.suvStd;
            this.sphere.voxelCount = stats.voxelCount;
        },

        // crosshair を vec で進める (slice paging 連動用)
        advanceCrosshair(vec: THREE.Vector3, n: number) {
            if (!this.crosshairWorld) return;
            this.crosshairWorld = this.crosshairWorld.clone().addScaledVector(vec, n);
            this.crosshairVersion++;
            if (this.sphere) {
                this.sphere.centerWorld.copy(this.crosshairWorld);
                this.recomputeSphereStatsInline();
            }
        },

        clearCrosshair() {
            this.crosshairWorld = null;
            this.crosshairVersion++;
        },

        // ===== MR-PET registration =====
        // MR の幾何 snapshot を初回 capture (元データを保持して何度でも再適用)
        ensureMrRegistrationSnapshot() {
            if (this.mrRegistrationSnapshot) return;
            const mr = this.mrVolumeRef;
            if (!mr) return;
            // dynamic import を避けるため、ここでは mrRegistrationSnapshot を直接構築
            this.mrRegistrationSnapshot = {
                originalImagePosition: [mr.imagePosition.x, mr.imagePosition.y, mr.imagePosition.z],
                originalVectorX: [mr.vectorX.x, mr.vectorX.y, mr.vectorX.z],
                originalVectorY: [mr.vectorY.x, mr.vectorY.y, mr.vectorY.z],
                originalVectorZ: [mr.vectorZ.x, mr.vectorZ.y, mr.vectorZ.z],
                currentParams: [0, 0, 0, 0, 0, 0],
            };
        },

        setMrRegistrationParams(p: [number, number, number, number, number, number] | null) {
            this.mrRegistrationParams = p ? [...p] : null;
            this.mrRegistrationVersion++;
        },

        setMrRegistrationProgress(prog: { level: number; nLevels: number; iter: number; mi: number } | null) {
            this.mrRegistrationProgress = prog;
        },

        setMrRegistrationInProgress(b: boolean) {
            this.mrRegistrationInProgress = b;
        },

        loadMaskFromNifti(
            mask: Uint16Array,
            dims: [number, number, number],
            sidecar?: {
                threshold?: number;
                thresholdUnit?: 'SUV' | 'CNTS';
                labels?: LabelEntry[];
            } | null,
        ): { ok: true } | { ok: false; reason: string } {
            const pet = this.petVolumeRef;
            if (!pet) {
                return { ok: false, reason: 'No PET volume is loaded. Load a PET volume first.' };
            }
            if (dims[0] !== pet.nx || dims[1] !== pet.ny || dims[2] !== pet.nz) {
                return {
                    ok: false,
                    reason: `Mask dims (${dims[0]} x ${dims[1]} x ${dims[2]}) do not match current PET volume (${pet.nx} x ${pet.ny} x ${pet.nz}).`,
                };
            }
            this.ensureMaskAllocated();
            const me = this.manualEdits!;
            const tm = this.thresholdMask!;
            me.set(mask);
            tm.fill(0);
            this.clearMaskUndo();
            this.recomputeFinalMask();
            this.invalidateComponentMap();
            this.maskVersion++;

            if (sidecar) {
                if (typeof sidecar.threshold === 'number' && Number.isFinite(sidecar.threshold)) {
                    this.threshold = sidecar.threshold;
                }
                if (sidecar.thresholdUnit === 'SUV' || sidecar.thresholdUnit === 'CNTS') {
                    this.thresholdUnit = sidecar.thresholdUnit;
                }
                if (Array.isArray(sidecar.labels) && sidecar.labels.length > 0) {
                    this.labels = sidecar.labels.map(l => ({
                        id: l.id,
                        name: l.name,
                        color: [l.color[0], l.color[1], l.color[2]] as [number, number, number],
                    }));
                    this.currentLabelId = this.labels[0].id;
                }
            }
            return { ok: true };
        },

        saveMaskAsNifti(filename?: string): boolean {
            const pet = this.petVolumeRef;
            const m = this.finalMask;
            if (!pet || !m) return false;
            const blob = writeNiftiUint16(m, pet);
            const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
            const sid = pet.metadata?.seriesUID
                ? pet.metadata.seriesUID.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
                : 'mask';
            const fname = filename ?? `${sid}_${ts}.nii`;
            triggerDownload(blob, fname);

            // JSON サイドカー
            const sidecar = {
                created: new Date().toISOString(),
                threshold: this.threshold,
                thresholdUnit: this.thresholdUnit,
                labels: this.labels,
                petMetadata: pet.metadata ?? null,
                voxelSizeMm: [pet.vectorX.length(), pet.vectorY.length(), pet.vectorZ.length()],
                dims: [pet.nx, pet.ny, pet.nz],
            };
            const jsonBlob = new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' });
            triggerDownload(jsonBlob, fname + '.json');
            return true;
        },
    },
});

export const ERASE_MARK = ERASE_SENTINEL;
