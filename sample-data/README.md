# sample-data/ — ローカルテスト用 DICOM 置き場

このフォルダは **各開発者のローカル症例データ** を置くための場所です。

## 重要: Git には上がりません

`.gitignore` で `sample-data/` フォルダごと除外してあります（この README だけは例外で同梱）。
なので、ここに患者 DICOM / NIfTI を置いても GitHub にはコミットされません。安心して置いてください。

```
sample-data/            ← ignore
!sample-data/README.md  ← このファイルだけ tracked
```

## 置き方

症例ごとにサブフォルダを作り、その中に DICOM ファイルを入れます（サブフォルダ再帰も可）:

```
sample-data/
├── README.md
├── case001/
│   ├── IM0001.dcm
│   ├── IM0002.dcm
│   └── ...
└── case002/
    ├── PT/  ... .dcm
    └── CT/  ... .dcm
```

- DICOM 拡張子は `.dcm` でなくても構いません（middleware は再帰的に全ファイルを列挙します）。
- NIfTI (`.nii` / `.nii.gz`) も同様に置けます。

## 使い方（dev サーバ + 自動ロード）

`vite.config.mts` の dev middleware がこのフォルダを HTTP 配信します:

- `GET /api/cases`                → 症例フォルダ名の一覧
- `GET /api/cases/:caseId/files`  → その症例内の全ファイル（相対パス）
- `GET /samples/:caseId/<relPath>` → ファイル本体

起動時に URL クエリ `?dev=<症例名>` を付けると、その症例を自動 fetch + `loadFiles` します:

```
npm run dev
http://localhost:3000/metavol-web-beta2/?dev=case001
```

これにより、フォルダ選択ダイアログ（Test ボタン / File System Access API）を使わずに、
リロードだけで同じ症例を再ロードできます（自動テスト・E2E に便利）。
