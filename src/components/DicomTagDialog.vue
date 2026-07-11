<script setup lang="ts">
// DICOM tag viewer dialog (metavol26 互換) — Non-modal で paging しながら使える。
//   - 上部: filter input ("space" = AND, "|" = OR), Single-line toggle, font +/-, copy, slice indicator
//   - 中央: 該当タグをモノスペースで表示
//   - 開いている間も canvas を wheel スクロールでき、表示中スライスのタグが reactive に更新される
//
// metavol26 (`dicom_view_presenter.py:show_tags`) との互換:
//   - 同じ filter 構文
//   - 同じ Single-line モード
//   - 同じ「pydicom str(ds)」風の整形
//
// Web app 特有: scrim 無し + pointer-events: none を空白部に設定して canvas をクリックスルー可能。

import { computed, ref, watch } from 'vue';
import type { DataSet } from 'dicom-parser';
import { formatDicomTags, filterTagText, toSingleLine } from './dicomTagFormatter';

const props = defineProps<{
    modelValue: boolean;
    /** 表示対象 DICOM (現スライス。reactive に更新される) */
    dataset: DataSet | null;
    /** ダイアログタイトル右に表示する小さなサブタイトル (例: シリーズ説明) */
    seriesLabel?: string;
    /** 現スライス番号 (0-based) */
    sliceIndex?: number;
    /** シリーズ内のスライス総数 */
    sliceCount?: number;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', v: boolean): void;
}>();

const filterText = ref('');
const singleLine = ref(false);
const fontSize = ref(12);

// dialog open 時に reset (位置とサイズはセッション継続)
watch(() => props.modelValue, (open) => {
    if (open) {
        filterText.value = '';
        singleLine.value = false;
        fontSize.value = 12;
    }
});

// ドラッグ移動 + リサイズ用 state (panel 自身の position / size を保持)。
// 初期位置は右上、Inspector を避ける位置に置く。
const panelX = ref(window.innerWidth - 980);
const panelY = ref(60);
const panelW = ref(640);
const panelH = ref(520);
const floatingStyle = computed(() => ({
    left: panelX.value + 'px',
    top: panelY.value + 'px',
    width: panelW.value + 'px',
    height: panelH.value + 'px',
}));

// ドラッグ
let dragStartX = 0, dragStartY = 0, dragStartPanelX = 0, dragStartPanelY = 0;
const onDragStart = (e: MouseEvent) => {
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanelX = panelX.value;
    dragStartPanelY = panelY.value;
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
};
const onDragMove = (e: MouseEvent) => {
    const nx = dragStartPanelX + (e.clientX - dragStartX);
    const ny = dragStartPanelY + (e.clientY - dragStartY);
    panelX.value = Math.max(0, Math.min(window.innerWidth - 100, nx));
    panelY.value = Math.max(0, Math.min(window.innerHeight - 40, ny));
};
const onDragEnd = () => {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
};

// リサイズ (右下ハンドル)
let resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;
const onResizeStart = (e: MouseEvent) => {
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = panelW.value;
    resizeStartH = panelH.value;
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
};
const onResizeMove = (e: MouseEvent) => {
    panelW.value = Math.max(360, resizeStartW + (e.clientX - resizeStartX));
    panelH.value = Math.max(220, resizeStartH + (e.clientY - resizeStartY));
};
const onResizeEnd = () => {
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
};

// pydicom-style 整形 (重い計算なので memoize 用に dataset 参照で computed)
const sourceText = computed(() => {
    if (!props.modelValue || !props.dataset) return '';
    return formatDicomTags(props.dataset);
});

const filteredText = computed(() => {
    let text = filterTagText(sourceText.value, filterText.value);
    if (singleLine.value) text = toSingleLine(text);
    return text;
});

// stat (フィルタ後の行数 / 全行数)
const lineStats = computed(() => {
    const all = sourceText.value.split('\n').filter(l => l.trim()).length;
    const shown = filteredText.value.split(/\n|\t/).filter(l => l.trim()).length;
    return { shown, all };
});

const onClose = () => emit('update:modelValue', false);

const onCopy = async () => {
    try {
        await navigator.clipboard.writeText(filteredText.value);
    } catch (err) {
        console.warn('[tag-viewer] clipboard write failed', err);
    }
};

const onDownload = () => {
    const blob = new Blob([filteredText.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.download = `dicom_tags_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const fontMinus = () => { fontSize.value = Math.max(9, fontSize.value - 1); };
const fontPlus  = () => { fontSize.value = Math.min(20, fontSize.value + 1); };
</script>

<template>
    <!-- Non-modal 浮遊パネル: scrim なし、固定位置。pointer-events を panel のみ enable で
         canvas を wheel スクロールしながらタグを参照できる。
         デフォルト位置は右上 (Inspector の左側)、ドラッグで自由に移動できる。-->
    <Teleport to="body">
        <div
            v-if="modelValue"
            class="mv-tag-floating"
            :style="floatingStyle"
        >
            <div class="mv-tag-head" @mousedown="onDragStart">
                <v-icon icon="mdi-tag-text-outline" size="small" class="mr-1" />
                <span class="mv-tag-title">DICOM Tags</span>
                <span v-if="seriesLabel" class="mv-tag-sublabel">{{ seriesLabel }}</span>
                <v-spacer />
                <span v-if="sliceCount && sliceCount > 1" class="mv-tag-slice mv-mono">
                    slice {{ (sliceIndex ?? 0) + 1 }}/{{ sliceCount }}
                </span>
                <span class="mv-tag-stats mv-mono">
                    {{ lineStats.shown }} / {{ lineStats.all }}
                </span>
                <v-btn icon="mdi-close" variant="text" size="x-small" @click="onClose" @mousedown.stop />
            </div>

            <div class="mv-tag-controls" @mousedown.stop>
                <v-text-field
                    v-model="filterText"
                    placeholder="Filter tags... (space = AND, | = OR)"
                    density="compact"
                    hide-details
                    variant="outlined"
                    prepend-inner-icon="mdi-magnify"
                    clearable
                    class="mv-tag-filter"
                />
                <v-checkbox
                    v-model="singleLine"
                    label="Single line"
                    density="compact"
                    hide-details
                />
                <v-btn variant="text" size="x-small" @click="fontMinus">
                    <v-icon icon="mdi-format-font-size-decrease" size="small" />
                    <v-tooltip activator="parent" location="bottom">Smaller font</v-tooltip>
                </v-btn>
                <v-btn variant="text" size="x-small" @click="fontPlus">
                    <v-icon icon="mdi-format-font-size-increase" size="small" />
                    <v-tooltip activator="parent" location="bottom">Larger font</v-tooltip>
                </v-btn>
                <v-btn variant="text" size="x-small" @click="onCopy">
                    <v-icon icon="mdi-content-copy" size="small" />
                    <v-tooltip activator="parent" location="bottom">Copy filtered text</v-tooltip>
                </v-btn>
                <v-btn variant="text" size="x-small" @click="onDownload">
                    <v-icon icon="mdi-download" size="small" />
                    <v-tooltip activator="parent" location="bottom">Download as .txt</v-tooltip>
                </v-btn>
            </div>

            <div class="mv-tag-output-wrap" @mousedown.stop>
                <pre class="mv-tag-output" :style="{ fontSize: fontSize + 'px' }">{{ filteredText || '(no tags)' }}</pre>
            </div>
            <div class="mv-tag-resize-handle" @mousedown.stop="onResizeStart" />
        </div>
    </Teleport>
</template>

<style scoped>
/* Non-modal floating panel — Teleport to body で z-index 制御。canvas より前に出るが
   pointer-events は panel 自身のみ enable (空白部分は通過する = canvas 操作可能)。 */
.mv-tag-floating {
    position: fixed;
    background: var(--mv-bg, #0F1419);
    color: var(--mv-text, #E8EEF2);
    border: 1px solid var(--mv-border, #2A3441);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    z-index: 2000;
    overflow: hidden;
    min-width: 360px;
    min-height: 220px;
}
.mv-tag-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--mv-border, #2A3441);
    background: var(--mv-surface-2, #222B36);
    font-size: 13px;
    flex-shrink: 0;
    cursor: move;
    user-select: none;
}
.mv-tag-title {
    font-weight: 600;
}
.mv-tag-sublabel {
    color: var(--mv-text-dim, #8FA0B0);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 480px;
}
.mv-tag-stats {
    color: var(--mv-text-muted, #5A6877);
    font-size: 11px;
}
.mv-tag-slice {
    color: var(--mv-accent, #00D4AA);
    font-size: 11px;
    font-weight: 600;
}
.mv-tag-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--mv-border, #2A3441);
    flex-shrink: 0;
}
.mv-tag-filter {
    flex: 1 1 auto;
    min-width: 0;
}
.mv-tag-output-wrap {
    flex: 1 1 auto;
    overflow: auto;
    background: var(--mv-bg-deep, #0A0E12);
    min-height: 320px;
}
.mv-tag-output {
    margin: 0;
    padding: 8px 12px;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    color: var(--mv-text, #E8EEF2);
    line-height: 1.4;
    white-space: pre;
    overflow-wrap: normal;
}
.mv-mono {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-feature-settings: 'tnum';
}

/* 右下のリサイズハンドル */
.mv-tag-resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background:
        linear-gradient(135deg,
            transparent 0%, transparent 50%,
            var(--mv-text-muted, #5A6877) 50%, var(--mv-text-muted, #5A6877) 60%,
            transparent 60%, transparent 70%,
            var(--mv-text-muted, #5A6877) 70%, var(--mv-text-muted, #5A6877) 80%,
            transparent 80%);
    opacity: 0.5;
}
.mv-tag-resize-handle:hover { opacity: 1; }
</style>
