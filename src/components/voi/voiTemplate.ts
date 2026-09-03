import * as nifti from 'nifti-reader-js';
import { gunzipSync } from 'fflate';
import { niftiAffineToVolumeGeometry } from '../niftiGeometry';
import type { Volume } from '../Volume';

// VOI テンプレート (ラベル付き NIfTI + 名前表) の読み込みと検査。
//
// 想定している実物は SPM 同梱の `labels_Neuromorphometrics.nii` + `labels_Neuromorphometrics.xml`。
// 実測 (2026-08): 121x145x121 / 1.5mm 等方 / UINT8 / sform_code=4 (MNI_152) /
// ラベル 136 種 (id 4〜207、**連番ではない**) / ラベル付き体積 1667ml。
// XML と NIfTI のラベル集合は完全一致していた。
//
// **ライセンス注意**: Neuromorphometrics は CC BY-NC で、Neuromorphometrics, Inc. の
// academic subscription 下の提供物。**アプリに同梱して配布しないこと。**
// ユーザ自身の SPM から読み込ませ、結果画面には XML ヘッダの出典表示を出す。

export interface VoiLabel {
    id: number;
    name: string;
}

/** SPM の atlas XML の header 部。出典表示に使う。 */
export interface VoiAtlasHeader {
    name?: string;
    version?: string;
    description?: string;
    licence?: string;
    coordinateSystem?: string;
    imageFile?: string;
}

export interface VoiTemplate {
    volume: Volume;
    labels: VoiLabel[];
    header: VoiAtlasHeader;
    /** 表示用。読み込んだ NIfTI のファイル名 */
    sourceName: string;
}

/** テンプレートの自己整合性チェック結果。UI に出して「壊れた組み合わせ」を検出させる。 */
export interface VoiTemplateCheck {
    /** ラベル volume に実在した ID (0 は除く) */
    idsInVolume: number[];
    /** 名前表にあるが volume に無い ID */
    missingInVolume: number[];
    /** volume にあるが名前表に無い ID */
    missingInTable: number[];
    labeledVoxels: number;
    totalVoxels: number;
    labeledVolumeMl: number;
    /** 値が整数でない voxel があれば true (ラベル volume として不正) */
    hasNonInteger: boolean;
}

// ---------------------------------------------------------------------------
// XML (SPM atlas 形式)
// ---------------------------------------------------------------------------

/**
 * SPM の atlas XML をパースする。
 *
 * **文字コードは宣言を見てから decode すること。** SPM が出す XML は
 * `<?xml version="1.0" encoding="ISO-8859-1"?>` で始まる。UTF-8 と決め打ちすると
 * 非 ASCII を含む記述で化ける。宣言部は ASCII なので、まず latin1 で頭だけ読んで
 * encoding を拾い、その charset で decode し直す。
 */
export const decodeXmlBytes = (bytes: Uint8Array): string => {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
    const label = m?.[1]?.toLowerCase() ?? 'utf-8';
    try {
        return new TextDecoder(label).decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
};

export const parseAtlasXml = (text: string): { header: VoiAtlasHeader; labels: VoiLabel[] } => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) {
        throw new Error('The label file is not valid XML.');
    }
    const txt = (sel: string): string | undefined => {
        const el = doc.querySelector(sel);
        const s = el?.textContent?.trim();
        return s ? s : undefined;
    };
    const header: VoiAtlasHeader = {
        name: txt('atlas > header > name'),
        version: txt('atlas > header > version'),
        description: txt('atlas > header > description'),
        licence: txt('atlas > header > licence') ?? txt('atlas > header > license'),
        coordinateSystem: txt('atlas > header > coordinate_system'),
        imageFile: txt('atlas > header > images > imagefile'),
    };
    const labels: VoiLabel[] = [];
    for (const el of Array.from(doc.querySelectorAll('atlas > data > label'))) {
        const id = Number(el.querySelector('index')?.textContent?.trim());
        const name = el.querySelector('name')?.textContent?.trim() ?? '';
        if (Number.isFinite(id) && id > 0) labels.push({ id, name: name || `Label ${id}` });
    }
    if (labels.length === 0) throw new Error('No <label> entries were found in the XML.');
    return { header, labels };
};

/**
 * CSV / TSV / FreeSurfer LUT 形式の名前表。XML でないテンプレートのための予備経路。
 * 「先頭が整数、続いて名前」の行だけを拾い、それ以外 (見出し行・コメント) は捨てる。
 */
export const parseLabelTableText = (text: string): VoiLabel[] => {
    const labels: VoiLabel[] = [];
    const seen = new Set<number>();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const m = /^(\d+)[\s,;\t]+(.+)$/.exec(line);
        if (!m) continue;
        const id = Number(m[1]);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        // FreeSurfer LUT は "id name R G B A" なので、末尾の数値列は名前から落とす
        const name = m[2].replace(/[\s,;\t]+\d+([\s,;\t]+\d+){2,}\s*$/, '').trim();
        seen.add(id);
        labels.push({ id, name: name || `Label ${id}` });
    }
    return labels;
};

/** 拡張子と中身から XML / テキスト表を判別して名前表を読む。 */
export const parseLabelFile = (bytes: Uint8Array, filename: string): { header: VoiAtlasHeader; labels: VoiLabel[] } => {
    const text = decodeXmlBytes(bytes);
    const looksXml = /\.xml$/i.test(filename) || /^\s*<\?xml|<atlas\b/i.test(text.slice(0, 400));
    if (looksXml) return parseAtlasXml(text);
    const labels = parseLabelTableText(text);
    if (labels.length === 0) {
        throw new Error(`No label definitions could be read from ${filename}.`);
    }
    return { header: {}, labels };
};

// ---------------------------------------------------------------------------
// ラベル volume (NIfTI)
// ---------------------------------------------------------------------------

/**
 * ラベル NIfTI を Volume にする。
 *
 * DicomView の読み込み経路とは別に持つ。テンプレートは **シリーズ一覧に出したくない**
 * (画像として並ぶと紛らわしい) ため。幾何変換は共有の `niftiAffineToVolumeGeometry` を通す。
 *
 * **scl_slope / scl_inter はここで適用する。** ラベルに scaling が掛かることは稀だが、
 * 「読んだ値がヘッダどおりである」ことは経路ごとに保証しておく。
 */
export const parseNiftiLabelVolume = (buffer: ArrayBuffer, filename: string): Volume => {
    let buf = buffer;
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (head[0] === 0x1f && head[1] === 0x8b) {
        buf = gunzipSync(new Uint8Array(buf)).buffer as ArrayBuffer;
    }
    if (!nifti.isNIFTI(buf)) throw new Error(`${filename} is not a NIfTI volume.`);
    const hdr = nifti.readHeader(buf) as nifti.NIFTI1;
    const raw = nifti.readImage(hdr, buf);
    const dims = (hdr as any).dims as number[];
    const nx = dims[1] | 0, ny = dims[2] | 0, nz = dims[3] | 0;
    const n = nx * ny * nz;
    if (n <= 0) throw new Error(`${filename} has invalid dimensions.`);

    const dt = (hdr as any).datatypeCode ?? (hdr as any).datatype ?? -1;
    let typed: ArrayLike<number>;
    switch (dt) {
        case 2:   typed = new Uint8Array(raw); break;
        case 4:   typed = new Int16Array(raw); break;
        case 8:   typed = new Int32Array(raw); break;
        case 16:  typed = new Float32Array(raw); break;
        case 64:  typed = new Float64Array(raw); break;
        case 256: typed = new Int8Array(raw); break;
        case 512: typed = new Uint16Array(raw); break;
        case 768: typed = new Uint32Array(raw); break;
        default:
            throw new Error(`${filename}: unsupported NIfTI datatype ${dt} for a label volume.`);
    }
    if (typed.length < n) throw new Error(`${filename}: image data is truncated.`);

    // scl_slope=0 は「スケーリングなし」を意味する (NIfTI-1 仕様)
    const slope = (hdr as any).scl_slope;
    const inter = (hdr as any).scl_inter ?? 0;
    const s = (typeof slope === 'number' && slope !== 0) ? slope : 1;
    const b = (typeof inter === 'number' && Number.isFinite(inter)) ? inter : 0;

    const voxel = new Float32Array(n);
    if (s === 1 && b === 0) {
        for (let i = 0; i < n; i++) voxel[i] = typed[i];
    } else {
        for (let i = 0; i < n; i++) voxel[i] = typed[i] * s + b;
    }

    const geom = niftiAffineToVolumeGeometry((hdr as any).affine);
    return {
        nx, ny, nz, voxel,
        imagePosition: geom.imagePosition,
        vectorX: geom.vectorX,
        vectorY: geom.vectorY,
        vectorZ: geom.vectorZ,
        metadata: {
            modality: 'OTHER',
            seriesUID: `voi-${filename}`,
            seriesDescription: (hdr as any).description?.trim() || filename,
            niftiHeader: hdr,
            sourceFilename: filename,
        } as any,
    };
};

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------

export const checkVoiTemplate = (volume: Volume, labels: VoiLabel[]): VoiTemplateCheck => {
    const counts = new Map<number, number>();
    let hasNonInteger = false;
    const v = volume.voxel;
    for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x === 0) continue;
        if (!Number.isInteger(x)) { hasNonInteger = true; continue; }
        counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    const idsInVolume = [...counts.keys()].sort((a, b) => a - b);
    const tableIds = new Set(labels.map(l => l.id));
    const volIds = new Set(idsInVolume);
    const voxelMl = Math.abs(volume.vectorX.length() * volume.vectorY.length() * volume.vectorZ.length()) / 1000;
    let labeled = 0;
    for (const c of counts.values()) labeled += c;
    return {
        idsInVolume,
        missingInVolume: labels.filter(l => !volIds.has(l.id)).map(l => l.id),
        missingInTable: idsInVolume.filter(id => !tableIds.has(id)),
        labeledVoxels: labeled,
        totalVoxels: v.length,
        labeledVolumeMl: labeled * voxelMl,
        hasNonInteger,
    };
};
