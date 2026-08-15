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

### ImageBox の用語 (2026-07 定義) — 会話でもコードでもこの語彙で統一する

**box** = 画面上のタイル 1 枚。中身は **Rendering (描画方式)** と **fused (融合の有無)** で言う。
放射線科の標準語 (native / MPR / MIP / VR) に合わせてあるので、そのまま口頭でも通じる。

**① Rendering — 排他。5 値** (`getBoxRendering`)

| 値 | 意味 | 実体 |
|---|---|---|
| `native` | 元スライスをそのまま表示。再構成なし。**マスク/セグメンテーション不可** | `DicomSliceImageBoxInfo` |
| `mpr` | 再構成して任意断面 | `VolumeImageBoxInfo` (isMip/isVr なし) |
| `mip` | 最大値投影 | `isMip: true` |
| `smip` | surface MIP (閾値 + 深さ) | `isMip: true, mip.isSurface: true` |
| `vr` | ボリュームレンダリング | `isVr: true` |

**② fused — 真偽値** (`isBoxFused`)

overlay 層を持つか (= `clut1` の有無)。**`mpr`/`mip`/`smip`/`vr` のどれとでも組み合わさる**
(fused VR は `fusionVrPipeline` で実在する)。だから融合は Rendering の値にせず直交フラグにしてある。

- 「再構成済み」= `rendering !== 'native'` (内部判定は `isAnyVolumeBox`)
- 「**投影系**」= `mip` / `smip` / `vr` = **断面を持たない** → paging・融合の受け先・cross-ref 線・
  crosshair が使えない。判定は `isProjectionRendering(r)` / `isProjectionInfo(info)` に集約
  (以前は `isMip || isVr` が 12 箇所に散在していた)。

→ **「MIP box」という型は無い**。正しくは「**MIP レンダリングの box**」。
   (2026-07 に Kind(dicom|volume|fusion) × Mode(slice|mip|smip|vr) の 2 軸から移行。
    旧構成は「dicom なら必ず slice」と非直交で、かつ fusion が Kind と Mode の両方の意味を持っていた)

**MIP の回転軸は volume の k 軸 (添字空間)**。axial 撮像でのみ体軸まわりの回転になる。
coronal/sagittal 撮像では解剖学的に正しくない (断面ベクトルは `planeVectorsWorld` で world 基準に
直してあるが、MIP の回転はこの修正の対象外)。

**③ 判定は固有フィールドで行う。`clut` を使わないこと**

`defaultInfo()` (= DICOM box) も stray な `clut: 0` を持つため、`"clut" in info` では
**DICOM box が Volume box と誤判定される**。判定は上表の固有フィールドで行う:
`currentSliceNumber` → DICOM / `centerInWorld` → Volume 系 / `+clut1` → Fusion。
また判定関数は **undefined を渡されても throw しない**こと (下記「2.8」参照)。

### Volume の幾何
- 物理座標（mm）の原点 = `imagePosition` (DICOM ImagePositionPatient)。
- `vectorX/Y/Z` は **「voxel index 1 進むと world で何 mm 進むか」** の3Dベクトル。
  したがって `vectorX.length()` などで voxel pitch (mm) が直接得られる。
- **すなわち vectorX/Y/Z は affine の「列」**。`world = imagePosition + i·vectorX + j·vectorY + k·vectorZ`。
  **転置 (行として扱う) と混同しないこと** — 対角 affine (軸平行) では行と列が一致するため、
  取り違えても軸平行データでは一切症状が出ず、回転を含むデータで初めて破綻する。
  2026-07 に `voxelToWorld` / `inverseAffineOf` (Volume.ts) が行として計算していた誤りを修正した
  (症状: 脳 MR/PET の NIfTI qform で world→voxel が全く別の場所を指し、registration の
  MI が常に 0 → 最適化が空回り)。新しく affine を触るコードを書くときは必ず列で組むこと。
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
- **↑↓←→** : 選択中 box の paging (±1) / **PageUp・PageDown** : ±10
  - **手動 alignment 中はその box に限り overlay の移動に切り替わる** (`onManualAlignKey` が
    `onPagingKey` より先。3.57 参照)
  - 実装は `onPagingKey` (DicomView.vue)。**向きは右端の縦スライダと一致**させる:
    index の増減ではなく `getBoxPaging().invert` を通すので、PET と CT でスライス順が逆でも
    ↑ が常に頭側 (through-plane が Y/X なら腹側/右側) になる。
  - 投影系 (MIP/sMIP/VR) は `getBoxPaging` が null なので**何もしない** (preventDefault もしない)。
  - `input` / `textarea` / `select` / contenteditable にフォーカスがあるときは奪わない。
    Vuetify の paging スライダは `input[type=range]` なので、掴んだ後は slider 自身の矢印処理に任せる。

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

### レポート出力 (④ Save → Others)

- **PDF** (`pdfReport.ts`, jsPDF): 病変テーブル **全行** + 画像。詳細な記録用。
- **PPTX** (`pptReport.ts`, pptxgenjs, 2026-07 追加): **画像メイン**。1 スライド 2 図で大きく敷き、
  病変テーブルは **全身サマリーのみ** (件数 / total MTV / total TLG / 最高 SUVmax / threshold /
  Deauville)。per-lesion 行は出さない (カンファ発表用というユーザ指定)。
- 入力は両者とも `PdfReportInput` で共通。**panel の `buildReportInput()` が唯一の組み立て箇所**なので、
  項目を足すときはここと両 renderer を揃える (数値が食い違わないように)。
- どちらも動的 import (`await import(...)`) で別チャンクに切る。pptxgenjs は ~370KB あるため
  静的 import にしないこと。

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
- **voxel 編集**: Shift+左クリックで `prompt()` ダイアログ。`Volume.voxel[idx]` を直接書換 →
  `evictVolumeTexture(voxel)` (GPU cache 破棄。無いと画像が変わらない。既知バグ 5 参照) → `show()`
- 実装は `composables/useDebugInspector.ts`（`updateDebugHover` / `handleDebugEditClick` / debug ref 群）。`debugMode` は defineModel なので DicomView 側に残り、composable に渡す。`seriesList` は reassign される let なので getter (`getSeriesList`) 経由で渡す

## DicomView.vue の composable 分割（肥大化対策・進行中）

DicomView.vue は god component（6,000 行超）。**挙動を変えずに**行数を減らすため、疎結合な leaf 機能から composable へ純粋なコード移動で切り出している。各切り出し後に `vue-tsc --noEmit` + `vite build` + ブラウザ mount 確認で検証。

- 依存は単一の `ctx` オブジェクトで明示的に渡す（tsc が配線を型検証 → 無言の挙動変化を防ぐ）
- **reassign される `let`（`seriesList` 等）は必ず getter (`() => seriesList`) で渡す**（値を capture するとstale化）
- composable 呼び出しは依存（`screenToWorldAny` / `show` 等）が全て定義済みの位置（`findPetSeriesIndex` の直後）に置く。返す ref/関数は同名で分割代入し、template・イベントハンドラは runtime で参照するので TDZ 問題は起きない
- 切り出し済み: `useDebugInspector.ts`（voxel inspector）、`useSnapshotIo.ts`（View state URL / Snapshot file の save/load。`RectRoiJson` 型はここに定義し DicomView へ import で戻す。`rectRoiToJson`/`importRectRoisFromJson` は rect ROI export と共有のため DicomView に残し ctx で渡す）

## テスト DICOM ロード（File System Access API）

- **ロード後は plain viewer のまま** (2026-07 変更)。以前は PT+CT が揃うと自動で
  `setupPetStandardView()` に飛んでいたが、「DICOM を読み込んだ直後は plain viewer」という
  ユーザ指定の原則 (drag&drop / `autoLayoutAfterLoad` と同じ) に揃えて廃止した。
  Volume 表示は Layouts / PET Standard ボタンから明示的に起動する。
- app-bar の **Test** ボタンで `window.showDirectoryPicker()` を呼びフォルダ選択
- 選択したディレクトリハンドルを `cachedTestDirHandle` にキャッシュ（**メモリのみ、リロードで消える**）
- 同セッション中は再選択不要、ボタン1クリックで再ロード
- Chrome/Edge のみ対応（Firefox/Safari は対応していない）

## レイアウト（app-bar「Layouts」メニュー）

`App.vue` の `runLayout(kind)` が `DicomView` の expose した `setup*` を呼ぶ。既存: `triplanarPt` /
`triplanarFused` / `ptOnly4up` / `compare2up`。**追加 (2026-07): `petCtMipRight`「PET/CT + MIP (3×2)」**。

- `setupPetCtMipRight()` (DicomView.vue)。**tileN=5** (tileN は「表示 box 数」であって列数ではない。
  `node scripts/render-health.mjs` で実測: triplanarFused=3 / ptOnly4up=4 / compare2up=2 / petCtMipRight=5)。
  3列×2行グリッドに 5 box を配置:
  - box0 = **CT axial** (r1c1, WC40/WW400)、box1 = **PET axial** (r1c2, CT と同じ mm/px・中心に整列)、
  - box2 = **PET MIP** (右列 c3, coronal 視軸)。**`rowSpan: 2` で 2 行ぶんの背高 box**。
  - box3 = **Fusion axial** (r2c1)、box4 = **Fusion coronal** (r2c2)。CT base + PET rainbow overlay。
- **`rowSpan` は `VolumeImageBoxInfo` の任意フィールド (default 1)**。`DicomImageBoxInfo.ts` に定義。
  描画側は `boxRenderHeight(i)` / `boxCellStyle(i)` (DicomView.vue) が `rowSpan` を見て canvas 高さと
  CSS grid の `grid-row: span N` を決める。**新レイアウトで背高 box を作るときはこの2関数を通すこと。**
- **screen↔world 変換の高さは必ず `boxRenderHeight(i)` を使う (2026-07 修正)**。`imageBoxH` は
  「1 行ぶんの高さ」なので、rowSpan=2 の box でこれを使うと中心が半行ずれる (MIP が上寄りになる不具合)。
  修正済みの箇所: `screenToWorld` / `worldToScreen` / 球輪郭の 2 箇所 / brush・polygon の「canvas 中心画素」。
  DICOM slice box は rowSpan を持たないので従来どおり `imageBoxH` で良い。
  検証は canvas の実ピクセルを走査して「明るい行の中点 ≒ canvas 中心」を確認するのが確実
  (CPU mode と GPU mode の両方で見ること。片方だけ直っている状態を見逃さないため)。

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

### 2.5. `isVolumeImageBoxInfo` が plain DICOM box にも true を返していた（解決済み 2026-07）

- **`defaultInfo()` (`DicomImageBoxInfo.ts`) は DICOM box なのに `clut: 0` を持つ。**
  旧実装の `isVolumeImageBoxInfo(i)` は `("clut" in info) && !("clut1" in info)` で判定していたため、
  **生スライス box でも true** になっていた (`isAnyVolumeBox` も同様)。
  ソース中の「この方法では、プロパティ名を変更したときにバグった」というコメントどおりの罠。
- 実測 (実 PET/CT DICOM 778 files ロード後): 全 box が `clut:true` / `currentSliceNumber:true` /
  `centerInWorld:false`。plain viewer なのに `isAnyVolumeBox` が全部 true だった。
- **「plain viewer なのに右 Inspector が開く」不具合の原因**だった。
- **修正**: 判定を固有フィールドに統一した (上の「ImageBox の用語」③ を参照)。
  `isVolumeImageBoxInfo` = `'centerInWorld' in info && !('clut1' in info)`、
  `isFusedImageBoxInfo` = `'centerInWorld' in info && 'clut1' in info`。
  判定が **厳しくなる**方向なので、`if (!isAnyVolumeBox) return` 型のガードは
  DICOM box を正しく除外するようになった (呼び出し 40 箇所は全て「DICOM を先に分岐 → else volume」
  の形であることを確認済み)。**`clut` を判定に使わないこと。**

### 2.7. タイルが画像エリアから溢れて右サイドバーに潜り込む (解決済み 2026-07)

**症状**: 「PET/CT + MIP (3×2)」で box が右サイドバーに重なる。実測 (実 PET/CT):
`.mv-imagearea` clientWidth=672 に対し scrollWidth=**1376**、box 右端が 1321 (サイドバー左端 952) まで到達。

**原因は 2 つ重なっていた**:
1. **titlebar が box の intrinsic 幅を決めていた**。grid は `repeat(cols, max-content)` なので、
   `.mv-titlebar-actions { flex-shrink: 0 }` のボタン列 (500px 超) が max-content を支配し、
   canvas 幅 (218px) を無視して box が 509px になっていた。
   → `.mv-titlebar { width: 0; min-width: 100%; overflow: hidden }` で titlebar を intrinsic 幅計算から
   外し、actions は `flex-shrink: 1; min-width: 0; overflow-x: auto` で横スクロールに逃がす。
   **titlebar にボタンを足すときはこの前提を壊さないこと。**
2. **fit が 1 ステップ古い幅で計算されていた**。`watch([drawer, inspector, tileN])` は即時に
   `applyAutoFit()` を呼ぶが、drawer は CSS transition (~0.2s) なのでその時点の
   `.mv-imagearea` はまだ変化前の幅を返す。補正役だった **ResizeObserver はこの要素では発火しない**
   (v-main の padding 変化では呼ばれない。プローブ RO を貼って 0 回発火を実測)。
   → `scheduleAutoFit()` = 即時 + 280ms 後の再 fit に変更。
   **drawer 開閉に連動して寸法を決めるコードは「transition 後にもう一度測る」こと。**

`BOX_BORDER_PX = 1` も追加 (noGapMode では SAFETY_PX=0 になるため border 分で数 px 溢れていた)。
検証は実データで `scrollWidth - clientWidth === 0` と「box 右端 < drawer 左端」を確認する。

### 2.8. box 判定関数が throw して **render が丸ごと停止**する (解決済み 2026-07)

**症状**: レイアウトを変えても画面が変わらない。`imageBoxInfos` は新しいのに DOM と
ImageBox の props は古いまま。`boxStateVersion++` も `show()` も効かない。
**DicomView のテンプレート内にある右ドロワーも描画されなくなる**ので
「right side bar が出ない」という別症状に化ける (実際にそう報告された)。

**真因**: `isDicomSliceImageBoxInfo` / `isVolumeImageBoxInfo` / `isFusedImageBoxInfo` は
`"clut" in imageBoxInfos.value[i]` の形で、**info が undefined だと TypeError**。
これが `crossRefLinesFor` 経由で template から呼ばれるため、render 関数が毎回失敗し、
Vue が `Unhandled error during execution of render function` を warn するだけで
以後 DOM が一切更新されない。console を error だけで見ていると warn なので見落とす。

**穴の発生源**: box を作る経路で `imageBoxInfos.value.push(newInfo)` を使っていた。
push は **配列末尾**に入るので、`newBoxId > length` のときは間の index が undefined のまま
`tileN` だけ伸びる。→ 事前に `defaultInfo` で埋めてから index 指定で代入する。

**対策 (両方入れてある)**:
1. 3 つの判定関数を null 安全に (`boxInfoAt(i)` 経由)。**render は絶対に throw させない**。
2. box 追加時に穴を作らない。

**デバッグ手順**: `app.config.errorHandler` を実行時に差し込んでから再描画を促すと実体が取れる。
```js
app.config.errorHandler = (e,i,info) => console.log(info, e.message, e.stack);
dvSetupState.boxStateVersion++;
```

### 2.9. `?dev=<case>` が大量ファイルで取りこぼす (解決済み 2026-07)

2375 ファイルの症例で **16 シリーズが 6 に欠落**した。dev middleware が
`fs.createReadStream(...).pipe(res)` で fd 枯渇等に失敗すると **200 のまま空ボディ**を返し、
クライアントは 0 バイトの File を作ってしまう (console に「otherfile: 0 bytes」が大量に出る)。
→ サーバは `fs.readFile` + 失敗は 500、クライアントは **0 バイトもリトライ対象**にした。
欠落は「PT が見つからない」等の別問題に見えるので、まずシリーズ数を数えること。

### 3. `setPetVolume(v)` が呼ばれるたびに mask が破棄される
- `setPetVolume` は `thresholdMask`/`manualEdits`/`finalMask`/`undoStack`/`sphere`/`polygon` を全 null 化する。
- `refreshSegStoreVolumeRefs()` は `===` で違いを検出し volume が「変わった」と判定すると毎回呼ぶ → **MPR を再度押すたびにマスクが消える**。
- 緩和策: `setPetVolume` で「同じ seriesUID なら state を保持」する。あるいは `refreshSegStoreVolumeRefs()` 側で seriesUID 比較する。

### 3.5. NIfTI の affine 解釈 (2026-07 修正) — brain MR/PET で発覚

`sample-data/brain_mri_pet` (MR00.nii / PT00.nii) は **qform のみ** (qform_code=1, sform_code=0,
srow は全ゼロ) で、かつ回転を含む。ここで 3 つの不具合が重なっていた:

1. **方向ベクトルを affine の行から取っていた** → 正しくは列。回転があると軸が混ざる。
2. **NIfTI は RAS+ / 本アプリ world は LPS** なのに、方向ベクトルだけ符号反転して
   **原点 (imagePosition) を変換していなかった** → NIfTI 同士 / NIfTI と DICOM が x,y でずれる。
   MR と PET で原点が違うため、相対位置が数百 mm 狂っていた。
3. `Volume.voxelToWorld` / `inverseAffineOf` 自体が転置だった (上記「Volume の幾何」参照)。

修正後の実測: voxel pitch がヘッダ値と一致 (MR 0.9766/0.9766/1.0、PT 0.5346/0.5346/3.0488)、
registration の MI が 0 → 有効値になり最適化が機能。`niftiVolumeWriter` も LPS→RAS の逆変換を
入れて save→load の往復を保った。**既存 DICOM は off-diagonal が厳密に 0 なので影響なし** (検証済み)。

### 3.55. 同一 FrameOfReference には registration を掛けないこと (2026-07)

**同 FrameOfReferenceUID = 同一装置が同一座標系で撮ったもの (PET/CT 一体機など) で、既に正解。**
ここに MI 最適化を掛けると **MI が装置の位置合わせより「良い」と誤判定して壊す**。

実測 (Hirata20260728 の `PET TRANSAXIAL` × `CT TRANSAXIAL+`、同 FoR):

| 条件 | PET の移動量 |
|---|---|
| 重心合わせ + 粗探索してから最適化 | **311.6mm** |
| identity から最適化のみ | **115.2mm** |
| 「開始位置より悪ければ不採用」ガードのみ | 効かない (MI 上は "改善" 判定のため) |

→ 全身 PET/CT では MI が十分に鋭くないので、**ガードでは防げない**。
`onBoxAutoRegister` は **同 FoR なら実行せず、その旨を伝えて return** する。
位置合わせが要るのは「別 study / 別スキャナのシリーズを drag&drop で重ねた」ケースだけ。

別 FoR の場合も保険として、(a) 推定初期値が現状より悪ければ採用しない、
(b) 最終結果が開始位置より悪ければ適用しない、の 2 段ガードを入れてある。

### 3.57. mis-registration を人が直す手段 (2026-08)

auto-registration は外れることがある (MI の局所解、FOV / 体位の食い違い、別 study 同士)。
**外れたときに人が直せる**手段を fusion box の「…」メニューに用意してある:

- **Adjust alignment manually** — 画像左下に調整パネル (`.mv-align-panel`)。
  面内 D-pad / through-plane ± / 面内回転 ± / step (0.5〜10mm, 1〜5°) / 現在オフセット表示。
  **カーソルキー**と **Shift+左ドラッグ**でも動かせる (Shift 必須なのは調整中も window/pan を
  使えるようにするため)。
- **Refine with auto** — **いまの手動姿勢を開始点**に MI 最適化。手で当たりを付けて機械に詰めさせる。
  `onBoxAutoRegister(boxId, { fromCurrent: true })`。このときは重心合わせ+粗探索を**使わない**
  (ユーザが付けた当たりを壊すため)。同一 FoR のスキップも適用しない (明示操作なので)。
- **Reset registration** — 撮影時の姿勢に戻す。

実装上の要点:

- **回転は world 原点まわりにしないこと。** `makeRigidMatrix` の rx/ry/rz は world 原点基準なので、
  角度を直接足すと体幹部が数百 mm 飛ぶ。手動側は world 空間の delta 行列を**左から**掛けて
  再分解する (`composeWorldDelta` / `paramsFromMatrix`, transform.ts)。回転中心は
  `rotationDeltaAbout` で **box の centerInWorld** (= いま見えている断面の中心) にしてある。
- 移動方向は box の `vecx` (右) / `vecy` (下) / `vecz` (奥) 基準。axial でも coronal でも
  「画面で見えている向き」に動く。px→mm 換算は `vec*.length()` なので zoom しても手応えが一致。
- **registration 変更後に `evictVolumeTexture` を呼ばないこと (2026-08 撤去)**。GPU texture が
  持つのは voxel だけで、幾何 (p00/v01/v10) は描画ごとに CPU 側で volume から作り直して
  uniform で渡している。捨てると数百 MB の再アップロードが走るだけで、ドラッグ調整が実用にならない。
- 幾何は `THREE.Vector3` の in-place mutation なのでパネルの数値表示は Vue が追えない。
  `manualAlignVersion` を bump して追従させる (`boxStateVersion` と同じ作法)。
- **投影系 (MIP/sMIP/VR) では出さない** (`canManualAlign` = fused かつ非 projection)。
  断面が無く「合っているか」を目視判断できないため。メニュー項目自体も出ない。

**永続化 (2026-08)**

registration は volume の幾何そのものではなく **撮影時姿勢からの差分 (rigid 6-DOF)** として
store (`segStore.registrations`, seriesUID → params) に写しを持ち、
snapshot (.mvs, top-level `registrations`) と auto-save (`SessionPayload.registrations`) の
両方に保存する。復元は seriesUID 照合で、別症例を開いていれば 0 件になるだけ。

- **registration を変える経路は必ず `setVolumeRegistration()` を通すこと。** 幾何と store の
  写しを同時に更新する唯一の場所。直接 `applyRigidToVolume` を呼ぶと画面と保存内容が食い違う。
- store は volume を持たないので、`restoreFromPersistence` / `applySnapshotJson` は
  **写しを入れるだけ**。実際に幾何へ掛け直すのは DicomView の `applyStoredRegistrations()`
  (snapshot 適用時と recovery dialog の Recover で呼ぶ)。
- identity は保存しない (エントリごと消す)。auto-register の途中 reset も store に反映するので、
  同一 FoR の early return で抜けても不整合にならない。

**undo (2026-08)**

mask 編集の履歴 (store の `history`) とは **別建て**。位置合わせは 6 個の数値で、voxel の
sparse diff と混ぜても得が無く、「マスクを戻したいのか位置を戻したいのか」が曖昧になるため。

- `regUndoStack` (DicomView, 最大 50, 永続化しない)。変更の **直前**の params を積む。
- ドラッグ/キーリピートで 1px ずつ積まれないよう、同一 series への連続操作は **400ms 以内なら
  1 ステップにまとめる** (`REG_UNDO_COALESCE_MS`)。auto-register は全体で 1 ステップ。
- 引くのは手動 alignment 中の **Ctrl+Z** とパネルの ↶ ボタン。モードを閉じれば Ctrl+Z は
  従来どおりマスクの undo に戻る。

### 3.58. **registration を壊していた 2 つの幾何バグ (2026-08 解決)**

**結論: MI 自動位置合わせは全身 PET/CT でも脳 MR/PET でも機能する。** 以前ここに
「MI は成立しない」と書いていたが、それは下記 2 つのバグの上で測った結果で、**すべて無効**。

**バグ①: `applyRigidToVolume` が voxel サイズを破壊していた**

```ts
vol.vectorX.copy(origVx.transformDirection(m));   // ← transformDirection は正規化する
```
`vectorX/Y/Z` は「voxel を 1 進めたとき world で何 mm 動くか」= 長さが voxel pitch そのもの。
THREE の `transformDirection` は回転後に **正規化** するので、この関数を通すたびに
**全部 1mm 角の volume に化ける**。実測 (metmri の MR): pitch 6.42mm の軸が 1.00 に。
auto-register / 手動調整 / snapshot 復元のすべてが通るため、**位置合わせを 1 回でも
掛けた時点で幾何が壊れ**、以後 MI も表示も当てにならなくなっていた。
→ 3x3 回転だけを掛けて長さを保つ `rotateKeepingLength` に修正。

**バグ②: `estimateIntensityRange` が位置合わせ前の姿勢で moving を標本化していた**

fixed と同じ world 点で moving をサンプルしていたが、別装置由来のデータは初期状態で
**まったく重ならない** (実測 metmri: overlap 0/4000)。moving 側のレンジが min=max=0 に潰れ、
以後どの姿勢でも全 voxel が最終ビンに入って **MI が恒等的に 0**。重心で 3897/4000 重ねた
後も 0 のままだった。→ moving のレンジは volume 全体の分位点から取る (姿勢非依存)。

**修正後の実測 (`node scripts/reg-eval.mjs`)**

Hirata20260728 の CT TRANSAXIAL+ × PET TRANSAXIAL (同一 FoR を正解とし、既知量ずらして戻す)。
開始誤差 26.9〜70.8mm、平均 mTRE:

| 構成 | 修正前 | 修正後 |
|---|---|---|
| 重心 + pyramid[2,1] | 84.9mm | **1.6mm** ← 既定 |
| 重心 + pyramid[4,2,1] | 320.9mm | 2.3mm |
| 初期値なし + pyramid[4,2,1] | 153.3mm | 3.9mm |
| 重心 + 単一解像度 | — | 6.8mm |
| 初期値なし + 単一解像度 | 48.0mm | 11.6mm |

所要 1 秒前後。**多重解像度も重心初期化も有効** (以前「有害」と書いたのは誤り)。

metmri (脳 MR + PET、別装置で重心が 210mm 離れている) でも
`node scripts/reg-metmri.mjs` で確認済み: 重心で 210mm を消し、MI で精密化して
±5/10/20mm・±2/5° の **30 摂動すべてで悪化する極小**、95mm ずらしても 12.7mm まで復帰。

**アルゴリズムは「① 重心で粗く → ② MI で精密に」の 2 段**。粗探索
(`coarseTranslationSearch`) は使っていない (重心で十分寄るため)。

**検証スクリプト**
```bash
node scripts/reg-eval.mjs      # Hirata: 構成ごとの mTRE 表
node scripts/reg-metmri.mjs    # metmri: 極小チェック + 収束半径
node scripts/affine-check.mjs  # world↔voxel の検算 (数秒、DICOM 不要)
```

### 3.59. **視野が食い違うペアには自動位置合わせを掛けないこと (2026-08)**

3.58 の 2 バグを直しても、**一方が他方の一部しか写していないペアでは強度ベースが原理的に破綻する**。
`assessFeasibility` (registerMrPt.ts) が z 方向の広がり比 **1.6 倍以上**を検出し、
`onBoxAutoRegister` は実行せず理由を出して手動調整へ誘導する。重心初期化も同条件で無効化する。

**実測 (hirata2: CT "Lung" 413mm × PET TRANSAXIAL 1148mm、比 2.8×)**

目視 (冠状断の融合画像) では **読み込み時点 (identity) がほぼ正解**。自動位置合わせを掛けると
tz=+48.6mm 動いて肝臓が右下肺野へ食い込み、明確に悪化した。tz を -60〜+80mm で掃引した結果:

| 指標 | 最小/最大の tz | 判定 |
|---|---|---|
| MI  全体サンプル | +55mm | NG |
| MI  体内限定 | +55mm | NG |
| NMI 全体サンプル | +50mm | NG |
| NMI 体内限定 | +50mm | NG |
| 形状 (体断面積プロファイル相関) | -60mm (探索端。-20〜+45 は 0.168〜0.177 で平坦) | NG |

**正解付近 (tz≒0) に極小すら無く、間違った方向へ単調に改善する。**

- **原因**: PET を頭側へずらすと CT の胸部視野に PET の腹部 (肝・腎・脾で情報量が多い) が入る。
  胸部の PET は肺で抜けて情報量が乏しい。MI は「対応の正しさ」ではなく
  **「情報量の多い領域が視野に入っているか」**を測ってしまう。
  **重なり量は変わらないので NMI でも消えない。**
- **形状指標が効かない理由**: 胸部は体断面積の変化が乏しく、z を識別する特徴が出ない。
- **重心合わせも無効**: 視野が違えば両者の体重心は別の解剖学的高さを指す (tz=+159.8mm と出た)。
  metmri (脳 MR 193mm × 脳 PET 165mm、比 1.17×) で 210mm のズレを正しく消せたのとは前提が違う。

**「複数の最適化経路を用意して最良を選ぶ」は、この症例では機能しない。** 実際に 8 通りの初期値から
走らせたが全て同じ解に収束した (7.4s、改善ゼロ)。**選択基準そのものが正解を指さない**ため、
経路を増やしても届かない。ここを直すには目的関数を変えるしかない。

**本命の解法は解剖ランドマークベース** (TotalSegmentator の臓器ラベル同士を合わせる)。
強度でも体輪郭でも視野非対称に耐えられない。TODO の TotalSegmentator 項目と直結。

**検証スクリプト**
```bash
node scripts/reg-feasibility-check.mjs --case hirata2   # ゲートの分岐確認
node scripts/reg-metric-sweep.mjs                       # MI/NMI × 全体/体内 の tz 掃引
node scripts/reg-shape-sweep.mjs                        # 形状指標の tz 掃引
node scripts/reg-hirata2-visual.mjs                     # 冠状断の融合画像を出して目視
```

**教訓: 自作の代理指標を信用しないこと。** このセッションで body-mask Dice / z プロファイル相関 v1 /
v2 の 3 つを作り、3 つとも壊れていた (感度不足 / ±245mm 探索での偽ピーク / 相互に矛盾)。
全身 PET/CT の位置合わせは **冠状断の融合画像を見るのが最も直接的**。指標を新しく作ったら、
既知量ずらして検出できるかの**自己試験**を必ず先に通すこと。

### 3.595. **肺プロファイル相関 — 試して**不採用**にした指標 (2026-08 実測)**

3.59 で 5 指標すべてが失敗したので、**肺をランドマークにする**案を 4 症例で検証した。
**結論: 定義に対して不安定で、目的関数には使えない。採用しない。**
以下は「同じ道を二度掘らない」ための記録。実験は `scripts/reg-lung-sweep.mjs` に残してある。

**指標の定義**

fixed (CT) の world bbox 内だけを走査し、world z ごとに
「体シルエット内で**抜けている** voxel の割合」を求めて z 方向のプロファイルにし、
CT と PET のプロファイルの相関が最大になる並進を答えとする。

しきい値は **CT だけ物理値、PET は順位**で決める (ここは 2 回間違えた):

| | 体 | 肺 |
|---|---|---|
| CT | HU > -300 | **HU < -400 (物理値)** |
| PT | p97.5 × 0.25 | **体内 voxel の下位 25% 点 (順位)** |

- PET を絶対値で決めると、肺の SUV 0.4〜0.6 がまるごと「体」に入り雑音になる (相関 -0.11)。
- CT を順位で決めると下位 25% は **-118HU = 脂肪**。全身 CT では脂肪と肺の分布が全く違う (相関 -0.07)。
- 教訓: **物理的に確定した値があるならそれを使い、無い側だけ順位で決める。**

**不採用の理由 — 体シルエットの定義を変えると答えが数十 mm 動く**

シルエットを「行 (x) の左右端の内側」とするか「行と列 (x と y) の両方の内側」とするかだけで、
4 症例の結果が入れ替わる。**どちらの定義も 4 症例すべてを通せない** (正解はいずれも tz = 0):

| 症例 | CT | 行のみ | 行 + 列 |
|---|---|---|---|
| hirata2 | 胸部 | +5mm (corr 0.52) | -15mm (corr 0.89) |
| Hirata20260728 | 胸部 (同一シリーズ) | -5mm (0.25) | +5mm (0.14) |
| cervicalca | 全身 | **-60mm NG** (0.27) | +15mm (0.31) |
| dicom | 全身 | 0mm (0.74) | **+40mm NG** (-0.25)  ← 相関が全域で負 |

行のみが破綻する理由は分かっている: 全身 CT では **脚の間や腕と体幹の隙間の空気**が
「左右の体に挟まれている」ので体内と判定され、HU < -400 なのでまるごと肺に数えられる。
実測 cervicalca で CT の肺マスクが **36,181ml** (実際の肺は 5,000ml 程度) に膨れていた。
列条件を足すとこれは消えるが、今度は dicom が壊れる。**理屈で潰しても別の症例が壊れる**ので、
この方向は打ち止めとした。

**併せて試して捨てたもの**

- **mean-in-body プロファイル** (体シルエット内の平均値 vs z): 症例によって符号が反転する。
  CT の HU と PET の集積は全身では同じ向きに動かない (骨盤は HU 高・集積中等度など)。
- **肺マスクの重心合わせ**: PET の肺マスクが 23,000〜26,000ml (CT は 6,770ml) に膨れ、
  重心が体の中央へ引かれて 163〜187mm ずれた。「体内下位 25%」を**全身に適用する**と
  脚や腕の低集積部まで拾う。プロファイル法が (多少とも) 効くのは fixed の視野内に限定しているから。
  実験は `scripts/reg-lung-centroid.mjs`。

**したがって既定は 3.59 のゲートのまま** (視野比 1.6 倍以上なら自動位置合わせを実行しない)。
視野非対称の症例は **手動 alignment が主**。自動化するなら TotalSegmentator の臓器ラベルなど、
**しきい値の切り方で結果が動かない**ランドマークが要る。

**方法論の教訓 (3.59 の続き)**

- 自己試験 (既知量をずらしてピークが同量動くか) は**必要条件でしかない**。この指標は
  4 症例すべてで自己試験に合格したが、うち 2 症例で正解を外した。
  **「感度がある」ことと「正しい点で最大になる」ことは別物。**
- **2 症例で判断しない。** 最初 hirata2 と Hirata20260728 で「誤差 5mm」と結論しかけたが、
  この 2 つは **CT が同一シリーズ** (肺体積 6,770ml・重心が完全一致) で、実質 1 つの CT に対する
  2 つの PET でしかなかった。別患者 (cervicalca / dicom) を入れた途端に崩れた。

### 3.6. MR↔PET registration の初期化 (2026-07)

MI + Nelder-Mead は **局所探索**なので初期値が全て。`onRegisterMrPt` は
`estimateInitialParams` = **重心合わせ → 粗探索** を経てから最適化に入る。

- **重心合わせだけでは足りない**: 重心は「撮影範囲に何が入っているか」に依存する。
  brain MR/PET 実データでは MR が頸部を含み明るい脂肪に引かれて重心が FOV 中心より 44.7mm 下、
  PET は 9.2mm 上 → 合わせると z が 70〜80mm ずれ、そこから抜け出せず「大きくずれた局所解」に落ちた。
- **粗探索を downsample してはいけない**: factor 4 で試すと PET の z が 55→13 スライスまで潰れ
  (`downsampleVolume` は平均でなく stride 抽出)、MI 地形が壊れて全解像度では明確に劣る点を
  最良と誤判定した (実測 -0.31 vs -0.51)。**全解像度で軸逐次探索 (z→y→x) を 2 パス** (≒86 評価、~3.5s)。
- 粗探索の MI binning は `estimateIntensityRange` (moving を identity 位置でサンプル) ではなく
  **volume 全体の 1〜99 パーセンタイル** を使う。初期ずれが大きい段階では前者が背景だらけになり不安定。

検証は「登録後の姿勢が局所最適か」を必ず数値で確認する: ±5/±15/±30mm と ±5° を振って
**全て MI が悪化する**こと。実測 (brain MR/PET): 最終 MI -0.72、全摂動で悪化、
PET 高集積部の MR 信号が周囲の 3.54 倍 (257.4 vs 72.8)。

### 4. NIfTI のみロード時の modality (解決済み 2026-08)
`nifti-reader-js` の affine からは Volume は作れるが modality は分からない。**3 段で決める**:

1. **ファイル名** — `detectModalityFromFilename` (`003PT00.nii` → PT)
2. **voxel 値の分布** — `guessModalityFromVoxels` (`modalityGuess.ts`)。**CT だけ**確度高く言える
   (空気 -1000HU の指紋)。実測 kitty.nii: 空気 46.2%・負値 89.2% → CT。
   **PT と MR は分布だけでは互いに区別できない**ので `null` を返し 'OTHER' のままにする。
3. **手動指定** — `SeriesList.vue` の **Set as PT / CT / MR** ボタン
   (`isUnknownModality` のときだけ出る) → `DicomView.onSetSeriesModality` が
   metadata を書き換えて `segStore.setPetVolume` / `setCtVolume` / `setMrVolume` を呼ぶ。
   seriesUID が無い NIfTI には `nii-{index}-{timestamp}` の sentinel を振る
   (registration の永続化が seriesUID 照合のため)。

検証: `node scripts/nifti-modality.mjs` (kitty で 6 項目すべて PASS を確認済み)。

### 5. GPU mode で voxel inspector の Shift+Click 編集が画像に反映されない (解決済み 2026-08)
- 症状: Voxel inspector で Shift+Click → prompt() で値を入力 → `Volume.voxel[idx]` には書き込まれ、inspector 表示も更新されるが、画面の画像は変わらない (色が変化しない)。
- 原因: GPU レンダリングパスは `volumeCache` (`src/components/webgpu/volumeCache.ts`) で voxel TypedArray を WebGPU テクスチャにアップロードしてキャッシュしている。voxel を 1 セルだけ書き換えても、**cache key = TypedArray の参照**なので cache hit してしまい texture が再アップロードされない。
- **修正**: `handleDebugEditClick` (`composables/useDebugInspector.ts`) の書き込み直後に
  `evictVolumeTexture(target.voxel)` を呼ぶ。デバッグ機能なので再アップロードのコストは許容する。
- **同種の罠**: voxel の中身を書き換える新コードを足すときは必ず evict すること。CPU mode では
  正しく見えるので気付きにくい。既存の呼び出し箇所は scramble/recover (DicomView) と
  SUV mode 切替 (segmentation store) の 2 つ。**幾何 (registration) の変更では evict 不要**
  (texture は voxel しか持たないため。3.57 参照)。

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

## CT 寝台除去 (体マスク) の 3 段構え (2026-08)

`segStore.computeCtBodyMask()` が作る `ctBodyMask` (1=体内 / 0=体外)。3 つを重ねて使う。

1. **最大連結成分** (`extractCtBodyMask`) — 患者と寝台の間に空気の隙間があれば、これだけで足りる。
   **被写体が台に載っていると成立しない** (実測 kitty: 本体・台座・背板が 1 成分 22.25%、
   2 番目以降は 50 voxel 以下のノイズのみ)。
2. **オプション A: 下面から N mm カット** (`ctBedCutBottomMm`)。CT の寝台は必ず下側なので
   単純だが外しにくい。実測 kitty: 22mm で台座が消え、体マスクが 22.3% → 11.7% に。
3. **オプション B: 6 面 crop box** (`ctCropMarginsMm`, `cropBodyMaskMargins`)。
   A を一般化したもので、**A は zMin と同じ値を指す** (両者は setter で同期させてある)。
   台座が下でない場合 (kitty の背板など) に使う。

- 削る基準は volume の外形ではなく **マスクの world bbox**。だから「体の端から N mm」になる。
- **world 座標は k, j, i の線形関数なので増分で回すこと。** voxel ごとに関数呼び出し + 積和を
  すると 2900 万 voxel × 2 周で秒単位かかり UI が固まる。
- UI は app-bar の Remove CT bed メニュー内 (`App.vue`)。B は 6 個の数値入力 + Clear。
- 検証: `npm run check:crop` (kitty で 6 面すべて bbox が要求どおり移動することを確認済み)。
  **「他の面は動かない」は不変条件ではない** — 削った層に他軸の最外郭 voxel が含まれていれば
  他軸の bbox も内側へ縮む。正しい条件は「**他面は内側にしか動かない**」。

---

## セッション保存のサイズとコスト (2026-08 実測)

保存経路は 2 つあり、**どちらも mask voxel を丸ごと持つ**ので、PET の格子が大きい症例では
そのまま作ると桁が合わなくなる。実測は Hirata の PET **256x490x146 = 18.3M voxel**
(mask 1 本 36.6MB、非ゼロは 1.2% だけ)。

**① Snapshot ファイル (.mvs / app-bar のカメラ) — `useSnapshotIo.ts`**

- **v1 (旧) は実用にならなかった**: mask 3 本を生の base64 にして **139.7MB**。
  読み戻しでページが落ちた (実測)。
- **v2 (現行) は gzip してから base64**。`fflate` の `gzipSync` / `gunzipSync`。
  mask は非ゼロが 1.2% しかないので圧縮が桁で効く。
- **読み込みは v1 / v2 の両方を受ける** (`maskFromSnapshot` が gz を優先し、無ければ生にフォールバック)。
  書き出しは常に v2。**新しいフィールドを足すときはこの前方/後方互換を壊さないこと。**
- 実測 (`npm run check:snapshot`): **139.73MB → 0.23MB** (約 600 分の 1)。
  mask 差分 0、registration は store だけでなく **volume の幾何まで**戻ることを確認済み。

**`applyViewState` は tileN を代入すること (2026-08 修正)**

以前は `newTileN` を計算するだけで **代入していなかった**ので、16 box で保存したスナップショットを
1 box の状態で読み込んでも 1 box のままだった。ログには "16 boxes" と出るので気付きにくい。
代入するときは **`imageBoxInfos.value.length` でも頭打ちにすること** — 超えると配列に穴ができ、
render が丸ごと停止する (2.8)。

**② 自動保存 (IndexedDB) — `useAutoSave.ts` + `stores/persistence.ts`**

- `maskVersion` の変化を **2 秒 debounce** して `serializeForPersistence()` → `saveSession()`。
  つまり **マスク編集のたびに走る**。実測は `node scripts/autosave-cost.mjs`。

実測 (Hirata の PET 256x490x146、mask 非ゼロ 1.16%):

| | 時間 | サイズ |
|---|---|---|
| `serializeForPersistence` (mask コピー) | 30.6 ms | 104.79 MB |
| IndexedDB 書き込み | 137.4 ms | |
| **合計** | **168.0 ms** | |

改善案を測った結果:

- **gzip は使えない**: 622 倍に縮む (0.17MB) が **2180ms** かかる。2 秒ごとに走る自動保存では
  編集が止まる。**一度きりの snapshot 保存でだけ使う** (上の ①)。
- **`finalMask` を保存しない**: これは採用した (2026-08)。`recomputeFinalMask()` が
  thresholdMask と manualEdits から**厳密に**導出するので持つ意味が無い。
  実測 **104.79MB → 69.86MB (33% 減)**、コピー 30.6ms → 25.7ms。
  ただし **合計の壁時計では改善が見えなかった** (168.0ms → 178.8ms)。IndexedDB の書き込みが
  支配的で実行ごとに揺れる (137〜153ms) ため。**確かなのは書き込み量とメモリ churn が 1/3 減ること**で、
  体感速度の改善は主張できない。さらに詰めるなら IndexedDB 書き込み側を見る必要がある。
  - `serializeForPersistence` は `finalMask: undefined` を返す。
  - `restoreFromPersistence` は **finalMask が無ければ `recomputeFinalMask()` を呼ぶ**。
    以前はこの呼び出しが無く、保存された finalMask をそのまま入れていた。
  - **古い保存データ (finalMask あり) はそのまま使う** (`hadFinal` で分岐)。
  - 退行検出は `npm run check:snapshot` の「finalMask 完全一致」。導出が厳密でなくなれば落ちる。

---

## DICOM → NIfTI 変換 (2026-08)

`niftiVolumeWriter.ts`。**元の生画素ではなく `dicom2volume` を通した後の値**を書き出す
(PT = SUV / CT = HU / MR = raw)。単位は sidecar JSON の `unit` に明記される。

**出力は 1 つの .zip にまとめる (image + sidecar)。** ブラウザは**ユーザ操作を伴わない
2 件目以降のダウンロードを落とす**。変換は非同期に作ってから落とすので必ず gesture の外になり、
実測で .nii.gz は出たのに sidecar の .json が来なかった (900ms 空けても駄目)。
zip なら 1 回で済み、「全シリーズ変換で 32 ファイル」問題も同時に消える。
zip 内の .nii.gz は**既に圧縮済みなので zip 側は無圧縮 (level 0)** にする (二重圧縮は無駄)。

**入口は 3 つ。用途が違う。**

| 入口 | 場所 | 用途 |
|---|---|---|
| シリーズカードの「…」→ Export as NIfTI | 左サイドバー | **box に出していないシリーズでも変換できる**。これが主 |
| app-bar の Save → Convert all series to NIfTI | ハンバーガー | 全シリーズ一括 |
| box のタイトルバー → Save volume as NIfTI | box | 表示中のものをそのまま |

3 つとも `DicomView.exportSeriesAsNifti()` → `buildNiftiZipEntries()` に集約してある。
**命名規則・gzip 既定・zip 化を 1 箇所に持たせるため**、新しい入口を足すときもここを通すこと。

**⚠ SeriesList に emit を足したら `Sidebar.vue` にも中継を足すこと。**
DicomView は `<sidebar @exportNifti=...>` と書くが、SeriesList はその**孫**。
コンポーネントのイベントは親から孫へ自動では伝わらないので、`Sidebar.vue` の `defineEmits` と
`<SeriesList @xxx="(p) => emit('xxx', p)">` の**両方**に足さないと**無言で捨てられる**
(エラーも警告も出ない)。実際これを忘れてメニューが完全に無反応になった。

**datatype は可逆な範囲で自動選択する (`canUseInt16`)**

- 全 voxel が整数かつ Int16 範囲 → **INT16**。CT の HU がこれ。
- そうでなければ **FLOAT32**。PET の SUV は小数なのでこちら。
- どちらも **値は 1 つも変わらない** (`npm run check:d2n` の「voxel 値が可逆 差分 0」)。
- 判定は 43M voxel の全走査になるので **voxel 参照をキーに WeakMap でキャッシュ**する
  (writer と sidecar で二重に走らせない)。

**性能上の落とし穴 (どちらも実測で踏んだ)**

- **`Int16Array.from(typedArray)` を使わないこと。** iterator 経由になり桁違いに遅い。
  実測 CT 512x512x165 (43.3M voxel): 書き出しが **84ms → 9305ms**。事前確保 + 素の for で 191ms。
- **gzip は `CompressionStream` を使うこと。** fflate の `gzipSync` は同期なので
  同じ CT で **12 秒 UI が固まった**。CompressionStream はブラウザ内部の別スレッドで走る。
  無い環境だけ fflate に落とす。

**実測 (Hirata20260728)**

| | dims | datatype | サイズ | 所要 (gzip 込み) |
|---|---|---|---|---|
| CT Lung | 512x512x165 | INT16 | 165MB → **42.7MB** | 1681ms |
| PT PET CORONAL | 256x490x146 | FLOAT32 | 69.9MB → **15.7MB** | 1251ms |

**検証は 2 本立て。両方要る。**

- `npm run check:d2n` — 変換の**中身**の検査 (内部関数を直接呼ぶ)
- `npm run check:d2n-ui` — **人と同じ UI 操作**の検査 (カード → "…" → Export をクリックし、
  落ちてきた .zip を開いて image と sidecar が入っているか見る)

**中身の検査だけでは足りない。** 上記の Sidebar 中継漏れは `check:d2n` では PASS のまま
通り抜け、UI では完全に無反応だった。**UI から足した機能は UI から検証すること。**

`npm run check:d2n` の中身 — 書き出した .nii の**ヘッダをライブラリを介さず自前で読み**、
dims / pixdim / sform_code / **srow から復元した affine が元の imagePosition・vectorX,Y,Z と
一致するか (LPS↔RAS の符号反転を含む)** / voxel が可逆か / .nii.gz が gunzip で一致するか
を見る。**アプリと同じ reader で読み戻すと「ライブラリ内で辻褄が合っているだけ」を見逃す**ので、
バイト位置直読みにしてある。

---

## 検証コマンド (2026-08 整理)

散在していた検証スクリプトに npm の入口を付けた。**DICOM を要らないものだけ**を `npm run check`
に入れてある (数十秒で終わる)。実データが要るものは個別に叩く。

```bash
npm run check            # UI 言語ポリシー + 型チェック + affine 往復。DICOM 不要、数十秒
npm run check:ui-lang    # <template> に日本語が混ざっていないか (CLAUDE.md の UI 言語ポリシー)
npm run check:affine     # world <-> voxel の往復誤差
npm run check:render     # ★ render 停止の回帰テスト (下記)。要 dev サーバ + 実データ
npm run check:mask       # マスクの保存 -> 読み戻しが差分 0 か。要 dev サーバ + 実データ
npm run check:reg        # registration の適用可否ゲートの分岐確認
npm run check:modality   # NIfTI の modality 推定 + 手動指定が store まで届くか
npm run check:crop       # CT 体マスクの crop box (6 面) が bbox どおり削れるか
npm run check:snapshot   # .mvs の保存 -> 復元が mask 差分 0 / 幾何まで戻るか
npm run check:d2n        # DICOM -> NIfTI 変換の affine / voxel 可逆性 / .nii.gz
npm run check:d2n-ui     # ★ 同上を **UI 操作から** (メニュー -> クリック -> zip の中身)
```

計測用 (合否ではなく数値を見るもの):
```bash
node scripts/autosave-cost.mjs      # 自動保存 1 回のコスト (コピー + IndexedDB 書き込み)
node scripts/axis-orientation.mjs   # 各シリーズの index 軸が world のどこを向いているか
```

**`check:render` は「2.8 の再発」専用**。template から呼ばれる判定関数が throw すると
render が毎回失敗して **DOM が一切更新されなくなる**が、Vue は error ではなく **warn** で出すので
console.error 監視では見逃す。このスクリプトは `console.warn` を包んで Vue warn を捕まえ、
レイアウト・タイル数を一通り切り替えて **canvas 枚数が追随するか**を確認し、
`imageBoxInfos` に穴 (undefined) が無いことも見る。**box を増やす経路を触ったら必ず走らせること。**

実データが要るスクリプトは先に `npm run dev` を起動しておく (既定 3000 番)。

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
