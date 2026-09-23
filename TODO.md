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

## 戦略: 4 ペルソナのエンドツーエンド完成

### Persona HUNTER: PET/CT segmentation (オーソドックスユーザ)
DICOM ロード → PET Standard → SUV threshold → manual ROI 編集 → MTV/TLG 測定 → NIfTI 保存
- 現状 90% 完成。Inspector の polygon ROI / Sphere ROI / Labels / Histogram / Save 動線あり
- 残: lesion 一覧の export 改善、レポート出力 (Phase 2)

### Persona ATLAS: 脳 PET の解剖学的標準化 + VOI テンプレート (2026-08 新設)

正規化 (MATLAB/SPM) は各自の PC。metavol-web は **DICOM→NIfTI** と
**正規化済み NIfTI + VOI テンプレート → 領域値** を担う。実装済み (CLAUDE.md 参照)。

### Persona COURIER: Quick viewer (DICOM/NIfTI さっと見たい)
URL クリック → ロード → 見て閉じる
- 現状 70% 完成。ファイル D&D / NIfTI auto-detect 動作
- 残: URL に file リンクを埋めて即ロードする shareable link、アップロード UI 簡素化、ロゴ/シェア boilerplate 削減
- 「3 秒以内に画像が出る」UX が目標

### Persona MINER: PET/MR + radiomics (ヘビーユーザ)
別撮影 PT/MR ロード → MR-PET register → MR ベースで ROI → ROI 内 PET radiomics 抽出
- 現状 40% 完成。Auto-register MR↔PET (☰ Preprocessing) 動作、blend slider あり
- 残: ROI を MRI で描画 → そのまま PET 値抽出する明示的 workflow、radiomics features の export
- 課題: 現状 Sphere/Polygon ROI は PET 格子で保持。MRI-defined ROI を PET に転写する path なし

---

## DICOM → NIfTI 変換 (2026-08-13 実装)

CLAUDE.md「DICOM → NIfTI 変換」に詳細。`npm run check:d2n` で affine 往復・voxel 可逆・
.nii.gz の復元まで確認済み (CT/PET とも PASS)。

- [ ] **手動検証 (ユーザ)**: 左サイドバーのシリーズカード「…」→ Export as NIfTI が
      **box に出していないシリーズでも**動くこと。Save メニューの Convert all series が
      全シリーズぶんダウンロードされること (ブラウザの複数ダウンロード許可が要る場合あり)。
      出力を他ツール (3D Slicer / TotalSegmentator など) で開いて位置が合っていること。
- [ ] 残り: **DICOM の生画素ではなく変換後の値** (PT=SUV / CT=HU) を出している点。
      生の Bq/ml や raw stored value が要るなら別オプションが要る。sidecar に
      `suvFactor` があるので割り戻しは可能。
- ~~1 シリーズ = 2 ファイル~~ ✅ **zip 1 個にまとめた** (2026-08-14)。2 件目のダウンロードが
      ブラウザに落とされて sidecar が出ない不具合の修正を兼ねる。
- [x] **UI から無反応だった不具合を修正** (2026-08-14) — `Sidebar.vue` のイベント中継漏れ。
      内部関数を直接呼ぶ `check:d2n` は PASS していたので気付けなかった。
      **UI 操作から検証する `npm run check:d2n-ui` を追加**した。

## SPM 標準脳変換 + VOI テンプレート解析 (2026-08-17 実装)

CLAUDE.md「SPM 標準脳変換 + VOI テンプレート解析」に詳細。
`npm run check:voi` (独立実装との突合を含む) と `npm run check:voi-ui` (UI 操作) が両方 PASS。

**動く範囲**: SPM で正規化した NIfTI を drag&drop → ハンバーガーの **VOI analysis…** →
テンプレート (`labels_Neuromorphometrics.nii` + `.xml`) を読み込み → シリーズを選んで Run →
136 領域の voxel 数 / 体積 / mean / SD / min / max → CSV 出力。

- [ ] **手動検証 (ユーザ)**: 実際の症例で通し、**数値が SPM/MarsBaR などの既存手段と一致するか**。
      スクリプトは「アプリ内で自己整合」と「Node の独立実装と一致」までしか保証していない。
      **外部ツールとの一致は未確認。**
- [x] **overlay 表示** ✅ (2026-08-17) — 既存のマスク overlay (`MaskOverlay`) を流用。
      ImageBox は 1 行も変えずに CPU/GPU 両方で描画できた。重ねるのは **labelOf (割り当て結果)** で
      アトラス原本ではないので、見えているものと表の数値が必ず一致する。
      `npm run check:voi-ui` が canvas の画素を読んで着色率を検査 (ON 62.4% / OFF 0.0%)。
      - [ ] 手動検証: 45% 既定だと脳全体が覆われて下の解剖が見づらい。実用上ちょうどよいか、
            **輪郭表示 (境界だけ描く) モードが要るか**は使ってみての判断待ち。
- [ ] 参照領域比 (SUVR) — 今回スコープ外。統計は純関数なので上に足せる。
- [ ] 左右差 / Z スコア / **複数症例のバッチ処理** — 同上。
- [ ] `scl_slope`/`scl_inter` の適用 (`loadNii`) — **今回のファイルは両方 slope=1 なので
      発火しない**が、他の SPM 出力 (int16 書き出し等) では値が定数倍ずれる。VOI 専用の
      loader (`parseNiftiLabelVolume`) では既に適用済み。既存の読み込み経路は未修正。

## Persona ATLAS (脳 PET + VOI) の満足度向上 (2026-08-19 着手)

**全体フロー**: ① 病院から DICOM → ② metavol-web で .nii 保存 → ③ SPM12 で normalize (`w*.nii`)
→ ④ metavol-web で開く → ⑤ テンプレート読込 → ⑥ 領域値 → ⑦ CSV

- [x] **⑤ でテンプレートの一致を目視できるようにした** (2026-08-19)。読み込み時に自動解析まで走らせ、
      overlay・診断・表が即出る。Run を押す手間も 1 つ減った。`npm run check:voi-ui` で検査。
- [ ] **② の摩擦**: SPM12 は `.nii.gz` を直接読めないのに、メニューは `.nii.gz` を
      「recommended」と表示している。**Persona ATLAS の用途では逆**。さらに両方 zip 包装なので
      「展開 → (gz なら) gunzip → SPM」の手数がかかる。SPM 向けの導線を用意する。
- [ ] **テンプレートを憶える** (localStorage / IndexedDB)。現状リロードで消え、症例ごとに
      2 ファイル選択し直し。**繰り返し作業で最も効く。**
- [ ] **参照領域比 (SUVR)** — 小脳・橋などを基準にした比。臨床でまず要る。
- [ ] **複数症例のバッチ処理** — 現状 1 症例ずつ。1 枚の CSV (症例 × 領域) に。
- [ ] 表の行クリックでその領域へジャンプ (Persona HUNTER の lesion table にはある)。
- [ ] VOI 結果・テンプレートが **snapshot (.mvs) にも自動保存にも入っていない**。
- [ ] VOI 領域値が **PDF / PPTX レポートに入らない** (現状 MTV 用のみ)。

## VOI ワークフローの使用感からの指摘 (2026-08-18)

- [x] **modality 不明でも見える window にする** ✅ — 分位点から自動決定 (`volumeWindow.ts`)。
      Window preset も不明を MR と同じ「Auto/Tight/Wide」に。実測 WC3.03/WW6.05。
- [x] **VOI 統計を NaN 安全に** ✅ — SPM 出力は視野外が NaN (実測 0.74%)。`nanVoxels` 列を追加。
- [x] **ファイル名の SPM 接頭辞を飛ばす** ✅ — `wPT_...` → PT。metavol-web→SPM→metavol-web が繋がる。
- [ ] **w00r.nii のような外部ファイルの PT 自動判定は見送り**。voxel 値では PT/MR を区別できず、
      正規化を通すと PET の指紋 (大きな負値) も消える (CLAUDE.md 既知バグ 4 に実測表)。
      現状は `Set as PT` の 1 クリック。**より良い案があれば要検討**:
      - metavol-web の書き出し側で NIfTI の `descrip` や `intent_name` に modality を埋め、
        SPM が上書きしないフィールドを探す (SPM は descrip を "Warped" で潰す)
      - sidecar JSON を SPM 後も手で持ち回る運用にする
- [ ] **小さい matrix の volume が 1 voxel = 1 画素で開く** (実測: 79x95 の脳が
      1203x875 の box に 4374 画素ぶんしか占めない)。**「Fit to window」を押しても変わらない**
      (あれは box の寸法を合わせるもので、画像の拡大率は変えない。実測 4374 → 4374)。
      現状の拡大手段は **Ctrl+ホイール** (実測 6 回で 4374 → 13636 画素)。
      → volume box を作るとき、**box に収まる倍率を初期値にする**のが素直。要検討。
- [x] 実際の Load files… 経路を実行して確認済み (`node scripts/voi-walkthrough.mjs`)。
      読み込んだ時点で volume box として表示され、自動 window も効く。

## 手動検証待ち (ユーザが手を離せるとき / 2026-08-12 時点)

コードは入っていて型チェック・ビルド・スクリプト検証は通っているが、**実際の画面で人の目による
確認が済んでいない**もの。スクリプトで代替できない (見た目・操作感の判断が要る) 項目だけを挙げる。

- [ ] **registration の適用可否ゲート** — hirata2 で auto-register が実行されず理由が出ること。
      metmri / Hirata20260728 では従来どおり動くこと。(上の registration 項目に詳細)
- [ ] **bed removal** — kitty で寝台が消え、体表が削れていないこと。
      app-bar の Remove CT bed メニューで、下面カット (mm) と **Crop margins の 6 面** が
      期待どおり効くこと。数値は `npm run check:crop` で検証済み (6 面とも bbox が要求量ぶん移動)
      だが、**「削りすぎて体表が欠けていないか」は目で見ないと分からない**。
- [ ] **surface projection (sMIP)** — kitty で体表が滑らかに出ること。閾値自動 (Otsu -672) が妥当か。
      縞・ノイズが出ていないか。
- [ ] **LLM tool calling** — Ollama 起動状態で「シリーズを教えて」「今の表示は？」に正しく答えるか。
      qwen2.5:3b で 15〜17s かかる往復が実用に耐えるか。
- [ ] **マスク round-trip の UI 外殻** — 中核の往復はスクリプトで検証済 (差分 0)。
      残るのはファイル選択ダイアログ、sidecar JSON の同時選択、PT seriesUID 不一致時の
      confirm ダイアログの 3 点。
- [ ] **paging の `invert: true` 分岐** — スライス順が逆のシリーズで ↑ が常に頭側になるか。
      実データで逆順のシリーズが手元にあるか自体が未確認。

## セッション保存のサイズ / コスト (2026-08-12 実測で判明)

CLAUDE.md「セッション保存のサイズとコスト」に詳細。実測は Hirata の PET 256x490x146 (18.3M voxel)。

- ~~Snapshot が 139.7MB になり読み戻しでページが落ちる~~ ✅ **修正済** — mask を gzip する v2 形式に。
  読み込みは v1 も受ける。`npm run check:snapshot`
- [x] **自動保存のコスト (一部改善、2026-08-13)** — `node scripts/autosave-cost.mjs`
      - 採用: **`finalMask` を保存しない** → 104.79MB → 69.86MB (33% 減)、コピー 30.6→25.7ms
      - **不採用: gzip** → 690 倍に縮むが **2108ms** かかる。2 秒ごとの自動保存には使えない
        (一度きりの snapshot 保存でだけ使っている)
      - [ ] **まだ 178ms かかる。IndexedDB 書き込みが支配的** (153ms)。壁時計では改善が見えていない。
            さらに詰めるなら書き込み側 (差分保存 / Worker へ逃がす) を見る

## MIP の回転軸が volume の k 軸固定 (未解決)

`mipShader.ts` / `ImageBox.drawNiftiMip` は **index 空間の (x, y) 平面で回す** = k 軸まわり。
axial 撮像でのみ体軸まわりの回転になる。

**実害が確定している**: Hirata20260728 の PET は 256x490x146 / 2.34mm 等方で、
全身の長軸 (490 x 2.34 = 1147mm) が **j 軸**。つまり k 軸は体軸ではないので、
このシリーズの MIP は体軸まわりに回らない。`node scripts/axis-orientation.mjs` で各軸の
world 方向を出せる。

- [ ] 直し方の案: index 軸の**置換**を uniform で渡し、「体軸に最も近い index 軸」を
      MIP の縦軸に割り当てる。world 空間への完全な書き直しより安く、axial/coronal/sagittal を
      カバーできる (実務上この 3 つは軸の置換で表せる)。
- [ ] **shader 変更なので目視確認が要る。** sMIP の見た目 (陰影/閾値) を壊さないこと。

## 未着手 / 継続中

### ★最優先: 画像重ね合わせ (registration) — **部分解決** (2026-08)

幾何を壊す 2 つのバグ (`applyRigidToVolume` の正規化 / `estimateIntensityRange` の姿勢依存) を
修正し、**視野が同等なペアでは機能するようになった** (Hirata mTRE 1.6mm、metmri 収束確認)。
詳細は **CLAUDE.md 3.58**。

**ただし視野が大きく食い違うペアは未解決** (CLAUDE.md 3.59)。hirata2 (CT=胸部 413mm ×
PET=全身 1148mm) では MI / NMI / 体内限定 / 形状の **5 指標すべてが正解を指さない**。
現状は `assessFeasibility` が z 方向の広がり比 1.6 倍以上を検出して**自動位置合わせを実行しない**。

- [ ] **手動検証 (ユーザ)**: hirata2 を開いて CT に PET を fuse → auto-register が実行されず
      理由ダイアログが出ること / 手動 alignment で合わせられること。
      metmri と Hirata20260728 では従来どおり動くこと。
      検証補助: `node scripts/reg-feasibility-check.mjs --case hirata2`
- ~~肺プロファイル相関~~ ❌ **不採用** (2026-08-12、4 症例で検証)。CLAUDE.md 3.595 に詳細。
      体シルエットの定義 (行のみ / 行+列) を変えるだけで答えが数十 mm 動き、**どちらの定義も
      4 症例すべてを通せない**。hirata2 と Hirata20260728 だけで「誤差 5mm」と見えたのは、
      この 2 例が **CT 同一シリーズ**だったため。別患者 (cervicalca / dicom) で崩れた。
      → **既定は 3.59 のゲートのまま**。視野非対称の症例は手動 alignment が主。
- [ ] **本命の解法 (より一般)**: 解剖ランドマークベース (TotalSegmentator の臓器ラベル同士)。
      肺プロファイルは肺が両方に丸ごと写っている症例に限られる。→ 下の TotalSegmentator 項目と直結

- ~~**マスクロード round-trip**~~ ✅ 検証済 (2026-08-12) — `node scripts/mask-roundtrip.mjs`。
  Hirata の PET 256x490x146 で writeNiftiUint16 → readNiftiMask → `store.loadMaskFromNifti` の往復が
  **差分 0 voxel**、多ラベル (2 種 × 106,668) 保持、voxel pitch 誤差 0、sidecar の threshold/labels 復元、
  dims 不一致の拒否まで確認。**未カバー**: `<input type=file>` の選択ダイアログと
  `onLoadMaskFiles` の外殻 (sidecar JSON パース、PT seriesUID 不一致の confirm)。ここは手動検証側。
- **composable 切り出し**: `DicomView.vue` (~1900行) を `useSphereROI` / `usePolygonROI` / `useDebug` 等に分解
- **バンドル 500KB 超**: `vite build` 時 warning。manual chunk 分割（vendor / nifti / dcmjs-codecs を分離）

### NIfTI 「raw byte array」表示モード (将来実装、Persona COURIER 向け)

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

## ペルソナ別の満足度スコア (2026-09-22 実測、2026-09-23 の改善後に再計測)

中核ジャーニーを UI 操作で実測 (`node scripts/persona-satisfaction.mjs`、要 dev サーバ)。
スコア = ジャーニー到達度 + 摩擦 (クリック/時間) + 既知ギャップの主観評点。

| ペルソナ | スコア | 実測 (読み込み操作を除く) | 最大の不満点 |
|---|---|---|---|
| HUNTER | **93** | **6 クリック** / 作業 ~11s で Lesions CSV (146 病変)。表は Apply で自動展開、行の「…」で付け替え/削除 (Ctrl+Z 可) | rename/merge/split (病変の永続 identity が必要)。multi-timepoint |
| ATLAS | **85** | 4 クリック / 1.4s で 136 領域 CSV + **SUVR 列** (参照は症例間で保持) | バッチ・テンプレート記憶・左右差/Z スコア。SPM 往復は各自 MATLAB |
| COURIER | **85** | 表示まで nii 1.3s / DICOM 4.2s。**?url=&mvs= の 1 リンクで view ごと共有**、?demo=phantom、.mvs d&d | 公開デモの実データ未配置。断面切替のワンアクション化 |
| MINER | **65** | Radiomics CSV 2.1s (HUNTER のマスクから) | 視野非対称の registration は手動が主 (仕様)。radiomics 結果の UI が素朴 |
| PILOT | **35** | (静的評価) 論文パイプライン 8 段中 ~3.5 段が自動 | モデル自動セグメンテーション・所見文ドラフト・write 側 LLM tool が未実装 |

PILOT の段階内訳 (Choi JNM 2026 のパイプライン対応): シリーズ選択=半自動 (曖昧時のみピッカー) /
SUV 変換=自動 / 同一 FoR 整合=自動 / MIP=レイアウトで自動 / モデルセグメンテーション=✗ (閾値のみ) /
vision 読影=✗ / 所見文ドラフト=✗ (PDF/PPT は数値表のみ) / agent tool=読み取り専用のみ。

## ペルソナ別の現状サマリ (2026-05-03 commit e649358 時点、機能一覧として保持)

### Persona HUNTER (PET/CT segmentation, MTV/TLG 測定) — **完成度 95%**
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

### Persona COURIER (Quick viewer) — **完成度 85%**
- ✅ DICOM/NIfTI ファイル D&D
- ✅ 自動 modality 推定 (NIfTI filename heuristics)
- ✅ Series card に description / DCM/NII chip / matrix size
- ✅ Image overlay (Image X/N, patient info corners) 即時表示
- ✅ Ctrl+wheel zoom / 中ボタン pan (Volume / DicomSlice 両対応)
- ✅ Box 複製 (More メニュー → Duplicate this box)
- ✅ **Shareable URL** `?url=https://...` で直接ロード (commit e649358)
- 残: NIfTI raw byte view (TODO に詳細)、デモデータの公開リンク
- 残: MIP / cor / sag への切替がもっとワンアクションで (現在は plane menu)

### Persona MINER (PET/MR + radiomics) — **完成度 70%**
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
3. **MR ROI UX cue** (Persona MINER 仕上げ): 描画開始時に「This ROI will be stored on PET grid」インラインヒント
4. **公開デモデータ** (Persona COURIER 仕上げ): `public/demo/*.nii.gz` + `?demo=lung01` mapping
5. **バンドル分割** (P2-C): manual chunk
6. **DicomView.vue composable 化** (P1-B): `useSphereROI` / `usePolygonROI` 等
