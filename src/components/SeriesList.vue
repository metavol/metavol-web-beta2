<script setup lang="ts">
import { computed, ref, inject } from 'vue';
import { useSegmentationStore } from '../stores/segmentation';

// DicomView から provide される thumbnail / slice count getter (paging 用)。
// 未提供環境ではフォールバック (paging 機能は無効化される)。
const getThumbnailForSlice = inject<(seriesIdx: number, sliceIdx: number) => string | null>(
    'getThumbnailForSlice',
    () => null,
);
const getSliceCount = inject<(seriesIdx: number) => number>(
    'getSliceCount',
    () => 0,
);

const props = defineProps<{
    series: Array<{
        index: number;
        description: string;
        modality: string;
        matrixSize: string;
        voxelSize: string;
        fileCount: number;
        hasVolume: boolean;
        thumbnail: string | null;
        seriesUID: string;
        transferSyntaxName: string;
        transferSyntaxSupported: boolean;
        transferSyntaxReason?: string;
        acquisitionTime?: string;
        studyDate?: string;
        studyUID?: string;
        attenuationCorrected?: boolean;
        isPrimary: boolean;
        isRgb: boolean;
        sourceType: 'DICOM' | 'NIFTI';
        datatypeName?: string;
    }>;
}>();

const emit = defineEmits<{
    (e: 'setModality', payload: { index: number; modality: 'PT' | 'CT' | 'MR' }): void;
    (e: 'setActiveForSeg', payload: { index: number; modality: 'PT' | 'CT' }): void;
    (e: 'inspectRaw', payload: { index: number }): void;
    (e: 'viewHeader', payload: { index: number }): void;
}>();

// Drag start: custom mime に series index を載せる。
// ImageBox の drop ハンドラでこの mime を検出してシリーズ差替えを発火する。
const onCardDragStart = (e: DragEvent, index: number) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('application/x-metavol-series', String(index));
    e.dataTransfer.effectAllowed = 'copy';
};

const segStore = useSegmentationStore();

// 同一 modality の series が 2 個以上あるときだけ ★ を表示する (誤操作防止)。
const ptCount = computed(() => props.series.filter(s => s.modality === 'PT' || s.modality === 'PET').length);
const ctCount = computed(() => props.series.filter(s => s.modality === 'CT').length);

const showActiveStarFor = (s: { modality: string }): 'PT' | 'CT' | null => {
    const m = (s.modality ?? '').toUpperCase();
    if ((m === 'PT' || m === 'PET') && ptCount.value >= 2) return 'PT';
    if (m === 'CT' && ctCount.value >= 2) return 'CT';
    return null;
};

const isActiveForSeg = (s: { seriesUID: string; modality: string }): boolean => {
    const m = (s.modality ?? '').toUpperCase();
    if (m === 'PT' || m === 'PET') {
        return !!s.seriesUID && segStore.petVolumeRef?.metadata?.seriesUID === s.seriesUID;
    }
    if (m === 'CT') {
        return !!s.seriesUID && segStore.ctVolumeRef?.metadata?.seriesUID === s.seriesUID;
    }
    return false;
};

const toggleActive = (e: MouseEvent, index: number, modality: 'PT' | 'CT') => {
    e.stopPropagation();
    emit('setActiveForSeg', { index, modality });
};

const modalityChip = (m: string): { color: string; text: string } => {
    if (m === 'PT' || m === 'PET') return { color: '#ff9b3a', text: 'PT' };
    if (m === 'CT') return { color: '#7ad0ff', text: 'CT' };
    if (m === 'MR') return { color: '#a78bfa', text: 'MR' };
    return { color: '#888', text: m || '??' };
};

const isUnknownModality = (m: string): boolean => {
    const u = (m ?? '').toUpperCase();
    return u !== 'PT' && u !== 'PET' && u !== 'CT' && u !== 'MR';
};

const setModality = (e: MouseEvent, index: number, modality: 'PT' | 'CT' | 'MR') => {
    e.stopPropagation();
    emit('setModality', { index, modality });
};

// Primary / Other 分離 (Other はデフォルト非表示、トグルで展開)
const primarySeries = computed(() => props.series.filter(s => s.isPrimary));
const otherSeries   = computed(() => props.series.filter(s => !s.isPrimary));
const showOthers = ref(false);

// ===== サムネ paging (preview only) =====
// 各カードごとに「現在プレビュー中の slice index」を保持。wheel で更新。
// thumbnail からの drag はカード全体の DnD (シリーズロード) のために解放。
const previewSliceIdx = ref<Map<number, number>>(new Map());     // seriesIdx -> sliceIdx
const previewThumb     = ref<Map<number, string>>(new Map());    // seriesIdx -> dataURL

const onThumbWheel = (e: WheelEvent, seriesIdx: number) => {
    const total = getSliceCount(seriesIdx);
    if (total <= 1) return;
    e.preventDefault();
    e.stopPropagation();

    const cur = previewSliceIdx.value.get(seriesIdx) ?? Math.floor(total / 2);
    const step = e.deltaY > 0 ? 1 : -1;
    let newSlice = cur + step;
    if (newSlice < 0) newSlice = 0;
    if (newSlice >= total) newSlice = total - 1;
    if (newSlice === cur) return;

    previewSliceIdx.value.set(seriesIdx, newSlice);
    const thumb = getThumbnailForSlice(seriesIdx, newSlice);
    if (thumb) previewThumb.value.set(seriesIdx, thumb);
    // reactive な map 変更通知のため新しい Map を作って差し替え
    previewSliceIdx.value = new Map(previewSliceIdx.value);
    previewThumb.value = new Map(previewThumb.value);
};

// 表示用 thumbnail: paging 中に書き換えがあればそれを使う、なければ初期サムネ
const thumbSrcFor = (s: { index: number; thumbnail: string | null }): string | null => {
    return previewThumb.value.get(s.index) ?? s.thumbnail;
};

// オーバーレイ表示用の slice 位置 (例: "87 / 372")
const sliceLabelFor = (s: { index: number }): string | null => {
    const idx = previewSliceIdx.value.get(s.index);
    if (idx == null) return null;
    const total = getSliceCount(s.index);
    if (total <= 1) return null;
    return `${idx + 1} / ${total}`;
};
</script>

<template>
    <v-container fluid class="pa-1">
        <div v-if="series.length === 0" class="text-caption text-disabled px-2">
            No series
        </div>

        <!-- Primary series (PET-CT fusion 解析対象) -->
        <div
            v-for="s in primarySeries"
            :key="`p-${s.index}`"
            class="series-card"
            :class="{ 'is-active-seg': isActiveForSeg(s) }"
            draggable="true"
            @dragstart="(e: DragEvent) => onCardDragStart(e, s.index)"
            :title="'Drag this card onto an image box to load this series'"
        >
            <!-- ... メニュー: NIfTI raw bytes 表示 / NIfTI header 表示。
                 sourceType=NIFTI のときだけ NIfTI 系項目を表示。 -->
            <v-menu location="bottom end">
                <template v-slot:activator="{ props: act }">
                    <button
                        v-bind="act"
                        class="card-menu-btn"
                        title="More options"
                        @click.stop
                        @mousedown.stop
                    >
                        <v-icon icon="mdi-dots-horizontal" size="x-small" />
                    </button>
                </template>
                <v-list density="compact">
                    <v-list-item
                        v-if="s.sourceType === 'NIFTI'"
                        @click="emit('viewHeader', { index: s.index })"
                    >
                        <template v-slot:prepend>
                            <v-icon icon="mdi-format-list-bulleted-type" size="small" />
                        </template>
                        <v-list-item-title>View NIfTI header</v-list-item-title>
                    </v-list-item>
                    <v-list-item
                        v-if="s.sourceType === 'NIFTI' && s.hasVolume"
                        @click="emit('inspectRaw', { index: s.index })"
                    >
                        <template v-slot:prepend>
                            <v-icon icon="mdi-database-search-outline" size="small" />
                        </template>
                        <v-list-item-title>Inspect raw bytes</v-list-item-title>
                        <v-list-item-subtitle>Bypass affine — show storage order</v-list-item-subtitle>
                    </v-list-item>
                    <v-list-item v-if="s.sourceType === 'DICOM'" disabled>
                        <v-list-item-title class="text-caption text-disabled">No actions for DICOM</v-list-item-title>
                    </v-list-item>
                </v-list>
            </v-menu>
            <div
                class="thumb"
                @wheel="(e: WheelEvent) => onThumbWheel(e, s.index)"
                title="Wheel to scrub slices (preview only)"
            >
                <img v-if="thumbSrcFor(s)" :src="thumbSrcFor(s) as string" draggable="false" />
                <div v-else class="thumb-placeholder">
                    <v-icon icon="mdi-image-off-outline" size="small"></v-icon>
                </div>
                <span v-if="sliceLabelFor(s)" class="slice-label">{{ sliceLabelFor(s) }}</span>
                <button
                    v-if="showActiveStarFor(s)"
                    class="star-btn"
                    :class="{ 'is-active': isActiveForSeg(s) }"
                    :title="isActiveForSeg(s)
                        ? `Currently active ${showActiveStarFor(s)} for segmentation`
                        : `Set as active ${showActiveStarFor(s)} for segmentation`"
                    @mousedown.stop
                    @click="(e) => toggleActive(e, s.index, showActiveStarFor(s) as 'PT' | 'CT')"
                >
                    <v-icon
                        :icon="isActiveForSeg(s) ? 'mdi-star' : 'mdi-star-outline'"
                        size="x-small"
                    />
                </button>
            </div>
            <div class="meta">
                <div class="row1">
                    <span class="modality" :style="{ background: modalityChip(s.modality).color }">
                        {{ modalityChip(s.modality).text }}
                    </span>
                    <span
                        class="source-chip"
                        :class="{ 'is-dicom': s.sourceType === 'DICOM', 'is-nifti': s.sourceType === 'NIFTI' }"
                        :title="s.sourceType === 'DICOM' ? 'Loaded from DICOM' : 'Loaded from NIfTI (.nii / .nii.gz)'"
                    >{{ s.sourceType === 'DICOM' ? 'DCM' : 'NII' }}</span>
                    <span
                        v-if="s.attenuationCorrected !== undefined"
                        class="attn-chip"
                        :class="{ 'is-attn': s.attenuationCorrected, 'is-nac': !s.attenuationCorrected }"
                        :title="s.attenuationCorrected ? 'Attenuation Corrected (CTAC)' : 'Non-Attenuation Corrected (NAC)'"
                    >{{ s.attenuationCorrected ? 'ATTN' : 'NAC' }}</span>
                    <span
                        v-if="s.isRgb"
                        class="rgb-chip"
                        title="Color (RGB) image — usable as 2D only, not for fusion analysis"
                    >RGB</span>
                </div>
                <div class="desc-row" :title="s.description">{{ s.description }}</div>
                <div class="row2">{{ s.matrixSize }}</div>
                <div class="row3">{{ s.voxelSize }}</div>
                <div class="row4">
                    <span v-if="s.acquisitionTime" class="info-pill">{{ s.acquisitionTime }}</span>
                    <span v-if="s.studyDate" class="info-pill">{{ s.studyDate }}</span>
                    <span v-if="s.datatypeName" class="info-pill dtype-pill" title="Source voxel datatype (internal store is always Float32)">{{ s.datatypeName }}</span>
                    <span v-if="s.hasVolume" class="vol-tag">VOL</span>
                </div>
                <div
                    v-if="!s.transferSyntaxSupported"
                    class="row-unsupported"
                    :title="s.transferSyntaxReason ?? 'Unsupported transfer syntax'"
                >
                    <v-icon icon="mdi-alert-circle" size="x-small" />
                    Unsupported: {{ s.transferSyntaxName }}
                </div>
                <div v-if="s.hasVolume && isUnknownModality(s.modality)" class="row5">
                    <span class="hint">Set as:</span>
                    <button class="set-mod" @click="(e) => setModality(e, s.index, 'PT')">PT</button>
                    <button class="set-mod" @click="(e) => setModality(e, s.index, 'CT')">CT</button>
                    <button class="set-mod" @click="(e) => setModality(e, s.index, 'MR')">MR</button>
                </div>
            </div>
        </div>

        <!-- Other (MIP / RGB / DERIVED) — デフォルト非表示、トグルで展開 -->
        <div v-if="otherSeries.length > 0" class="other-section">
            <button class="other-toggle" @click="showOthers = !showOthers">
                <v-icon
                    :icon="showOthers ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                    size="small"
                />
                <span>Other ({{ otherSeries.length }})</span>
                <span class="other-hint">MIP / RGB / derived</span>
            </button>
            <div v-if="showOthers">
                <div
                    v-for="s in otherSeries"
                    :key="`o-${s.index}`"
                    class="series-card is-other"
                    :class="{ 'is-active-seg': isActiveForSeg(s) }"
                    draggable="true"
                    @dragstart="(e: DragEvent) => onCardDragStart(e, s.index)"
                    :title="'Drag this card onto an image box to load this series'"
                >
                    <div
                        class="thumb"
                        @wheel="(e: WheelEvent) => onThumbWheel(e, s.index)"
                        title="Wheel to scrub slices (preview only)"
                    >
                        <img v-if="thumbSrcFor(s)" :src="thumbSrcFor(s) as string" draggable="false" />
                        <div v-else class="thumb-placeholder">
                            <v-icon icon="mdi-image-off-outline" size="small"></v-icon>
                        </div>
                        <span v-if="sliceLabelFor(s)" class="slice-label">{{ sliceLabelFor(s) }}</span>
                    </div>
                    <div class="meta">
                        <div class="row1">
                            <span class="modality" :style="{ background: modalityChip(s.modality).color }">
                                {{ modalityChip(s.modality).text }}
                            </span>
                            <span
                                class="source-chip"
                                :class="{ 'is-dicom': s.sourceType === 'DICOM', 'is-nifti': s.sourceType === 'NIFTI' }"
                                :title="s.sourceType === 'DICOM' ? 'Loaded from DICOM' : 'Loaded from NIfTI (.nii / .nii.gz)'"
                            >{{ s.sourceType === 'DICOM' ? 'DCM' : 'NII' }}</span>
                            <span v-if="s.isRgb" class="rgb-chip" title="Color (RGB) image">RGB</span>
                        </div>
                        <div class="desc-row" :title="s.description">{{ s.description }}</div>
                        <div class="row2">
                            {{ s.matrixSize }}
                            <span v-if="s.datatypeName" class="info-pill dtype-pill ml-1" title="Source voxel datatype">{{ s.datatypeName }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </v-container>
</template>

<style scoped>
.series-card {
    display: flex;
    gap: 8px;
    padding: 6px;
    background: var(--mv-surface-2);
    border-radius: 4px;
    margin-bottom: 6px;
    cursor: grab;
    border: 1px solid transparent;
    transition: border-color 0.15s, background 0.15s;
    position: relative;       /* card-menu-btn の絶対位置 anchor */
}
.card-menu-btn {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: rgba(0, 0, 0, 0.35);
    color: var(--mv-text-muted);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, background 0.12s, color 0.12s;
    z-index: 2;
}
.series-card:hover .card-menu-btn {
    opacity: 0.85;
}
.card-menu-btn:hover {
    background: rgba(0, 212, 170, 0.20);
    color: var(--mv-accent);
    opacity: 1 !important;
}
.series-card:active {
    cursor: grabbing;
}
.series-card:hover {
    border-color: var(--mv-border-strong);
    background: #2A3441;
}

.thumb {
    position: relative;
    width: 84px;
    height: 84px;
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    /* card 全体の drag (grab) を継承 */
    cursor: inherit;
}

/* paging 中の "87 / 372" オーバーレイラベル */
.slice-label {
    position: absolute;
    bottom: 2px;
    left: 2px;
    right: 2px;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 10px;
    text-align: center;
    color: #fff;
    background: rgba(0,0,0,0.55);
    padding: 1px 4px;
    border-radius: 2px;
    pointer-events: none;
    line-height: 1.3;
}

.star-btn {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 3px;
    color: var(--mv-text-dim, #8FA0B0);
    cursor: pointer;
    padding: 0;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.star-btn:hover {
    color: var(--mv-accent, #00D4AA);
    border-color: var(--mv-accent-dim, #007E66);
    background: rgba(0, 212, 170, 0.18);
}
.star-btn.is-active {
    color: var(--mv-warning, #FFB454);
    border-color: var(--mv-warning, #FFB454);
    background: rgba(255, 180, 84, 0.16);
}

.series-card.is-active-seg {
    border-color: var(--mv-accent, #00D4AA);
    background: rgba(0, 212, 170, 0.05);
}

/* Other (derived/MIP/RGB) section */
.series-card.is-other {
    opacity: 0.78;
}
.series-card.is-other:hover {
    opacity: 1;
}
.other-section {
    margin-top: 8px;
    border-top: 1px solid var(--mv-border);
    padding-top: 6px;
}
.other-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    background: transparent;
    border: none;
    padding: 4px 6px;
    color: var(--mv-text-dim, #8FA0B0);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    border-radius: 3px;
}
.other-toggle:hover {
    background: var(--mv-surface-2);
    color: var(--mv-text);
}
.other-hint {
    margin-left: auto;
    font-size: 9px;
    color: var(--mv-text-muted);
    font-style: italic;
}
.thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
}
.thumb-placeholder {
    color: var(--mv-text-muted);
}

.meta {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    line-height: 1.3;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--mv-text);
}

.row1 {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
}
.modality {
    color: #0F1419;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 2px;
    font-size: 10px;
    flex-shrink: 0;
    letter-spacing: 0.04em;
}
.desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    color: var(--mv-text);
    font-weight: 500;
}

/* description を独立行で表示 (chip 同居だと省略されがちな問題対策) */
.desc-row {
    color: var(--mv-text);
    font-weight: 500;
    font-size: 11px;
    line-height: 1.3;
    word-break: break-word;
    overflow-wrap: anywhere;
}

.row2, .row3 {
    color: var(--mv-text-dim);
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 10px;
}

.row4 {
    display: flex;
    gap: 6px;
    color: var(--mv-text-muted);
    font-size: 10px;
}
.vol-tag {
    color: var(--mv-accent);
    font-weight: 600;
}

.attn-chip {
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 2px;
    line-height: 1.5;
    flex-shrink: 0;
    letter-spacing: 0.04em;
}
.attn-chip.is-attn {
    background: #ff9b3a;
    color: #0F1419;
}
.attn-chip.is-nac {
    background: transparent;
    color: var(--mv-text-dim, #8FA0B0);
    border: 1px solid var(--mv-border-strong, #3A4A5C);
}

.rgb-chip {
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 2px;
    line-height: 1.5;
    flex-shrink: 0;
    letter-spacing: 0.04em;
    background: linear-gradient(90deg, #ff5577 0%, #ffd54f 50%, #66cc88 100%);
    color: #0F1419;
}

.source-chip {
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 2px;
    line-height: 1.5;
    flex-shrink: 0;
    letter-spacing: 0.04em;
    border: 1px solid var(--mv-border-strong, #3A4A5C);
    color: var(--mv-text-dim, #8FA0B0);
    background: transparent;
}
.source-chip.is-dicom {
    color: #8FA0B0;
    border-color: #3A4A5C;
}
.source-chip.is-nifti {
    color: #00D4AA;
    border-color: rgba(0, 212, 170, 0.5);
    background: rgba(0, 212, 170, 0.08);
}

.info-pill {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 9px;
    color: var(--mv-text-dim, #8FA0B0);
    background: rgba(255,255,255,0.04);
    padding: 0 4px;
    border-radius: 2px;
}
/* datatype 表示用 (Float32 = 緑、整数系 = neutral、unknown は警告色) */
.dtype-pill {
    color: #9aa6b2;
    background: rgba(122, 208, 255, 0.06);
    border: 1px solid rgba(122, 208, 255, 0.18);
}

.row-unsupported {
    margin-top: 4px;
    font-size: 10px;
    color: var(--mv-error, #FF5C7A);
    background: rgba(255, 92, 122, 0.08);
    border: 1px solid rgba(255, 92, 122, 0.3);
    border-radius: 3px;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    gap: 3px;
}

.row5 {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
}
.row5 .hint {
    color: var(--mv-text-muted);
    font-size: 10px;
}
.set-mod {
    background: var(--mv-surface-2, #1a232b);
    border: 1px solid var(--mv-border-strong, #3a4a55);
    color: var(--mv-text);
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 2px;
    cursor: pointer;
    line-height: 1.4;
}
.set-mod:hover {
    border-color: var(--mv-accent, #00D4AA);
    color: var(--mv-accent, #00D4AA);
}
</style>
