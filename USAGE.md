# metavol-web 使用ガイド

## 1. 画面構成

```
┌─ app-bar (48px) ──────────────────────────────────────────────────────┐
│ ☰ │ metavol │ ⚙tools │ Test │ PET Standard │ Sync │ -+ │ tiles │ 🗑 │
├──────────────┬─────────────────────────────────┬──────────────────────┤
│              │                                 │                      │
│   Sidebar    │       Image Area                │     Inspector        │
│   (280px)    │   (n×n タイル, 黒背景)          │     (320px)          │
│              │                                 │                      │
│ • Series     │                                 │  Segmentation        │
│ • Slice      │                                 │  • Threshold         │
│ • Window     │                                 │  • Overlay           │
│ • Color      │                                 │  • Sphere ROI        │
│ • View       │                                 │  • Polygon ROI       │
│ • Advanced   │                                 │  • Labels            │
│              │                                 │  • Islands           │
│              │                                 │  • Save NIfTI        │
└──────────────┴─────────────────────────────────┴──────────────────────┘
```

- 左 Sidebar / 右 Inspector はそれぞれ app-bar 左端の **☰** ボタン、または右端のサイドパネルアイコンで開閉
- ☰ で Sidebar、右側のアイコンで Inspector

---

## 2. ツールバー（app-bar）

### 左半分

| ボタン | 動作 |
|---|---|
| ☰ | Sidebar 開閉 |
| metavol | （ロゴ） |
| 🌗 Window/Level | ドラッグで WC/WW |
| ✋ Pan | ドラッグで中心移動 |
| 🔍+ Zoom | ドラッグでズーム |
| ↕ Page | ドラッグでスライス送り |
| ○ Sphere ROI | クリックで球を配置、球内ホイールで半径変更 |
| ⬡ Polygon ROI | スライス単位の add/erase ROI |
| 🏷 Assign Label | アイランドにラベルを付与 |

各ツールアイコンを **もう一度クリックで OFF**（toggle）。

### 右半分

| ボタン | 動作 |
|---|---|
| 📁 Test | フォルダ選択ダイアログ → 中の DICOM をロード（同セッション中は再選択不要） |
| 🟢 PET Standard | CT/PET ロード後、ワンクリックで 2x2 標準ビュー |
| 🔗 Sync | Sync ON/OFF（ON のとき pan/zoom/page を全 Box 同期） |
| 🔍-/🔍+ | Box サイズ縮小・拡大 |
| ▦ tile数 | タイル数（1/2/3/4/6/8/9/10/12） |
| パネル | Inspector 開閉 |
| 🗑 | 全画像クローズ |

---

## 3. 基本ワークフロー

### A. 通常の手順
1. PET/CT のフォルダを **drag & drop**（または `Test` ボタンでフォルダ選択）
2. **PET Standard** を押す → 2x2（CT axial / PET axial / Fusion axial / PET MIP）が自動配置
3. Inspector の **Threshold** で SUV 閾値（2.5/3.0/3.5/4.0/Manual）を選んで **Apply**
4. PET / Fusion / MIP に赤マスクが乗る。同時に Find islands も自動実行され、
   **Lesions の表が自動で開く**。各行の「…」から **Set label**（Tumor/Non-tumor 等へ付け替え）と
   **Delete lesion**（マスクから除去、Ctrl+Z で復元可）ができ、生理的集積の選別が行単位で進む
5. 必要なら **Polygon ROI (Erase)** で生理学的集積（脳、心臓、膀胱等）を消す
6. **Labels** で病変ラベル（tumor1, tumor2…）を作成・選択
7. **Assign Label** ツール → 病変アイランドをクリックで腫瘍ラベルを付与
8. ラベル別の体積 (mm³) が Inspector に表示
9. **Save NIfTI** でマスクを `.nii` + `.nii.json` として保存

### B. 最短手順
- **Test** → **PET Standard** → **Apply** → **Save NIfTI**

---

## 3.5 脳 PET の解剖学的標準化 + VOI 解析（ペルソナ ATLAS）

標準脳への正規化そのものは **MATLAB + SPM12（各自の PC）** で行う。metavol-web が担うのは
その **前（DICOM → NIfTI）** と **後（正規化済み NIfTI + VOI テンプレート → 領域値）**。

### 全体の流れ

| | 工程 | 場所 |
|---|---|---|
| ① | 病院から DICOM をダウンロード | 院内 |
| ② | metavol-web で開いて **.nii で保存** | metavol-web |
| ③ | SPM12 で normalize → `w*.nii` | MATLAB |
| ④ | `w*.nii` を metavol-web で開く | metavol-web |
| ⑤ | VOI テンプレートを読み込む（→ **その場で解析まで走る**） | metavol-web |
| ⑥ | overlay と診断で一致を確認 → CSV 出力 | metavol-web |

### ② DICOM → NIfTI

1. **☰ → Load files…**（または drag & drop）で DICOM フォルダを読む
2. 左サイドバーの対象シリーズの **「…」→ Export as NIfTI (.nii)** を選ぶ
   - **SPM12 は `.nii.gz` を直接読めない**ので、この用途では**非圧縮 `.nii` を選ぶ**
   - ダウンロードされるのは `.zip`（画像 + sidecar JSON）。展開して `.nii` を SPM へ
   - box に出していないシリーズでも変換できる
3. sidecar JSON には単位（PT なら SUV）や SUV 係数が入る。**書き出す値は生画素ではなく
   `dicom2volume` 通過後の値**（PT = SUV / CT = HU / MR = raw）

### ④ 正規化済み NIfTI を開く

1. **☰ → Load files…** で `w*.nii` を選ぶ（drag & drop も可）
2. **読み込んだ時点で 1 box に表示される**。MPR への切り替えなどは不要
3. window は **volume の分位点から自動**で決まる（modality 不明でも見える）
4. 必要なら左サイドバーのカードの **Set as: PT** を押す（任意）
   - 押すと単位表示が **SUV** になり、CSV にも `unit,SUV` が入る
   - 押さなくても VOI 解析は動く（単位表示が `raw` になるだけ）
5. 小さく表示されるときは **Ctrl + ホイール**で拡大
   - ⚠ **「Fit to window」は画像の拡大率を変えない**（box の寸法を合わせる機能）

### ⑤ VOI テンプレートを読み込む

1. **☰ → VOI analysis…** でダイアログを開く
2. **Load VOI template…** で **2 ファイルを同時に選択**
   - SPM の `tpm` フォルダの `labels_Neuromorphometrics.nii` と `.xml`
   - 名前表は CSV / TSV / FreeSurfer LUT でも可
3. **読み込んだ時点で解析まで自動で走る**。Run を押す必要はない
   （シリーズを変えて再実行したいときだけ **Run**）

### ⑥ 一致の確認と CSV 出力

**目視（overlay）**: 「Show regions on the image」が既定 ON。ダイアログを閉じるか脇へ寄せると
画像に領域が色分けで乗っている。**Opacity** で濃さを調整。
重ねているのは**数値を出したのと同じ割り当て結果**なので、見えているものと表は必ず一致する。

領域は **MTV 測定と同じマスク層**に読み込まれる。読み込まれると**左サイドバーの最上部に
MASK カード**が現れ、何のマスクか（VOI: Neuromorphometrics … / MTV mask）・対象 PT・
ラベル数・体積 (mL) が見える。カード上で 表示/非表示（目アイコン）・透過度・
「…」→ Save mask / Clear mask ができる。さらに右サイドバー（Segmentation パネル）で
- **Mask スライダ** … 透過度（ダイアログの Opacity と同じ値）
- **目アイコン** … 領域ごとの表示/非表示（例: 白質だけ消す）
- **色チップ** … クリックで領域色を変更（カラーピッカーが開く）
- **☰ → Save mask** … 領域マスクを NIfTI で保存
がそのまま使える。⚠ マスク層は 1 枚なので、VOI 解析を実行すると実行中の MTV マスクは
置き換わる（逆も同じ）。

**SUVR（参照領域比）**: 結果の表の上にある **SUVR reference region** で参照領域
（小脳・橋・Brain Stem など）を選ぶと、表と CSV に `suvr` 列（= 各領域の mean ÷ 参照領域の mean）が
付く。選択は再解析・別症例でも保持されるので、同じ参照で症例を順に処理できる。

**数値（Alignment check）**: 正常なら次のようになる。

| 項目 | 期待値 |
|---|---|
| Image voxels inside template | 100% |
| Bounding-box overlap | 100% |
| Regions with no voxels | ごく少数 |

低い場合は正規化されていない可能性があり、警告が出る。

**表と CSV**: 見出しクリックでソート、検索欄で絞り込み（例 `hippocampus` → 左右 2 行）、
**Hide empty regions** で voxel 0 を隠す。**Export CSV** で
`id / name / voxels / nan_voxels / volume_ml / mean / sd / min / max` と出典行が出る。

### 最短手順

**☰ → Load files…**（`w*.nii`）→ **☰ → VOI analysis…** → **Load VOI template…** → **Export CSV**

テンプレートはセッション中は保持されるので、2 症例目以降は
**Load files… → VOI analysis… → Export CSV** だけで済む
（※ ページをリロードするとテンプレートは消える）。

---

## 4. マウス & キーボード操作

### マウス（ツール非依存・常時有効）

| 操作 | 動作 |
|---|---|
| **ホイール** | スライス送り |
| **Ctrl + ホイール** | 即時ズーム（視野中心固定） |
| **中ボタンドラッグ** | 即時 Pan |
| **左クリック** | （現在のツールに従う） |

### マウス（ツール選択中）

| ツール | 操作 |
|---|---|
| Window/Level | 左ドラッグ: WC/WW |
| Pan | 左ドラッグ: 視点移動 |
| Zoom | 左ドラッグ: ズーム |
| Page | 左ドラッグ: スライス送り |
| Sphere ROI | 左クリック: 中心配置 / 球内ホイール: 半径変更 |
| Polygon ROI | 左クリック: 頂点 / 右クリック・ダブルクリック: 確定 |
| Assign Label | 左クリック: そのアイランドに現在ラベル付与 |

### キーボード

| キー | 動作 |
|---|---|
| **Esc** | 進行中の Polygon ROI を取消 |
| **Ctrl + Z** | 直前の Polygon 編集を undo（スライス単位） |
| **Ctrl + Shift + D** | デバッグモード toggle |

---

## 5. Inspector — Segmentation パネル

### Threshold
- プリセット: SUV 2.5 / 3.0 / 3.5 / 4.0 / Manual
- Manual を選ぶと数値入力欄が出る
- **Apply**: 閾値を全 PET ボリュームに適用 + 自動で Find islands も実行
- **Clear**: 閾値マスクのみクリア（manual edits は残る）

### Overlay
- **Show mask** スイッチ: マスクの表示 ON/OFF
- **Opacity** スライダ: マスクの不透明度 (5%〜100%)

### Sphere ROI
- 配置中の球の SUVmax / SUVmean ± std / voxel 数 / 半径 (mm)
- **Clear sphere** で削除

### Polygon ROI
- **Add / Erase** トグル: ポリゴンが追加か削除かを切替
- 操作ガイド表示

### Labels
- 各ラベル: 色スウォッチ + 名前 + 体積 (mm³)
- クリックで「現在ラベル」に選択（accent 色枠）
- 入力欄 + ＋ボタンで新規追加（Enter でも追加）
- ✕ で削除

### Islands
- **Find islands** で 26連結成分を検出（Apply 直後は自動実行済み）
- マスクが更新されると「再検出が必要です」と表示 → **Re-find** で再計算
- 検出済みなら Assign Label ツールで島クリック → 現在ラベル付与

### Save / Clear
- **Save NIfTI**: 多ラベル Uint16 マスクを `.nii` + メタ情報 `.nii.json` でダウンロード
- **Clear edits**: manual edits（polygon 編集分）をクリア

---

## 6. Sidebar

### Series
- ←/→ ボタンで選択中 Box のシリーズ切替
- 読み込み済みシリーズの **カード一覧**: サムネイル + Modality バッジ + 説明 + matrix size + voxel size
- カードをクリックで選択中 Box にそのシリーズを反映（Volume 表示中なら自動 MPR）

### Slice
- ⏮ / ← / → / ⏭ でスライス送り

### Window preset
- Lung / Med / Abd / Bone / Brain / Fat / Reset

### Color
- Mono / Rainbow / Hot / Reverse — 即時反映

### View
- MPR / Axi / Cor / MIP / sMIP / Fusion

### Advanced（折りたたみ）
- Demo phantoms: NEMA IEC / Whole-body FDG / Whole-body PET-CT
- Show summary / Show tag

---

## 6.4 匿名化データの注意

匿名化ソフトによっては DICOM の Modality タグ (0008,0060) を全シリーズ一括で
書き換えることがある（実例: 全部 "RG" になる）。metavol-web は **SOP Class UID から
本来のモダリティ（PT/CT/MR）を復元する**ので、そのようなデータでもそのまま
MTV 測定に進める。fusion のキャプチャ画像（Secondary Capture）は復元対象外で、
書き換え後の表記のまま表示される。

## 6.5 リンク共有 (ペルソナ COURIER)

**データは URL パラメータ、見え方は .mvs** の分担で 1 リンク共有ができる。

| パラメータ | 意味 |
|---|---|
| `?url=<https://…/scan.nii.gz>` | 外部 URL から DICOM/NIfTI を読む (複数可・カンマ区切り可。CORS 必須) |
| `?mvs=<url>` | データ読み込み完了後に snapshot (.mvs) を取得して view を復元 |
| `?demo=phantom` | ブラウザ内で全身 PET/CT ファントムを生成。**データ配布なしで動くデモリンク** |

例: `https://…/metavol-web-beta2/?url=https://host/pet.nii.gz&mvs=https://host/view.mvs`

.mvs はカメラアイコンで保存できる。**.mvs は d&d / Load files でも読める**
(単独なら即適用、画像と同時に落とすと画像の後に適用される)。

## 7. 保存形式

### Voxel リスト（④ Save → Others → Voxel list (.txt)）
- マスク内の全 voxel を 1 行ずつ `island_id label_id x y z value`（空白区切り）で書き出す
- `island_id` は病変（26-連結成分）の番号。**Lesion table / Lesions CSV と同じ SUVmax 降順**
  （1 = SUVmax 最大の病変）なので、表の病変 #N と `island_id==N` が厳密に対応する。
  「腫瘍だけ取り出して各病変を別々に解析する」用途はこの列でフィルタする
- `label_id` は数値ラベル id（id → 名前の対応はファイル先頭の `#` コメント行）
- `x y z` は PET 格子の 0-based voxel index。voxel サイズ・格子寸法・単位・病変数も `#` 行に記載
- Python なら `pandas.read_csv(f, comment='#', sep='\s+')` でそのまま読める

### NIfTI マスク
- ファイル名: `{seriesUID}_{YYYYMMDDhhmmss}.nii`
- データ: Uint16 多ラベル（0=背景、1..N=ラベルID）
- 幾何: PET の affine そのまま（origin = ImagePositionPatient、軸 = vectorX/Y/Z）
- 1 voxel = PET voxel（CT 解像度ではない）

**読み戻しは画像と同じ d&d でよい。** 対象の画像を読み込んだ状態でマスク `.nii` を
drag & drop（または ☰ → Load files…）すると、格子が一致しラベル値らしい場合に
「Load it as a MASK on that volume?」と確認が出る。**OK** でマスクとして取り込まれ
（MASK カード・透過度・per-label 表示がそのまま使える）、**Cancel** なら普通の
画像 volume として開く。`.nii.json` サイドカーを同時に落とすとラベル名・色も復元される。
（従来の ☰ → Load mask (NIfTI)… も残っているが、d&d と同じ入口に流れるだけ）

**自動判定に乗らなかった / 間違えて Cancel したとき**: そのファイルは普通の volume として
左サイドバーに並ぶ。そのカードの **「…」→ Use as mask** を押せば、その場でマスクとして
取り込み直せる（同じ格子の画像が読み込まれていることが条件。値が整数ラベルでない場合や
格子が合わない場合は理由が alert で出る）。

### JSON サイドカー
- ファイル名: `{seriesUID}_{YYYYMMDDhhmmss}.nii.json`
- 内容:
  - `created`: ISO timestamp
  - `threshold`, `thresholdUnit`
  - `labels[]`: id, name, color, volume_mm3
  - `petMetadata`: modality, units, suvFactor, patientWeight 等
  - `voxelSizeMm`: [dx, dy, dz]
  - `dims`: [nx, ny, nz]

---

## 8. デバッグモード（一般ユーザー向けではない）

### 有効化
- URL クエリ: `?debug=1` で起動時 ON
- ショートカット: **Ctrl + Shift + D** で toggle
- ON のとき画面右下に赤い `DEBUG` バッジ表示

### voxel inspector
- 画像上にホバーすると、ポインタ近くにテーブル表示
- 全シリーズ × その world 位置の voxel 値（i, j, k と value）を一覧
- ドラッグ中は表示抑止（操作の邪魔にならないよう）

### voxel 編集
- **Shift + 左クリック** で編集ダイアログ
- 該当位置に複数 Volume があれば対象シリーズを選択
- 続けて新値を入力 → Volume.voxel を直接書換 → 即時再描画
- Console に `[debug edit] series N (i,j,k): old → new` を出力
- PET なら SUV 値（intercept/slope+SUV因子適用後）が直接書き換わる

---

## 9. 注意事項

### マスク overlay は Volume レンダ時のみ
- 生 DICOM 表示モードではマスクは見えない
- **Sidebar > View > MPR** または **Fusion** に切替えるか、**PET Standard** を使う

### 同一 PET の MPR を再実行してもマスクは保持される
- ただし **異なる PET シリーズに切替えるとマスクは破棄**される（seriesUID で判定）

### Pinia state HMR に注意（開発時）
- store のアクション定義を変えた直後はブラウザを Ctrl+Shift+R でハードリロードすること

### NIfTI のみのロード
- NIfTI には modality タグが無いので、**ファイル名 → voxel 値の分布 → 手動指定**の 3 段で決める
- 名前で分からなければシリーズカードの **Set as: PT / CT / MR** で 1 クリック指定
  （SPM の `w` などの接頭辞は読み飛ばすので `wPT_….nii` は PT と判定される）
- **PT と MR は voxel 値では区別できない**（正規化を通すと PET の指紋が消えるため）

---

## 10. 既知の制限

- サムネイルは JPEG Lossless 圧縮 DICOM では生成スキップ
- ラベル ID は最大 65535（Uint16）
- 球輪郭の画面投影は等方 voxel 前提の概算（斜め scaling では誤差）
- File System Access API（Test ボタン）は Chrome / Edge のみ
