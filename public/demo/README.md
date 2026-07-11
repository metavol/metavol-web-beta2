# Public demo cases

This directory hosts demo data accessible via `?demo=<id>` URL parameter.
Files placed here are bundled into the production build (`dist/`) and served
from the static host (e.g. GitHub Pages).

## Layout

```
public/demo/
├── lung01/
│   ├── manifest.json        ← required
│   ├── ct.nii.gz
│   └── pet.nii.gz
├── case002/
│   ├── manifest.json
│   └── ...
└── README.md (this file)
```

## manifest.json

```json
{
  "description": "Lung adenocarcinoma, FDG-PET/CT (synthetic / public)",
  "files": [
    "ct.nii.gz",
    "pet.nii.gz"
  ]
}
```

`files` is an array of relative paths under the case directory. The loader
fetches them in parallel (4 concurrent), then feeds them to the standard
`loadFiles()` pipeline (NIfTI / DICOM auto-detection).

## URL

```
https://metavol.github.io/metavol-web-beta2/?demo=lung01
```

## Size guidance

GitHub Pages: ~100 MB / file soft limit, ~1 GB / repo soft limit. Keep demo
cases small (a few MB to ~50 MB). For larger cases, host on GitHub Releases
(2 GB / file) and use `?url=https://github.com/.../releases/download/...`.

## Privacy

Only commit fully de-identified or synthetic data. Real patient DICOM is
**not** appropriate here — use a backend with auth instead.
