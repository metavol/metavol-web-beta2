# metavol-web

PET/CT を中心とした医用画像ビューア。Vue 3 + Vuetify 3 + Vite + TypeScript。

## 主な機能

- **DICOM / NIfTI ビューア** — drag & drop でロード、複数シリーズの並列表示
- **PET 標準ビュー** — ワンクリックで CT axial / PET axial / Fusion axial / PET MIP の 2x2 を構成
- **Fusion 表示** — CT に PET (rainbow) を重ねた合成表示
- **MIP / 表面 MIP** — 任意の角度で投影
- **球状 ROI** — クリックで配置、ホイールで半径変更、SUVmax / SUVmean / std / voxel 数を即時表示
- **多角形 ROI** — スライス単位で add / erase 編集（マスク修正用）
- **閾値セグメンテーション** — SUV 閾値を選択して PET を一括セグメント
- **アイランド検出 + ラベル付け** — 26連結 CC を検出し、Assign Label ツールで島ごとに腫瘍ラベルを付与
- **NIfTI マスク保存** — 多ラベル Uint16 を NIfTI-1 形式 + メタ情報 JSON で書き出し
- **モダンダーク UI** — 3カラム（Sidebar / 画像 / Inspector）、teal アクセント

## 起動

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000/metavol-web-beta2/ を開きます（3000 が使用中なら 3001 にフォールバック）。

公開版: https://metavol.github.io/metavol-web-beta2/

その他のコマンド:
- `npm run build` — 型チェック + 本番ビルド
- `npm run preview` — `dist/` のプレビュー

## 使い方の詳細

[USAGE.md](./USAGE.md) を参照。

## 用語集 (Glossary)

画面パーツ・ImageBox の種類・ツール・機能名・ドメイン概念をまとめた辞書: [GLOSSARY.md](./GLOSSARY.md)
（開発者と AI アシスタントとの会話を共通化する用途）。

## サードパーティライセンス

本プロジェクトは多数の OSS パッケージに依存しています。全パッケージのライセンス一覧は
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) を参照。

主要な依存:
- **Vue 3** / **Vuetify 3** / **Vite** / **Pinia** — MIT
- **dicom-parser** / **nifti-reader-js** / **dcmjs-codecs** — MIT
- **three.js** — MIT
- **@mdi/font** / **roboto-fontface** — Apache-2.0 (NOTICE 同梱必須)
- **pako** (gzip) — MIT AND Zlib
- **typescript** — Apache-2.0

ライセンス一覧は `npx license-checker --production --json` で再生成できます。
