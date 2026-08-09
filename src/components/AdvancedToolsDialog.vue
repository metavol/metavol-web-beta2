<script setup lang="ts">
// Advanced tools (demo phantoms / experiments / series priority rules)。
//
// 以前は左サイドバーの折り畳みセクションだったが、シリーズを全件表示するようにした結果
// 一覧の下に押し出されて到達できなくなった (16 series で y=2106px、ペインは 700px)。
// 使用頻度は極めて低い一方、series priority rules は表形式の編集 UI でメニュー項目には
// 収まらないので、ハンバーガーから開くダイアログに移した。
import { ref } from 'vue';
import { loadPriorityRules, savePriorityRules, resetPriorityRules, DEFAULT_RULES, type PriorityRule } from './seriesPriorityRules';

const open = defineModel<boolean>({ default: false });

const emit = defineEmits([
  'phantomNema',
  'phantomWholeBody',
  'phantomWholeBodyPetCt',
  'scrambleSlices',
  'recoverSlices',
]);

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

// phantom / experiment は実行したらダイアログを閉じる (結果は画像側に出る)
const run = (ev: 'phantomNema' | 'phantomWholeBody' | 'phantomWholeBodyPetCt' | 'scrambleSlices' | 'recoverSlices') => {
  emit(ev);
  open.value = false;
};
</script>

<template>
  <v-dialog v-model="open" max-width="520" scrollable>
    <v-card class="mv-adv-card">
      <v-card-title class="mv-adv-title">
        <v-icon icon="mdi-flask-outline" size="small" class="mr-2" />
        Advanced tools
      </v-card-title>
      <v-card-text class="mv-adv-body">
        <div class="mv-section-title">Demo phantoms</div>
        <div class="mv-btn-row">
          <v-btn size="x-small" variant="tonal" @click="run('phantomNema')">
            NEMA IEC
            <v-tooltip activator="parent" location="bottom" max-width="260">
              Generate a NEMA IEC body phantom (6 spheres) for QC — no patient data needed
            </v-tooltip>
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="run('phantomWholeBody')">
            Whole-body PET
            <v-tooltip activator="parent" location="bottom" max-width="260">
              Generate a synthetic whole-body FDG PET (brain / heart / liver / kidneys / bladder + 8 lesions)
            </v-tooltip>
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="run('phantomWholeBodyPetCt')">
            Whole-body PET/CT
            <v-tooltip activator="parent" location="bottom" max-width="260">
              Generate a matched synthetic CT + PET pair (same world space, so Fusion lines up)
            </v-tooltip>
          </v-btn>
        </div>
        <div class="text-caption text-disabled mt-1">
          NEMA IEC: 6 hot spheres in a warm body, cold lung insert.<br />
          Whole-body PET: synthetic FDG-PET with brain, heart, liver, kidneys, bladder, and 8 metastases.<br />
          Whole-body PET/CT: paired synthetic CT + PET (cervical-cancer-like geometry) built from
          geometric shapes; opens as PET Standard.
        </div>

        <div class="mv-section-title mt-4">Experiments</div>
        <div class="mv-btn-row">
          <v-btn size="x-small" variant="tonal" @click="run('scrambleSlices')">
            Scramble Z
            <v-tooltip activator="parent" location="bottom" max-width="260">
              Research tool: randomly shuffle the selected volume's z-slices (select the target box first)
            </v-tooltip>
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="run('recoverSlices')">
            Recover Z
            <v-tooltip activator="parent" location="bottom" max-width="260">
              Research tool: rebuild the slice order from slice-to-slice similarity alone, then report accuracy
            </v-tooltip>
          </v-btn>
        </div>
        <div class="text-caption text-disabled mt-1">
          Scramble Z: randomly shuffles the selected volume's z-slices (view coronal/MIP to see it).<br />
          Recover Z: reorders slices by slice-to-slice similarity (SSD) and reports how well the
          original order was recovered.
        </div>

        <!-- PET Standard 候補スコアリングルール (ATTN > NAC、WB > Lung 等) -->
        <div class="mv-section-title mt-4">Series priority rules</div>
        <div class="mv-rules-help text-caption text-disabled mb-1">
          Higher score wins for default PT/CT pick. + boosts, − avoids.
        </div>
        <div class="mv-rules-table">
          <div v-for="(r, i) in priorityRules" :key="i" class="mv-rule-row">
            <input class="mv-rule-pat" type="text" v-model="r.pattern"
                   placeholder="substring" @change="onRulesChanged" />
            <select class="mv-rule-mod" v-model="r.modality" @change="onRulesChanged">
              <option value="ANY">ANY</option>
              <option value="PT">PT</option>
              <option value="CT">CT</option>
              <option value="MR">MR</option>
            </select>
            <input class="mv-rule-w" type="number" v-model.number="r.weight"
                   step="1" @change="onRulesChanged" />
            <button class="mv-rule-del" @click="removeRule(i)" title="Delete rule">×</button>
          </div>
        </div>
        <div class="mv-btn-row mt-1">
          <v-btn size="x-small" variant="tonal" @click="addRule">
            + Add
            <v-tooltip activator="parent" location="bottom">Add a series-priority rule (pattern + modality + weight)</v-tooltip>
          </v-btn>
          <v-btn size="x-small" variant="text" @click="resetRules">
            Reset to defaults
            <v-tooltip activator="parent" location="bottom">Discard your rules and restore the built-in series-priority defaults</v-tooltip>
          </v-btn>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn size="small" variant="text" @click="open = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mv-adv-card { background: var(--mv-surface, #1a2028); }
.mv-adv-title { font-size: 14px; font-weight: 700; }
.mv-adv-body { max-height: 60vh; }

.mv-section-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mv-text-muted, #5a6877);
  margin-bottom: 6px;
}
.mv-btn-row { display: flex; gap: 4px; flex-wrap: wrap; }
.mv-btn-row .v-btn { text-transform: none; letter-spacing: 0; }

.mv-rules-table { display: flex; flex-direction: column; gap: 2px; }
.mv-rule-row { display: flex; gap: 3px; align-items: center; }
.mv-rule-pat { flex: 1 1 auto; min-width: 0; }
.mv-rule-pat, .mv-rule-mod, .mv-rule-w {
  background: var(--mv-surface-2, #222b36);
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 3px;
  color: var(--mv-text, #e8eef2);
  font-size: 11px;
  padding: 2px 4px;
}
.mv-rule-mod { width: 62px; }
.mv-rule-w { width: 52px; }
.mv-rule-del {
  width: 20px;
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 3px;
  background: transparent;
  color: var(--mv-text-dim, #8fa0b0);
  cursor: pointer;
}
.mv-rule-del:hover { color: var(--mv-error, #ff5c7a); border-color: var(--mv-error, #ff5c7a); }
</style>
