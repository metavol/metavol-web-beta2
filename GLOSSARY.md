# Glossary — metavol-web 用語集

開発者と Claude / 自分自身との間で「あの部分」「あの機能」が指すものを共通化するための辞書です。
画面のパーツ、ImageBox の種類、ツール、機能名、ドメイン概念をまとめています。

---

## 1. レイアウト構造

```
┌──────────────────────────────────────────────────────┐
│ App-bar (48px, ハンバーガー / ツール群 / メニュー群) │
├──────────┬──────────────────────────────┬────────────┤
│          │                              │            │
│ Sidebar  │   Image area                 │ Inspector  │
│ (左,     │   ├ Tile grid                │ (右,       │
│  280px)  │   │  └ ImageBox * N          │  320px)    │
│          │   └ Empty state              │            │
│          │     (tileN === 0 のとき)      │ Segmen-    │
│          │                              │ tation     │
└──────────┴──────────────────────────────┴────────────┘
```

| 名称 | 別名 / コード上の名前 | 説明 |
|---|---|---|
| **App-bar** | top toolbar | 48px の上部ツールバー。タイトル / ツールアイコン / メニュー / 表示制御 |
| **Sidebar** | left drawer / `drawerLeft` | 左ナビゲーション。Series カード一覧、Window preset、Slice 操作 |
| **Inspector** | right drawer / `drawerRight` | 右ナビゲーション。Segmentation パネル。**初期は非表示** |
| **Image area** | `.mv-imagearea` | 画像表示領域全体 |
| **Tile grid** | `.mv-tile-grid` | ImageBox を並べる CSS Grid。`tileN` で個数 |
| **Empty state (image area)** | `.mv-imagearea-empty` | tileN=0 のときに「No image / Drop DICOM or NIfTI files」を表示 |
| **Hamburger menu** | 左上 `mdi-menu` ボタン | Show/Hide sidebar / DICOM Tags / Browser support |

---

## 2. ImageBox（画像ボックス）の種類

各タイルが「ImageBox」。中身は box の種類 (`boxKind`) で切り替わる。

| 名称 (UI) | 型名 (TS) | `boxKind` | 内容 | DICOM tag 表示 |
|---|---|---|---|---|
| **DicomSliceBox** | `DicomSliceImageBoxInfo` | `'dicom'` | 生 DICOM 1 ファイルを 1 枚表示 (再構成なし) | ◯ 対応 |
| **VolumeBox** | `VolumeImageBoxInfo` | `'volume'` | 3D 再構成された MPR スライス (axial / coronal / sagittal) | × 非対応 |
| **FusionBox** | `FusedVolumeImageBoxInfo` | `'fusion'` | CT/MR を base、PT を overlay にした重畳表示 | × 非対応 |
| **MIP / sMIP / VR** | `VolumeImageBoxInfo` (`isMip` / `isVr`) | `'mip'` | Maximum Intensity Projection / 表面 MIP / Volume Rendering | × 非対応 |

### ImageBox 内部のパーツ

| 名称 | コード上 | 説明 |
|---|---|---|
| **Titlebar** | `.mv-titlebar` | 22px の上部バー。modality chip / description / アクションボタン群 |
| **Modality chip** | `.mv-mod-chip` | PT / CT / MR / FUSED / MIP のラベル。**Volume / Fusion box ではドラッグ可能 (Fusion 起点)** |
| **Description** | `.mv-desc` | DICOM SeriesDescription / "Fusion" 等の説明 |
| **Plane menu** | `mdi-axis-arrow` | Axial / Coronal / Sagittal / MIP / sMIP / VR 切替 |
| **CLUT menu** | `mdi-palette` | Mono / Hot / Rainbow / Reverse |
| **Reset button** | `mdi-restart` | WC/WW + view を初期化 |
| **Sync toggle** | `mdi-link-variant` | この box の同期参加 / 離脱 |
| **Maximize** | `mdi-arrow-expand` | 1 box にズーム / 元に戻す |
| **More menu** | `mdi-dots-horizontal` | Save PNG / Toggle mask / Make MPR |
| **Close** | `mdi-close` | この box を空に戻す |
| **Canvas** | `.mv-canvas` | 描画領域 |
| **Empty state (box)** | `.mv-empty-state` | "No image" 等のオーバーレイ |
| **Color scale legend** | `.mv-clut-legend` | 右下の CLUT バー + min/max ラベル (HU / SUV) |
| **Crosshair** | `.mv-crosshair` | segStore.crosshairWorld の投影点 (緑系破線) |
| **Cross-reference lines** | `.mv-cross-ref` | 他 Volume/Fusion box の slice plane を投影した黄色破線 |
| **Corner info overlay** | `.mv-corner-overlay` (TL/TR/BL/BR) | 4 隅に Patient name / Study date / Modality / Image #/Total / Zoom 等 |

---

## 3. Sidebar の構成要素

| 名称 | コード上 | 説明 |
|---|---|---|
| **Series card** | `.series-card` | シリーズ 1 つを表すカード。サムネ + matrix size + voxel size |
| **Thumbnail** | `.thumb` | サムネ画像。**ホイールで preview slice scrub** |
| **Modality chip** (card) | `.modality` | PT/CT/MR/?? のラベル |
| **ATTN / NAC chip** | `.attn-chip` | PT の Attenuation Corrected / Non-AC |
| **Active star** | `.star-btn` | 同 modality が複数あるとき active を ★ で指定 |
| **Set as: PT / CT / MR** | `.set-mod` | hasVolume + 不明 modality のときだけ表示。NIfTI 用 |
| **Window preset** | `.mv-preset-toggle` | CT 用 (Lung/Med/Abd/Bone/Brain/Fat) と PT 用 (SUV-0-3 等) |
| **Other (collapsed)** | `.other-section` | derived / RGB / MIP series を畳む |

---

## 4. ツール (App-bar の左ボタン機能)

App-bar のツール選択でマウス左ドラッグの挙動が切り替わる (`leftButtonFunction`)。

| 名称 | アイコン | 値 | 動作 |
|---|---|---|---|
| **Window/Level** | `mdi-contrast-circle` | `window` | ドラッグで WC/WW |
| **Pan** | `mdi-hand-back-right-outline` | `pan` | ドラッグで中心移動 |
| **Zoom** | `mdi-magnify-plus-outline` | `zoom` | ドラッグでズーム |
| **Page** | `mdi-arrow-up-down` | `page` | ドラッグでスライス送り |
| **Sphere ROI** | `mdi-circle-outline` | `sphereROI` | クリックで球中心、球内ホイールで半径 |
| **Polygon ROI** | `mdi-pentagon-outline` | `polygonROI` | 左 = 頂点 / 右 or ダブルクリック = 確定 / Esc = 取消 / Ctrl+Z = undo |
| **Assign Label** | `mdi-tag-outline` | `assignLabel` | クリックでその voxel の 26 連結成分に現在ラベルを付与 |

### ツール非依存の常時操作

| 操作 | 動作 |
|---|---|
| **Ctrl + ホイール** | 即時ズーム (DicomSlice / Volume / Fusion 全部) |
| **中ボタンドラッグ** | 即時 Pan |
| **ホイール (通常)** | スライス送り |
| **Drag DICOM/NIfTI files** | 画像エリア全体に drop でロード |
| **Drag Series card → Box** | その series を box にロード |
| **Drag Modality chip → 別 Box** | **Fusion 化** (PT を overlay、CT/MR を base に自動振り分け) |

---

## 5. レイアウトプリセット

App-bar から呼び出せる 1-click レイアウト。

| 名称 | 構成 | コード上 |
|---|---|---|
| **PET Standard** | 2x2 — CT axial / PET axial / Fusion axial / PET MIP | `setupPetStandardView` |
| **Triplanar PT** | 1x3 — PT axial / coronal / sagittal | `setupTriplanarPt` |
| **Triplanar Fused** | 1x3 — Fusion axial / coronal / sagittal | `setupTriplanarFused` |
| **PT-only 4-up** | 2x2 — PT axi / cor / sag / MIP | `setupPtOnly4up` |
| **Compare 2-up** | 1x2 — 同一 plane の 2 シリーズ並列 | `setupCompare2up` |
| **Tile count menu** | `tileN` を 1〜12 の範囲で手動指定 |

---

## 6. 表示モード / グローバルトグル

| 名称 | コード上 ref | アイコン | 動作 |
|---|---|---|---|
| **Sync** | `syncImageBox` | `mdi-link-variant` | パン / スライス操作を全 box で同期 |
| **Voxel inspector** | `voxelInspector` (旧 debugMode) | `mdi-eyedropper` | hover で voxel 値テーブル / Shift+Click で voxel 編集 (Ctrl+Shift+D で toggle) |
| **Show overlay info** | `showOverlayInfo` | `mdi-information-outline` | 4 隅 patient/exam info の ON/OFF |
| **No-gap mode (全体化)** | `noGapMode` | `mdi-arrow-expand-all` | tile 間 gap=0 で画像エリア最大化 |
| **Fit to window** | (one-shot) | `mdi-fit-to-screen-outline` | 現在の tile/drawer 配置で画像を最大化 |
| **Sidebar toggle** | `drawerLeft` | hamburger menu 内 | 左 sidebar |
| **Inspector toggle** | `drawerRight` | `mdi-format-vertical-align-top` (回転) | 右 inspector (segmentation) |
| **Close all** | (action) | `mdi-trash-can-outline` | 全 box を default に戻す |

---

## 7. セグメンテーション機能 (Inspector パネル)

| 機能 | 説明 | コード上 |
|---|---|---|
| **SUV threshold** | combobox: 2.5 / 3.0 / 3.5 / 4.0 / Manual | `segStore.suvThreshold` |
| **Apply** | 閾値で PET をマスク化 (`thresholdMask`) | |
| **Sphere ROI stats** | 球内の SUVmax / mean / std / voxel 数 | `sphereStatsInPet` |
| **Polygon ROI** | スライス単位 add/erase。`manualEdits` レイヤに記録 | `fillPolygonOnSlice` |
| **Find islands** | 26 連結成分検出。`componentMap` を構築 | `connectedComponents26` |
| **Label CRUD** | 任意のラベル ID と色を管理 | `segStore.labels` |
| **Assign Label** | クリックした voxel の連結成分に現在ラベル付与 | `assignLabelAtVoxel` |
| **Save NIfTI** | Uint16 mask + JSON sidecar (label 一覧 / SUV 閾値 / metadata) | `niftiWriter.ts` |

### マスクのレイヤ構造 (内部)

| レイヤ | 用途 |
|---|---|
| `thresholdMask` | 閾値由来。Apply で全再計算 |
| `manualEdits` | Polygon add/erase の差分。`ERASE_MARK = 0xFFFF` を sentinel |
| `finalMask` | `recomputeFinalMask()` で 2 つを合成 (manualEdits 優先) |

---

## 8. ドメイン概念

### Volume の幾何 (重要)

```ts
type Volume = {
  voxel: Float32Array;
  nx, ny, nz: number;
  imagePosition: THREE.Vector3;     // mm 原点 = DICOM ImagePositionPatient
  vectorX, vectorY, vectorZ: THREE.Vector3;  // voxel index 1 進むと world で何 mm 進むか
  metadata?: VolumeMetadata;
};
```

`vectorX.length()` 等で voxel pitch (mm) が直接得られる。

### Modality

| 値 | 意味 |
|---|---|
| `PT` / `PET` | 陽電子断層撮影 |
| `CT` | X 線 CT |
| `MR` | MRI |
| `OTHER` | NIfTI ロード時の sentinel (まだ手動指定されていない) |

### 単位 / 値変換

| 用語 | 説明 |
|---|---|
| **HU** | Hounsfield Unit. CT の標準値。空気 -1000、水 0、骨 +400〜 |
| **Bq/ml** | PET の生濃度値 (Becquerel / mL) |
| **SUV** | Standardized Uptake Value. `Bq/ml × suvFactor`。体重・投与量・崩壊補正済 |
| **SUVmax / SUVmean** | 球 ROI 内の最大 / 平均 SUV |
| **WC / WW** | Window Center / Window Width。表示輝度の中心と幅 |
| **CLUT** | Color Look-Up Table. 0=Mono, 2=Rainbow, 4=Hot |
| **intercept / slope** | DICOM tag (0028,1052/1053). raw → HU 変換係数 |
| **suvFactor** | `dicom2volume.ts` で算出して `volume.metadata.suvFactor` に格納 |

### 平面 (plane)

| 値 | 意味 |
|---|---|
| `axi` | Axial (横断面) |
| `cor` | Coronal (冠状断面) |
| `sag` | Sagittal (矢状断面) |
| `mip` | Maximum Intensity Projection |
| `smip` | 表面 MIP |
| `vr` | Volume Rendering |

---

## 9. ファイル形式

| 形式 | 拡張子 | サポート |
|---|---|---|
| **DICOM** | `.dcm` (拡張子なしも) | 入力 ◯ (一部 transfer syntax は要 JPEG Lossless 解凍) |
| **NIfTI** | `.nii` | 入力 ◯ |
| **NIfTI gzip** | `.nii.gz` | 入力 ◯ (`nifti.decompress()` で自動解凍) |
| **NIfTI mask 出力** | `.nii` + `.json` sidecar | Uint16 多ラベル + label 一覧 + SUV 閾値 + PET metadata |

---

## 10. URL パラメータ

| パラメータ | 効果 |
|---|---|
| `?n=4` | 起動時 tileN を 4 に (省略時は 0 = box ゼロ) |
| `?w=500&h=500` | 起動時 imageBoxW/H |
| `?debug=1` | 起動時に Voxel inspector ON |

---

## 11. キーバインド

| キー | 動作 |
|---|---|
| **Ctrl + Shift + D** | Voxel inspector toggle |
| **Ctrl + Z** | 直前 polygon 編集の undo |
| **Esc** | 進行中 polygon キャンセル |
| **右クリック / ダブルクリック** | Polygon 確定 |
| **Ctrl + Shift + R** | ハードリロード (HMR で挙動が古いとき) |

---

## 12. 内部用語 (コードで頻出)

| 用語 | 意味 |
|---|---|
| **boxStateVersion** | Vector3 in-place mutation でも reactive を発火させるためのカウンタ。`show()` / `showImage()` 末尾で bump |
| **autoFitMode** | 画面サイズ変化や drawer 開閉に追従して `imageBoxW/H` を自動再計算 |
| **componentMap** | 26 連結 CC 結果。`finalMask` を成分 ID にマップした Uint32Array |
| **componentMapValid** | mask が変更されたときに `false` 化される。Assign Label 前に再計算が必要 |
| **bagOfFiles** | doSort 前のファイル一時バッファ |
| **seriesList** | 同一 series UID で grouping した DICOM / NIfTI シリーズの配列 |
| **seriesSummaries** | seriesList を rebuild して UI 用に整形した reactive 配列 |
| **imb** | 各 tile の ImageBox component ref 配列 (`imb.value[i].drawNiftiSlice(...)` で描画) |
| **imageBoxInfos** | 各 tile の info object (`DicomSliceImageBoxInfo` / `VolumeImageBoxInfo` / `FusedVolumeImageBoxInfo`) |
