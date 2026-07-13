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

- **Ctrl+Z** : 直前 polygon 編集の undo（`undoStack` から pop してスライス全 voxel を巻き戻し）
- **Esc** : 進行中 polygon キャンセル
- **右クリック / ダブルクリック** : polygon 確定

---

## 保存形式

- `saveMaskAsNifti()` で 2 ファイル同時ダウンロード:
  - `{seriesUID}_{YYYYMMDD-HHMMSS}.nii` : Uint16 多ラベルマスク（PET 格子、PET と同一 affine）
  - 同名 `.json` : ラベル一覧、SUV閾値、PET metadata、voxel size、dims
- NIfTI ヘッダは自前実装（348B + 4B magic + raw voxel）。`niftiWriter.ts` を参照。

---

## デバッグ機能（一般ユーザ非露出）

- **有効化**: URL `?debug=1` で起動時 ON、または **Ctrl+Shift+D** トグル
- ON 時は画面右下に赤い `DEBUG` バッジ
- **voxel inspector** (`DebugInspector.vue`): マウスホバーで全シリーズの voxel 値テーブルを表示。ドラッグ中は抑止
- **voxel 編集**: Shift+左クリックで `prompt()` ダイアログ。`Volume.voxel[idx]` を直接書換 → `show()`
- 実装は `DicomView.vue` 内の `debugMode` ref、`updateDebugHover`、`handleDebugEditClick`

## テスト DICOM ロード（File System Access API）

- app-bar の **Test** ボタンで `window.showDirectoryPicker()` を呼びフォルダ選択
- 選択したディレクトリハンドルを `cachedTestDirHandle` にキャッシュ（**メモリのみ、リロードで消える**）
- 同セッション中は再選択不要、ボタン1クリックで再ロード
- Chrome/Edge のみ対応（Firefox/Safari は対応していない）

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

### 2. 分離した片方の島だけ assign したら他方にも波及する (調査中)
- `assignLabelAtVoxel` は `componentMap` を使わず、クリック位置から `finalMask` を **その場で局所
  flood fill** する (`floodFillAssignLabel`, 26-連結)。常に最新の連結性を辿るので、**本当に非連結**なら
  他島へは波及しない (旧 componentMap ベースの stale 波及は解消済み)。
- それでも「両方塗られる」場合、最有力の原因は **3D 連結**: polygon/brush の erase は 1 スライス単位
  なので、見た目 2D で分離したつもりでも隣接スライスで繋がっていれば 3D 的には 1 連結成分 → assign
  (3D flood) は両方を塗る。これは連結性 (6 vs 26) の問題ではなく「どこまで erase したか」の問題。
- **診断手段**: voxel inspector (Ctrl+Shift+D) を ON にすると mask 各層 (threshold / manual /
  final / component id) を表示する。2 つの segment を hover して同じ component id なら 3D 連結。
  gap を各スライスで hover し final==0 か確認すると、どのスライスで繋がっているか特定できる。
- 連結性は findIslands / summarizeLesions / assign すべて 26-連結で統一 (inspector の component 欄が
  assign 波及範囲をそのまま予測する)。

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
