// Tracer (放射性医薬品) ごとの推奨プリセット定義。
// PET 解析を「誰にでも」する mission に従い、Sidebar / Inspector の値を
// 1 クリックで適切な初期値にリセットする。
//
// 提供する値:
//   - SUV threshold default      (Apply ボタンで使う閾値)
//   - SUV window WC/WW           (PET 表示の Lo/Hi)
//   - PET CLUT                   (cluts[] のインデックス)
//   - Label preset               (segStore.labels に流し込むカテゴリ)
//   - detectKeywords             (SeriesDescription / StudyDescription 自動判定)
//
// CLUT 番号 (Clut.ts:550-557 と同期):
//   0=gray, 1=gray_r, 2=rainbow, 3=rainbow_r, 4=hot, 5=hot_r

export interface TracerLabelDef {
    name: string;
}

/** TMTV (Total Metabolic Tumor Volume) の prognostic cutoff
 *  cancer 別に文献 carved。複数 cutoff を持てる (e.g. low / high prognosis tier)
 */
export interface TmtvCutoff {
    label: string;          // UI 表示用 (e.g. "DLBCL CAR-T threshold")
    valueCc: number;        // cutoff (cc)
    /** "above" cutoff のとき alert (PFS 短い) — 通常 "above" */
    direction: 'above' | 'below';
    /** 出典の論文タイトル + URL (UI tooltip) */
    sourceLabel: string;
    sourceUrl?: string;
}

export interface TracerPreset {
    id: 'fdg' | 'psma' | 'dotatate' | 'amyloid' | 'fes' | 'tau' | 'custom';
    name: string;
    /** SUV threshold (Apply の初期値) */
    suvThreshold: number;
    /** PET 表示窓 (WC = (lo+hi)/2, WW = hi-lo) */
    suvWindow: { wc: number; ww: number };
    /** Clut.ts 内の CLUT 番号 */
    petClut: number;
    /** Label 一覧 (順序が id=1..N に対応) */
    labels: TracerLabelDef[];
    /** SeriesDescription / StudyDescription の自動判定キーワード (大文字小文字無視) */
    detectKeywords: string[];
    /** 簡単な説明 (UI tooltip) */
    description: string;
    /** TMTV prognostic cutoffs (該当 cancer の参考値、複数可) */
    tmtvCutoffs?: TmtvCutoff[];
}

export const TRACER_PRESETS: TracerPreset[] = [
    {
        id: 'fdg',
        name: 'FDG (¹⁸F)',
        suvThreshold: 2.5,
        suvWindow: { wc: 3, ww: 6 },
        petClut: 4, // hot
        labels: [
            { name: 'Tumor' },
            { name: 'Lymph node' },
            { name: 'Bone metastasis' },
            { name: 'Physiological' },
            { name: 'Inflammation' },
            { name: 'Other' },
        ],
        detectKeywords: ['fdg', 'fluorodeoxyglucose', '18f-fdg', 'f-18 fdg'],
        description: 'Generic oncology FDG PET (SUV 2.5 threshold, hot CLUT, 0–6 window)',
        tmtvCutoffs: [
            {
                label: 'DLBCL CAR-T (TMTV)',
                valueCc: 48.4,
                direction: 'above',
                sourceLabel: 'Mussetti et al. 2024 (CAR-T B-cell lymphoma PFS)',
                sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11666922/',
            },
            {
                label: 'NSCLC poor prognosis (TMTV)',
                valueCc: 80,
                direction: 'above',
                sourceLabel: 'Zhang et al. 2022 (NSCLC overall survival)',
                sourceUrl: 'https://ejhi.springeropen.com/articles/10.1186/s41824-022-00158-x',
            },
        ],
    },
    {
        id: 'psma',
        name: 'PSMA',
        suvThreshold: 3.0,
        suvWindow: { wc: 5, ww: 10 },
        petClut: 2, // rainbow
        labels: [
            { name: 'Prostate' },
            { name: 'Lymph node' },
            { name: 'Bone metastasis' },
            { name: 'Visceral met' },
            { name: 'Salivary gland' },
            { name: 'Other' },
        ],
        detectKeywords: ['psma', '68ga-psma', '18f-psma', 'psma-617', 'psma-1007', 'pylarify'],
        description: 'Prostate cancer PSMA PET (SUV 3.0 threshold, rainbow CLUT, 0–10 window)',
    },
    {
        id: 'dotatate',
        name: 'DOTATATE',
        suvThreshold: 2.0,
        suvWindow: { wc: 7.5, ww: 15 },
        petClut: 2, // rainbow
        labels: [
            { name: 'NET lesion' },
            { name: 'Lymph node' },
            { name: 'Liver' },
            { name: 'Bone metastasis' },
            { name: 'Physiological' },
            { name: 'Other' },
        ],
        detectKeywords: ['dotatate', 'dotatoc', 'dotanoc', 'ga-dota', '68ga-dota'],
        description: 'NET imaging (SUV 2.0 threshold, rainbow CLUT, 0–15 window)',
    },
    {
        id: 'amyloid',
        name: 'Amyloid',
        suvThreshold: 1.5,
        suvWindow: { wc: 1.5, ww: 3 },
        petClut: 2, // rainbow
        labels: [
            { name: 'Cortical' },
            { name: 'Reference (cerebellum)' },
            { name: 'White matter' },
            { name: 'Other' },
        ],
        detectKeywords: ['amyloid', 'florbetapir', 'florbetaben', 'flutemetamol', 'amyvid', 'pib'],
        description: 'Brain amyloid PET (SUV 1.5 threshold, rainbow CLUT, 0–3 window)',
    },
    {
        id: 'fes',
        name: 'FES',
        suvThreshold: 1.5,
        suvWindow: { wc: 2, ww: 4 },
        petClut: 4, // hot
        labels: [
            { name: 'ER+ lesion' },
            { name: 'Lymph node' },
            { name: 'Bone metastasis' },
            { name: 'Other' },
        ],
        detectKeywords: ['fes', 'fluoroestradiol', '18f-fes'],
        description: 'Estrogen receptor (breast cancer) FES PET (SUV 1.5 threshold, 0–4)',
    },
    {
        id: 'tau',
        name: 'Tau',
        suvThreshold: 1.3,
        suvWindow: { wc: 1.25, ww: 2.5 },
        petClut: 2, // rainbow
        labels: [
            { name: 'Cortical tangles' },
            { name: 'Reference' },
            { name: 'Other' },
        ],
        detectKeywords: ['tau', 'flortaucipir', 'av-1451', 'mk-6240', 'pi-2620', 'gtp1'],
        description: 'Brain tau PET (SUV 1.3 threshold, 0–2.5)',
    },
    {
        id: 'custom',
        name: 'Custom',
        suvThreshold: 2.5,
        suvWindow: { wc: 3, ww: 6 },
        petClut: 4,
        labels: [{ name: 'Lesion' }, { name: 'Background' }],
        detectKeywords: [],
        description: 'Generic placeholder (manually adjust threshold/window/labels)',
    },
];

export const tracerById = (id: string): TracerPreset | null => {
    return TRACER_PRESETS.find(t => t.id === id) ?? null;
};

// SeriesDescription / StudyDescription を見て tracer を自動推定。
// 該当キーワードを最初に含む preset を返す。空 / 不一致 → null。
export const detectTracer = (
    seriesDescription?: string,
    studyDescription?: string,
): TracerPreset | null => {
    const hay = `${seriesDescription ?? ''} ${studyDescription ?? ''}`.toLowerCase();
    if (!hay.trim()) return null;
    for (const preset of TRACER_PRESETS) {
        if (preset.id === 'custom') continue;
        for (const kw of preset.detectKeywords) {
            if (hay.includes(kw.toLowerCase())) return preset;
        }
    }
    return null;
};
