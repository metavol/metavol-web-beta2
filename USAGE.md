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
4. PET / Fusion / MIP に赤マスクが乗る。同時に Find islands も自動実行
5. 必要なら **Polygon ROI (Erase)** で生理学的集積（脳、心臓、膀胱等）を消す
6. **Labels** で病変ラベル（tumor1, tumor2…）を作成・選択
7. **Assign Label** ツール → 病変アイランドをクリックで腫瘍ラベルを付与
8. ラベル別の体積 (mm³) が Inspector に表示
9. **Save NIfTI** でマスクを `.nii` + `.nii.json` として保存

### B. 最短手順
- **Test** → **PET Standard** → **Apply** → **Save NIfTI**

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
- Demo phantoms: Earth / Humanoid / Voronoi
- Show summary / Show tag

---

## 7. 保存形式

### NIfTI マスク
- ファイル名: `{seriesUID}_{YYYYMMDDhhmmss}.nii`
- データ: Uint16 多ラベル（0=背景、1..N=ラベルID）
- 幾何: PET の affine そのまま（origin = ImagePositionPatient、軸 = vectorX/Y/Z）
- 1 voxel = PET voxel（CT 解像度ではない）

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
- modality 情報が無いため PET/CT 自動検出が動かない
- 現状は DICOM ロード前提の設計（NIfTI 用の手動指定は未実装）

---

## 10. 既知の制限

- サムネイルは JPEG Lossless 圧縮 DICOM では生成スキップ
- ラベル ID は最大 65535（Uint16）
- 球輪郭の画面投影は等方 voxel 前提の概算（斜め scaling では誤差）
- File System Access API（Test ボタン）は Chrome / Edge のみ
