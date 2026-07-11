<template>
  <v-app>
    <v-app-bar class="mv-appbar" flat density="compact" :height="48">
      <template v-slot:prepend>
        <v-menu>
          <template v-slot:activator="{ props: act }">
            <v-btn
              v-bind="act"
              icon="mdi-menu"
              variant="text"
              size="small"
            />
          </template>
          <v-list density="compact">
            <v-list-item @click="onClickLoadFromMenu">
              <template v-slot:prepend>
                <v-icon icon="mdi-folder-open-outline" size="small" />
              </template>
              <v-list-item-title>Load files…</v-list-item-title>
              <v-list-item-subtitle>DICOM or NIfTI (added to existing series)</v-list-item-subtitle>
            </v-list-item>
            <input
              ref="appBarLoadInput"
              type="file"
              multiple
              accept=".dcm,.nii,.nii.gz,.gz,application/dicom,application/octet-stream"
              style="display: none"
              @change="onAppBarLoadInputChange"
            />

            <v-divider />

            <v-list-item @click="drawerLeft = !drawerLeft">
              <template v-slot:prepend>
                <v-icon icon="mdi-dock-left" size="small" />
              </template>
              <v-list-item-title>{{ drawerLeft ? 'Hide sidebar' : 'Show sidebar' }}</v-list-item-title>
            </v-list-item>
            <v-list-item
              :disabled="!canShowTags"
              @click="onShowTags"
            >
              <template v-slot:prepend>
                <v-icon icon="mdi-tag-text-outline" size="small" />
              </template>
              <v-list-item-title>DICOM Tags</v-list-item-title>
              <v-list-item-subtitle v-if="!canShowTags">
                Select a DICOM box first
              </v-list-item-subtitle>
            </v-list-item>

            <v-divider />

            <!-- Preprocessing: 一回限りのセットアップ系。Inspector から移管 (2026-05) -->
            <v-list-subheader class="mv-menu-subheader">Preprocessing</v-list-subheader>

            <!-- CT bed removal: マスク未計算 → 計算ボタン / 計算済 → ON/OFF + Reset -->
            <v-list-item
              v-if="!segStore.ctBodyMask"
              :disabled="!segStore.ctVolumeRef"
              @click="onComputeBodyMask"
            >
              <template v-slot:prepend>
                <v-icon icon="mdi-bed-empty" size="small" />
              </template>
              <v-list-item-title>Remove CT bed</v-list-item-title>
              <v-list-item-subtitle v-if="!segStore.ctVolumeRef">CT volume required</v-list-item-subtitle>
            </v-list-item>
            <v-list-item v-else @click.stop="onToggleBodyMask">
              <template v-slot:prepend>
                <v-icon
                  :icon="segStore.ctBodyMaskEnabled ? 'mdi-eye' : 'mdi-eye-off'"
                  size="small"
                  :color="segStore.ctBodyMaskEnabled ? 'primary' : undefined"
                />
              </template>
              <v-list-item-title>CT bed: {{ segStore.ctBodyMaskEnabled ? 'hidden' : 'visible' }}</v-list-item-title>
              <v-list-item-subtitle>Click to toggle</v-list-item-subtitle>
              <template v-slot:append>
                <v-btn
                  size="x-small"
                  variant="text"
                  @click.stop="onClearBodyMask"
                  title="Reset bed mask"
                >Reset</v-btn>
              </template>
            </v-list-item>

            <!-- MR-PET registration: PT+MR 揃いのときのみ -->
            <v-list-item
              :disabled="!canRegisterMrPt || segStore.mrRegistrationInProgress"
              @click="onRegisterMrPt"
            >
              <template v-slot:prepend>
                <v-icon
                  :icon="segStore.mrRegistrationInProgress ? 'mdi-cog-sync' : 'mdi-vector-link'"
                  size="small"
                  :class="{ 'mv-spin': segStore.mrRegistrationInProgress }"
                />
              </template>
              <v-list-item-title>
                {{ segStore.mrRegistrationInProgress ? 'Registering MR↔PET…' : 'Auto-register MR ↔ PET' }}
              </v-list-item-title>
              <v-list-item-subtitle v-if="!canRegisterMrPt">PT and MR volumes required</v-list-item-subtitle>
              <template v-if="segStore.mrRegistrationParams && !segStore.mrRegistrationInProgress" v-slot:append>
                <v-btn
                  size="x-small"
                  variant="text"
                  @click.stop="onResetRegistration"
                  title="Reset registration to identity"
                >Reset</v-btn>
              </template>
            </v-list-item>

            <v-divider />

            <!-- Inspect NIfTI raw bytes (Persona 2 デバッグ用): NIfTI series が 1 つ以上あるときだけ表示 -->
            <v-menu v-if="niftiSeriesList.length > 0" location="end">
              <template v-slot:activator="{ props: act }">
                <v-list-item v-bind="act">
                  <template v-slot:prepend>
                    <v-icon icon="mdi-database-search-outline" size="small" />
                  </template>
                  <v-list-item-title>Inspect NIfTI raw bytes</v-list-item-title>
                  <v-list-item-subtitle>Bypass affine — show storage order</v-list-item-subtitle>
                </v-list-item>
              </template>
              <v-list density="compact">
                <v-list-item
                  v-for="s in niftiSeriesList"
                  :key="s.idx"
                  @click="onInspectNiftiRaw(s.idx)"
                >
                  <v-list-item-title>{{ s.description }}</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>

            <v-divider v-if="niftiSeriesList.length > 0" />

            <v-list-item @click="browserSupportOpen = true">
              <template v-slot:prepend>
                <v-icon icon="mdi-web" size="small" />
              </template>
              <v-list-item-title>Browser support</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </template>

      <div class="mv-brand ml-1">
        meta<span class="mv-brand-accent">vol</span>-web
      </div>

      <!-- Snapshot save/load: viewer status を JSON にして download / 別セッションで読み込み -->
      <v-menu location="bottom">
        <template v-slot:activator="{ props: act }">
          <v-btn
            v-bind="act"
            :class="['mv-tool-btn', 'ml-2', { 'is-active': !!snapshotMsg }]"
            variant="text"
            size="small"
          >
            <v-icon :icon="snapshotMsg ? 'mdi-check' : 'mdi-camera-outline'" />
            <v-tooltip activator="parent" location="bottom">
              <template v-if="snapshotMsg">{{ snapshotMsg }}</template>
              <template v-else>Snapshot — save / load viewer status</template>
            </v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item @click="onSaveSnapshot">
            <template v-slot:prepend>
              <v-icon icon="mdi-tray-arrow-down" size="small" />
            </template>
            <v-list-item-title>Save snapshot…</v-list-item-title>
            <v-list-item-subtitle>Download .json with layout + segmentation</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="onLoadSnapshot">
            <template v-slot:prepend>
              <v-icon icon="mdi-tray-arrow-up" size="small" />
            </template>
            <v-list-item-title>Load snapshot…</v-list-item-title>
            <v-list-item-subtitle>Pick a previously saved .json (load images first)</v-list-item-subtitle>
          </v-list-item>
          <v-divider />
          <v-list-item @click="onExportRois">
            <template v-slot:prepend>
              <v-icon icon="mdi-vector-rectangle" size="small" />
            </template>
            <v-list-item-title>Export ROIs…</v-list-item-title>
            <v-list-item-subtitle>Download .json with rectangle ROIs (voxel coordinates)</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="onImportRois">
            <template v-slot:prepend>
              <v-icon icon="mdi-vector-rectangle" size="small" />
            </template>
            <v-list-item-title>Import ROIs…</v-list-item-title>
            <v-list-item-subtitle>Load a previously exported metavol-roi .json</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>
      <input
        ref="snapshotLoadInput"
        type="file"
        accept=".json,application/json"
        style="display: none"
        @change="onSnapshotInputChange"
      />
      <input
        ref="roiImportInput"
        type="file"
        accept=".json,application/json"
        style="display: none"
        @change="onRoiInputChange"
      />

      <v-divider vertical class="mx-3" />

      <!-- Tool icons -->
      <div class="mv-tools">
        <v-btn
          v-for="t in tools"
          :key="t.value"
          :class="['mv-tool-btn', { 'is-active': leftButtonFunction === t.value }]"
          variant="text"
          size="small"
          @click="leftButtonFunction = leftButtonFunction === t.value ? null : t.value"
        >
          <v-icon :icon="t.icon" />
          <v-tooltip activator="parent" location="bottom">{{ t.label }}</v-tooltip>
        </v-btn>
      </div>

      <v-divider vertical class="mx-3" />

      <!-- Undo: 矩形 ROI 追加/削除 + polygon マスク編集を時系列で巻き戻す (Ctrl+Z) -->
      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        :disabled="!canUndo"
        @click="onUndo"
      >
        <v-icon icon="mdi-undo" />
        <v-tooltip activator="parent" location="bottom">Undo (Ctrl+Z)</v-tooltip>
      </v-btn>

      <v-spacer />

      <!-- JPEG Lossless decompress progress (★2) -->
      <div v-if="jpegProgress.inProgress" class="mv-jpeg-progress mr-2">
        <v-icon icon="mdi-package-variant" size="x-small" class="mr-1" />
        <span class="mv-jpeg-progress-label">
          Decompressing JPEG Lossless… {{ jpegProgress.done }} / {{ jpegProgress.total }}
        </span>
        <v-progress-linear
          :model-value="jpegProgress.percent"
          height="3"
          color="primary"
          class="mv-jpeg-progress-bar"
        />
      </div>

      <!-- nii.gz gunzip 進捗 (DecompressionStream chunk-by-chunk) -->
      <div v-if="niftiGunzipProgress.inProgress" class="mv-jpeg-progress mr-2" style="background: rgba(122, 208, 255, 0.10);">
        <v-icon icon="mdi-zip-box-outline" size="x-small" class="mr-1" />
        <span class="mv-jpeg-progress-label">
          gunzip {{ niftiGunzipProgress.name }}: {{ niftiGunzipProgress.mb }} MB
        </span>
        <v-progress-linear
          indeterminate
          height="3"
          color="primary"
          class="mv-jpeg-progress-bar"
        />
      </div>

      <!-- MR↔PET registration 進捗 chip (Inspector からハンバーガーへの移管に伴い app-bar に出す) -->
      <div v-if="segStore.mrRegistrationInProgress" class="mv-jpeg-progress mr-2" style="background: rgba(0, 212, 170, 0.10);">
        <v-icon icon="mdi-vector-link" size="x-small" class="mr-1 mv-spin" />
        <span class="mv-jpeg-progress-label">
          MR↔PET reg
          <template v-if="segStore.mrRegistrationProgress">
            L{{ segStore.mrRegistrationProgress.level + 1 }}/{{ segStore.mrRegistrationProgress.nLevels }}
            · iter {{ segStore.mrRegistrationProgress.iter }}
            · MI {{ (-segStore.mrRegistrationProgress.mi).toFixed(4) }}
          </template>
        </span>
        <v-progress-linear
          :indeterminate="!segStore.mrRegistrationProgress"
          :model-value="mrRegPercent"
          height="3"
          color="primary"
          class="mv-jpeg-progress-bar"
        />
      </div>

      <v-btn
        class="mv-pet-std-btn mr-1"
        variant="flat"
        size="small"
        :disabled="!petCtReady"
        @click="onClickPetStandard"
      >
        <v-icon icon="mdi-view-grid" class="mr-1" size="small" />
        PET Standard
        <v-tooltip activator="parent" location="bottom">
          {{ petStandardTooltip }}
        </v-tooltip>
      </v-btn>

      <!-- PET Standard ピッカー (PT or CT が複数あるときだけ開く) -->
      <v-dialog
        v-model="petPickerOpen"
        max-width="520"
        @after-leave="petPickerCandidates = null"
      >
        <v-card v-if="petPickerCandidates" class="pa-4">
          <div class="text-h6 mb-3">Choose PT and CT for PET Standard</div>
          <div class="text-caption text-disabled mb-4">
            Multiple series detected. Pick one PT and one CT to fuse, or click ★ on a series card to set defaults persistently.
          </div>

          <div class="mv-pet-picker-section">
            <div class="mv-pet-picker-label">
              <span class="modality-chip is-pt">PT</span>
              {{ petPickerCandidates.pt.length }} series
            </div>
            <v-radio-group v-model="petPickerSelectedPt" density="compact" hide-details>
              <v-radio
                v-for="c in petPickerCandidates.pt"
                :key="`pt-${c.idx}`"
                :label="c.label + (c.isActive ? '  (★ active)' : '')"
                :value="c.idx"
              />
            </v-radio-group>
          </div>

          <div class="mv-pet-picker-section mt-4">
            <div class="mv-pet-picker-label">
              <span class="modality-chip is-ct">CT</span>
              {{ petPickerCandidates.ct.length }} series
            </div>
            <v-radio-group v-model="petPickerSelectedCt" density="compact" hide-details>
              <v-radio
                v-for="c in petPickerCandidates.ct"
                :key="`ct-${c.idx}`"
                :label="c.label + (c.isActive ? '  (★ active)' : '')"
                :value="c.idx"
              />
            </v-radio-group>
          </div>

          <div class="d-flex justify-end mt-5" style="gap: 8px">
            <v-btn variant="text" @click="petPickerOpen = false">Cancel</v-btn>
            <v-btn color="primary" variant="flat" @click="confirmPetPicker">Build</v-btn>
          </div>
        </v-card>
      </v-dialog>

      <v-menu>
        <template v-slot:activator="{ props: act }">
          <v-btn
            v-bind="act"
            class="mv-tool-btn mv-tool-btn--wide mr-1"
            variant="text"
            size="small"
          >
            <v-icon icon="mdi-view-dashboard-outline" />
            <span class="mv-tool-label">Layouts</span>
            <v-tooltip activator="parent" location="bottom">More layout presets</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item @click="runLayout('triplanarPt')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-week-outline" size="small" />
            </template>
            <v-list-item-title>Triplanar PT (1×3)</v-list-item-title>
            <v-list-item-subtitle>PT axial / coronal / sagittal</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('triplanarFused')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-week" size="small" />
            </template>
            <v-list-item-title>Triplanar Fused (1×3)</v-list-item-title>
            <v-list-item-subtitle>Fused axial / coronal / sagittal</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('ptOnly4up')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-grid" size="small" />
            </template>
            <v-list-item-title>PT-only 4-up (2×2)</v-list-item-title>
            <v-list-item-subtitle>PT axi / cor / sag / MIP</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('compare2up')">
            <template v-slot:prepend>
              <v-icon icon="mdi-compare" size="small" />
            </template>
            <v-list-item-title>Compare 2-up (1×2)</v-list-item-title>
            <v-list-item-subtitle>Two series side-by-side, same plane</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-menu>
        <template v-slot:activator="{ props: act }">
          <v-btn
            v-bind="act"
            :class="['mv-tool-btn', 'mv-tool-btn--wide', 'mr-1', { 'is-active': !!activeTracer }]"
            variant="text"
            size="small"
          >
            <v-icon icon="mdi-flask-outline" />
            <span class="mv-tool-label">{{ activeTracer ? activeTracer.name : 'Tracer' }}</span>
            <v-tooltip activator="parent" location="bottom">
              {{ activeTracer
                ? `Active: ${activeTracer.name} — click to switch`
                : 'Pick a tracer preset (SUV threshold + window + labels)' }}
            </v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item
            v-for="t in tracerPresets"
            :key="t.id"
            :active="segStore.activeTracerId === t.id"
            @click="onTracerSelected(t.id)"
          >
            <template v-slot:prepend>
              <v-icon icon="mdi-radioactive" size="small" />
            </template>
            <v-list-item-title>{{ t.name }}</v-list-item-title>
            <v-list-item-subtitle class="mv-tracer-sub">
              SUV {{ t.suvThreshold }} · 0–{{ (t.suvWindow.wc + t.suvWindow.ww / 2).toFixed(0) }} · {{ t.labels.length }} labels
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-btn
        class="mv-tool-btn mv-tool-btn--wide mr-2"
        variant="text"
        size="small"
        :disabled="!petCtReady"
        @click="runFusion"
      >
        <v-icon icon="mdi-circle-multiple-outline" />
        <span class="mv-tool-label">Fusion</span>
        <v-tooltip activator="parent" location="bottom">
          {{ petCtReady ? 'Fuse CT (base) + PET (overlay) into the active box' : 'Load both PET and CT first' }}
        </v-tooltip>
      </v-btn>

      <v-divider vertical class="mx-2" />

      <v-btn
        :class="['mv-tool-btn', { 'is-active': syncImageBox }]"
        variant="text"
        size="small"
        @click="syncImageBox = !syncImageBox"
      >
        <v-icon icon="mdi-link-variant" />
        <v-tooltip activator="parent" location="bottom">{{ syncImageBox ? 'Sync ON' : 'Sync OFF' }}</v-tooltip>
      </v-btn>

      <v-btn
        :class="['mv-tool-btn', { 'is-active': voxelInspector }]"
        variant="text"
        size="small"
        @click="voxelInspector = !voxelInspector"
      >
        <v-icon icon="mdi-eyedropper" />
        <v-tooltip activator="parent" location="bottom">
          {{ voxelInspector ? 'Voxel inspector ON (hover to read voxel values)' : 'Voxel inspector OFF (Ctrl+Shift+D)' }}
        </v-tooltip>
      </v-btn>

      <v-btn
        :class="['mv-tool-btn', { 'is-active': showOverlayInfo }]"
        variant="text"
        size="small"
        @click="showOverlayInfo = !showOverlayInfo"
      >
        <v-icon icon="mdi-information-outline" />
        <v-tooltip activator="parent" location="bottom">
          {{ showOverlayInfo ? 'Hide patient/exam info overlay' : 'Show patient/exam info overlay' }}
        </v-tooltip>
      </v-btn>

      <v-btn
        class="mv-tool-btn"
        variant="text" size="small"
        @click="fitToWindow"
      >
        <v-icon icon="mdi-fit-to-screen-outline" />
        <v-tooltip activator="parent" location="bottom">Fit to window</v-tooltip>
      </v-btn>
      <v-btn
        :class="['mv-tool-btn', { 'is-active': noGapMode }]"
        variant="text" size="small"
        @click="noGapMode = !noGapMode"
      >
        <v-icon icon="mdi-arrow-expand-all" />
        <v-tooltip activator="parent" location="bottom">
          {{ noGapMode ? 'Edge-to-edge tiles ON (gap = 0)' : 'Edge-to-edge tiles OFF (click to fill the image area without gaps)' }}
        </v-tooltip>
      </v-btn>

      <v-divider vertical class="mx-1" />

      <v-menu>
        <template v-slot:activator="{ props }">
          <v-btn class="mv-tool-btn mv-tool-btn--wide" variant="text" size="small" v-bind="props">
            <v-icon icon="mdi-view-grid-outline" />
            <span class="mv-tool-label">{{ tileN }}</span>
            <v-tooltip activator="parent" location="bottom">Tile count</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" @click:select="clickItem">
          <v-list-item v-for="n in [1,2,3,4,6,8,9,10,12]" :key="n" :value="String(n)">
            <v-list-item-title>{{ n }} {{ n === 1 ? 'box' : 'boxes' }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        @click="drawerRight = !drawerRight"
      >
        <v-icon icon="mdi-format-vertical-align-top" style="transform: rotate(90deg)" />
        <v-tooltip activator="parent" location="bottom">{{ drawerRight ? 'Hide inspector' : 'Show inspector' }}</v-tooltip>
      </v-btn>

      <v-divider vertical class="mx-1" />

      <!-- Renderer (CPU/GPU) トグル + perf 集計表示 -->
      <v-menu :close-on-content-click="false">
        <template v-slot:activator="{ props: act }">
          <v-btn class="mv-tool-btn mv-tool-btn--wide" variant="text" size="small" v-bind="act">
            <v-icon :icon="rendererModeIcon" />
            <span class="mv-tool-label">{{ rendererModeLabel }}</span>
            <v-tooltip activator="parent" location="bottom">Renderer (CPU/GPU) and perf stats</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" min-width="280">
          <v-list-subheader>Renderer mode</v-list-subheader>
          <v-list-item
            :active="perfStore.rendererMode === 'auto'"
            @click="setRendererMode('auto')"
          >
            <template v-slot:prepend>
              <v-icon icon="mdi-auto-fix" size="small" />
            </template>
            <v-list-item-title>Auto (GPU if available)</v-list-item-title>
          </v-list-item>
          <v-list-item
            :active="perfStore.rendererMode === 'cpu'"
            @click="setRendererMode('cpu')"
          >
            <template v-slot:prepend>
              <v-icon icon="mdi-cpu-64-bit" size="small" />
            </template>
            <v-list-item-title>Force CPU</v-list-item-title>
          </v-list-item>
          <v-list-item
            :active="perfStore.rendererMode === 'gpu'"
            @click="setRendererMode('gpu')"
          >
            <template v-slot:prepend>
              <v-icon icon="mdi-expansion-card-variant" size="small" />
            </template>
            <v-list-item-title>Force GPU (no fallback)</v-list-item-title>
          </v-list-item>

          <v-divider class="my-1" />
          <v-list-subheader>Median (last 30)</v-list-subheader>
          <v-list-item density="compact" class="mv-perf-row">
            <div class="mv-perf-grid">
              <div class="mv-perf-cell mv-perf-h">kind</div>
              <div class="mv-perf-cell mv-perf-h">CPU</div>
              <div class="mv-perf-cell mv-perf-h">GPU</div>
              <template v-for="r in perfKinds" :key="r.kind">
                <div class="mv-perf-cell">{{ r.label }}</div>
                <div class="mv-perf-cell mv-perf-num">{{ perfRow(r.kind).cpu }}</div>
                <div class="mv-perf-cell mv-perf-num">{{ perfRow(r.kind).gpu }}</div>
              </template>
            </div>
          </v-list-item>
          <v-list-item @click="perfStore.clearSamples">
            <template v-slot:prepend>
              <v-icon icon="mdi-restart" size="small" />
            </template>
            <v-list-item-title>Clear stats</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        color="error"
        @click="onCloseAll"
      >
        <v-icon icon="mdi-trash-can-outline" />
        <v-tooltip activator="parent" location="bottom">Close all</v-tooltip>
      </v-btn>
    </v-app-bar>

    <!-- Close-all 確認ダイアログ。データ損失リスクを明示する。 -->
    <v-dialog v-model="closeAllDialogOpen" max-width="460">
      <v-card>
        <v-card-title class="text-body-1">Close all images?</v-card-title>
        <v-card-text>
          <p>This clears the current session, including:</p>
          <ul class="mv-close-list">
            <li>{{ closeAllSummary.boxes }} open box(es)</li>
            <li>{{ closeAllSummary.series }} loaded series</li>
            <li v-if="closeAllSummary.hasMask">
              <strong>Segmentation work</strong> (mask, labels, lesion table)
            </li>
            <li v-if="closeAllSummary.hasSphere">
              Sphere ROI
            </li>
          </ul>
          <p v-if="closeAllSummary.hasMask || closeAllSummary.hasSphere" class="text-warning text-caption mt-2">
            Save your work first if you need it (Snapshot, Save NIfTI mask, etc.).
          </p>
          <p v-else class="text-caption text-disabled mt-2">
            No segmentation work detected — safe to close.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeAllDialogOpen = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="confirmCloseAll">Close all</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-main>
      <DicomView
        ref="dicomViewRef"
        v-model:drawer="drawerLeft"
        v-model:inspector="drawerRight"
        v-model:leftButtonFunction="leftButtonFunction"
        v-model:imageBoxW="imageBoxW"
        v-model:imageBoxH="imageBoxH"
        v-model:tileN="tileN"
        v-model:syncImageBox="syncImageBox"
        v-model:closingImages="closingImages"
        v-model:debugMode="voxelInspector"
        v-model:showOverlayInfo="showOverlayInfo"
        v-model:noGapMode="noGapMode"
      />
    </v-main>

    <DicomTagDialog
      v-model="tagDialogOpen"
      :dataset="tagContext?.dataset ?? null"
      :series-label="tagContext?.label ?? ''"
      :slice-index="tagContext?.sliceIndex"
      :slice-count="tagContext?.sliceCount"
    />

    <!-- Browser support dialog -->
    <v-dialog v-model="browserSupportOpen" max-width="540">
      <v-card>
        <v-card-title class="text-body-1">Browser support</v-card-title>
        <v-card-text>
          <div class="mv-ua-line">{{ userAgent }}</div>
          <v-list density="compact" class="mv-bs-list">
            <v-list-item v-for="c in browserChecks" :key="c.name">
              <template v-slot:prepend>
                <v-icon
                  :icon="c.supported ? 'mdi-check-circle' : (c.critical ? 'mdi-alert-circle' : 'mdi-information-outline')"
                  :color="c.supported ? 'success' : (c.critical ? 'error' : 'warning')"
                  size="small"
                />
              </template>
              <v-list-item-title>{{ c.name }}</v-list-item-title>
              <v-list-item-subtitle v-if="!c.supported && !c.critical">
                Optional — feature unavailable in this browser
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>
          <p class="mv-bs-note">
            Best experienced on Chrome or Edge. DICOM/NIfTI loading via drag-and-drop works on Firefox and Safari too.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="browserSupportOpen = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import DicomView from "./components/DicomView.vue";
import { getWH, getTileN } from "./components/UrlParser.ts";
import { useSegmentationStore } from "./stores/segmentation";
import { ensureWasmCodecsReady } from "./components/wasmCodec";
import { TRACER_PRESETS, tracerById } from "./components/tracerPresets";
import DicomTagDialog from "./components/DicomTagDialog.vue";

// アプリ起動時に dcmjs-codecs WASM をプリウォーム (DICOM JPEG Lossless 用)。
// ~4 MB の WASM を fetch + instantiate するので体感 0.3-1s かかる。
// バックグラウンドで進行、失敗時は jpeg-lossless-decoder-js (純 JS) にフォールバック。
onMounted(() => {
  ensureWasmCodecsReady().catch(err => {
    console.warn('[wasm-codecs] init failed (will fall back to pure JS for JPEG Lossless):', err);
  });
});

const segStore = useSegmentationStore();

// Renderer mode (Auto / Force CPU / Force GPU) + perf 集計表示
import { usePerfStore, type RendererMode, type DrawKind } from '@/stores/perf';
const perfStore = usePerfStore();
const setRendererMode = (m: RendererMode) => {
  perfStore.setMode(m);
  redraw();   // 全 box 再描画 (新 mode で)
};
const rendererModeLabel = computed(() => {
  if (perfStore.rendererMode === 'cpu') return 'CPU';
  if (perfStore.rendererMode === 'gpu') return 'GPU';
  return 'Auto';
});
const rendererModeIcon = computed(() => {
  if (perfStore.rendererMode === 'cpu') return 'mdi-cpu-64-bit';
  if (perfStore.rendererMode === 'gpu') return 'mdi-expansion-card-variant';
  return 'mdi-auto-fix';
});
const perfKinds: { kind: DrawKind; label: string }[] = [
  { kind: 'mpr',         label: 'MPR' },
  { kind: 'fusion-mpr',  label: 'Fusion MPR' },
  { kind: 'mip',         label: 'MIP' },
  { kind: 'smip',        label: 'sMIP' },
  { kind: 'vr',          label: 'VR' },
  { kind: 'mip-multi',   label: 'MIP (multi)' },
  { kind: 'vr-multi',    label: 'VR (multi)' },
];
const perfRow = (kind: DrawKind) => {
  const cpu = perfStore.median(kind, 'cpu');
  const gpu = perfStore.median(kind, 'gpu');
  return {
    cpu: cpu == null ? '—' : `${cpu.toFixed(1)} ms`,
    gpu: gpu == null ? '—' : `${gpu.toFixed(1)} ms`,
  };
};

// PET Standard ボタンを enable する条件:
//   (a) PET/CT 両方の Volume が既に MPR 済み、または
//   (b) DicomView が公開する seriesSummaries に PT と CT の DICOM がある
const seriesSummariesView = computed(() => dicomViewRef.value?.seriesSummariesPublic ?? []);
const petCtReady = computed(() => {
  if (segStore.petVolumeRef && segStore.ctVolumeRef) return true;
  const list = seriesSummariesView.value as Array<any>;
  const hasPt = list.some(s => s.modality === 'PT' || s.modality === 'PET');
  const hasCt = list.some(s => s.modality === 'CT');
  return hasPt && hasCt;
});

const drawerLeft = ref(true);
// Inspector (右ドロワ) は初期表示 — ROI リスト等をすぐ見せる
const drawerRight = ref(true);
const leftButtonFunction = ref<string | null>(null);
const [w, h] = getWH();
const imageBoxW = ref(w);
const imageBoxH = ref(h);
const closingImages = ref(false);
const tileN = ref(getTileN());
// default OFF: NIfTI を 2 つドラッグしただけのときに勝手に paging が連動して
// 視点が壊れるのを防ぐ。PET Standard / Triplanar 等のレイアウト関数は
// 個別に syncImageBox.value = true を設定する。
const syncImageBox = ref(false);
const voxelInspector = ref(false);
const showOverlayInfo = ref(true);
const noGapMode = ref(true);

const tools = [
  { value: 'window',     icon: 'mdi-contrast-circle',       label: 'Window/Level' },
  { value: 'pan',        icon: 'mdi-hand-back-right-outline', label: 'Pan' },
  { value: 'zoom',       icon: 'mdi-magnify-plus-outline',  label: 'Zoom' },
  { value: 'page',       icon: 'mdi-arrow-up-down',         label: 'Page' },
  { value: 'sphereROI',  icon: 'mdi-circle-outline',        label: 'Sphere ROI' },
  { value: 'rectROI',    icon: 'mdi-rectangle-outline',     label: 'Rectangle ROI' },
  { value: 'polygonROI', icon: 'mdi-pentagon-outline',      label: 'Polygon ROI' },
  { value: 'brushROI',   icon: 'mdi-brush',                 label: 'Brush (paint/erase voxels)' },
  { value: 'assignLabel',icon: 'mdi-tag-outline',           label: 'Assign Label' },
];

const fitToWindow = () => {
  dicomViewRef.value?.fitToWindow?.();
};

// Close all 確認ダイアログ
const closeAllDialogOpen = ref(false);
const closeAllSummary = computed(() => {
  const list = (dicomViewRef.value?.seriesSummariesPublic ?? []) as Array<unknown>;
  const boxes = tileN.value ?? 0;
  const series = list.length;
  const hasMask = !!(segStore.finalMask && segStore.labels && segStore.labels.length > 0);
  const hasSphere = !!segStore.sphere;
  return { boxes, series, hasMask, hasSphere };
});
const onCloseAll = () => {
  // データが何も無ければ即時閉じる (boxes=0 かつ series=0)。
  // それ以外は確認ダイアログを出す。
  const s = closeAllSummary.value;
  if (s.boxes === 0 && s.series === 0) {
    closingImages.value = true;
    return;
  }
  closeAllDialogOpen.value = true;
};
const confirmCloseAll = () => {
  closeAllDialogOpen.value = false;
  closingImages.value = true;
};

// "Load files…" (ハンバーガーメニュー) から OS のファイルピッカーを開く。
// 選択されたファイルは DicomView.loadFiles に流す → 既存 series に append される。
const appBarLoadInput = ref<HTMLInputElement | null>(null);
const onClickLoadFromMenu = () => {
  appBarLoadInput.value?.click();
};
const onAppBarLoadInputChange = (e: Event) => {
  const inp = e.target as HTMLInputElement;
  if (inp.files && inp.files.length > 0) {
    dicomViewRef.value?.loadFiles?.(inp.files);
  }
  inp.value = '';
};

const clickItem = (e: any) => {
  tileN.value = Number(e.id);
};

const dicomViewRef = ref<any>(null);

// PET Standard ピッカー state (PT or CT が複数あるとき開くダイアログ)
type SeriesCandidate = { idx: number; label: string; isActive: boolean; score: number };
const petPickerOpen = ref(false);
const petPickerCandidates = ref<{ pt: SeriesCandidate[]; ct: SeriesCandidate[] } | null>(null);
const petPickerSelectedPt = ref<number | null>(null);
const petPickerSelectedCt = ref<number | null>(null);

// PET Standard ボタン: 候補の数で挙動を分岐
//   - 1 PT × 1 CT → 即実行 (現状通り)
//   - PT or CT が複数 → ピッカーダイアログを開いて、active or first-found を既定選択
const onClickPetStandard = () => {
  const r = dicomViewRef.value;
  if (!r) return;
  const cands = r.getPetCtSeriesCandidates?.() as { pt: SeriesCandidate[]; ct: SeriesCandidate[] } | undefined;
  if (!cands || cands.pt.length === 0 || cands.ct.length === 0) return;

  const ambiguous = cands.pt.length > 1 || cands.ct.length > 1;
  if (!ambiguous) {
    runPetStandardWith();
    return;
  }

  // 既定選択 (resolvePetCtIndices と同じ優先順位: active → first)
  const defaultPt = cands.pt.find(c => c.isActive)?.idx ?? cands.pt[0].idx;
  const defaultCt = cands.ct.find(c => c.isActive)?.idx ?? cands.ct[0].idx;
  petPickerCandidates.value = cands;
  petPickerSelectedPt.value = defaultPt;
  petPickerSelectedCt.value = defaultCt;
  petPickerOpen.value = true;
};

const confirmPetPicker = () => {
  const pt = petPickerSelectedPt.value;
  const ct = petPickerSelectedCt.value;
  petPickerOpen.value = false;
  if (pt == null || ct == null) return;
  runPetStandardWith(pt, ct);
};

const runPetStandardWith = (overridePt?: number, overrideCt?: number) => {
  tileN.value = 4;
  setTimeout(() => {
    dicomViewRef.value?.setupPetStandardView?.(overridePt, overrideCt);
  }, 50);
};

// ボタンの tooltip: 解決済の PT/CT description を表示
const petStandardTooltip = computed(() => {
  if (!petCtReady.value) return 'Load both PET and CT first';
  const r = dicomViewRef.value;
  if (!r) return '2x2: CT axi / PET axi / Fusion axi / PET MIP';
  const cands = r.getPetCtSeriesCandidates?.() as { pt: SeriesCandidate[]; ct: SeriesCandidate[] } | undefined;
  if (!cands) return '2x2: CT axi / PET axi / Fusion axi / PET MIP';
  const ambiguous = cands.pt.length > 1 || cands.ct.length > 1;
  if (ambiguous) return `Multiple PT/CT detected — click to choose (${cands.pt.length} PT × ${cands.ct.length} CT)`;
  const pt = cands.pt[0]?.label ?? '';
  const ct = cands.ct[0]?.label ?? '';
  return `Build PET Standard with PT: ${pt}  /  CT: ${ct}`;
});

const runFusion = () => {
  dicomViewRef.value?.fusion?.();
};

const runLayout = (kind: 'triplanarPt' | 'triplanarFused' | 'ptOnly4up' | 'compare2up') => {
  const r = dicomViewRef.value;
  if (!r) return;
  if (kind === 'triplanarPt')   r.setupTriplanarPt?.();
  if (kind === 'triplanarFused') r.setupTriplanarFused?.();
  if (kind === 'ptOnly4up')     r.setupPtOnly4up?.();
  if (kind === 'compare2up')    r.setupCompare2up?.();
};

// Tracer preset を pull-down で適用
const tracerPresets = TRACER_PRESETS;
const activeTracer = computed(() => {
  const id = segStore.activeTracerId;
  return id ? tracerById(id) : null;
});
const onTracerSelected = (id: string) => {
  dicomViewRef.value?.applyTracerById?.(id);
};

// DICOM tag viewer (non-modal). 開いている間 paging に追従して中身が更新される。
// dicomViewRef が expose する activeTagContext (computed ref) を直接読む。
const tagDialogOpen = ref(false);
const tagContext = computed(() => {
  if (!tagDialogOpen.value) return null;
  // Vue の defineExpose で expose された computed は ref として渡される。.value で unwrap。
  const ctxRef: any = dicomViewRef.value?.activeTagContext;
  if (ctxRef == null) return null;
  // dicomViewRef.value は ComponentPublicInstance 越しなので、computed は自動 unwrap される。
  return ctxRef as { dataset: any; label: string; sliceIndex: number; sliceCount: number } | null;
});
const onShowTags = () => {
  tagDialogOpen.value = true;
};

// メニュー項目の disable 制御:
// activeTagContext は Volume / Fusion / MIP の Box が選択されているとき null を返す。
const canShowTags = computed<boolean>(() => {
  return !!dicomViewRef.value?.activeTagContext;
});

// Browser support dialog
const browserSupportOpen = ref(false);
const userAgent = computed(() => navigator.userAgent);
const browserChecks = computed(() => {
  const w = window as unknown as { showDirectoryPicker?: unknown };
  const hasFolderDrag = typeof DataTransferItem !== 'undefined'
    && typeof DataTransferItem.prototype !== 'undefined'
    && 'webkitGetAsEntry' in DataTransferItem.prototype;
  return [
    { name: 'File API (FileReader)',         supported: typeof FileReader !== 'undefined', critical: true },
    { name: 'Drag-and-drop files',           supported: typeof DragEvent !== 'undefined',  critical: true },
    { name: 'Drag folders into the app',     supported: hasFolderDrag,                     critical: false },
    { name: 'Folder picker (showDirectoryPicker)', supported: typeof w.showDirectoryPicker === 'function', critical: false },
    { name: 'Canvas 2D rendering',           supported: typeof HTMLCanvasElement !== 'undefined', critical: true },
    { name: 'Typed arrays (Float32 / Int16)', supported: typeof Float32Array !== 'undefined' && typeof Int16Array !== 'undefined', critical: true },
  ];
});

// ★2: JPEG Lossless decompress 進捗を app-bar に表示
const jpegProgress = computed(() => {
  const r = dicomViewRef.value;
  const inProgress = !!r?.jpegDecompressInProgress;
  const done = (r?.jpegDecompressDone as number) ?? 0;
  const total = (r?.jpegDecompressTotal as number) ?? 0;
  const percent = total > 0 ? (done / total) * 100 : 0;
  return { inProgress, done, total, percent };
});

// Snapshot save / load (replaces former Copy share URL).
//   Save: layout + segmentation + lesion table を 1 JSON にして download。
//   Load: 別セッションで JSON を読み込み → 同じ images を再ロード済みの状態に対して復元。
const snapshotMsg = ref<string>('');
const setSnapshotMsg = (m: string) => {
  snapshotMsg.value = m;
  setTimeout(() => { if (snapshotMsg.value === m) snapshotMsg.value = ''; }, 3000);
};
const onSaveSnapshot = () => {
  try {
    dicomViewRef.value?.downloadSnapshotFile?.();
    setSnapshotMsg('Snapshot downloaded');
  } catch (err: any) {
    setSnapshotMsg('Save failed: ' + (err?.message ?? err));
  }
};
const snapshotLoadInput = ref<HTMLInputElement | null>(null);
const onLoadSnapshot = () => {
  snapshotLoadInput.value?.click();
};
const onExportRois = () => {
  try {
    dicomViewRef.value?.exportRoisAsJson?.();
  } catch (err: any) {
    setSnapshotMsg('ROI export failed: ' + (err?.message ?? err));
  }
};

// 統合 Undo (矩形 ROI 追加/削除 + polygon マスク編集)。Ctrl+Z と同じ動作。
const canUndo = computed(() => segStore.canUndo);
const onUndo = () => {
  dicomViewRef.value?.undoLastAction?.();
};
const onSnapshotInputChange = async (e: Event) => {
  const inp = e.target as HTMLInputElement;
  const file = inp.files?.[0];
  inp.value = '';
  if (!file) return;
  const r = await dicomViewRef.value?.loadSnapshotFile?.(file);
  if (r?.ok) setSnapshotMsg(`Loaded: ${r.info}`);
  else setSnapshotMsg(`Load failed: ${r?.reason ?? 'unknown error'}`);
};

const roiImportInput = ref<HTMLInputElement | null>(null);
const onImportRois = () => {
  roiImportInput.value?.click();
};
const onRoiInputChange = async (e: Event) => {
  const inp = e.target as HTMLInputElement;
  const file = inp.files?.[0];
  inp.value = '';
  if (!file) return;
  const r = await dicomViewRef.value?.importRoisFromJsonFile?.(file);
  if (r?.ok) setSnapshotMsg(`ROIs: ${r.info}`);
  else setSnapshotMsg(`ROI import failed: ${r?.info ?? 'unknown error'}`);
};

// nii.gz gunzip 進捗 (累計 MB)。最終サイズは gzip 形式上事前取得困難のため進捗 % は出さず
// 「currently X MB processed」表示 + indeterminate bar。
const niftiGunzipProgress = computed(() => {
  const r = dicomViewRef.value;
  const inProgress = !!r?.niftiGunzipInProgress;
  const name = (r?.niftiGunzipName as string) ?? '';
  const bytes = (r?.niftiGunzipBytes as number) ?? 0;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return { inProgress, name, mb };
});

// ===== Preprocessing menu (ハンバーガーから) =====
// CT bed removal & MR-PET registration の handlers。Inspector から移管。

const redraw = () => dicomViewRef.value?.redraw?.();

const onComputeBodyMask = () => {
  if (!segStore.ctVolumeRef) { alert('No CT volume loaded.'); return; }
  if (!segStore.computeCtBodyMask(-300)) { alert('Failed to compute CT body mask.'); return; }
  redraw();
};
const onToggleBodyMask = () => { segStore.toggleCtBodyMaskEnabled(); redraw(); };
const onClearBodyMask  = () => { segStore.clearCtBodyMask();        redraw(); };

const canRegisterMrPt = computed(() => !!segStore.petVolumeRef && !!segStore.mrVolumeRef);

const onRegisterMrPt = async () => {
  if (!canRegisterMrPt.value) {
    alert('PT and MR volumes are both required for registration.');
    return;
  }
  // 動的 import で重い registration コードを実行時のみロード (bundle 分割効果)
  const [{ registerMrToPt }, { applyRigidToVolume }] = await Promise.all([
    import('./components/registration/registerMrPt'),
    import('./components/registration/transform'),
  ]);
  const pt = segStore.petVolumeRef!;
  const mr = segStore.mrVolumeRef!;
  segStore.ensureMrRegistrationSnapshot();
  const snap = segStore.mrRegistrationSnapshot;
  if (!snap) { alert('Could not capture MR snapshot.'); return; }
  applyRigidToVolume(mr, snap, [0, 0, 0, 0, 0, 0]);
  segStore.setMrRegistrationParams(null);
  segStore.setMrRegistrationInProgress(true);
  segStore.setMrRegistrationProgress(null);
  await new Promise(r => setTimeout(r, 30));
  try {
    const res = registerMrToPt(pt, mr, [0, 0, 0, 0, 0, 0], (info) => {
      segStore.setMrRegistrationProgress({
        level: info.level, nLevels: info.nLevels,
        iter: info.iter, mi: info.bestNegMI,
      });
    });
    applyRigidToVolume(mr, snap, res.params);
    segStore.setMrRegistrationParams(res.params as [number, number, number, number, number, number]);
    redraw();
  } catch (err: any) {
    alert('Registration failed: ' + (err?.message ?? err));
  } finally {
    segStore.setMrRegistrationInProgress(false);
  }
};

const onResetRegistration = async () => {
  const { applyRigidToVolume } = await import('./components/registration/transform');
  const mr = segStore.mrVolumeRef;
  const snap = segStore.mrRegistrationSnapshot;
  if (mr && snap) applyRigidToVolume(mr, snap, [0, 0, 0, 0, 0, 0]);
  segStore.setMrRegistrationParams(null);
  segStore.setMrRegistrationProgress(null);
  redraw();
};

// 進捗 chip 用パーセンテージ (level + iter から大まかに推定)
const mrRegPercent = computed(() => {
  const p = segStore.mrRegistrationProgress;
  if (!p || p.nLevels <= 0) return 0;
  return Math.min(100, (p.level / p.nLevels) * 100);
});

// NIfTI raw byte view (Persona 2 / orientation 検証用)
const niftiSeriesList = computed<Array<{ idx: number; description: string }>>(() => {
  const r = dicomViewRef.value;
  if (!r?.getNiftiSeriesList) return [];
  // getNiftiSeriesList は seriesList 直読みなので、reactive 連動のため
  // seriesSummariesPublic にアクセスして reactivity を確保
  void r.seriesSummariesPublic;
  return r.getNiftiSeriesList();
});
const onInspectNiftiRaw = (idx: number) => {
  dicomViewRef.value?.inspectNiftiRaw?.(idx);
};
</script>

<style scoped>
.mv-tools {
  display: flex;
  gap: 2px;
  align-items: center;
  flex-wrap: nowrap;
}

/* app-bar 内の divider を細く */
:deep(.v-app-bar .v-divider) {
  border-color: var(--mv-border) !important;
  height: 24px !important;
  min-height: 24px !important;
  align-self: center !important;
  opacity: 1;
}

.mv-pet-std-btn {
  background: var(--mv-accent) !important;
  color: var(--mv-bg) !important;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0.01em;
  border-radius: 6px;
  height: 32px;
}
.mv-pet-std-btn:hover {
  background: #00B894 !important;
}

/* Hamburger menu subheader (Preprocessing 等) */
.mv-menu-subheader {
  font-size: 9px !important;
  letter-spacing: 0.08em;
  color: var(--mv-text-muted) !important;
  text-transform: uppercase;
  min-height: 24px !important;
  padding-left: 12px !important;
}

/* MR↔PET reg / spinner icon */
@keyframes mv-spin {
  from { transform: rotate(0); }
  to   { transform: rotate(360deg); }
}
.mv-spin {
  animation: mv-spin 1.2s linear infinite;
}

/* PET Standard ピッカーダイアログ */
.mv-pet-picker-section .mv-pet-picker-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--mv-text);
  margin-bottom: 4px;
}
.modality-chip {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 2px;
  letter-spacing: 0.04em;
  color: #0F1419;
}
.modality-chip.is-pt { background: #ff9b3a; }
.modality-chip.is-ct { background: #7ad0ff; }

:deep(.mv-tool-btn--wide) {
  width: auto !important;
  padding: 0 8px !important;
  gap: 4px;
}
:deep(.mv-tool-label) {
  font-size: 12px;
  font-weight: 600;
  color: var(--mv-text);
}

/* perf 集計テーブル (Renderer toggle menu 内) */
.mv-perf-row { padding: 4px 12px !important; }
.mv-perf-grid {
  display: grid;
  grid-template-columns: 1fr auto auto;
  column-gap: 14px;
  row-gap: 2px;
  font-size: 12px;
}
.mv-perf-cell { white-space: nowrap; }
.mv-perf-h {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--mv-text-muted);
  border-bottom: 1px solid var(--mv-border);
  padding-bottom: 2px;
}
.mv-perf-num {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  text-align: right;
}

.mv-tracer-sub {
  font-size: 10px !important;
  color: var(--mv-text-muted) !important;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
}

:deep(.v-app-bar) {
  border-bottom: 1px solid var(--mv-border);
}

/* ★2: JPEG Lossless decompress progress chip — pulse animation で「作業中」を強調 */
@keyframes mv-pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 212, 170, 0.45); }
  50%      { box-shadow: 0 0 8px 2px rgba(0, 212, 170, 0.55); }
}
.mv-jpeg-progress {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 4px 12px;
  background: var(--mv-surface-2, #222B36);
  border: 1px solid var(--mv-accent-dim, #007E66);
  border-radius: 6px;
  min-width: 240px;
  animation: mv-pulse-glow 1.6s ease-in-out infinite;
}
.mv-jpeg-progress-label {
  font-size: 11px;
  color: var(--mv-accent, #00D4AA);
  font-feature-settings: 'tnum';
  white-space: nowrap;
  font-weight: 600;
}
.mv-jpeg-progress-bar {
  border-radius: 2px;
}

/* Browser support dialog */
.mv-ua-line {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 11px;
  color: var(--mv-text-dim, #8FA0B0);
  word-break: break-all;
  background: var(--mv-surface-2, #222B36);
  padding: 6px 8px;
  border-radius: 3px;
  margin-bottom: 8px;
}
.mv-bs-list {
  background: transparent !important;
}
.mv-bs-note {
  margin-top: 8px;
  font-size: 11px;
  color: var(--mv-text-dim, #8FA0B0);
  line-height: 1.5;
}
</style>
