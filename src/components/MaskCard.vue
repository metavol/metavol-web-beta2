<script setup lang="ts">
import { computed } from 'vue';
import { useSegmentationStore } from '../stores/segmentation';

// 左サイドバーの **MASK カード**。
//
// マスクは PET 格子上の volume (Uint16Array) だが、**seriesList には入れない**。
// 撮影シリーズと違って「生きた派生物」(ブラシ 1 回ごとに書き換わり、PET 格子に従属) なので、
// 普通のシリーズとして挿すと (a) window/CLUT/fusion などラベルマップに意味の無い操作が
// 全部当たる、(b) registration / fusion が依存する series index の不変条件に触る。
// segStore 直結の専用カードとして描き、操作も 表示/非表示・透過度・Save・Clear に絞る。
//
// マスク層は 1 枚で、VOI 解析の実行は MTV マスクを置き換える (逆も同じ)。
// だから「いま載っているのは何か」(maskLabel) を常に見えるようにするのがこのカードの主目的。

const emit = defineEmits<{
  (e: 'redraw'): void;
}>();

const store = useSegmentationStore();

// 非ゼロ voxel 数。maskVersion 依存の computed なので編集のたびに数え直すが、
// 実測 18M voxel (全身 PET) の 1 パスで ~15ms、ブラシは stroke 終了時しか
// maskVersion を上げないので許容範囲。
const nonZeroVoxels = computed(() => {
  void store.maskVersion;
  const m = store.finalMask;
  if (!m) return 0;
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) n++;
  return n;
});

const visible = computed(() => nonZeroVoxels.value > 0);

const volumeMl = computed(() => {
  const v = store.petVolumeRef;
  if (!v) return 0;
  // scalar triple product = voxel 1 個の体積 (mm^3)。斜交格子でも正しい。
  const a = v.vectorX, b = v.vectorY, c = v.vectorZ;
  const det = Math.abs(
    a.x * (b.y * c.z - b.z * c.y) -
    a.y * (b.x * c.z - b.z * c.x) +
    a.z * (b.x * c.y - b.y * c.x));
  return nonZeroVoxels.value * det / 1000;
});

const usedLabelCount = computed(() => {
  void store.maskVersion;
  const m = store.finalMask;
  if (!m) return 0;
  const seen = new Set<number>();
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) seen.add(m[i]);
  return seen.size;
});

const linkedPt = computed(() =>
  store.petVolumeRef?.metadata?.seriesDescription ?? null);

const toggleVisible = () => {
  store.overlayEnabled = !store.overlayEnabled;
  emit('redraw');
};
const onAlpha = (v: number) => {
  store.overlayAlpha = Math.min(1, Math.max(0, v));
  emit('redraw');
};
const onSave = () => { store.saveMaskAsNifti(); };
const onClear = () => {
  // Clear は破壊的なので yes/no 確認 (SegmentationPanel の Clear と同じ扱い)。
  if (!window.confirm('Clear the current mask (all labels)? This cannot be undone.')) return;
  store.clearMask();
  emit('redraw');
};
</script>

<template>
  <div v-if="visible" class="mask-card" data-testid="mask-card">
    <div class="row1">
      <span class="chip">MASK</span>
      <span class="name" :title="store.maskLabel ?? 'Mask'">{{ store.maskLabel ?? 'Mask' }}</span>
      <v-menu location="bottom end">
        <template #activator="{ props: mp }">
          <button class="menu-btn" v-bind="mp" title="Mask actions">
            <v-icon icon="mdi-dots-horizontal" size="16" />
          </button>
        </template>
        <v-list density="compact">
          <v-list-item prepend-icon="mdi-download" title="Save mask (.nii.gz)" @click="onSave" />
          <v-list-item prepend-icon="mdi-delete-outline" title="Clear mask" @click="onClear" />
        </v-list>
      </v-menu>
    </div>
    <div class="row2">
      <span v-if="linkedPt" class="linked" :title="linkedPt">on {{ linkedPt }}</span>
      <span class="stats">{{ usedLabelCount }} label{{ usedLabelCount === 1 ? '' : 's' }} ·
        {{ volumeMl >= 100 ? volumeMl.toFixed(0) : volumeMl.toFixed(1) }} mL</span>
    </div>
    <div class="row3">
      <button class="eye-btn" :title="store.overlayEnabled ? 'Hide mask' : 'Show mask'"
              @click="toggleVisible">
        <v-icon :icon="store.overlayEnabled ? 'mdi-eye' : 'mdi-eye-off'" size="16" />
      </button>
      <v-slider :model-value="store.overlayAlpha" :min="0" :max="1" :step="0.05"
                density="compact" hide-details class="alpha"
                :disabled="!store.overlayEnabled"
                @update:model-value="onAlpha" />
      <span class="pct">{{ Math.round(store.overlayAlpha * 100) }}%</span>
    </div>
  </div>
</template>

<style scoped>
/* SeriesList の series-card と同じ土台色に合わせる (同じサイドバーに並ぶため) */
.mask-card {
  padding: 6px 8px;
  background: var(--mv-surface-2);
  border-radius: 4px;
  margin-bottom: 6px;
  border: 1px solid transparent;
}
.mask-card:hover {
  border-color: var(--mv-border-strong);
}
.row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.chip {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 1px 6px;
  border-radius: 3px;
  background: #7c4dbd;   /* series の modality chip と被らない紫 */
  color: #fff;
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--mv-text-muted);
  border-radius: 4px;
  cursor: pointer;
}
.menu-btn:hover {
  background: rgba(0, 212, 170, 0.20);
  color: var(--mv-accent);
}
.row2 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 2px;
  min-width: 0;
  font-size: 11px;
  color: var(--mv-text-muted);
}
.linked {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats {
  flex-shrink: 0;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.row3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.eye-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--mv-text-muted);
  border-radius: 4px;
  cursor: pointer;
}
.eye-btn:hover {
  color: var(--mv-accent);
}
.alpha {
  flex: 1 1 auto;
}
.pct {
  flex-shrink: 0;
  width: 34px;
  text-align: right;
  font-size: 11px;
  color: var(--mv-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
