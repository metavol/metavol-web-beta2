# CLAUDE.md

このファイルは Claude Code（および将来の自分自身）への引き継ぎノートです。
Vue 3 + Vuetify 3 + Vite + TypeScript ベースの DICOM viewer `metavol-web` の開発を進めるための要点をまとめます。

---

## UI 言語ポリシー（厳守）

**ユーザに見える文字列はすべて英語で書くこと。** 日本語 UI テキストは禁止。

対象（必ず英語）:
- `<template>` 内の表示テキスト、`v-tooltip` / `v-btn` / `v-text-field` の `label` / `placeholder` などの属性
- `prompt()` / `alert()` / `confirm()` などダイアログ引数
- canvas に描く文字（`ctx.fillText` など）
- エラーメッセージ、空状態のヒント、トースト等すべての UI 文字列

非対象（日本語可）:
- 開発者向けの `//`, `/* */`, `<!-- -->` コメント
- このファイル (CLAUDE.md)、README、コミットメッセージ等の開発者ドキュメント

新規に UI テキストを足すときは必ず英語で書く。既存箇所に日本語を見つけたら必ず英訳して直す。
レビュー時は `<template>` および `prompt|alert|confirm|fillText` を grep して日本語が混入していないか確認する。

---

## 起動

```bash
cd C:\Users\kenji\Desktop\metavol-web\metavol-web
npm install        # 初回のみ
npm run dev
```

`vite.config.mts` で `base: '/metavol-web-beta2/'` を設定しているため URL は
**http://localhost:3000/metavol-web-beta2/**（3000 が使用中なら 3001 等にフォールバック）。
公開版: https://metavol.github.io/metavol-web-beta2/

その他:
- `npm run build` — 型チェック (`vue-tsc --noEmit`) + 本番ビルド
- `npm run preview` — `dist/` のプレビュー

---

## ハイレベル構成

```
src/
├── App.vue                   ツールバー（Window/Pan/Zoom/Page/SphereROI/PolygonROI/AssignLabel）
├── main.ts                   Pinia 登録、Vuetify 登録、App マウント
├── plugins/                  vuetify 設定
├── stores/
│   └── segmentation.ts       Pinia: PET/CT 参照、マスク、ラベル、球、polygon、CC、保存
├── types/
│   └── VolumeMetadata.ts     modality/SUV メタ情報の型
├── components/
│   ├── DicomView.vue         イベント中枢（マウス、ホイール、show()/showImage()、各ツール起点）
│   ├── ImageBox.vue          canvas 描画（drawNiftiSlice / drawNiftiSliceFusion / drawNiftiMip / overlay）
│   ├── Sidebar.vue           Window preset / 3D / Color / Phantom / Segmentation 開閉
│   ├── SegmentationPanel.vue 閾値スライダ、ラベル CRUD、球統計、polygon mode、Save NIfTI
│   ├── Volume.ts             Volume 型 + voxelToWorld / worldToVoxel + findVolumeBySeries
│   ├── DicomImageBoxInfo.ts  Box 情報の型（Dicom / Volume / Fused 系）
│   ├── dicom2volume.ts       DICOM → Volume（intercept/slope/SUV因子適用、modality検出、metadata付与）
│   ├── dicom2nifti.ts        NIfTI 出力（既存）
│   ├── Clut.ts               CLUT パレット（gray/rainbow/hot + labelClut カテゴリカル）
│   ├── linalg.ts             3x3 連立方程式 solve
│   └── segmentation/
│       ├── maskOps.ts        sphereStatsInPet / fillPolygonOnSlice / connectedComponents26 等
│       └── niftiWriter.ts    NIfTI-1 単一ファイル (Uint16) 書き出し（348B ヘッダ + 4B magic + voxel）
```

---

## 重要な設計上の前提

### SUV 計算と Vox-BASE 照合 (2026-07)
- SUV factor は `dicom2volume.ts` の `getSuvFactor` で決定。BQML 経路の式:
  `dose_at_ref = TotalDose(0018,1074) × 2^(-Δt/half-life)`, `factor = BW[kg]×1000 / dose_at_ref`,
  `SUV = voxel[Bq/ml] × factor`。**この式自体は Vox-BASE と一致**している。
- 減衰補正の Δt = `acq_dt − inj_dt`:
  - `inj_dt` = `getInjectionDateTime`: **(0018,1078) RadiopharmaceuticalStartDateTime 優先**、無ければ
    (0018,1072) StartTime + acq date。**Vox-BASE は (0018,1072) を使う**ので、両タグが食い違う DICOM では差が出る。
  - `acq_dt` = `findEarliestAcquisitionDateTime`: 全 slice の {(0008,002a) / (0008,0022+0032) /
    (0008,0021+0031 SeriesTime)} の**最小**。Vox-BASE は (0008,0032) AcquisitionTime を「補正時刻」に使う。
- **Vox-BASE 照合の残差 → 整数秒切り捨てで解決 (2026-07)**: Biograph 症例で SUV が Vox-BASE 比 +0.006%
  (喉頭 16.898 vs 16.897、膀胱 195.924 vs 195.913) 系統的に高かった。原因は **AcquisitionTime の小数秒**
  (…56.53s)。Vox-BASE は整数秒 (Δt=3836s) で減衰計算、Metavol は小数秒 (Δt=3836.5s) を使っていた差。
  → `tryBqmlSuvFactor` は **2 通りの factor を計算**する: `factor` (整数秒切り捨て = voxBase, 既定) と
  `factorPrecise` (小数秒)。voxel は voxBase で bake。Δt=3836s で dose@corr=185124699.252 /
  slope=0.000394328797 となり Vox-BASE と **12桁一致**。
- **SUV mode トグル (voxbase / precise)**: SUVbw details パネル内に「Decay time: Vox-BASE / Precise」トグル。
  `store.setSuvMode(mode)` が PET voxel を factor 比で rescale + `evictVolumeTexture` で GPU 再upload +
  sphere/referenceSphere の cached SUV stats も同比で更新 + maskVersion bump (lesion table 再計算)。
  metadata に `suvFactorVoxBase` / `suvFactorPrecise` / `suvMode` を保持。既定は voxBase (一般ユーザ向け)。
  小数秒の差が実在する BQML 症例でのみトグル表示 (両 factor が一致するときは非表示)。
  panel の dose@corr / decayFactor / Δt は現 `suvFactor` から逆算するので mode を反映する。
- 検証手段: 右 Inspector の緑チェック行「SUVbw (DICOM BQML)」を**クリックで展開** → SUV details に
  **Inj/Acq time・Δt・Decay factor・Dose@corr・SUV slope** を表示 (Vox-BASE ダイアログと直接照合可能)。
  SUV 表示は全て小数**3桁**。SUV factor 逆算 `doseAtRefBq = BW×1000/suvFactor` は BQML 経路のみ表示。

### Volume の幾何
- 物理座標（mm）の原点 = `imagePosition` (DICOM ImagePositionPatient)。
- `vectorX/Y/Z` は **「voxel index 1 進むと world で何 mm 進むか」** の3Dベクトル。
  したがって `vectorX.length()` などで voxel pitch (mm) が直接得られる。
- 表示時は `centerInWorld + vecx*(x-W/2) + vecy*(y-H/2)` で screen → world、
  `worldToVoxel` で world → voxel に逆変換して画素サンプリング。

### マスクは PET 格子で保持
- `Uint16Array(PET.nx * PET.ny * PET.nz)`、`segStore.finalMask`。
- マスク overlay は表示時に PET の affine で `worldToVoxel_(_, petIdx)` してサンプリング。
- 多ラベル（label id 1..N）。`labelClut` で色付け。
- 内部に層を分ける:
  - `thresholdMask` : 閾値由来。Apply で全再計算。
  - `manualEdits`   : polygon add / erase の差分。`ERASE_MARK = 0xFFFF` を sentinel として 0 と区別。
  - `finalMask`     : `recomputeFinalMask()` で `manualEdits` 優先で合成。

### PET/CT 自動検出
- DICOM タグ `(0008,0060) Modality` を見て `PT`/`PET` → PET、`CT` → CT。
- DicomView の `doSort()` 末尾で `detectPetCtFromDicom()` 実行。MPR 後は `refreshSegStoreVolumeRefs()` で volume 参照を最新化。

### Pinia Proxy トラップに注意（既知の落とし穴）
- Pinia state に格納されたオブジェクトは Vue が `reactive(Proxy)` でラップする。
- そのため `seriesList[i].volume === segStore.petVolumeRef` は **常に false** になりうる。
- `findPetSeriesIndex()` (DicomView.vue) は次の3段比較で照合:
  1. `voxel` TypedArray の参照同一（`Float32Array` は Proxy ラップされない）
  2. `seriesUID` 文字列一致（metadata 経由）
  3. modality === 'PT' によるフォールバック
- 新たに「store の Volume と外部の Volume が一致するか」を判定するコードを書く場合、必ずこの方針を踏襲すること。

### マスク overlay は Volume レンダ時のみ
- `ImageBox.vue` の `drawNiftiSlice` / `drawNiftiSliceFusion` のみが overlay 引数を受け取り描画する。
- 生 DICOM 表示（`drawImageCvZoom` 系）には overlay を乗せていない。
- セグメンテーション機能を使う前に **MPR or Fusion** に切り替えが必要。

### 描画パイプライン（各 Box）
1. CT base（gray CLUT、Fusion なら 50% 重み）
2. PET color overlay（hot/rainbow CLUT、Fusion なら 50% 重み）
3. mask label color（`finalMask` をサンプル、α=overlayAlpha でブレンド）
4. 球輪郭（スライス面と球の交差円、`ctx.arc()`）
5. 進行中 polygon（`ctx.stroke()` + 頂点ドット + カーソルへのラバーバンド）

**重要: アノテーション (球/rect/polygon) は base 描画の後に重ねること。**
draw メソッドは全て async (GPU パスは offscreen → `ctx.drawImage`)。`showImage` は各 draw の
promise を `drawPromise` に捕まえ、**解決後**に `drawAnnotationOverlays` を呼ぶ。同期的に描くと
GPU 描画に上書きされてアノテーションが消える (描画中 polygon の線が見えない不具合の原因だった)。

---

## ツール（leftButtonFunction）

| 値 | 動作 |
|---|---|
| `window` | ドラッグで WC/WW |
| `pan` | ドラッグで中心移動 |
| `zoom` | ドラッグでズーム（`vecx`/`vecy` 倍率） |
| `page` | ドラッグでスライス送り |
| `sphereROI` | クリックで球中心配置、球内ホイールで半径変更（外なら slice送り） |
| `polygonROI` | 左クリック=頂点 / 右クリック or ダブルクリック=確定 / Esc=取消 / Ctrl+Z=undo |
| `brushROI` | 左ドラッグで円形ブラシ (半径 mm)。add=現ラベル / erase |
| `assignLabel` | クリックでその voxel が属する連結領域に現在ラベルID を付与 (局所 flood fill) |

**編集ツールの共通仕様 (polygon / brush): 既存ラベルの修正専用。**
polygon 内・brush 円内であっても **背景 (finalMask==0) は一切変更しない** (`fillPolygonOnSlice` の
`gate` 引数 / `paintBrushAt` の `fmask[idx]===0` スキップ)。add は既存ラベルの付け替え、erase は既存ラベルの
除去のみ。ゼロから新規領域を塗るのは threshold Apply の役割。
これら 3 ツールは右 Inspector の **Edit tool** トグルからも選択でき、上の Tumor/Physiological
(currentLabelId) を共有する。
**slice index は必ず `Math.round(vc[sliceAxis])`** で決める (overlay サンプリング = `floor(mv+0.5)` と一致させる)。

### ツール非依存の常時操作

| 操作 | 動作 | 実装位置 |
|---|---|---|
| **Ctrl + ホイール** | 即時ズーム（視野中心固定） | `wheel()` 先頭で `e.ctrlKey` 判定、`vecx/vecy.multiplyScalar(1/r)` |
| **中ボタンドラッグ** | 即時 Pan | `mouseMove()` 先頭で `(e.buttons & 4) !== 0` 判定 → `doPan()` |
| ホイール（通常） | スライス送り | 各 Box 個別 or Sync |

`doPan()` は `pan` ツールと共通。Volume / Fusion では `centerInWorld` を更新、DICOM では `centerX/Y` を更新。

Ctrl+wheel ズームは `isAnyVolumeBox(i) = isVolumeImageBoxInfo(i) || isFusedImageBoxInfo(i)` で
Volume 単独 / Fusion 両方をハンドル（`isVolumeImageBoxInfo` は `clut1` を持たないものに限定するため Fusion を除外する点に注意）。

---

## キーバインド

- **Ctrl+Z** : undo / **Ctrl+Shift+Z** or **Ctrl+Y** : redo（下記「編集履歴」参照）
- **Esc** : 進行中 polygon キャンセル
- **右クリック / ダブルクリック** : polygon 確定

## 編集履歴 (undo / redo)

- store (`segmentation.ts`) に **1 本の履歴タイムライン** `history` (適用済み) + `redoStack` (取消済み) を持つ。
- 記録単位: マスク編集 (Apply / Clear / polygon / brush stroke / assign) と 矩形 ROI 追加/削除。
- マスク編集は **thresholdMask + manualEdits の sparse diff** (`MaskDiff`: 変更 voxel の idx と before/after)
  で保存する。finalMask は diff に含めず undo/redo 時に `recomputeFinalMask` で導出。背景が広い PET では
  diff は病変サイズに比例するので省メモリ。
- 使い方: 編集の直前に `beginMaskEdit()` (threshold/manual を snapshot) → 編集 → `commitMaskEdit(label)`
  (diff を計算して history に push、変更無しなら false で無視)。undo/redo は store が復元まで担当し、
  呼び出し側 (DicomView) は `show()` するだけ。
- UI: app-bar の Undo/Redo ボタン、右 Inspector の **History** セクション (タイムラインをクリックで
  任意地点へ `gotoHistory` ジャンプ)。
- 履歴を無効化するのは `clearHistory()` (setPetVolume で別 volume、snapshot 復元、tracer preset 変更、
  manual 全消去 時)。`history`/`redoStack` は .mvs にも auto-save にも永続化しない。

---

## 保存形式

- `saveMaskAsNifti()` で 2 ファイル同時ダウンロード:
  - `{seriesUID}_{YYYYMMDD-HHMMSS}.nii` : Uint16 多ラベルマスク（PET 格子、PET と同一 affine）
  - 同名 `.json` : ラベル一覧、SUV閾値、PET metadata、voxel size、dims
- NIfTI ヘッダは自前実装（348B + 4B magic + raw voxel）。`niftiWriter.ts` を参照。

---

## 右 Inspector (SegmentationPanel) レイアウト — Persona 1 ワークフロー順 (2026-07)

Persona 1 (MTV 測定) の動線に沿って、既定は 4 ステップの一本道に簡略化してある:
- **最上部 Overlay バー**: mask 表示切替 + 不透明度を **1 行** で (step ①〜④ 共通のため最上段固定)。
- **① Segment**: SUV threshold preset + **Apply split-button**。メインは現在ラベルで適用、caret メニューで
  Tumor/Physiological を選んで即適用 (`onApplyAs`)。+ Clear
- **② Refine**: **共通ラベルピッカー** (`labelPickItems` = 全ラベルを v-menu で選択、`currentLabelId` へ) +
  Edit tool (Assign/Polygon/Brush)。polygon/brush の詳細 (Add/Erase, radius) は**そのツール選択中のみ**表示。
  assign/polygon/brush は全てこの共通ラベルへ書き込む。
- **③ Measure**: Lesion table (MTV/TLG/SUVpeak, TMTV cutoff, Deauville)。`finalMask` があるときのみ
- **④ Save**: Save NIfTI / snapshot / PDF
- History のクリック可能タイムラインは Advanced に格納 (undo/redo は app-bar と Ctrl+Z/Ctrl+Shift+Z に常設)。

使用頻度の低い機能は削除せず **Advanced トグル** (`showAdvanced` ref, localStorage 記憶) に格納:
threshold method (PERCIST/Deauville/%max/%liver) + reference sphere、Sphere ROI、Labels 編集の一部、
Find islands、Rectangle ROI。ステップ見出しは `.mv-step-head`。
**新セクションを足すときは「① 主要フローか / Advanced か」を必ず判断し、後者は `v-if="showAdvanced"` で畳む。**

**パネルは 3 段 flex (2026-07 更新)**: `.mv-seg-panel { display:flex; flex-direction:column; height:100% }` で
`.mv-seg-head` (常時表示: PT/SUV 状態 + Overlay mask/opacity バー、`flex:0 0 auto`) /
`.mv-seg-body` (スクロール、`flex:1; overflow-y:auto`) / `.mv-seg-foot` (常時表示: Save NIfTI/.mvs/… メニュー) の
sticky レイアウト。よく使う保存と mask opacity は常に見える。
- **③ は Statistics** に改称。ラベル単位 (Labels 体積表) と病変単位 (Lesions MTV/TLG 表) の**両テーブル + Histogram** を格納。
- **Histogram は病変単位**: Lesion table の行クリックで選択 (`selectedLesion`) → その 26-連結成分の SUV 分布
  (`collectComponentSuv` を SUVmax voxel を seed に flood)。ラベル単位の全 voxel 分布は廃止。
- **Add/Erase は廃止**: polygon/brush/assign は「選択ラベルへの塗り替え (既存ラベル voxel のみ)」専用。
  voxel を消すのは Save メニューの Clear edits。brush radius は Refine の brush 選択時のみ表示 (ボタン近傍)。
- History はデフォルト畳んだ expander (`showHistoryList`)。undo/redo は header に常時。
- Sphere ROI: 最小半径 **5mm** (`DicomView` wheel clamp)。**stats は右サイドバーではなく画像中の ROI 近傍に
  フローティング表示** (`.mv-sphere-float`、voxel inspector と同様)。位置は `sphereScreenInBox`/`sphereFloatPos`
  computed が drawAnnotationOverlays の球輪郭中心と同じ式で算出 (選択 box 優先、boxStateVersion で追従)。
  SUVmax を大きく、SUVmean/radius/voxels + Clear を表示。サイドバーの Sphere ROI(Advanced) は説明のみ。
- Refine の編集ツール hint は常時表示せず **hover の v-tooltip** (`.mv-tool-toggle-wrap` + activator="parent")。
- **単位は ml** (旧 cc)。lesion table MTV/ml・SUVpeak 1ml、Labels 体積 ml、CSV/PDF ヘッダも ml。
- `jumpToWorld` は未初期化 box (centerInWorld なし) を skip する防御を追加 (lesion 行クリック時の crash 防止)。

---

## デバッグ機能（一般ユーザ非露出）

- **有効化**: URL `?debug=1` で起動時 ON、または **Ctrl+Shift+D** トグル
- ON 時は画面右下に赤い `DEBUG` バッジ
- **voxel inspector** (`DebugInspector.vue`): マウスホバーで全シリーズの voxel 値テーブルを表示。ドラッグ中は抑止
- **voxel 編集**: Shift+左クリックで `prompt()` ダイアログ。`Volume.voxel[idx]` を直接書換 → `show()`
- 実装は `composables/useDebugInspector.ts`（`updateDebugHover` / `handleDebugEditClick` / debug ref 群）。`debugMode` は defineModel なので DicomView 側に残り、composable に渡す。`seriesList` は reassign される let なので getter (`getSeriesList`) 経由で渡す

## DicomView.vue の composable 分割（肥大化対策・進行中）

DicomView.vue は god component（6,000 行超）。**挙動を変えずに**行数を減らすため、疎結合な leaf 機能から composable へ純粋なコード移動で切り出している。各切り出し後に `vue-tsc --noEmit` + `vite build` + ブラウザ mount 確認で検証。

- 依存は単一の `ctx` オブジェクトで明示的に渡す（tsc が配線を型検証 → 無言の挙動変化を防ぐ）
- **reassign される `let`（`seriesList` 等）は必ず getter (`() => seriesList`) で渡す**（値を capture するとstale化）
- composable 呼び出しは依存（`screenToWorldAny` / `show` 等）が全て定義済みの位置（`findPetSeriesIndex` の直後）に置く。返す ref/関数は同名で分割代入し、template・イベントハンドラは runtime で参照するので TDZ 問題は起きない
- 切り出し済み: `useDebugInspector.ts`（voxel inspector）、`useSnapshotIo.ts`（View state URL / Snapshot file の save/load。`RectRoiJson` 型はここに定義し DicomView へ import で戻す。`rectRoiToJson`/`importRectRoisFromJson` は rect ROI export と共有のため DicomView に残し ctx で渡す）

## テスト DICOM ロード（File System Access API）

- app-bar の **Test** ボタンで `window.showDirectoryPicker()` を呼びフォルダ選択
- 選択したディレクトリハンドルを `cachedTestDirHandle` にキャッシュ（**メモリのみ、リロードで消える**）
- 同セッション中は再選択不要、ボタン1クリックで再ロード
- Chrome/Edge のみ対応（Firefox/Safari は対応していない）

## レイアウト（app-bar「Layouts」メニュー）

`App.vue` の `runLayout(kind)` が `DicomView` の expose した `setup*` を呼ぶ。既存: `triplanarPt` /
`triplanarFused` / `ptOnly4up` / `compare2up`。**追加 (2026-07): `petCtMipRight`「PET/CT + MIP (3×2)」**。

- `setupPetCtMipRight()` (DicomView.vue)。tileN=3 の 3列×2行グリッドに 5 box を配置:
  - box0 = **CT axial** (r1c1, WC40/WW400)、box1 = **PET axial** (r1c2, CT と同じ mm/px・中心に整列)、
  - box2 = **PET MIP** (右列 c3, coronal 視軸)。**`rowSpan: 2` で 2 行ぶんの背高 box**。
  - box3 = **Fusion axial** (r2c1)、box4 = **Fusion coronal** (r2c2)。CT base + PET rainbow overlay。
- **`rowSpan` は `VolumeImageBoxInfo` の任意フィールド (default 1)**。`DicomImageBoxInfo.ts` に定義。
  描画側は `boxRenderHeight(i)` / `boxCellStyle(i)` (DicomView.vue) が `rowSpan` を見て canvas 高さと
  CSS grid の `grid-row: span N` を決める。**新レイアウトで背高 box を作るときはこの2関数を通すこと。**

## デジタルファントム（`phantom.ts`）

Sidebar の Advanced → Phantom セクションのボタンから生成。`Sidebar.vue` が emit → `App.vue` → `DicomView`。

- `generatePhantomNema()` — NEMA IEC ボディ (QC 用、球体 6 個)。
- `generatePhantomWholeBody()` — 全身 FDG-PET 単独 (脳/心/肝/腎/膀胱 + 転移 8 個)。
- **`generatePhantomWholeBodyPetCt()` (追加 2026-07)** — **CT+PET ペア**の全身ファントム。
  幾何プリミティブ (ellipsoid / cylinder / sphere) のみで作り、**ジオメトリを sample-data `cervicalca`
  に合わせてある** (CT 512×512×345 @0.98×0.98×5.0mm、PET 168×168×849 @4.07×4.07×2.03mm、
  origin も cervicalca 準拠、z↓)。CT と PET は別グリッドだが**同一 world 空間の解剖**を描くので Fusion が合う。
  組織ラベル `Tissue` → `(CT HU, PET SUV)` を `TISSUE_HU` / `TISSUE_SUV` で定義。内部分布は幾何形状のみ
  (網走監獄モデル実験のための「疾患＝幾何パターン」の下地)。`PetCtPhantom = { ct: Volume; pet: Volume }`。

## 実験機能（Scramble / Recover — Sidebar Advanced → Experiments）

`src/components/experiments/sliceScramble.ts`。z スライスをシャッフルし、**スライス間類似度 (SSD) だけで
元順序を復元できるか**を試す研究用機能 (網走監獄モデルの 1 次元版 proof-of-concept)。

- **対象 volume 選択**: `volumeForExperiment()` (DicomView) が「選択中 box の series → PET → series0」の順で
  最初に volume を持つものを返す。特定 series を狙うときは対象 box をクリックで選択してから押す。
- **Scramble Z**: `scrambleZSlices(vol)` が Fisher–Yates で z を並べ替えた新 voxel と `perm` を返す。
  `vol.voxel` を差し替え、**旧 voxel は `evictVolumeTexture(old)` で GPU cache 解放** (cache key = voxel 参照)。
  ground truth `perm` を `scrambleTruth` ref に保持。
- **Recover Z**: `recoverZOrder(vol)` = 全ペア SSD (D×D 平均プーリング特徴, 既定 D=24) → 端点推定
  (最近傍距離が最大のノード) → 最近傍チェイン → **open-path 2-opt** (既定 6 pass) で並べ直す。
- **精度レポート**: 同じ series をスクランブルしていれば `scrambleAccuracy(perm, order)` が
  **隣接一致率**と **|Spearman|** (＋全体反転フラグ) を alert / console に出す。復元後は `scrambleTruth` を無効化。
- 検証済み実測 (実データ cervicalca): CT 隣接99.7%/ρ0.90、PET 隣接99.6%/ρ0.85。合成ファントムは
  区分一定で隣接スライスが同一になり復元困難 (ρ~0.07) ← 連続変化する実データ向けの実験。
- **単位変換や mask 格子への影響はなし** (voxel を並べ替えるだけ)。研究用途で、一般ワークフローには非露出。

## 既知バグ / 注意点

### 0. UI レイアウト（モダン化済み）

- ダーク基調 (#0F1419) + teal アクセント (#00D4AA)
- 3カラム: Sidebar 280px / 画像 / Inspector 320px (`v-navigation-drawer` 左右)
- app-bar 高さ 48px、ツールアイコンは横並び、`.mv-tool-btn` クラスで統一
- Segmentation は **Inspector 側** に常駐（Sidebar からは切り離し済み）
- Sidebar は Series カード一覧 + Slice/Window/Color/View/Advanced セクション
- 画像エリアは CSS Grid + `overflow: auto`（タイル数が多くてもクリップしない）
- グローバル CSS は `src/styles/app.scss` で CSS 変数管理（`--mv-bg` `--mv-surface` `--mv-accent` 等）
- フォント: Inter / JetBrains Mono（unplugin-fonts 経由）

### 1. Polygon ROI が 1 スライス隣に反映される (解決済み 2026-07-12)
- 真因: overlay の mask サンプリングは shader (`sliceShader.ts`) / CPU とも `floor(mv + 0.5)` = **round-to-nearest**。
  一方 fill の slice index を `Math.floor(vc[sliceAxis])` で決めていたため、小数部 ≥0.5 のとき
  「表示スライス = round」と「書き込みスライス = floor」が 1 ずれ、描いた面と別の面に ROI が出ていた。
  (過去に round→floor へ変えた対策は shader が floor だという誤った前提に基づくもので、逆効果だった。)
- 修正: `handlePolygonClick` / `brushMouseDown` の slice index を `Math.round(vc[sliceAxis])` に統一し、
  overlay の round サンプリングと一致させた。今後 slice index を決めるコードは必ず round に揃えること。

### 2. 分離した片方の島だけ assign したら他方にも波及する (解決済み 2026-07-14)
- **真因**: `floodFillAssignLabel` の連結判定が「mask ≠ 0 (非ゼロなら前景)」だった。
  再現: 球全体 Tumor → 中間スライスを polygon で **Physio に変更** (erase ではない) → 上半球に assign
  すると、Physio スライスは非ゼロなので flood が **通過**して下半球まで波及した。
  球体ファントム実験 (41³ grid, r=10) で再現・修正を確認: 修正前 4169 voxel (全体) → 修正後 1926 voxel (上半球のみ)。
- **修正**: flood の連結条件を「**seed voxel と同一ラベル**」に変更。背景 (0) も他ラベルも境界として
  働くので、ユーザが視覚的に区別している「segment」単位で塗り替わる。分離のない単一ラベル領域への
  assign は従来通り全体に及ぶ (回帰確認済み)。
- **注意 (将来の変更時)**: assign の領域単位 = 「同一ラベルの 26-連結成分」。
  `findIslands`/`summarizeLesions` の島 = 「非ゼロの 26-連結成分」で定義が異なる (こちらは病変単位)。
  voxel inspector (Ctrl+Shift+D) で mask 各層 (threshold / manual / final / component) を hover 確認できる。

### 3. `setPetVolume(v)` が呼ばれるたびに mask が破棄される
- `setPetVolume` は `thresholdMask`/`manualEdits`/`finalMask`/`undoStack`/`sphere`/`polygon` を全 null 化する。
- `refreshSegStoreVolumeRefs()` は `===` で違いを検出し volume が「変わった」と判定すると毎回呼ぶ → **MPR を再度押すたびにマスクが消える**。
- 緩和策: `setPetVolume` で「同じ seriesUID なら state を保持」する。あるいは `refreshSegStoreVolumeRefs()` 側で seriesUID 比較する。

### 4. NIfTI のみロード時は modality 不明
- `nifti-reader-js` の affine からは Volume は作れるが modality は不明 → PET/CT 検出が動かない。
- 回避: ユーザに「PET として登録」「CT として登録」ボタンを提供する（未実装）。

### 5. GPU mode で voxel inspector の Shift+Click 編集が画像に反映されない
- 症状: Voxel inspector で Shift+Click → prompt() で値を入力 → `Volume.voxel[idx]` には書き込まれ、inspector 表示も更新されるが、画面の画像は変わらない (色が変化しない)。
- 原因: GPU レンダリングパスは `volumeCache` (`src/components/webgpu/volumeCache.ts`) で voxel TypedArray を WebGPU テクスチャにアップロードしてキャッシュしている。voxel を 1 セルだけ書き換えても、cache key (= TypedArray 参照) が同じなので texture が再アップロードされない。
- 影響範囲: 開発デバッグ用機能 (一般ユーザは使わない)。CPU mode (Force CPU) なら正しく反映される。
- 対応方針: 当面 known issue として放置。修正するなら voxel 編集時に `volumeCache.invalidate(target)` を呼ぶ、または `Volume.dataVersion: number` フィールドを追加して cache key に含める。前者が安全。
- ワークアラウンド: 編集前に Renderer mode を Force CPU に切り替える。

### 6. 大型 CT volume が GPU mode で真っ黒になる (解決済み 2026-07-18)
- **症状**: 大型 CT (例 `512×512×345`, Float32 で ~362MB) を含む症例で PET Standard すると、
  **CT axial / Fusion box だけ真っ黒**。PET / MIP は正常。Force CPU にすると CT も表示される。
  (sample-data `cervicalca` で再現。PET は 168×168×849=~96MB で無事だった。)
- **真因**: `getGpuDevice` (`webgpu/gpuContext.ts`) が `requiredLimits` 無しで `requestDevice()` していた
  → device の `maxBufferSize` が **default 256MB**。`volumeCache.ts` の `writeTexture` は「コピー全体
  サイズ」の staging buffer (`Dawn_DynamicUploaderStaging`) を確保するので、362MB の 1 回コピーが
  256MB 上限を超えて **validation error**。WebGPU のエラーは例外でなく errorScope 経由なので握りつぶされ、
  texture が全ゼロのまま = 黒。`pushErrorScope('validation')` で
  `Buffer size (361758720) exceeds the max buffer size limit (268435456)` を実測して確定。
- **修正 (二重の防御)**:
  1. `gpuContext.ts`: adapter が対応していれば `requiredLimits.maxBufferSize = adapter.limits.maxBufferSize`
     を指定して device 取得 (Intel iGPU でも adapter 上限は 2GB だった)。
  2. `volumeCache.ts`: `writeTexture` を **Z スラブ分割** (`slicesPerSlab = floor(maxBufferSize*0.9 / (nx*4*ny))`)。
     上限を上げられない低スペック環境でも 1 回のコピーが上限を超えない。
- **注意**: 今後 GPU に大きな buffer/texture を送るコードを足すときは、device が default limits だと
  256MB/128MB(storage binding) で頭打ちになることを念頭に。errorScope で握りつぶされて「無言で黒」に
  なりやすいので、大型データ経路は必ず実データ (大型 CT 症例) で GPU mode 確認する。

---

## デザイン

- 既存はブラウンベース (`color: brown-darken-4` `#4E342E` 系)。`App.vue` の `myBtn` クラスがツールバーの基準。
- Vuetify テーマは `plugins/vuetify.ts` で設定（dark default 可）。
- モダン化を進める場合は dark + アクセント1色（cyan/orange）+ サイドバー幅再設計を推奨（`UI-design` 計画は別ファイル）。

---

## 開発時の小ワザ

- 型チェックだけ走らせたい: `npx vue-tsc --noEmit`
- ビルド確認: `npx vite build`
- HMR で Pinia の **アクション定義は更新されないことがある**（state は `__hmrId` 経由で patch されるが、closure は古いまま）。挙動が古いと感じたら **Ctrl+Shift+R**（ハードリロード）。
- Volume の voxel pitch を確認したい: `vectorX.length()` `vectorY.length()` `vectorZ.length()`。
- Console で store を覗くには `app.config.globalProperties.$pinia` 経由が必要だが、開発中は SegmentationPanel に一時的にデバッグ表示を埋めるのが速い。

---

## TODO

タスク管理は別ファイル [TODO.md](./TODO.md) を参照。CLAUDE.md は変動の少ない規約・アーキテクチャ用、TODO.md は流動的な作業 backlog。

---

## セッション引き継ぎサマリー（2026-04-27 時点）

### この期間で完了した作業

**機能追加**
1. SUV/segmentation 機能一式 (Step 1〜4): Pinia store、Volume metadata、SegmentationPanel、マスク overlay、PET/CT 自動検出
2. Sphere ROI（クリック中心配置 + 球内ホイール半径変更 + SUVmax/mean 即時表示）
3. Polygon ROI（slice 単位 add/erase、Esc/Ctrl+Z）
4. アイランド検出 (26連結 CC) + Assign Label ツール
5. NIfTI-1 マスク保存（Uint16 多ラベル + JSON サイドカー）
6. PET 標準ビュー（CT axi / PET axi / Fusion axi / PET MIP の 2x2 ワンクリック）
7. MIP にもマスク overlay
8. 閾値 UI コンボボックス化 (2.5/3.0/3.5/4.0/Manual)
9. Volume card リスト（サムネ + Modality バッジ + matrix size、クリックで Box に反映）
10. Ctrl+ホイール 即時ズーム（視野中心固定、Volume/Fusion 両対応）
11. 中ボタンドラッグ 即時 Pan
12. Test ボタン（File System Access API でフォルダ選択 → 自動 PET Standard）
13. デバッグモード（?debug=1 / Ctrl+Shift+D で voxel inspector + Shift+Click voxel 編集）
14. autoFitMode（ウィンドウ/drawer/tileN 変化に追従）+ Fit to window ボタン
15. Synchronize 初期 OFF、CLUT クリック即時反映、PET voxel 表記削除など細かい修正

**UI 全面刷新**
- ダークメディカルテーマ (#0F1419 / teal #00D4AA)
- 3カラムレイアウト (Sidebar 280px / 画像 / Inspector 320px)
- app-bar 48px スリム化、全ツールアイコン化
- Inter / JetBrains Mono フォント
- グローバル CSS 変数 (`src/styles/app.scss`)

**バグ修正**
- Polygon ROI 1スライスずれ（Math.round → Math.floor、画面中央 voxel 基準で算出）
- Pinia Proxy で `===` 比較が破綻 → voxel TypedArray + seriesUID + modality の3段照合
- 同一 PET の MPR 再実行でマスクが消える → seriesUID 同一なら state 保持
- Ctrl+wheel ズームが Fusion で効かない → `isAnyVolumeBox` で対応

### このセッションで踏んだ重要な落とし穴（再発防止）

1. **Pinia state は Proxy ラップされる** — DicomView 内 `let seriesList: SeriesList[]` のような plain な変数と store の値を `===` で比較してはいけない。voxel TypedArray の参照同一 / seriesUID 文字列一致 / modality を順に試す。`findPetSeriesIndex()` がこのパターンの実装例。
2. **Pinia アクションの HMR は不完全** — store のアクション定義を変えてもブラウザ側で古い closure が使われ続けることがある。挙動が変わらないと感じたら **Ctrl+Shift+R** ハードリロード。
3. **`isVolumeImageBoxInfo` は Fusion を含まない** — `clut1` を持つものは除外する判定。Fusion を含めたいときは `isAnyVolumeBox = isVolumeImageBoxInfo || isFusedImageBoxInfo` を使う。
4. **マスク overlay は Volume レンダのみ** — 生 DICOM 表示モード (`drawImageCvZoom`) には overlay コードパスが無い。MPR/Fusion/PET Standard を経由させる UX にしてある。
5. **ImageBox の re-init が必要なタイミング** — tileN 変更後、imageBoxW/H 変更後は `imb.value[i].init()` を呼んでから `show()` しないと canvas が壊れる。`watch(tileN)` と `watch([imageBoxW, imageBoxH])` で対応済み。

### 次セッション再開時のチェックポイント

1. **動作確認の最短手順**
   - `npm run dev` → ブラウザで http://localhost:3000/metavol-web-beta2/
   - **Test** ボタン → PET/CT フォルダ選択 → 自動で PET Standard が出る
   - Inspector で **Apply** → 赤マスク → polygon erase → Find islands → Assign label → Save NIfTI

2. **既知の未解決事項**
   - `DicomView.vue` が約 1700 行。composable (`useSphereROI`, `usePolygonROI`, `useDebug`) に切り出す価値あり
   - bundle size 500KB超: code splitting 未着手
   - NIfTI のみロード時 modality 手動指定 UI 未実装
   - マスクをロードして再編集する round-trip 機能なし
   - 球輪郭描画は等方 voxel 前提の概算
   - Test ボタンの directory handle は IndexedDB に永続化していないため、ページリロードで再選択が必要

3. **着手中だった案件**
   - なし（Step 5 微調整まで完了）

4. **触っていないので次の改善候補（推奨順）**
   - composable 切り出し（DicomView.vue の保守性）
   - NIfTI ロード時の modality 手動指定
   - マスクロード round-trip
   - Sidebar の閉じ機能 (現状は app-bar の ☰ のみ)
   - PET Standard 後の各 Box のラベル表示（"CT" / "PET" / "Fusion" / "MIP" を画像左上に）

### ファイル状態（git）

- 新規追加: CLAUDE.md, USAGE.md, src/stores/segmentation.ts, src/types/VolumeMetadata.ts,
  src/styles/app.scss, src/components/SegmentationPanel.vue, src/components/SeriesList.vue,
  src/components/DebugInspector.vue, src/components/segmentation/{maskOps,niftiWriter}.ts
- 変更: README.md, components.d.ts, package.json, package-lock.json, vite.config.mts,
  src/main.ts, src/App.vue, src/plugins/vuetify.ts,
  src/components/{DicomView,ImageBox,Sidebar,Volume,Clut,dicom2volume}.{vue,ts}
- 削除: なし
- ブランチ: main
- 未コミット（このセッションでは commit していない）

### 動作確認済み環境

- Windows 11 Pro、Chrome/Edge（File System Access API 必要）
- npm run build / vue-tsc --noEmit いずれも exit=0
- 開発サーバ: ポート 3000 が使用中だったため 3001 で起動していた

---

## ペルソナと優先度 (2026-05-04 確認、ユーザ指示)

**最重要 = ペルソナ 1 (PET/CT MTV 測定)**。Metavol はもともと MTV 測定ソフトとして始まった。

### ペルソナ 1: PET/CT MTV 測定 ★最重要
- **解決する問題**: PET volume から腫瘍体積 (MTV) と total lesion glycolysis (TLG) を測定する。臨床/研究用。
- **現状の充足度** (commit b84d1cd 時点で高い):
  - Sphere ROI / Polygon ROI / threshold スライダ (PERCIST liver / pct-of-max / fixed) / Apply
  - Find islands (26-連結 CC) / Assign label / Save NIfTI mask
  - Lesion table、SUVpeak、TMTV cutoff (DLBCL CAR-T 48cc / NSCLC 80cc)、Deauville 5pt
  - Snapshot (.mvs) で session 永続化
- **次の伸びしろ** (この優先順で):
  1. Voxel-level brush edit (1 voxel ON/OFF。polygon より細かい修正用)
  2. Undo を polygon 以外にも拡張 (apply / assign label / paint の取消)
  3. Lesion table の inline rename / delete / merge / split
  4. Multi-timepoint comparison (baseline vs follow-up、PERCIST 自動判定)

### ペルソナ 2: 簡易 viewer (URL share)
- **解決する問題**: 院内/カンファレンスで DICOM/NIfTI を「リンク 1 つ」で共有して見せる。
- **現状の充足度** (中-高):
  - Drag & drop DICOM/NIfTI、`?url=` で外部 URL 共有、append drag (commit b84d1cd)
  - NIfTI raw byte view、NIfTI header viewer (volume card "..." menu)
  - nii.gz native streaming gunzip + 進捗 chip
- **次の伸びしろ**: URL に view state (W/L、CLUT、layout) を載せる。OHIF 風 share。

### ペルソナ 3: PET/MR + radiomics
- **解決する問題**: MR と PET を整合させて anatomical context 付きで MTV を測る。Radiomics 抽出。
- **現状の充足度** (中):
  - MR registration (rigid 6-DOF, MI + Nelder-Mead, 3-level pyramid)
  - Radiomics features (first-order / shape / GLCM / GLRLM)
- **次の伸びしろ**:
  1. WebGPU MI で registration 5-30s → 0.1-1s (TODO に詳細あり)
  2. 手動 nudge UI (Fusion box で MR を Shift+drag で ±1mm 移動)
  3. Radiomics 結果テーブルの UI 改善 (現状は console / snapshot 内)

### 開発判断のガイド
- 機能追加で迷ったら **ペルソナ 1 の MTV 測定 UX を改善するか?** を最初に問う。Yes なら高優先。
- 「P2/P3 専用機能」は P1 を妨げない範囲で追加 (画面の右下に隠す等)。
- 「P1 が触らない領域」(MR registration、PNG/JPG planar 等) は別 commit で。
