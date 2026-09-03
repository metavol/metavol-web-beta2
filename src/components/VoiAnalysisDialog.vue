<script setup lang="ts">
import { ref, computed } from 'vue';
import { useVoiStore } from '../stores/voi';
import { useSegmentationStore } from '../stores/segmentation';

// SPM で標準脳へ正規化した画像に VOI テンプレートを重ねて領域統計を出すダイアログ。
// **Persona 2 (脳 PET の解剖学的標準化 + VOI) の中心機能。**
//
// **右 Inspector には入れない。** あそこは Persona 1 (忙しい医師の MTV 測定) の 4 ステップ動線で、
// 136 行の表を差し込むと主要フローが埋まり、**クリック数最小という P1 の最優先制約**を壊す。
// 独立したダイアログにして完全に分離する。

const props = defineProps<{
  candidates: Array<{ index: number; label: string }>;
}>();
const emit = defineEmits<{
  (e: 'loadTemplate'): void;
  (e: 'run', index: number): void;
  (e: 'exportCsv'): void;
  (e: 'overlayChanged'): void;
}>();

const open = defineModel<boolean>('open', { default: false });
const store = useVoiStore();
// overlay の表示/透過度は **MTV マスクと同じ state** (segmentation store)。
// ここに独自の透過度を持つと「マスクパネルのスライダと別物」になり操作が二重化する。
const seg = useSegmentationStore();

const selected = ref<number | null>(null);
const sortKey = ref<'name' | 'volumeMl' | 'mean' | 'sd' | 'max' | 'voxels'>('name');
const sortDesc = ref(false);
const filter = ref('');
const hideEmpty = ref(false);

// 既定の選択。**解析済みならそのシリーズを指す** — テンプレート読み込み時に自動解析が走るので、
// ここが候補の先頭のままだと「表に出ている数値」と「選択中のシリーズ」が食い違って見える。
const effectiveIndex = computed(() =>
  selected.value
  ?? (store.analyzedSeriesIndex >= 0 ? store.analyzedSeriesIndex : undefined)
  ?? props.candidates[0]?.index ?? -1);

const rows = computed(() => {
  let r = store.stats;
  if (hideEmpty.value) r = r.filter(s => s.voxels > 0);
  const q = filter.value.trim().toLowerCase();
  if (q) r = r.filter(s => s.name.toLowerCase().includes(q) || String(s.id) === q);
  const k = sortKey.value;
  const dir = sortDesc.value ? -1 : 1;
  return [...r].sort((a, b) => {
    if (k === 'name') return dir * a.name.localeCompare(b.name);
    const av = (a as any)[k] as number, bv = (b as any)[k] as number;
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return dir * (av - bv);
  });
});

// overlay は **MTV マスクそのもの** (runVoiAnalysis が loadMaskFromNifti で import する)。
// だからここは segmentation store を直接書く。SegmentationPanel のスライダと同じ値が動く。
const onOverlayToggle = (v: boolean | null) => { seg.overlayEnabled = !!v; emit('overlayChanged'); };
const onOverlayAlpha = (v: number) => { seg.overlayAlpha = Math.min(1, Math.max(0, v)); emit('overlayChanged'); };

const setSort = (k: typeof sortKey.value) => {
  if (sortKey.value === k) sortDesc.value = !sortDesc.value;
  else { sortKey.value = k; sortDesc.value = k !== 'name'; }
};

const num = (v: number, d = 3) => Number.isFinite(v) ? v.toFixed(d) : '—';
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const box = (b: [number, number][] | undefined) =>
  b ? b.map(([lo, hi]) => `${lo.toFixed(0)}…${hi.toFixed(0)}`).join(' / ') : '—';
</script>

<template>
  <v-dialog v-model="open" max-width="1100" scrollable>
    <v-card class="mv-voi-card">
      <v-card-title class="mv-voi-title">
        <v-icon icon="mdi-brain" size="small" class="mr-2" />
        VOI analysis
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="open = false" />
      </v-card-title>

      <v-card-text>
        <!-- ① テンプレート -->
        <div class="mv-voi-step">1. VOI template</div>
        <div v-if="!store.hasTemplate" class="mv-voi-empty">
          <p>No template loaded. Select the label volume and its label-name file together.</p>
          <p class="mv-voi-hint">
            For SPM this is <code>labels_Neuromorphometrics.nii</code> and
            <code>labels_Neuromorphometrics.xml</code> in the <code>tpm</code> folder of your SPM installation.
          </p>
          <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-folder-open"
                 @click="emit('loadTemplate')">Load VOI template…</v-btn>
        </div>
        <div v-else class="mv-voi-info">
          <div class="mv-voi-row">
            <b>{{ store.template!.header.name ?? store.template!.sourceName }}</b>
            <span v-if="store.template!.header.version">v{{ store.template!.header.version }}</span>
            <span v-if="store.template!.header.coordinateSystem">· {{ store.template!.header.coordinateSystem }}</span>
            <span>· {{ store.template!.labels.length }} regions</span>
            <span>· {{ store.template!.volume.nx }}×{{ store.template!.volume.ny }}×{{ store.template!.volume.nz }}</span>
            <v-spacer />
            <v-btn size="x-small" variant="text" @click="emit('loadTemplate')">Change…</v-btn>
          </div>
          <div v-if="store.template!.header.licence" class="mv-voi-licence">
            Licence: {{ store.template!.header.licence }} — cite the atlas as required by its authors.
          </div>
          <div v-if="store.templateCheck && (store.templateCheck.missingInTable.length || store.templateCheck.missingInVolume.length)"
               class="mv-voi-warn">
            <span v-if="store.templateCheck.missingInTable.length">
              {{ store.templateCheck.missingInTable.length }} label(s) in the volume have no name.
            </span>
            <span v-if="store.templateCheck.missingInVolume.length">
              {{ store.templateCheck.missingInVolume.length }} named label(s) are absent from the volume.
            </span>
          </div>
        </div>

        <!-- ② 画像を選んで実行 -->
        <div class="mv-voi-step">2. Normalised image</div>
        <div class="mv-voi-run">
          <v-select
            :model-value="effectiveIndex"
            @update:model-value="(v: number) => selected = v"
            :items="candidates" item-title="label" item-value="index"
            density="compact" variant="outlined" hide-details
            label="Series to analyse" :disabled="!store.hasTemplate || candidates.length === 0"
          />
          <v-btn size="small" color="primary" :disabled="!store.hasTemplate || effectiveIndex < 0"
                 prepend-icon="mdi-play" @click="emit('run', effectiveIndex)">Run</v-btn>
        </div>
        <p v-if="candidates.length === 0" class="mv-voi-hint">
          No series with a reconstructed volume. Load the SPM-normalised NIfTI first (drag &amp; drop).
        </p>

        <!-- ③ 診断 -->
        <template v-if="store.diagnostics">
          <div class="mv-voi-step">3. Alignment check</div>
          <div class="mv-voi-diag">
            <div><span>Image voxels inside template</span><b>{{ pct(store.diagnostics.insideFraction) }}</b></div>
            <div><span>Image voxels that got a label</span><b>{{ pct(store.diagnostics.labeledFraction) }}</b></div>
            <div><span>Bounding-box overlap</span><b>{{ pct(store.diagnostics.bboxOverlapFraction) }}</b></div>
            <div><span>Regions with no voxels</span><b>{{ store.emptyRegionCount }} / {{ store.stats.length }}</b></div>
            <div class="mv-voi-diag-wide"><span>Image box (mm)</span><b>{{ box(store.diagnostics.imageBoxMm) }}</b></div>
            <div class="mv-voi-diag-wide"><span>Template box (mm)</span><b>{{ box(store.diagnostics.templateBoxMm) }}</b></div>
          </div>
          <v-alert v-if="store.warnings.length" type="warning" density="compact" variant="tonal" class="mt-2">
            <div v-for="(w, i) in store.warnings" :key="i">{{ w }}</div>
          </v-alert>
          <!-- 重ねているのは **数値を出したのと同じ割り当て結果**。
               アトラス原本ではないので、ここで見えるものと表の数値は必ず一致する。 -->
          <div class="mv-voi-overlay">
            <v-checkbox :model-value="seg.overlayEnabled" density="compact" hide-details
                        label="Show regions on the image"
                        @update:model-value="onOverlayToggle" />
            <span class="mv-voi-olabel">Opacity</span>
            <v-slider :model-value="seg.overlayAlpha" :min="0" :max="1" :step="0.05"
                      density="compact" hide-details :disabled="!seg.overlayEnabled"
                      @update:model-value="onOverlayAlpha" />
            <span class="mv-voi-oval">{{ Math.round(seg.overlayAlpha * 100) }}%</span>
          </div>
          <p class="mv-voi-hint">
            The overlay shows the labels that produced the numbers below — not the atlas on its own
            grid — so what you see is exactly what was measured. The regions are loaded into the
            same mask layer used for MTV segmentation, so the Mask panel (opacity slider,
            per-region visibility, Save mask) works on them too.
          </p>
        </template>

        <!-- ④ 結果 -->
        <template v-if="store.hasResults">
          <div class="mv-voi-step">
            4. Regional values
            <span class="mv-voi-sub">{{ store.analyzedLabel }} · unit {{ store.analyzedUnit }} · {{ store.lastRunMs }} ms</span>
          </div>
          <div class="mv-voi-tools">
            <v-text-field v-model="filter" density="compact" variant="outlined" hide-details
                          placeholder="Filter by region name or id" prepend-inner-icon="mdi-magnify" />
            <v-checkbox v-model="hideEmpty" density="compact" hide-details label="Hide empty regions" />
            <v-spacer />
            <v-btn size="small" variant="tonal" prepend-icon="mdi-download" @click="emit('exportCsv')">Export CSV</v-btn>
          </div>
          <div class="mv-voi-tablewrap">
            <table class="mv-voi-table">
              <thead>
                <tr>
                  <th @click="setSort('name')">Region</th>
                  <th class="num" @click="setSort('voxels')">Voxels</th>
                  <th class="num" @click="setSort('volumeMl')">Volume (ml)</th>
                  <th class="num" @click="setSort('mean')">Mean</th>
                  <th class="num" @click="setSort('sd')">SD</th>
                  <th class="num">Min</th>
                  <th class="num" @click="setSort('max')">Max</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in rows" :key="s.id" :class="{ empty: s.voxels === 0 }">
                  <td>{{ s.name }}</td>
                  <td class="num">{{ s.voxels }}</td>
                  <td class="num">{{ num(s.volumeMl, 2) }}</td>
                  <td class="num">{{ num(s.mean) }}</td>
                  <td class="num">{{ num(s.sd) }}</td>
                  <td class="num">{{ num(s.min) }}</td>
                  <td class="num">{{ num(s.max) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mv-voi-hint">
            Values come from the image voxels themselves; the template is resampled onto the image grid with
            nearest-neighbour, so no interpolation is applied to the measurements. Small regions covering few
            voxels are more affected by partial-volume effects — check the voxel count.
          </p>
        </template>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mv-voi-card { background: var(--mv-surface, #161c24); }
.mv-voi-title { display: flex; align-items: center; font-size: 15px; }
.mv-voi-step {
  margin: 14px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--mv-accent, #00d4aa);
}
.mv-voi-sub { margin-left: 10px; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--mv-text-muted, #5a6877); }
.mv-voi-empty { font-size: 13px; }
.mv-voi-hint { font-size: 11px; color: var(--mv-text-muted, #5a6877); margin: 6px 0; }
.mv-voi-info { font-size: 13px; }
.mv-voi-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mv-voi-licence { font-size: 11px; color: var(--mv-text-muted, #5a6877); margin-top: 2px; }
.mv-voi-warn { font-size: 11px; color: #ffb74d; margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; }
.mv-voi-run { display: flex; align-items: center; gap: 10px; }
.mv-voi-run :deep(.v-input) { flex: 1; }
.mv-voi-diag { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 18px; font-size: 12px; }
.mv-voi-diag > div { display: flex; justify-content: space-between; gap: 10px; }
.mv-voi-diag span { color: var(--mv-text-muted, #5a6877); }
.mv-voi-diag-wide { grid-column: span 2; }
.mv-voi-overlay { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.mv-voi-overlay :deep(.v-slider) { flex: 1; max-width: 240px; }
.mv-voi-olabel { font-size: 11px; color: var(--mv-text-muted, #5a6877); }
.mv-voi-oval { font-size: 11px; width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.mv-voi-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.mv-voi-tools :deep(.v-input) { max-width: 320px; flex: 0 1 320px; }
.mv-voi-tablewrap { max-height: 46vh; overflow: auto; border: 1px solid var(--mv-border, #2a3441); border-radius: 4px; }
.mv-voi-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mv-voi-table th {
  position: sticky; top: 0; z-index: 1; cursor: pointer; user-select: none;
  background: var(--mv-surface-2, #222b36); text-align: left; padding: 5px 8px; white-space: nowrap;
}
.mv-voi-table td { padding: 3px 8px; border-top: 1px solid var(--mv-border, #2a3441); }
.mv-voi-table td.num, .mv-voi-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.mv-voi-table tr.empty { opacity: .45; }
</style>
