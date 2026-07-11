<script setup lang="ts">
import { computed, ref } from 'vue';
import SeriesList from './SeriesList.vue';
import { useSegmentationStore } from '../stores/segmentation';
import { loadPriorityRules, savePriorityRules, resetPriorityRules, DEFAULT_RULES, type PriorityRule } from './seriesPriorityRules';

defineProps<{
  seriesSummaries?: Array<{
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
  }>;
}>();

const emit = defineEmits([
  "fileLoaded",
  "dirLoaded",
  "leftButtonFunctionChanged",
  "openSample",
  "presetSelected",
  "changeSlice",
  "phantomNema",
  "phantomWholeBody",
  "redraw",
  "setModality",
  "setActiveForSeg",
  "inspectRaw",
  "viewHeader",
]);

// 最後にクリックした preset を track して active 表示。
// Reset または window tool で WC/WW を直接いじったら null に戻る (今は前者のみ実装)。
const activePreset = ref<string | null>(null);

const presetClicked = (e: string) => {
  if (e === 'Reset') activePreset.value = null;
  else activePreset.value = e;
  emit("presetSelected", e);
};
const onPresetToggle = (val: string | null | undefined) => {
  // v-btn-toggle で active が変わったとき: 同じ button をもう 1 度押すと null になる
  if (val == null) {
    activePreset.value = null;
    emit("presetSelected", "Reset");
  } else {
    presetClicked(val);
  }
};
const changeSlice = (e: number) => emit("changeSlice", e);

const showAdvanced = ref(false);

// PET Standard 候補スコアリングの編集可能ルール (localStorage 永続化)
const priorityRules = ref<PriorityRule[]>(loadPriorityRules());
const onRulesChanged = () => savePriorityRules(priorityRules.value);
const addRule = () => {
  priorityRules.value.push({ pattern: '', modality: 'ANY', weight: 1 });
  onRulesChanged();
};
const removeRule = (i: number) => {
  priorityRules.value.splice(i, 1);
  onRulesChanged();
};
const resetRules = () => {
  resetPriorityRules();
  priorityRules.value = [...DEFAULT_RULES];
};

// CT 用 (HU window)
const wPresets = [
  { id: 'Lung',  label: 'Lung'  },
  { id: 'Med',   label: 'Med'   },
  { id: 'Abd',   label: 'Abd'   },
  { id: 'Bone',  label: 'Bone'  },
  { id: 'Brain', label: 'Brain' },
  { id: 'Fat',   label: 'Fat'   },
];

// PET 用 (SUV window) -- WC = (lo+hi)/2, WW = hi-lo として DicomView 側で展開
const wPresetsPet = [
  { id: 'SUV-0-3',  label: '0-3'  },
  { id: 'SUV-0-6',  label: '0-6'  },
  { id: 'SUV-0-10', label: '0-10' },
  { id: 'SUV-0-15', label: '0-15' },
];

// 高レンジ preset (Bq/ml 表示や非 SUV 系で使用)。Other メニューに格納。
const wPresetsPetOther = [
  { id: 'SUV-0-100',   label: '0-100'   },
  { id: 'SUV-0-1000',  label: '0-1000'  },
  { id: 'SUV-0-10000', label: '0-10000' },
];

// PT 表示単位 (legend / 4-corner / 入力換算に影響。voxel と内部 WC/WW は SUV のまま)。
const segStore = useSegmentationStore();
// NAC PT (= 減衰補正されていない PT) は SUV 換算不可のため SUV モードを禁止し Bq/ml 固定。
// dicom2volume.ts 側で suvFactor=1 強制 + suvOk=false を設定済み。
const isNacPt = computed<boolean>(() => {
  const pt = segStore.petVolumeRef;
  if (!pt) return false;
  return pt.metadata?.suvOk === false;
});
const petUnit = computed<'SUV' | 'BqMl'>(() => isNacPt.value ? 'BqMl' : segStore.petDisplayUnit);
const onPetUnitChange = (v: 'SUV' | 'BqMl' | null | undefined) => {
  if (isNacPt.value) return;  // NAC PT では SUV 切替不可
  if (v === 'SUV' || v === 'BqMl') {
    segStore.petDisplayUnit = v;
    emit('redraw');
  }
};
</script>

<template>
  <div class="mv-sidebar">

    <!-- Series -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-folder-multiple-image" size="x-small" />
        Series
      </div>
      <SeriesList
        :series="seriesSummaries ?? []"
        @setModality="(p: { index: number; modality: 'PT' | 'CT' | 'MR' }) => emit('setModality', p)"
        @setActiveForSeg="(p: { index: number; modality: 'PT' | 'CT' }) => emit('setActiveForSeg', p)"
        @inspectRaw="(p: { index: number }) => emit('inspectRaw', p)"
        @viewHeader="(p: { index: number }) => emit('viewHeader', p)"
      />
    </section>

    <!-- Slice -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-layers-triple" size="x-small" />
        Slice
      </div>
      <div class="mv-btn-row">
        <v-btn size="x-small" variant="tonal" @click="changeSlice(-100000)">
          <v-icon icon="mdi-arrow-collapse-left" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(-1)">
          <v-icon icon="mdi-arrow-left" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(1)">
          <v-icon icon="mdi-arrow-right" size="small" />
        </v-btn>
        <v-btn size="x-small" variant="tonal" @click="changeSlice(100000)">
          <v-icon icon="mdi-arrow-collapse-right" size="small" />
        </v-btn>
      </div>
    </section>

    <!-- Window preset -->
    <section class="mv-section">
      <div class="mv-section-title">
        <v-icon icon="mdi-contrast-circle" size="x-small" />
        Window preset (CT)
      </div>
      <v-btn-toggle
        :model-value="activePreset"
        @update:model-value="onPresetToggle"
        density="compact"
        variant="outlined"
        divided
        class="mv-preset-toggle"
      >
        <v-btn
          v-for="p in wPresets"
          :key="p.id"
          :value="p.id"
          size="x-small"
        >{{ p.label }}</v-btn>
      </v-btn-toggle>

      <div class="mv-section-title mt-3 mv-pt-header">
        <v-icon icon="mdi-radioactive" size="x-small" />
        <span>PT window</span>
        <v-btn-toggle
          :model-value="petUnit"
          @update:model-value="onPetUnitChange"
          density="compact"
          variant="outlined"
          divided
          mandatory
          class="mv-unit-toggle"
        >
          <v-btn value="SUV" size="x-small" :disabled="isNacPt" :title="isNacPt ? 'SUV not available for non attenuation-corrected PT' : ''">SUV</v-btn>
          <v-btn value="BqMl" size="x-small">Bq/ml</v-btn>
        </v-btn-toggle>
      </div>
      <v-btn-toggle
        :model-value="activePreset"
        @update:model-value="onPresetToggle"
        density="compact"
        variant="outlined"
        divided
        class="mv-preset-toggle"
      >
        <v-btn
          v-for="p in wPresetsPet"
          :key="p.id"
          :value="p.id"
          size="x-small"
        >{{ p.label }}</v-btn>
        <v-menu location="bottom">
          <template v-slot:activator="{ props: act }">
            <v-btn v-bind="act" size="x-small" :active="!!wPresetsPetOther.find(p => p.id === activePreset)">
              Other
              <v-icon icon="mdi-chevron-down" size="x-small" />
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item
              v-for="p in wPresetsPetOther"
              :key="p.id"
              :active="activePreset === p.id"
              @click="onPresetToggle(p.id)"
            >
              <v-list-item-title>{{ p.label }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </v-btn-toggle>

      <div class="mv-btn-row mt-2">
        <v-btn size="x-small" variant="text" @click="presetClicked('Reset')">
          <v-icon icon="mdi-restart" size="x-small" class="mr-1" />Reset to DICOM tag
        </v-btn>
      </div>
    </section>

    <!-- Demo / Advanced -->
    <section class="mv-section">
      <div class="d-flex align-center">
        <v-btn
          size="x-small"
          variant="text"
          :prepend-icon="showAdvanced ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          @click="showAdvanced = !showAdvanced"
        >
          Advanced
        </v-btn>
      </div>

      <div v-if="showAdvanced" class="mt-2">
        <div class="mv-section-title">Demo phantoms</div>
        <div class="mv-btn-row">
          <v-btn size="x-small" variant="tonal" @click="emit('phantomNema')">
            NEMA IEC
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="emit('phantomWholeBody')">
            Whole-body PET
          </v-btn>
        </div>
        <div class="text-caption text-disabled mt-1">
          NEMA IEC: 6 hot spheres in a warm body, cold lung insert.<br />
          Whole-body: synthetic FDG-PET with brain, heart, liver, kidneys, bladder, and 8 metastases.
        </div>

        <!-- PET Standard 候補スコアリングルール (ATTN > NAC、WB > Lung 等) -->
        <div class="mv-section-title mt-3">Series priority rules</div>
        <div class="mv-rules-help text-caption text-disabled mb-1">
          Higher score wins for default PT/CT pick. + boosts, − avoids.
        </div>
        <div class="mv-rules-table">
          <div v-for="(r, i) in priorityRules" :key="i" class="mv-rule-row">
            <input
              class="mv-rule-pat"
              type="text"
              v-model="r.pattern"
              placeholder="substring"
              @change="onRulesChanged"
            />
            <select
              class="mv-rule-mod"
              v-model="r.modality"
              @change="onRulesChanged"
            >
              <option value="ANY">ANY</option>
              <option value="PT">PT</option>
              <option value="CT">CT</option>
              <option value="MR">MR</option>
            </select>
            <input
              class="mv-rule-w"
              type="number"
              v-model.number="r.weight"
              step="1"
              @change="onRulesChanged"
            />
            <button class="mv-rule-del" @click="removeRule(i)" title="Delete rule">×</button>
          </div>
        </div>
        <div class="mv-btn-row mt-1">
          <v-btn size="x-small" variant="tonal" @click="addRule">+ Add</v-btn>
          <v-btn size="x-small" variant="text" @click="resetRules">Reset to defaults</v-btn>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mv-sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-top: 4px;
}

/* Window preset segmented control: 横一杯に 6 等分、各 btn を細めに */
.mv-preset-toggle {
  width: 100%;
}

/* PT 単位トグル (SUV / Bq/ml) */
.mv-pt-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mv-pt-header > span {
  flex: 0 0 auto;
}
.mv-unit-toggle {
  margin-left: auto;
  height: 18px;
}
.mv-unit-toggle :deep(.v-btn) {
  min-width: 0 !important;
  padding: 0 6px !important;
  font-size: 9px !important;
  height: 18px !important;
  text-transform: none;
  letter-spacing: 0;
}
.mv-unit-toggle :deep(.v-btn--active) {
  background: rgba(0, 212, 170, 0.16) !important;
  color: var(--mv-accent) !important;
  border-color: var(--mv-accent-dim) !important;
}
.mv-preset-toggle :deep(.v-btn) {
  flex: 1 1 0;
  min-width: 0 !important;
  padding: 0 4px !important;
  font-size: 11px !important;
  letter-spacing: 0;
  text-transform: none;
  height: 26px !important;
}
.mv-preset-toggle :deep(.v-btn--active) {
  background: rgba(0, 212, 170, 0.16) !important;
  color: var(--mv-accent) !important;
  border-color: var(--mv-accent-dim) !important;
}

/* Series priority rules editor */
.mv-rules-table {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mv-rule-row {
  display: grid;
  grid-template-columns: 1fr 60px 50px 22px;
  gap: 4px;
  align-items: center;
}
.mv-rule-pat,
.mv-rule-mod,
.mv-rule-w {
  background: var(--mv-surface-2, #1a232b);
  border: 1px solid var(--mv-border-strong, #3a4a55);
  color: var(--mv-text);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 2px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.mv-rule-w {
  text-align: right;
}
.mv-rule-del {
  background: transparent;
  border: 1px solid transparent;
  color: var(--mv-text-muted);
  font-size: 14px;
  line-height: 1;
  padding: 0;
  width: 22px;
  height: 22px;
  border-radius: 2px;
  cursor: pointer;
}
.mv-rule-del:hover {
  color: var(--mv-error, #FF5C7A);
  border-color: var(--mv-error, #FF5C7A);
}
</style>
