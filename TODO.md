# TODO

`metavol-web` の作業 backlog。CLAUDE.md はリポジトリ規約・アーキテクチャの恒久的なリファレンス、こちらは変動の激しいタスク管理を担当する。

---

## 完了済み

- ~~PET 標準ビュー（CT axial / PET axial / Fusion axial / PET MIP の 2×2）ワンクリック~~ ✅
- ~~MIP にもマスク overlay~~ ✅
- ~~閾値 UI を combobox 化（2.5 / 3.0 / 3.5 / 4.0 / manual）~~ ✅
- ~~ラベル波及の仕様再定義（バグ #2 関連）~~ ✅ componentMapValid invalidate
- ~~UI デザイン全体刷新（モダン化）~~ ✅ 3カラム + ダークテーマ
- ~~NIfTI ロード対応 (.nii / .nii.gz)~~ ✅ `nifti.isCompressed/decompress`
- ~~NIfTI ロード時の modality 推定~~ ✅ filename ベース (`detectModalityFromFilename`)。手動指定 UI も SeriesList に存在
- ~~「全体化」ボタン (edge-to-edge tiles)~~ ✅ `noGapMode`
- ~~Fusion 操作改善 (modality chip drag-and-drop)~~ ✅
- ~~Sidebar SERIES 直下の矢印ボタン削除~~ ✅
- ~~断面支持線 (cross-reference lines)~~ ✅
- ~~サムネ paging を wheel 化~~ ✅ `onThumbWheel`
- ~~ImageBox 名称整理 (DicomSliceImageBoxInfo)、4隅 patient/exam overlay、bilinear、Ctrl+wheel ズーム~~ ✅
- ~~DICOM tag ボタンをハンバーガーメニューに~~ ✅
- ~~タイトル metavol → metavol-web~~ ✅
- ~~Polygon ROI アイコン五角形化~~ ✅
- ~~VolumeBox では DICOM tag view 非対応~~ ✅
- ~~Series card に DICOM/NIfTI 種別表示~~ ✅ (2026-05-02)
- ~~ロード後シリーズ数に応じて tileN 自動設定 + 各 Box にシリーズ割当~~ ✅ (2026-05-03) `autoLayoutAfterLoad`
- ~~Stop / Notification 時の Windows トースト + サウンド~~ ✅ (2026-05-03) `~/.claude/notify.ps1` (後に削除)
- ~~Inspector 内の preprocessing 系ツール (CT bed removal, MR-PET registration) を ☰ メニューに移管~~ ✅ (2026-05-03)
- ~~Fusion D&D を DicomSlice からも可能に + Fusion box titlebar に blend slider~~ ✅ (2026-05-03)
- ~~Series card description 独立行 / "XX files" 削除 / image overlay 即時表示~~ ✅ (2026-05-03)
- ~~NAC PT は SUV 換算抑止 (suvFactor=1 強制 + Bq/ml 表示)~~ ✅ (2026-05-03)
- ~~Cross-box mutation: refreshSegStoreVolumeRefs が active を上書きする bug 修正~~ ✅ (2026-05-03)
- ~~Make MPR (this box) で window/CLUT を保持 + 正しい box id へ書込み~~ ✅ (2026-05-03)
- ~~PET window preset に 0-100/1000/10000 追加 (Other ▾ pulldown)~~ ✅ (2026-05-03)
- ~~Fusion box CLUT を base/overlay の 2 ボタン化 (modality badge 付き)~~ ✅ (2026-05-03)
- ~~Fusion box の W/L drag が base/overlay どっちか明示する toggle~~ ✅ (2026-05-03)
- ~~ImageBox 複製ボタン (More メニュー → Duplicate this box)~~ ✅ (2026-05-03)

---

## 戦略: 3 ペルソナのエンドツーエンド完成

### Persona 1: PET/CT segmentation (オーソドックスユーザ)
DICOM ロード → PET Standard → SUV threshold → manual ROI 編集 → MTV/TLG 測定 → NIfTI 保存
- 現状 90% 完成。Inspector の polygon ROI / Sphere ROI / Labels / Histogram / Save 動線あり
- 残: lesion 一覧の export 改善、レポート出力 (Phase 2)

### Persona 2: Quick viewer (DICOM/NIfTI さっと見たい)
URL クリック → ロード → 見て閉じる
- 現状 70% 完成。ファイル D&D / NIfTI auto-detect 動作
- 残: URL に file リンクを埋めて即ロードする shareable link、アップロード UI 簡素化、ロゴ/シェア boilerplate 削減
- 「3 秒以内に画像が出る」UX が目標

### Persona 3: PET/MR + radiomics (ヘビーユーザ)
別撮影 PT/MR ロード → MR-PET register → MR ベースで ROI → ROI 内 PET radiomics 抽出
- 現状 40% 完成。Auto-register MR↔PET (☰ Preprocessing) 動作、blend slider あり
- 残: ROI を MRI で描画 → そのまま PET 値抽出する明示的 workflow、radiomics features の export
- 課題: 現状 Sphere/Polygon ROI は PET 格子で保持。MRI-defined ROI を PET に転写する path なし

---

## 未着手 / 継続中

- **マスクロード round-trip**: `niftiReader.ts` は実装済だが、SegmentationPanel からの読込フローが segmentation store に反映されるか未検証。書いて読み戻す e2e テストが必要
- **composable 切り出し**: `DicomView.vue` (~1900行) を `useSphereROI` / `usePolygonROI` / `useDebug` 等に分解
- **バンドル 500KB 超**: `vite build` 時 warning。manual chunk 分割（vendor / nifti / dcmjs-codecs を分離）

### NIfTI 「raw byte array」表示モード (将来実装、Persona 2 向け)

NIfTI ヘッダの affine / orientation を **無視**して、ファイル内 byte 配列の物理ストレージ順をそのまま画面に再現するモード。
- innermost dim (= fastest-varying = pixel データの先頭から連続する軸) を **screen X (左→右)**
- middle dim を **screen Y (上→下)**
- outermost dim (= slowest-varying) を **paging 方向**
- WC/WW は voxel 値の min/max から自動推定 (rescale slope/intercept は無視)
- modality / SUV factor も無視 (raw counts そのまま)

UI 案: NIfTI series card のメニュー or ☰ から "Inspect NIfTI bytes" として開く専用 box。軸ラベルを 4 隅に表示 (例: "X: dim0 (innermost)" / "Y: dim1" / "Z: dim2 (paging)").

背景: NIfTI ヘッダの qform/sform は信頼性が低いケースがある。byte レベルで「データがどう詰まっているか」を見たい用途 (orientation バグの検証、研究用 raw export の確認)。

### Fusion 系統の整理（2026-05-03 検討）

現在 fusion / multi-box layout を起こす経路は 5 系統あり責務が重複している:

| # | 起点 | 実装関数 | 性質 |
|---|---|---|---|
| 1 | App-bar 「PET Standard」 | `setupPetStandardView` | 全体レイアウト書換 (2×2) |
| 2 | App-bar 「Fusion」 | `fusion()` | アクティブ Box 1 つを Fusion 化 |
| 3 | Layouts プルダウン | `setupTriplanarPt` 等 | 1×3 / 2×2 / 1×2 プリセット |
| 4 | modality chip drag-and-drop | `fuseSeriesIntoBox` | 対話的、target 平面保持 |
| 5 | Sidebar series card drop | `onSelectSeriesIntoBox` | シリーズ単純差替（Fusion ではない） |

統合案:
- **「Fusion」ボタンは廃止**（modality chip drag-and-drop で代替）
- **「Layouts」プルダウンと「PET Standard」を統合**したコマンドパレット風 UI
- (5) の card drag は名前を「Load into box」に変えて Fusion と区別

---

## 2026-05-03 追加タスク

### 外部ライブラリーの一覧化 (NOTICES / THIRD_PARTY_LICENSES)
- `package.json` の dependencies / devDependencies すべてについて、ライブラリー名、バージョン、ライセンス種別 (MIT / Apache-2.0 / BSD-3-Clause 等)、コピーライト表記、入手元 URL を一覧化する
- 必要なライセンス表示 (license text、attribution) をビルド成果物 (`dist/`) または README に同梱する。MIT/BSD は LICENSE 文の保持が必須
- 対象（現時点）: `@mdi/font`, `axios`, `dcmjs-codecs`, `dicom-parser`, `jpeg-lossless-decoder-js`, `nifti-reader-js`, `pinia`, `roboto-fontface`, `three`, `vue`, `vuetify`, devDeps（sass、unplugin-fonts、unplugin-vue-components、vite、vite-plugin-vuetify、vue-tsc 他）
- 自動化: `license-checker` や `npm-license-crawler` で初回生成、以降 dependency 追加時に再走査

### ライブラリー必要性の精査（NOTICES 完成後）
各 dependency が実際に使われているか / 軽量代替があるか / 自前実装可能かを判定:

- `axios` — 実コードで本当に必要か (fetch で代替可能なら削除)
- `roboto-fontface` — Inter / JetBrains Mono がメインなら不要可能性
- `@mdi/font` — 大量のアイコンを含むが実使用は数十個。tree-shake できる alternative (`@mdi/js`) を検討
- `three` — Volume Rendering / 3D 用途で使用中。voxel / matrix 計算だけなら gl-matrix の方が軽量
- `dcmjs-codecs` — JPEG Lossless 復号で使用、別エンコーディング DICOM が来ない運用なら不要

削減できればバンドル 500KB 問題の根本対策にもなる。

---

## ペルソナ別の現状サマリ (2026-05-03 commit e649358 時点)

### Persona 1 (PET/CT segmentation, MTV/TLG 測定) — **完成度 95%**
- ✅ DICOM ロード (PET+CT) → autoLayout で multi-tile DicomSlice
- ✅ PET Standard ボタン → 2x2 (CT axial / PET axial / Fusion axial / PET MIP)
- ✅ Threshold (SUV preset 0-3 / 0-6 / 0-10 / 0-15 / Other 0-100/1000/10000)
- ✅ Sphere ROI / Polygon ROI (slice add/erase, Esc, Ctrl+Z)
- ✅ Find islands + Assign label
- ✅ Lesion table (SUVmax, SUVmean, MTV, TLG)
- ✅ **Lesion CSV export** (`#, Label, SUVmax, SUVmean, MTV_cc, TLG, VoxelCount, Centroid xyz mm`)
- ✅ NIfTI mask save + JSON sidecar
- ✅ NIfTI mask **load (round-trip)** with seriesUID validation
- 残: lesion 別 SUV histogram、SUVpeak (1cc sphere centered at SUVmax)、PDF レポート出力

### Persona 2 (Quick viewer) — **完成度 85%**
- ✅ DICOM/NIfTI ファイル D&D
- ✅ 自動 modality 推定 (NIfTI filename heuristics)
- ✅ Series card に description / DCM/NII chip / matrix size
- ✅ Image overlay (Image X/N, patient info corners) 即時表示
- ✅ Ctrl+wheel zoom / 中ボタン pan (Volume / DicomSlice 両対応)
- ✅ Box 複製 (More メニュー → Duplicate this box)
- ✅ **Shareable URL** `?url=https://...` で直接ロード (commit e649358)
- 残: NIfTI raw byte view (TODO に詳細)、デモデータの公開リンク
- 残: MIP / cor / sag への切替がもっとワンアクションで (現在は plane menu)

### Persona 3 (PET/MR + radiomics) — **完成度 70%**
- ✅ MR-PET registration (☰ Preprocessing → Auto-register、進捗 chip 付き)
- ✅ Fusion D&D (modality chip drag → 任意 box)
- ✅ Fusion box の base/overlay 別 CLUT + W/L active layer toggle
- ✅ Blend slider in titlebar
- ✅ **MR Volume box で Polygon/Sphere ROI 描画 → PET grid に保存** (アーキテクチャ的に既に支持。screen→world→PET voxel 変換)
- 残: MR ROI 描画時の UX cue (「PET grid に保存されます」のヒント表示)
- 残: radiomics features (texture: GLCM/GLRLM/GLSZM 等) の export
- 残: 複数 ROI を横並びで radiomics score 比較する UI (DataBox 抽象が活きる場面)

---

## 2026-05-03 後半セッションで追加されたトピック

### Fusion MIP / Volume Rendering (次セッション着手予定)
- 現状 PET Standard の MIP は PT 単独。Fusion MIP (CT 上に PT MIP overlay) は未実装
- VR 経路 (`drawNiftiVR`) は単一レイヤのみ
- ユーザ確認済: **Plan B** (true volume composite ray-cast) を採用予定 (10-15h)

#### 詳細設計 (Plan B)
1. 新関数 `drawNiftiSliceFusionVR(ct..., pt..., angle, alpha)` を `ImageBox.vue` に追加
2. ロジック (drawNiftiVR を base に拡張):
   ```
   for each canvas pixel (i, j):
     for ray step t = 0..N:
       world point P = origin + t * dir
       sample CT at worldToVoxel_(P, ctIdx) → ctValue, ctAlpha=transferFn(ctValue)
       sample PT at worldToVoxel_(P, ptIdx) → ptValue, ptAlpha=transferFn(ptValue)
       blendedColor = ctClut(ctValue) * (1-alpha) + ptClut(ptValue) * alpha
       blendedAlpha = max(ctAlpha, ptAlpha)
       composite front-to-back into accum
       early exit if accumAlpha > 0.99
   ```
3. UI: Fusion box の plane menu に "VR" 追加 (現状 mip / smip / vr は Volume box only)
4. `FusedVolumeImageBoxInfo.isVr: boolean` 追加 + showImage 分岐
5. パフォーマンス: WASM SIMD 化検討。ピュア JS で 64×64×64 = 200ms 想定。512^3 だと数秒 → fast mode (stride=2) と組合せ
6. 既存 blend slider (overlayAlpha) を流用: Fusion VR でも base/overlay 比を制御
7. リスク: PT (低解像) と CT (高解像) で sample 数が大きく異なる → ray step は CT 解像度基準で OK

### LiteMedSAM AI ROI: 中止 (2026-05-04)

ONNX 化のハードルが高く、ユーザ判断で中止。`segmentation/medSam.ts` / `aiRoi` toolbar entry / `onnxruntime-web` 依存はすべて削除済。
代替案 (smart click region growing 等) も別途検討中だが現時点では未着手。

### GPU MI + rigid registration (将来課題, 2026-05-04 棚上げ)

現状 `src/components/registration/` は純 JS 単一スレッド。MI 計算 (32-bin joint histogram × 8000 sample × 数百 iter × 3 level) で 5-30 秒 main thread block。

**設計案** (実装時の参考):
- WebGPU compute shader で MI 評価を 1 dispatch 化
  - bind: PT 3D tex, MR 3D tex, sample point buffer, fixed/moving min/max uniform, rigid params uniform
  - thread per sample: trilinear sample 両方 → bin index → atomic add into joint histogram (storage buffer)
  - 戻りで joint histogram を CPU に readback → MI 計算 (これは軽い)
- 期待: 5-30 s → 0.1-1 s、main thread freeze 完全解消
- 既存 webgpu/gpuContext / volumeCache を流用可
- 工数 10-15h

セット候補: WebGPU MI + abort UI (1h) + 手動 nudge UI (3-5h)。合計 14-21h。
現状ユーザ需要は低いので保留。

### 遠い将来の夢: VR デモに BGM

VR auto demo (vrDemo.ts、~30s シネマ) 再生中にバックグラウンド音楽を流す。
案:
- 短い royalty-free 軽音楽 (orchestra ambient / piano / strings) を `public/audio/` に配置
- WebAudio API で fade-in/out
- demo 終了で auto-stop
- toggle UI: VR demo ボタン横に 🔊 アイコン
工数 ~2h。視覚的なインパクトが強いだけに音もあると "あっと言わせる" 度合いが格段に上がる。

### 遠い将来の夢: 骨シンチ (planar) + CT 2D fusion

ユーザ提案 (2026-05-04):
- 骨シンチ = 平面像 (anterior/posterior 1 枚 or 2 枚)。DICOM だけでなく PNG/JPG で配布される
  ことも多い。
- CT volume を coronal MIP / sum projection で 2D 化 → 同じ平面に並べる。
- 2D mutual information で 2 画像を rigid (translation + scale + rotation) に整合。
- アウトプット: 骨シンチに hot spot がある場所を CT 上で局在化。

実装スケッチ:
- `loadFiles` を PNG/JPG 拡張。`createImageBitmap(file)` → canvas → grayscale Float32Array。
  既存 NIfTI/DICOM 経路と分離した 2D-only 系統が必要 (Volume ではないので Box は DicomSlice
  or 専用の "PlanarBox" を新設)。
- CT 2D 化: 既存 drawNiftiMip (sum or max projection) の出力を Float32Array で取り出す。
- 2D MI: 既存 src/components/registration/mi.ts の 3D ロジックを 2D に縮退 (sample 点を
  z = 1 に固定)。32-bin joint hist。3-DOF (tx, ty, rotation) optimizer。affine 化なら 6-DOF。
- UI: PNG/JPG drag & drop accept、整合ボタン → 結果プレビュー。

**さらに遠い夢**: 骨ごとに rigid。CT を骨 segmentation (例: TotalSegmentator の bone 出力 or
own threshold) → 各骨を独立に剛体移動 → 2D 投影で骨シンチに合わせ込み。
- 必要技術: 多体 rigid + 制約 (隣接骨は近接維持)、または bone-by-bone deformable like
  ICP variant。
- 工数想定: 50-100h、複雑系。論文・実装も少ない。

### Dosimetry (single-timepoint simplified, 次セッション)
ユーザ確認済: single-timepoint approximation (6-10h)。

#### 設計
- 1 時相 SPECT/PET をロード → organ ROI 内 activity を測定
- 仮定: tracer half-life で物理崩壊、生物学的半減期は organ-specific table から
- 累積活性 Ã (Bq·s) = A0 × τ_eff、τ_eff = T_half_eff / ln(2)
  - T_half_eff = (T_half_phys × T_half_bio) / (T_half_phys + T_half_bio)
- 線量 D (Gy) = Ã × S-value (Gy/Bq·s)
- S-value table を bundled JSON に持つ (organ × source / target、tracer dependent)
  - 主要なのは Lu-177, Y-90, I-131 (theranostics)

#### 必要な新規モジュール
- `src/components/dosimetry/sValueTables.ts` — organ × source/target × tracer の S-value JSON
- `src/components/dosimetry/biologicalHalfLife.ts` — organ-specific T_bio table
- `src/components/dosimetry/activityToDose.ts` — D = Ã × S 計算
- UI: Inspector に新セクション "Dosimetry" — organ ROI list + 計算結果
- 出力: organ 別 Gy/MBq テーブルの CSV export
- 実装コスト: 6-10h、データ table 整備が半分

### Manual ROI 編集の細かい不具合 (詳細未確認、まとめて見直す)
- polygon が 1 スライスズレるケース (CLAUDE.md 既知バグ #1 関連、修正済? 要確認)
- erase でラベル波及が不完全 (CLAUDE.md 既知バグ #2 関連)
- undo stack が大きくなりすぎてメモリリーク傾向の可能性
- sphere ROI と polygon ROI 同時編集で挙動不定
- Ctrl+Z で polygon と segmentation mask の両方が undo される / されない不整合
→ 別セッションで集中的に潰す

### Snapshot / セッション保存・復元 (議論あり、設計未確定)
- 現状の auto-save は IndexedDB に書込まれている (useAutoSave composable)
- ユーザー要望: ファイルとして download できると安心
- 案 A (download): mask + 全 box state + active series UID 等を JSON にして download。リロード後 upload で復元
- 案 B (login + cloud storage): GitHub Pages では backend 持てないので、Firebase / Supabase / Vercel KV のような BaaS が必要
- GitHub Pages + 認証: client-side で OAuth は可能 (GitHub App / Auth0 等) だが、保存先 backend は別途必要 (例: gist API でユーザの GitHub gist に保存、Read/Write 権限)
- 案 C (export-all): 1 case = 1 ZIP (mask.nii + state.json + sidecar) を 1 file で download。最も単純で GitHub Pages のままで OK

### 公開デモデータのホスティング
- 同 HTML サーバ (GitHub Pages) で `public/demo/*.nii.gz` として配置 → 100MB/file 制限あり、合計 1GB ソフト上限。小さい NIfTI なら OK
- 巨大 DICOM フォルダは GitHub Releases (2GB/file まで) または別 CDN (Cloudflare R2 / Backblaze B2) を検討
- 現時点で推奨: 小さい demo (10-50MB level) を `public/demo/` に置き、`?demo=lung01` 等で起動 (loadFromExternalUrls の派生)

### pyradiomics 完全互換 (遠い将来)
現在の `radiomics.ts` は IBSI/pyradiomics 完全準拠ではない。研究論文用の数値が必要なケースで:
- IBSI strict gray-level discretization (fixed bin width vs fixed bin count)
- すべての GLCM / GLRLM / GLSZM / NGTDM / GLDM features (合計 ~75 features)
- ROI normalization / resampling / interpolation の選択肢
→ 着手するなら別セッション。pyradiomics リファレンス実装と数値比較しながら進める

## 次の優先順位 (commit e649358 以降)

1. **DataBox abstraction Phase 1** (P1-A): `BoxTitlebar.vue` 抽出。機能変化なし refactor
2. **NOTICES / THIRD_PARTY_LICENSES** (P2-A): `license-checker` で生成、配布物に同梱
3. **MR ROI UX cue** (Persona 3 仕上げ): 描画開始時に「This ROI will be stored on PET grid」インラインヒント
4. **公開デモデータ** (Persona 2 仕上げ): `public/demo/*.nii.gz` + `?demo=lung01` mapping
5. **バンドル分割** (P2-C): manual chunk
6. **DicomView.vue composable 化** (P1-B): `useSphereROI` / `usePolygonROI` 等
