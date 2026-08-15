import { defineStore } from 'pinia';
import * as THREE from '@/lib/threeMath';
import type { Volume } from '../components/Volume';
import { connectedComponents26, floodFillAssignLabel, extractCtBodyMask, sphereStatsInPet } from '../components/segmentation/maskOps';
import { writeNiftiUint16, triggerDownload } from '../components/segmentation/niftiWriter';
import { evictVolumeTexture } from '../components/webgpu/volumeCache';

/** 体マスクを world bbox の各面から何 mm 削るか (オプション B の crop box)。 */
export interface CtCropMarginsMm {
    xMin: number; xMax: number;
    yMin: number; yMax: number;
    zMin: number; zMax: number;
}
export const emptyCropMargins = (): CtCropMarginsMm =>
    ({ xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 });
export const hasAnyCropMargin = (m: CtCropMarginsMm): boolean =>
    m.xMin > 0 || m.xMax > 0 || m.yMin > 0 || m.yMax > 0 || m.zMin > 0 || m.zMax > 0;
import { surfaceThresholdFor } from '../components/surfaceThreshold';

export interface LabelEntry {
    id: number;
    name: string;
    color: [number, number, number];
    // overlay 表示の on/off (eye アイコン)。未定義は表示とみなす (旧 snapshot 後方互換)。
    visible?: boolean;
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

// ===== 編集履歴 (undo / redo) =====
// マスク編集 (Apply / Clear / polygon / brush / assign) は thresholdMask と manualEdits の
// **sparse diff** (変更された voxel だけ) で記録する。finalMask は recomputeFinalMask で
// threshold+manual から導出できるので diff には含めない。矩形 ROI 操作も同じ履歴に載せて
// 1 本のタイムラインで undo/redo できるようにする。
export interface MaskDiff {
    idx: Uint32Array;      // 変更された voxel の flat index
    tBefore: Uint16Array;  // thresholdMask の before 値 (idx と並行)
    tAfter: Uint16Array;   // thresholdMask の after 値
    mBefore: Uint16Array;  // manualEdits の before 値
    mAfter: Uint16Array;   // manualEdits の after 値
}
export type HistoryOp =
    | { kind: 'mask'; diff: MaskDiff }
    | { kind: 'rectAdd'; roi: RectROI }
    | { kind: 'rectRemove'; roi: RectROI };
export interface HistoryEntry {
    label: string;   // 履歴パネル表示用ラベル (UI ポリシーに従い英語)
    ts: number;      // epoch ms
    op: HistoryOp;
}

const HISTORY_LIMIT = 50;

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
// 既定は 3 つだけに絞る (多すぎると選択のコストが上がるため)。
// 部位別 (Lymph / Bone / Lung / Liver …) が要るケースはラベルリスト下端の
// 「+ Add label」から随時足せる (addLabel が palette 色を自動割り当て)。
const DEFAULT_LABELS: Array<{ name: string; color: [number, number, number] }> = [
    { name: 'Tumor',           color: [255, 90, 90] },    // red
    { name: 'Non-tumor',       color: [120, 200, 255] },  // light blue (水色)
    // Other は cyan だと Non-tumor の水色と紛らわしかったので黄色に。
    // 赤 (Tumor) とは色相、水色 (Non-tumor) とは色相・明度の両方で離れる。
    { name: 'Other',           color: [255, 205, 60] },   // amber / yellow
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

    // 編集履歴 (undo/redo)。ROI 操作 + マスク編集を時系列で 1 本に。
    history: HistoryEntry[];   // 適用済み (古い→新しい)。undo で末尾を巻き戻す。
    redoStack: HistoryEntry[]; // undo で取り消した操作 (redo で戻せる)。
    // マスク編集の diff 計算用スナップショット (transient、永続化しない)。
    editSnapT: Uint16Array | null;
    editSnapM: Uint16Array | null;

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

    // 位置合わせ (rigid 6-DOF) を **series 単位**で保持する。
    // 実体 (volume の imagePosition / vector*) は DicomView 側が持つが、それは
    // 再ロードで失われるので、永続化できる「撮影時姿勢からの差分」をここに写しておく。
    // auto-register / 手動調整のたびに DicomView が setRegistration で更新する。
    registrations: Array<{ seriesUID: string; params: number[] }>;
    registrationVersion: number;     // auto-save の watch 用

    // CT 寝台除去 (体マスク) — 1=体内、0=体外。CT volume と同じ次元。
    ctBodyMask: Uint8Array | null;
    ctBodyMaskEnabled: boolean;     // 表示時に適用するか (toggle)
    ctBodyMaskVersion: number;      // 表示更新トリガ用
    // 体マスクから「下から N mm」を落とす (寝台/台座の除去)。0 = 使わない。
    // これは ctCropMarginsMm.zMin と同じものを指す (下面だけは使用頻度が高いので別入口を持たせてある)。
    ctBedCutBottomMm: number;
    // **オプション B: 6 面それぞれから N mm 削る (crop box)。**
    // 下面カット (オプション A) は「world -Z 面から削る」特殊形。台座が下でない場合
    // (kitty の背板など) は他の面も要るので一般化してある。すべて 0 なら何もしない。
    ctCropMarginsMm: CtCropMarginsMm;

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

        threshold: 3.0,
        thresholdUnit: 'SUV',

        labels: DEFAULT_LABELS.map((l, i) => ({
            id: i + 1,
            name: l.name,
            color: l.color,
            visible: true,
        })),
        // 初期の編集ラベルは Non-tumor (id=2)。生理的集積を先に塗り分け、腫瘍だけを Tumor に付け替える運用。
        currentLabelId: 2,

        sphere: null,
        polygon: null,

        rectRois: [],
        nextRectRoiId: 1,

        history: [],
        redoStack: [],
        editSnapT: null,
        editSnapM: null,

        overlayAlpha: 0.5,
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
        registrations: [],
        registrationVersion: 0,

        ctBodyMask: null,
        ctBedCutBottomMm: 0,
        ctCropMarginsMm: emptyCropMargins(),
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
        // Undo / Redo ボタン・Ctrl+Z / Ctrl+Shift+Z の活性判定
        canUndo(state): boolean {
            return state.history.length > 0;
        },
        canRedo(state): boolean {
            return state.redoStack.length > 0;
        },
        // 履歴パネル表示用タイムライン。適用済み (古い→新しい) の後に、redo 可能な操作を
        // 「次に redo される順」で並べる。applied=false が redo 待ち。
        historyTimeline(state): Array<{ label: string; ts: number; applied: boolean; step: number }> {
            const out: Array<{ label: string; ts: number; applied: boolean; step: number }> = [];
            state.history.forEach((e, i) => out.push({ label: e.label, ts: e.ts, applied: true, step: i }));
            // redoStack は「最後に undo したもの」が末尾。次に redo されるのは末尾なので逆順に並べる。
            for (let i = state.redoStack.length - 1; i >= 0; i--) {
                const e = state.redoStack[i];
                out.push({ label: e.label, ts: e.ts, applied: false, step: state.redoStack.length - 1 - i });
            }
            return out;
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
            // finalMask は recomputeFinalMask / assign で **in-place 変更** される (配列参照は不変) ので、
            // finalMask だけを dep にすると Vue が再計算せず Labels 表が stale になる (assign しても 0 のまま)。
            // lesionRows と同様に maskVersion を dep に含めて、マスク編集ごとに再計算させる。
            void state.maskVersion;
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
            // 同上: finalMask は in-place 変更されるため maskVersion を dep にして再計算させる。
            void state.maskVersion;
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
                this.clearHistory();
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
            this.beginMaskEdit();
            const v = this.petVolumeRef!;
            const t = this.thresholdMask!;
            const pet = v.voxel;
            const id = this.currentLabelId;
            for (let i = 0; i < pet.length; i++) {
                t[i] = pet[i] >= threshold ? id : 0;
            }
            this.recomputeFinalMask();
            this.invalidateComponentMap();
            const lname = this.labelById(id)?.name ?? `#${id}`;
            this.commitMaskEdit(`Apply threshold SUV ${threshold} → ${lname}`);
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
            if (!this.thresholdMask) return;
            this.beginMaskEdit();
            this.thresholdMask.fill(0);
            this.recomputeFinalMask();
            this.invalidateComponentMap();
            this.commitMaskEdit('Clear threshold');
        },

        clearManualEdits() {
            if (this.manualEdits) this.manualEdits.fill(0);
            this.clearHistory();
            this.recomputeFinalMask();
            this.invalidateComponentMap();
        },

        // Polygon 確定後など外部から手動編集が入った直後に呼ぶ
        markManualEditsChanged() {
            this.invalidateComponentMap();
        },

        // SUV 減衰補正モードの切替 ('voxbase' = 整数秒/Vox-BASE 一致 / 'precise' = 小数秒)。
        // voxel は現モードの factor 済みなので、目標 factor との定数比で PET voxel を rescale する。
        // GPU texture を evict して再アップロードさせ、cached な SUV stats も同じ比で更新する。
        setSuvMode(mode: 'voxbase' | 'precise') {
            const v = this.petVolumeRef;
            const md = v?.metadata;
            if (!v || !md || md.suvFactorVoxBase == null || md.suvFactorPrecise == null) return;
            if (md.suvMode === mode) return;
            const target = mode === 'precise' ? md.suvFactorPrecise : md.suvFactorVoxBase;
            const current = md.suvFactor ?? md.suvFactorVoxBase;
            if (!target || !current || target <= 0 || current <= 0) return;
            const ratio = target / current;
            if (Number.isFinite(ratio) && Math.abs(ratio - 1) > 1e-15) {
                const vox = v.voxel;
                for (let i = 0; i < vox.length; i++) vox[i] *= ratio;
                evictVolumeTexture(vox);   // GPU 3D texture を再アップロード強制
                // 再測定不要で即反映されるよう、保持済み SUV stats も同比で rescale。
                if (this.sphere) {
                    this.sphere.suvMax *= ratio;
                    this.sphere.suvMean *= ratio;
                    this.sphere.suvStd *= ratio;
                }
                for (const k of ['liver', 'bloodPool'] as const) {
                    const rs = this.referenceSpheres[k];
                    if (rs) { rs.suvMean *= ratio; rs.suvStd *= ratio; }
                }
            }
            md.suvFactor = target;
            md.suvMode = mode;
            this.maskVersion++;   // lesion table / histogram を再計算させる
        },

        // ===== 編集履歴 (undo / redo) =====
        // マスクが置き換わった等で履歴が無効になったとき全消去する。
        clearHistory() {
            this.history = [];
            this.redoStack = [];
            this.editSnapT = null;
            this.editSnapM = null;
        },

        // マスク編集を始める直前に呼ぶ。現在の threshold/manual を snapshot して diff の基準にする。
        // begin → (編集) → commitMaskEdit(label) の対で 1 履歴エントリを作る。
        beginMaskEdit() {
            this.editSnapT = this.thresholdMask ? this.thresholdMask.slice() : null;
            this.editSnapM = this.manualEdits ? this.manualEdits.slice() : null;
        },

        // beginMaskEdit 後の編集を履歴に確定する。変更が無ければ何もしない (false)。
        commitMaskEdit(label: string): boolean {
            const t = this.thresholdMask;
            const m = this.manualEdits;
            const tb = this.editSnapT;
            const mb = this.editSnapM;
            this.editSnapT = null;
            this.editSnapM = null;
            if (!t || !m) return false;

            // 変更のあった voxel index を収集 (threshold か manual のどちらかが変わった所)。
            const changed: number[] = [];
            const n = t.length;
            for (let i = 0; i < n; i++) {
                const tPrev = tb ? tb[i] : 0;
                const mPrev = mb ? mb[i] : 0;
                if (t[i] !== tPrev || m[i] !== mPrev) changed.push(i);
            }
            if (changed.length === 0) return false;

            const cnt = changed.length;
            const idx = Uint32Array.from(changed);
            const tBefore = new Uint16Array(cnt), tAfter = new Uint16Array(cnt);
            const mBefore = new Uint16Array(cnt), mAfter = new Uint16Array(cnt);
            for (let e = 0; e < cnt; e++) {
                const i = idx[e];
                tBefore[e] = tb ? tb[i] : 0; tAfter[e] = t[i];
                mBefore[e] = mb ? mb[i] : 0; mAfter[e] = m[i];
            }
            this.pushHistory({ label, ts: Date.now(), op: { kind: 'mask', diff: { idx, tBefore, tAfter, mBefore, mAfter } } });
            return true;
        },

        // 履歴へ 1 件積む。新規操作なので redo スタックは無効化する。
        pushHistory(entry: HistoryEntry) {
            this.history.push(entry);
            if (this.history.length > HISTORY_LIMIT) this.history.shift();
            this.redoStack = [];
        },

        // MaskDiff を dir 方向へ適用 (undo=before / redo=after)。finalMask は recompute で導出。
        applyMaskDiff(diff: MaskDiff, dir: 'undo' | 'redo') {
            const t = this.thresholdMask;
            const m = this.manualEdits;
            if (!t || !m) return;
            const tv = dir === 'undo' ? diff.tBefore : diff.tAfter;
            const mv = dir === 'undo' ? diff.mBefore : diff.mAfter;
            for (let e = 0; e < diff.idx.length; e++) {
                const i = diff.idx[e];
                t[i] = tv[e];
                m[i] = mv[e];
            }
            this.recomputeFinalMask();
            this.invalidateComponentMap();
        },

        // 履歴エントリを「取り消す」(undo) / 「やり直す」(redo) 方向へ適用する内部ヘルパ。
        applyHistoryEntry(entry: HistoryEntry, dir: 'undo' | 'redo') {
            const op = entry.op;
            if (op.kind === 'mask') {
                this.applyMaskDiff(op.diff, dir);
            } else if (op.kind === 'rectAdd') {
                // 追加 op: undo=消す / redo=戻す
                if (dir === 'undo') {
                    this.rectRois = this.rectRois.filter(r => r.id !== op.roi.id);
                } else if (!this.rectRois.some(r => r.id === op.roi.id)) {
                    this.rectRois.push(op.roi);
                }
            } else if (op.kind === 'rectRemove') {
                // 削除 op: undo=戻す / redo=消す
                if (dir === 'undo') {
                    if (!this.rectRois.some(r => r.id === op.roi.id)) this.rectRois.push(op.roi);
                } else {
                    this.rectRois = this.rectRois.filter(r => r.id !== op.roi.id);
                }
            }
        },

        // 直前操作を 1 つ巻き戻す。成功で true。
        undo(): boolean {
            const entry = this.history.pop();
            if (!entry) return false;
            this.applyHistoryEntry(entry, 'undo');
            this.redoStack.push(entry);
            if (this.redoStack.length > HISTORY_LIMIT) this.redoStack.shift();
            return true;
        },

        // 取り消した操作を 1 つやり直す。成功で true。
        redo(): boolean {
            const entry = this.redoStack.pop();
            if (!entry) return false;
            this.applyHistoryEntry(entry, 'redo');
            this.history.push(entry);
            if (this.history.length > HISTORY_LIMIT) this.history.shift();
            return true;
        },

        // 履歴パネルから任意地点へジャンプ: 適用済みを targetAppliedLen 件にする。
        // (現在 > target なら undo、現在 < target なら redo を繰り返す)
        gotoHistory(targetAppliedLen: number) {
            let guard = 0;
            while (this.history.length > targetAppliedLen && guard++ < 1000) {
                if (!this.undo()) break;
            }
            while (this.history.length < targetAppliedLen && guard++ < 1000) {
                if (!this.redo()) break;
            }
        },

        addLabel(name: string): LabelEntry {
            const nextId = this.labels.length === 0
                ? 1
                : Math.max(...this.labels.map(l => l.id)) + 1;
            const color = DEFAULT_LABEL_PALETTE[(nextId - 1) % DEFAULT_LABEL_PALETTE.length];
            const entry: LabelEntry = { id: nextId, name, color, visible: true };
            this.labels.push(entry);
            return entry;
        },

        // overlay 上でのラベル表示を切り替える (eye アイコン)。複数ラベルを個別に on/off 可能。
        // 描画は labelClut の 4 番目の成分 (visibility) 経由で反映されるので、呼び出し側は
        // この後に show() (redraw) を実行する。
        toggleLabelVisible(id: number) {
            const l = this.labels.find(x => x.id === id);
            if (l) l.visible = l.visible === false ? true : false;
        },

        // overlay バー先頭の master eye 用: 全ラベルの表示を一括で on/off する。
        setAllLabelsVisible(v: boolean) {
            for (const l of this.labels) l.visible = v;
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
                // roi 実体を履歴に載せる (redo で同一 id を復元できるように)
                this.pushHistory({ label: `Add rectangle ROI ${roi.label ?? '#' + this.rectRois.length}`, ts: Date.now(), op: { kind: 'rectAdd', roi: { ...roi } } });
            }
            return roi;
        },

        removeRectRoi(id: number) {
            const roi = this.rectRois.find(r => r.id === id);
            if (!roi) return;
            this.rectRois = this.rectRois.filter(r => r.id !== id);
            // 削除を undo できるよう ROI 実体を保持
            this.pushHistory({ label: `Remove rectangle ROI ${roi.label ?? '#' + id}`, ts: Date.now(), op: { kind: 'rectRemove', roi: { ...roi } } });
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

        // 全削除。履歴からも矩形 ROI 関連エントリを除去する
        // (履歴に残しても復元先の整合が取れないため)。
        clearRectRois() {
            this.rectRois = [];
            const notRect = (e: HistoryEntry) => e.op.kind !== 'rectAdd' && e.op.kind !== 'rectRemove';
            this.history = this.history.filter(notRect);
            this.redoStack = this.redoStack.filter(notRect);
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
            const t = this.thresholdMask;
            const me = this.manualEdits;
            if (!pet || !m || !t || !me) return 0;
            // クリック位置から 26-連結で局所 flood fill し、seed と同一ラベルの島だけを labelId に
            // 書き換える (finalMask + manualEdits)。O(領域サイズ)。
            // flood fill が変更点 (changedIdx / manualBefore) を返すので、そこから **直接**
            // sparse diff を作って履歴に push する。beginMaskEdit の全配列 clone (~100MB) と
            // commitMaskEdit の O(n) 走査を回避 → WB PET でも assign が即時反映される。
            const { count, changedIdx, manualBefore } = floodFillAssignLabel(m, me, { i, j, k }, pet.nx, pet.ny, pet.nz, labelId);
            if (count > 0) {
                const cnt = changedIdx.length;
                const tBefore = new Uint16Array(cnt), tAfter = new Uint16Array(cnt);
                const mAfter = new Uint16Array(cnt);
                for (let e = 0; e < cnt; e++) {
                    const idx = changedIdx[e];
                    tBefore[e] = t[idx]; tAfter[e] = t[idx];   // threshold は不変
                    mAfter[e] = labelId;
                }
                const lname = this.labelById(labelId)?.name ?? `#${labelId}`;
                // 非ゼロ集合 (連結成分の構造) は不変なので componentMap は有効なまま。
                this.pushHistory({
                    label: `Assign region → ${lname}`,
                    ts: Date.now(),
                    op: { kind: 'mask', diff: { idx: changedIdx, tBefore, tAfter, mBefore: manualBefore, mAfter } },
                });
                this.maskVersion++;
            }
            return count;
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
                this.clearHistory();
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
                // **finalMask は保存しない。** recomputeFinalMask() が thresholdMask と
                // manualEdits から厳密に導出できるので、持つ意味が無いうえに実害がある。
                // これは **マスク編集のたびに 2 秒 debounce で走る** (useAutoSave)。
                // 実測 (Hirata の PET 256x490x146): 3 本で 104.79MB のコピー 30.6ms +
                // IndexedDB 書き込み 137.4ms = 168ms。1 本減らすと 33% 削れる。
                // (gzip も測ったが **2180ms** かかるので自動保存には使えない。
                //  一度きりの snapshot 保存では使っている。CLAUDE.md「セッション保存のサイズとコスト」)
                finalMask:     undefined,
                dims: [pet.nx, pet.ny, pet.nz],
                voxelSizeMm: [pet.vectorX.length(), pet.vectorY.length(), pet.vectorZ.length()],
                threshold: this.threshold,
                thresholdUnit: this.thresholdUnit,
                labels: this.labels.map(l => ({ id: l.id, name: l.name, color: [...l.color] as [number,number,number] })),
                currentLabelId: this.currentLabelId,
                sphere: this.sphere
                    ? { centerWorld: [this.sphere.centerWorld.x, this.sphere.centerWorld.y, this.sphere.centerWorld.z], radiusMm: this.sphere.radiusMm }
                    : null,
                registrations: this.registrations.map(r => ({ seriesUID: r.seriesUID, params: [...r.params] })),
            };
        },

        // ===== 位置合わせ (rigid 6-DOF) の記録 =====
        // 実際に volume を動かすのは DicomView (registerSnapshots + applyRigidToVolume)。
        // ここは **永続化のための写し** だけを持つ。identity は保持しない (エントリごと消す)。
        setRegistration(seriesUID: string | undefined | null, params: readonly number[]) {
            if (!seriesUID) return;
            const isIdentity = params.every(v => Math.abs(v) < 1e-9);
            const i = this.registrations.findIndex(r => r.seriesUID === seriesUID);
            if (isIdentity) {
                if (i >= 0) this.registrations.splice(i, 1);
            } else if (i >= 0) {
                this.registrations[i].params = [...params];
            } else {
                this.registrations.push({ seriesUID, params: [...params] });
            }
            this.registrationVersion++;
        },
        clearRegistrations() {
            if (this.registrations.length === 0) return;
            this.registrations = [];
            this.registrationVersion++;
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
            registrations?: Array<{ seriesUID: string; params: number[] }>;
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
            // finalMask は保存していない (導出できるため)。**古い保存データには入っている**ので、
            // あればそのまま入れ、無ければ下の recomputeFinalMask() に任せる。
            const hadFinal = !!payload.finalMask;
            if (hadFinal) restoreInto(this.finalMask, payload.finalMask);
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
            // 位置合わせは **記録するだけ**。実際に volume を動かすのは DicomView 側で、
            // 復元後に applyStoredRegistrations() を呼んでもらう (この store は volume を持たない)。
            if (Array.isArray(payload.registrations)) {
                this.registrations = payload.registrations
                    .filter(r => r && typeof r.seriesUID === 'string' && Array.isArray(r.params) && r.params.length === 6)
                    .map(r => ({ seriesUID: r.seriesUID, params: r.params.map(Number) }));
                this.registrationVersion++;
            }
            // **finalMask を保存しなくなったので、ここで導出する。**
            // 以前は保存された finalMask をそのまま入れており、この呼び出しが無かった。
            // 古い保存データ (finalMask を含む) はそのまま使い、新しいものだけ導出する。
            if (!hadFinal) this.recomputeFinalMask();
            this.clearHistory();
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
        // threshold 未指定なら **データから決める**。
        // 既定の -300HU は人体 CT (皮膚 ≒ 0HU) 前提で、体表の吸収が低い被写体では
        // 体そのものを体外と誤判定して穴だらけになる (実測: sample-data/kitty は体表が
        // -600HU 付近で、-300 だと殻が削れて輪郭が荒れた)。
        // surfaceThresholdFor は Otsu で背景と被写体を分けるので、そのまま体マスクにも使える。
        computeCtBodyMask(threshold?: number, cutBottomMm?: number): boolean {
            const ct = this.ctVolumeRef;
            if (!ct) return false;
            if (threshold == null) threshold = surfaceThresholdFor(ct).threshold;
            if (cutBottomMm == null) cutBottomMm = this.ctBedCutBottomMm;
            const t0 = performance.now();
            this.ctBodyMask = extractCtBodyMask(ct.voxel, ct.nx, ct.ny, ct.nz, threshold);
            // **接触している寝台/台座は連結成分では分けられない。**
            // 実測 (sample-data/kitty): 本体・台座・背板が 1 成分 (22.25%) で、
            // 2 番目以降は 50 voxel 以下のノイズしかなかった。人体 CT では患者と寝台の間に
            // 空気の隙間があるので最大成分＝患者になるが、被写体が台に載っていると成立しない。
            // そこで「下から N mm を落とす」を併用する。CT では寝台は必ず下側なので、
            // 単純だが外しにくい。0 なら従来どおり (連結成分のみ)。
            // オプション A (下面カット) は crop の zMin と同じもの。引数で来たらそちらを優先する。
            const margins: CtCropMarginsMm = { ...this.ctCropMarginsMm, zMin: cutBottomMm };
            if (hasAnyCropMargin(margins)) this.cropBodyMaskMargins(ct, margins);
            this.ctBodyMaskEnabled = true;
            this.ctBodyMaskVersion++;
            const t1 = performance.now();
            console.log(`[ct-bed-removal] body mask computed in ${(t1 - t0).toFixed(0)}ms (threshold=${threshold!.toFixed(0)} HU)`);
            return true;
        },

        // body mask の **world bbox の各面から N mm** を体外にする (オプション B)。
        //
        // 「下から N mm」(オプション A) はこの zMin だけを使う特殊形。CT の寝台は必ず下側なので
        // 人体ではそれで足りるが、被写体が台に載っていたり背板があると他の面も要る
        // (実測 kitty: 本体・台座・背板が 1 連結成分になり、連結成分だけでは分けられない)。
        //
        // **world 座標は k, j, i の線形関数なので増分で回すこと。** voxel ごとに
        // 関数呼び出し + 3 回の積和をすると 2900 万 voxel × 2 周で秒単位かかり UI が固まる
        // (実測: 描画待ちと区別できないほど遅かった)。
        cropBodyMaskMargins(ct: Volume, margins: CtCropMarginsMm) {
            const m = this.ctBodyMask;
            if (!m) return;
            if (!hasAnyCropMargin(margins)) return;
            const t0 = performance.now();
            const { nx, ny, nz } = ct;
            const p0 = ct.imagePosition;
            const vx = ct.vectorX, vy = ct.vectorY, vz = ct.vectorZ;

            // ---- pass 1: マスクの world bbox ----
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            for (let k = 0; k < nz; k++) {
                const x0 = p0.x + vz.x * k, y0 = p0.y + vz.y * k, z0 = p0.z + vz.z * k;
                for (let j = 0; j < ny; j++) {
                    const base = k * nx * ny + j * nx;
                    let x = x0 + vy.x * j, y = y0 + vy.y * j, z = z0 + vy.z * j;
                    for (let i = 0; i < nx; i++, x += vx.x, y += vx.y, z += vx.z) {
                        if (m[base + i] === 0) continue;
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                    }
                }
            }
            if (!Number.isFinite(minX)) return;   // マスクが空

            // ---- pass 2: 各面から margin ぶんを落とす ----
            const cxLo = minX + margins.xMin, cxHi = maxX - margins.xMax;
            const cyLo = minY + margins.yMin, cyHi = maxY - margins.yMax;
            const czLo = minZ + margins.zMin, czHi = maxZ - margins.zMax;
            let removed = 0;
            for (let k = 0; k < nz; k++) {
                const x0 = p0.x + vz.x * k, y0 = p0.y + vz.y * k, z0 = p0.z + vz.z * k;
                for (let j = 0; j < ny; j++) {
                    const base = k * nx * ny + j * nx;
                    let x = x0 + vy.x * j, y = y0 + vy.y * j, z = z0 + vy.z * j;
                    for (let i = 0; i < nx; i++, x += vx.x, y += vx.y, z += vx.z) {
                        if (m[base + i] === 0) continue;
                        if (x < cxLo || x > cxHi || y < cyLo || y > cyHi || z < czLo || z > czHi) {
                            m[base + i] = 0; removed++;
                        }
                    }
                }
            }
            const f = (n: number) => n.toFixed(1);
            console.log(`[ct-bed-removal] crop margins x[${margins.xMin},${margins.xMax}] `
                + `y[${margins.yMin},${margins.yMax}] z[${margins.zMin},${margins.zMax}] mm `
                + `(bbox x ${f(minX)}..${f(maxX)} y ${f(minY)}..${f(maxY)} z ${f(minZ)}..${f(maxZ)}): `
                + `${removed} voxels removed in ${(performance.now() - t0).toFixed(0)}ms`);
        },

        /** 旧 API 互換。下面だけ削る (オプション A)。 */
        cutBodyMaskBottom(ct: Volume, cutBottomMm: number) {
            this.cropBodyMaskMargins(ct, { ...emptyCropMargins(), zMin: cutBottomMm });
        },

        /** crop の 1 面を設定する。zMin は「下面カット」と同じものなので両方を同期させる。 */
        setCtCropMargin(face: keyof CtCropMarginsMm, mm: number) {
            const v = Math.max(0, Number.isFinite(mm) ? mm : 0);
            this.ctCropMarginsMm = { ...this.ctCropMarginsMm, [face]: v };
            if (face === 'zMin') this.ctBedCutBottomMm = v;
        },

        clearCtCropMargins() {
            this.ctCropMarginsMm = emptyCropMargins();
            this.ctBedCutBottomMm = 0;
        },

        setCtBedCutBottomMm(mm: number) {
            // 下面カットは crop の zMin と同じもの。両方を同期させる。
            const v = Math.max(0, Number.isFinite(mm) ? mm : 0);
            this.ctBedCutBottomMm = v;
            this.ctCropMarginsMm = { ...this.ctCropMarginsMm, zMin: v };
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
            this.clearHistory();
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
