<template>
  <v-app>
    <!-- 高さは app.scss の --mv-appbar-h と一致させること (v-app-bar は数値指定が必要) -->
    <v-app-bar class="mv-appbar" flat density="compact" :height="APPBAR_H">
      <template v-slot:prepend>
        <v-menu>
          <template v-slot:activator="{ props: act }">
            <v-btn
              v-bind="act"
              icon="mdi-menu"
              variant="text"
              size="small"
              data-demo="menu"
            >
              <v-icon icon="mdi-menu" />
              <v-tooltip activator="parent" location="bottom">
                Main menu — load / save / export, snapshots, preprocessing, help
              </v-tooltip>
            </v-btn>
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

            <!-- Save / export (Segmentation footer + Snapshot menu を集約) -->
            <v-list-item :disabled="!segStore.finalMask" data-demo="save-nifti" @click="onSaveNiftiMask">
              <template v-slot:prepend><v-icon icon="mdi-content-save" size="small" /></template>
              <v-list-item-title>Save NIfTI mask</v-list-item-title>
              <v-list-item-subtitle>.nii + .json sidecar (multi-label mask)</v-list-item-subtitle>
            </v-list-item>
            <v-list-item :disabled="!segStore.hasPet" @click="onExportPdfFromMenu">
              <template v-slot:prepend><v-icon icon="mdi-file-pdf-box" size="small" /></template>
              <v-list-item-title>Export PDF report…</v-list-item-title>
            </v-list-item>
            <v-list-item @click="onExportRois">
              <template v-slot:prepend><v-icon icon="mdi-vector-rectangle" size="small" /></template>
              <v-list-item-title>Export ROIs…</v-list-item-title>
            </v-list-item>

            <v-divider />

            <v-list-item @click="onLoadSnapshot">
              <template v-slot:prepend><v-icon icon="mdi-tray-arrow-up" size="small" /></template>
              <v-list-item-title>Load snapshot…</v-list-item-title>
              <v-list-item-subtitle>Restore a saved .json session (load images first)</v-list-item-subtitle>
            </v-list-item>
            <v-list-item @click="onLoadMaskFromMenu">
              <template v-slot:prepend><v-icon icon="mdi-folder-open" size="small" /></template>
              <v-list-item-title>Load mask (NIfTI)…</v-list-item-title>
            </v-list-item>
            <v-list-item @click="onImportRois">
              <template v-slot:prepend><v-icon icon="mdi-vector-rectangle" size="small" /></template>
              <v-list-item-title>Import ROIs…</v-list-item-title>
            </v-list-item>

            <v-divider />

            <v-list-item :disabled="!segStore.finalMask" @click="onClearEditsFromMenu">
              <template v-slot:prepend><v-icon icon="mdi-eraser" size="small" /></template>
              <v-list-item-title>Clear edits</v-list-item-title>
            </v-list-item>

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
              <v-list-item-subtitle v-else>Keeps the largest connected structure</v-list-item-subtitle>
            </v-list-item>
            <!-- 接触している台/寝台は連結成分では分けられないので、高さで落とす手段を持たせる。
                 (実測: kitty は本体・台座・背板が 1 つの連結成分になる) -->
            <v-list-item v-if="!segStore.ctBodyMask" :disabled="!segStore.ctVolumeRef" @click.stop>
              <template v-slot:prepend><v-icon icon="mdi-arrow-collapse-down" size="small" /></template>
              <v-list-item-title>Also cut bottom</v-list-item-title>
              <v-list-item-subtitle>For objects resting on a stand</v-list-item-subtitle>
              <template v-slot:append>
                <input class="mv-mini-num" type="number" min="0" step="1"
                       :value="segStore.ctBedCutBottomMm"
                       @click.stop
                       @change="(e: Event) => segStore.setCtBedCutBottomMm(Number((e.target as HTMLInputElement).value))" />
                <span class="mv-mini-unit">mm</span>
              </template>
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

            <v-divider />

            <v-list-item @click="startMtvTour">
              <template v-slot:prepend>
                <v-icon icon="mdi-school-outline" size="small" />
              </template>
              <v-list-item-title>Guided tour: measure MTV</v-list-item-title>
              <v-list-item-subtitle>Watch a step-by-step demo on a sample PET/CT</v-list-item-subtitle>
            </v-list-item>

            <v-list-item @click="browserSupportOpen = true">
              <template v-slot:prepend>
                <v-icon icon="mdi-web" size="small" />
              </template>
              <v-list-item-title>Browser support</v-list-item-title>
            </v-list-item>

            <v-list-item @click="llmOpen = !llmOpen">
              <template v-slot:prepend>
                <v-icon icon="mdi-robot-outline" size="small" />
              </template>
              <v-list-item-title>{{ llmOpen ? 'Hide assistant' : 'Assistant (local LLM)…' }}</v-list-item-title>
              <v-list-item-subtitle>Chat with a model running on this machine via Ollama</v-list-item-subtitle>
            </v-list-item>

            <!-- 左サイドバーから移設 (シリーズ一覧が長くなって到達できなくなったため) -->
            <v-list-item @click="advancedOpen = true">
              <template v-slot:prepend>
                <v-icon icon="mdi-flask-outline" size="small" />
              </template>
              <v-list-item-title>Advanced tools…</v-list-item-title>
              <v-list-item-subtitle>Demo phantoms, experiments, series priority rules</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-menu>

        <!-- 左サイドバー開閉。ハンバーガーの「右隣」に置く: 最左はアプリメニュー (慣習) を保ち、
             その次に、制御対象である左ドロワーの真上に来る位置。右端の右サイドバートグルと左右対称。 -->
        <v-btn
          :class="['mv-tool-btn', { 'is-active': drawerLeft }]"
          variant="text"
          size="small"
          @click="drawerLeft = !drawerLeft"
        >
          <v-icon icon="mdi-dock-left" />
          <v-tooltip activator="parent" location="bottom">
            {{ drawerLeft ? 'Hide left sidebar (series list & view settings)' : 'Show left sidebar (series list & view settings)' }}
          </v-tooltip>
        </v-btn>
      </template>

      <div class="mv-brand ml-1">
        meta<span class="mv-brand-accent">vol</span>-web
      </div>

      <!-- Snapshot: ワンクリックでフルセッション (.json) を保存。Load / ROI 系はハンバーガーへ移設。 -->
      <v-btn
        :class="['mv-tool-btn', 'ml-2', { 'is-active': !!snapshotMsg }]"
        variant="text"
        size="small"
        @click="onSaveSnapshot"
      >
        <v-icon :icon="snapshotMsg ? 'mdi-check' : 'mdi-camera-outline'" />
        <v-tooltip activator="parent" location="bottom">
          <template v-if="snapshotMsg">{{ snapshotMsg }}</template>
          <template v-else>Save snapshot (full session: layout + mask + labels + ROIs)</template>
        </v-tooltip>
      </v-btn>
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

        <!-- Window preset: 左サイドバーから移設。読影中に最も触るので常時見える位置に置く。
             中身は選択中 box の modality (CT / MR / PT) に応じて出し分けるので 1 ボタンで済む。 -->
        <WindowPresetMenu
          :modality="selectedBoxModality"
          @preset-selected="(id: string) => dicomViewRef?.presetSelected?.(id)"
          @redraw="dicomViewRef?.redraw?.()"
        />
      </div>

      <v-divider vertical class="mx-3" />

      <!-- Undo / Redo: マスク編集 (Apply/Clear/polygon/brush/assign) + 矩形 ROI を時系列で巻き戻す/やり直す -->
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
      <v-btn
        class="mv-tool-btn"
        variant="text"
        size="small"
        :disabled="!canRedo"
        @click="onRedo"
      >
        <v-icon icon="mdi-redo" />
        <v-tooltip activator="parent" location="bottom">Redo (Ctrl+Shift+Z)</v-tooltip>
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

      <!-- PET Standard は Layouts メニュー内「PET/CT/Fusion」に移設 (単独ボタン廃止)。 -->

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
            <v-btn variant="text" @click="petPickerOpen = false">
              Cancel
              <v-tooltip activator="parent" location="top">Close without building the layout</v-tooltip>
            </v-btn>
            <v-btn color="primary" variant="flat" @click="confirmPetPicker">
              Build
              <v-tooltip activator="parent" location="top">Build the PET/CT/Fusion layout from the selected PT and CT</v-tooltip>
            </v-btn>
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
            data-demo="pet-standard"
          >
            <v-icon icon="mdi-view-dashboard-outline" />
            <span class="mv-tool-label">Layouts</span>
            <v-tooltip activator="parent" location="bottom">Layout presets</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" class="mv-layouts-menu">
          <v-list-item :disabled="!petCtReady" @click="onClickPetStandard">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-grid" size="small" />
            </template>
            <v-list-item-title>MTV measurement</v-list-item-title>
            <v-list-item-subtitle>{{ petStandardTooltip }}</v-list-item-subtitle>
          </v-list-item>
          <v-divider />
          <!-- Triplanar PT (1×3) は廃止: PET Triplanar + MIP と内容が重複していたため。 -->
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
            <v-list-item-title>PET Triplanar + MIP (2×2)</v-list-item-title>
            <v-list-item-subtitle>PT axial / coronal / sagittal + MIP</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('compare2up')">
            <template v-slot:prepend>
              <v-icon icon="mdi-compare" size="small" />
            </template>
            <v-list-item-title>Compare 2-up (1×2)</v-list-item-title>
            <v-list-item-subtitle>Two series side-by-side, same plane</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="runLayout('petCtMipRight')">
            <template v-slot:prepend>
              <v-icon icon="mdi-view-grid-plus" size="small" />
            </template>
            <v-list-item-title>PET/CT + MIP (3×2)</v-list-item-title>
            <v-list-item-subtitle>CT / PET / Fusion / Fusion coronal + full-height PET MIP</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>

      <!-- Tracer ボタン廃止 (不要)。Fusion ボタンも廃止 → drag&drop fusion に一本化。 -->

      <v-divider vertical class="mx-2" />

      <!-- 表示系トグルは 1 つの View メニューに集約する。
           **app-bar が溢れると右端のボタン (右サイドバー開閉など) が画面外に押し出され、
           操作不能になる**ため (実測: 1280px 幅で 211px 溢れ、tiles/renderer/Close all/
           右サイドバー開閉の 4 つが viewport 外)。頻度の低いものを畳んで幅を確保する。 -->
      <v-menu>
        <template v-slot:activator="{ props: act }">
          <v-btn class="mv-tool-btn" variant="text" size="small" v-bind="act">
            <v-icon icon="mdi-tune-variant" />
            <v-tooltip activator="parent" location="bottom">View options (sync, voxel inspector, overlays, fit)</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item @click="syncImageBox = !syncImageBox">
            <template v-slot:prepend>
              <v-icon :icon="syncImageBox ? 'mdi-link-variant' : 'mdi-link-variant-off'" size="small"
                      :color="syncImageBox ? 'primary' : undefined" />
            </template>
            <v-list-item-title>{{ syncImageBox ? 'Sync ON' : 'Sync OFF' }}</v-list-item-title>
            <v-list-item-subtitle>Page/zoom all boxes together</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="voxelInspector = !voxelInspector">
            <template v-slot:prepend>
              <v-icon icon="mdi-eyedropper" size="small" :color="voxelInspector ? 'primary' : undefined" />
            </template>
            <v-list-item-title>{{ voxelInspector ? 'Voxel inspector ON' : 'Voxel inspector OFF' }}</v-list-item-title>
            <v-list-item-subtitle>Hover to read voxel values (Ctrl+Shift+D)</v-list-item-subtitle>
          </v-list-item>
          <v-list-item @click="showOverlayInfo = !showOverlayInfo">
            <template v-slot:prepend>
              <v-icon icon="mdi-information-outline" size="small" :color="showOverlayInfo ? 'primary' : undefined" />
            </template>
            <v-list-item-title>{{ showOverlayInfo ? 'Hide patient/exam info' : 'Show patient/exam info' }}</v-list-item-title>
          </v-list-item>
          <v-divider />
          <v-list-item @click="fitToWindow">
            <template v-slot:prepend><v-icon icon="mdi-fit-to-screen-outline" size="small" /></template>
            <v-list-item-title>Fit to window</v-list-item-title>
          </v-list-item>
          <v-list-item @click="noGapMode = !noGapMode">
            <template v-slot:prepend>
              <v-icon icon="mdi-arrow-expand-all" size="small" :color="noGapMode ? 'primary' : undefined" />
            </template>
            <v-list-item-title>{{ noGapMode ? 'Edge-to-edge tiles ON' : 'Edge-to-edge tiles OFF' }}</v-list-item-title>
            <v-list-item-subtitle>Fill the image area without gaps</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-menu>
      <v-divider vertical class="mx-1" />

      <v-menu>
        <template v-slot:activator="{ props }">
          <v-btn class="mv-tool-btn mv-tool-btn--wide" variant="text" size="small" v-bind="props">
            <v-icon icon="mdi-view-grid-outline" />
            <span class="mv-tool-label">{{ tileN }}</span>
            <v-tooltip activator="parent" location="bottom">
              Tile count — number of image boxes on screen (currently {{ tileN }})
            </v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" @click:select="clickItem">
          <v-list-item v-for="n in [1,2,3,4,6,8,9,10,12]" :key="n" :value="String(n)">
            <v-list-item-title>{{ n }} {{ n === 1 ? 'box' : 'boxes' }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-divider vertical class="mx-1" />

      <!-- Renderer (CPU/GPU) トグル + perf 集計表示 -->
      <v-menu :close-on-content-click="false">
        <template v-slot:activator="{ props: act }">
          <v-btn class="mv-tool-btn" variant="text" size="small" v-bind="act">
            <v-icon :icon="rendererModeIcon" />
            <v-tooltip activator="parent" location="bottom">{{ rendererModeTooltip }}</v-tooltip>
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
        <v-tooltip activator="parent" location="bottom">
          Close all images and clear the session (asks for confirmation)
        </v-tooltip>
      </v-btn>

    </v-app-bar>

    <!-- 右サイドバー開閉ボタンは **app-bar の flex 内に置かない**。
         app-bar は項目が多く、ウィンドウ幅次第で内容が溢れる。flex 内にあると溢れた分が
         画面外に押し出され、実測で 1280px 幅では 211px 溢れ・1100px 幅では 4 個 (tiles /
         renderer / Close all / この開閉ボタン) が viewport 外になり、
         **サイドバーを開く手段が消える** (「right side bar が出ない」の原因)。
         そこで position:fixed で右上に固定し、幅に依存せず必ず押せるようにする。
         見た目の位置は従来どおり app-bar の右端。 -->
    <v-btn
      :class="['mv-tool-btn', 'mv-inspector-toggle', { 'is-active': drawerRight }]"
      variant="text"
      size="small"
      data-demo="inspector"
      @click="drawerRight = !drawerRight"
    >
      <v-icon icon="mdi-dock-right" />
      <v-tooltip activator="parent" location="bottom">
        {{ drawerRight ? 'Hide right sidebar (Segmentation panel)' : 'Show right sidebar (Segmentation panel)' }}
      </v-tooltip>
    </v-btn>

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
              Sphere VOI
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
          <v-btn variant="text" @click="closeAllDialogOpen = false">
            Cancel
            <v-tooltip activator="parent" location="top">Keep the current session</v-tooltip>
          </v-btn>
          <v-btn color="error" variant="flat" @click="confirmCloseAll">
            Close all
            <v-tooltip activator="parent" location="top">Discard all images and segmentation work — cannot be undone</v-tooltip>
          </v-btn>
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
          <v-btn @click="browserSupportOpen = false">
          Close
          <v-tooltip activator="parent" location="top">Close this dialog</v-tooltip>
        </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Advanced tools (左サイドバーから移設)。実処理は DicomView 側に残っている。 -->
    <AdvancedToolsDialog
      v-model="advancedOpen"
      @phantomNema="dicomViewRef?.phantomNema?.()"
      @phantomWholeBody="dicomViewRef?.phantomWholeBody?.()"
      @phantomWholeBodyPetCt="dicomViewRef?.phantomWholeBodyPetCt?.()"
      @scrambleSlices="dicomViewRef?.scrambleSlices?.()"
      @recoverSlices="dicomViewRef?.recoverSlices?.()"
    />

    <!-- ローカル LLM (Ollama) チャット。開放しているのは **読み取り専用** の 2 tool のみ。 -->
    <LlmChatPanel v-model="llmOpen" :tool-context="llmToolContext" />

    <DemoOverlay :demo="demo" />
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import DicomView from "./components/DicomView.vue";
import { getWH, getTileN } from "./components/UrlParser.ts";
import { useSegmentationStore } from "./stores/segmentation";
import DicomTagDialog from "./components/DicomTagDialog.vue";
import WindowPresetMenu from "./components/WindowPresetMenu.vue";
import AdvancedToolsDialog from "./components/AdvancedToolsDialog.vue";
import LlmChatPanel from "./components/llm/LlmChatPanel.vue";
import DemoOverlay from "./components/demo/DemoOverlay.vue";
import { useDemoPlayer } from "./components/demo/useDemoPlayer";
import { buildDemoApi } from "./components/demo/demoApi";
import { createMtvScenario } from "./components/demo/scenarios/mtv";

// dcmjs-codecs WASM (JPEG Lossless 用) はもう起動時にプリウォームしない。
// ~4MB の WASM を毎回起動時に fetch するのは非圧縮ケースには無駄。圧縮フレームを
// 実際に含むケースを読み込んだとき decompressAllJpegLossless が
// ensureWasmCodecsReady() を await するので、その時点で初回ロードされる。

const segStore = useSegmentationStore();

// Renderer mode (Auto / Force CPU / Force GPU) + perf 集計表示
import { usePerfStore, type RendererMode, type DrawKind } from '@/stores/perf';
const perfStore = usePerfStore();
const setRendererMode = (m: RendererMode) => {
  perfStore.setMode(m);
  redraw();   // 全 box 再描画 (新 mode で)
};
// A / G / C の 1 文字アイコンで現在のモードを示す (Auto / GPU / CPU)。
// 以前は "Auto" 等のラベル文字を併記していたが意味が伝わらないため文字は廃止し、
// 意味は hover tooltip (rendererModeTooltip) に寄せた。
const rendererModeIcon = computed(() => {
  if (perfStore.rendererMode === 'cpu') return 'mdi-alpha-c-box-outline';
  if (perfStore.rendererMode === 'gpu') return 'mdi-alpha-g-box-outline';
  return 'mdi-alpha-a-box-outline';
});

const rendererModeTooltip = computed(() => {
  if (perfStore.rendererMode === 'cpu') return 'Renderer: C = forced CPU — click for renderer modes and perf stats';
  if (perfStore.rendererMode === 'gpu') return 'Renderer: G = forced GPU (no CPU fallback) — click for renderer modes and perf stats';
  return 'Renderer: A = Auto (GPU when available, else CPU) — click for renderer modes and perf stats';
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

// 起動時は左サイドバーも隠す (右 Inspector と同じ方針)。空状態では series も設定も無く、
// 「Drop files here」だけを見せたいため。ロード完了時に DicomView が true にする。
// app-bar の高さ (px)。**app.scss の --mv-appbar-h と必ず一致させること。**
// v-app-bar は数値 prop を要求するので CSS 変数を直接渡せず、ここだけ二重管理になる。
const APPBAR_H = 36;

const drawerLeft = ref(false);
// 右 Inspector (Segmentation) も起動時は隠す。空状態では測る対象が無いので用が無い。
// 開くのは MTV measurement を選んだとき (runPetStandardWith) と、ユーザのトグル操作だけ。
// **true に戻さないこと** — 起動直後にパネルが出てしまう。
const drawerRight = ref(false);
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
  { value: 'sphereROI',  icon: 'mdi-circle-outline',        label: 'Sphere VOI' },
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
  // 空状態に戻るので Segmentation パネルは畳む
  // (自動追従の watch は持たない方針なので、ここで明示的に閉じる)
  drawerRight.value = false;
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

// ===== ガイドツアー (デモ) =====
const demo = useDemoPlayer();
const startMtvTour = () => {
  const api = buildDemoApi({
    dicomView: () => dicomViewRef.value,
    store: segStore,
    setInspectorOpen: (open: boolean) => { drawerRight.value = open; },
  });
  demo.start(createMtvScenario(api));
};
const onDemoKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && demo.active.value) { demo.stop(); }
};
onMounted(() => {
  window.addEventListener('keydown', onDemoKeydown);
  // ?tour=mtv で起動時に自動開始 (アプリ mount 後、少し待って dicomViewRef 準備を待つ)。
  const tour = new URLSearchParams(window.location.search).get('tour');
  if (tour === 'mtv') setTimeout(startMtvTour, 600);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onDemoKeydown));

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
  // MTV measurement は「測る」ための入口なので Segmentation パネルを開く。
  // (drag&drop の軽い fusion では開かない ← 自動表示は MTV 経路だけ)
  //
  // **drawerRight を直接立てる。** 以前は dicomViewRef 経由で
  // `dicomViewRef.value?.openInspectorForMtv?.()` を呼んでいたが、
  //   - ref が null (mount 前 / HMR で壊れた等) だと `?.` で **無言でスキップ**される
  //   - setup が throw すると後続の open に到達しない
  // という 2 つの失敗経路があり「パネルが出ない」報告になっていた。
  // drawerRight は App 自身の ref なので、ここで立てれば必ず反映される。
  drawerRight.value = true;
  setTimeout(async () => {
    try {
      await dicomViewRef.value?.setupPetStandardView?.(overridePt, overrideCt);
    } catch (err) {
      console.warn('[MTV] setupPetStandardView failed', err);
    } finally {
      drawerRight.value = true;   // レイアウト構築後にも念押し
    }
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
  return `2×2 CT / PET / Fusion / MIP — PT: ${pt}  /  CT: ${ct}`;
});

const runLayout =(kind: 'triplanarFused' | 'ptOnly4up' | 'compare2up' | 'petCtMipRight') => {
  const r = dicomViewRef.value;
  if (!r) return;
  if (kind === 'triplanarFused') r.setupTriplanarFused?.();
  if (kind === 'ptOnly4up')     r.setupPtOnly4up?.();
  if (kind === 'compare2up')    r.setupCompare2up?.();
  if (kind === 'petCtMipRight') r.setupPetCtMipRight?.();
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
// Advanced tools (phantom / experiments / series priority) — 左サイドバーから移設
const advancedOpen = ref(false);
// ローカル LLM チャット (Ollama)。右下フローティングなのでレイアウトは押しのけない。
const llmOpen = ref(false);
// LLM に渡す読み取り専用の窓口。実体は DicomView 側 (状態を持っているのはあちら)。
// 呼び出しのたびに dicomViewRef を引き直すので、遅延マウントでも取りこぼさない。
const llmToolContext = {
  listSeries:   () => dicomViewRef.value?.llmListSeries?.() ?? { error: 'viewer not ready' },
  describeView: () => dicomViewRef.value?.llmDescribeView?.() ?? { error: 'viewer not ready' },
};
// app-bar の Window preset ボタンが出し分けに使う。選択 box が変わるたびに追従させたいので
// dicomViewRef 経由の computed にする (exposed な computed はそのまま値として読める)。
const selectedBoxModality = computed<string>(() => dicomViewRef.value?.selectedBoxModality ?? '');
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

// Segmentation の save/load をハンバーガーから (旧フッターから移設)。
// Save NIfTI / Clear edits は store action 直呼び、Load mask / Export PDF は
// DicomView 経由で SegmentationPanel のハンドラをパススルー。
const onSaveNiftiMask = () => { segStore.saveMaskAsNifti(); };
const onClearEditsFromMenu = () => { segStore.clearManualEdits(); dicomViewRef.value?.redraw?.(); };
const onLoadMaskFromMenu = () => { dicomViewRef.value?.segLoadMask?.(); };
const onExportPdfFromMenu = () => { dicomViewRef.value?.segExportPdf?.(); };
const onExportRois = () => {
  try {
    dicomViewRef.value?.exportRoisAsJson?.();
  } catch (err: any) {
    setSnapshotMsg('ROI export failed: ' + (err?.message ?? err));
  }
};

// 統合 Undo / Redo (Apply/Clear/polygon/brush/assign + 矩形 ROI)。Ctrl+Z / Ctrl+Shift+Z と同じ。
const canUndo = computed(() => segStore.canUndo);
const canRedo = computed(() => segStore.canRedo);
const onUndo = () => {
  dicomViewRef.value?.undoLastAction?.();
};
const onRedo = () => {
  dicomViewRef.value?.redoLastAction?.();
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
  const [{ registerMrToPt, estimateInitialParams }, { applyRigidToVolume }] = await Promise.all([
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
    // MI + Nelder-Mead は局所探索なので、FOV がまるごと離れている症例 (別々に撮った脳 MR と
    // 脳 PET など) では初期値ゼロから収束しない。
    // 重心合わせ → 粗グリッド探索 で「正しい山」に乗せてから最適化に渡す
    // (重心だけだと撮影範囲の違いでバイアスが乗り、実データで z が 70〜80mm ずれた)。
    const init = estimateInitialParams(pt, mr);
    const res = registerMrToPt(pt, mr, init, (info) => {
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
/* Layouts メニューは固定幅。長い項目名 (PET/CT/Fusion 等の可変長) は省略記号で切る。 */
.mv-layouts-menu {
  width: 300px;
  max-width: 300px;
}
.mv-layouts-menu :deep(.v-list-item-title),
.mv-layouts-menu :deep(.v-list-item-subtitle) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
.mv-mini-num {
  width: 52px;
  background: var(--mv-surface-2, #222b36);
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 3px;
  color: var(--mv-text, #e8eef2);
  font-size: 11px;
  padding: 2px 4px;
  text-align: right;
}
.mv-mini-unit {
  font-size: 10px;
  color: var(--mv-text-muted, #5a6877);
  margin-left: 4px;
}
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
