// PET Standard / Fusion 起動時の PT/CT 候補スコアリング。
//
// ユーザがロードしたシリーズの中から「これを fuse に使いたい」を自動で選ぶための
// ルールベース。ATTN > NAC、WB > Lung 等を表現する小さな DSL。
//
// スコア計算: baseline (modality 暗黙ボーナス) + Σ(マッチした rule の weight)。
// 同点は seriesList の出現順 (= getPetCtSeriesCandidates 側で安定ソート)。

export type RuleModality = 'ANY' | 'PT' | 'CT' | 'MR';

export interface PriorityRule {
    pattern: string;       // 大文字小文字無視で description を substring 検索
    modality: RuleModality;
    weight: number;        // 正 = 優先、負 = 非優先
}

// 出荷時デフォルト。ユーザは Sidebar Advanced > Series rules で編集可能。
// パターンは substring (case-insensitive)、modality 'ANY' は全 modality に適用。
export const DEFAULT_RULES: PriorityRule[] = [
    // PT: 減衰補正済み (ATTN/CTAC/AC) を優先、NAC を非優先
    { pattern: 'ATTN', modality: 'PT', weight: 10 },
    { pattern: 'CTAC', modality: 'PT', weight: 10 },
    { pattern: 'NAC',  modality: 'PT', weight: -10 },
    // 全身 (Whole Body) を優先
    { pattern: 'WB',         modality: 'ANY', weight: 5 },
    { pattern: 'WHOLE BODY', modality: 'ANY', weight: 5 },
    // CT: 軟部組織条件を優先、特殊条件 (肺野/骨条件等) を非優先
    { pattern: 'LUNG',  modality: 'CT', weight: -3 },
    { pattern: 'CHEST', modality: 'CT', weight: -2 },
    { pattern: 'BONE',  modality: 'CT', weight: -3 },
];

const STORAGE_KEY = 'metavol.seriesPriorityRules.v1';

// ユーザがカスタマイズしたルールを localStorage から読込。失敗時は default。
export const loadPriorityRules = (): PriorityRule[] => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [...DEFAULT_RULES];
        const parsed = JSON.parse(raw) as PriorityRule[];
        if (!Array.isArray(parsed)) return [...DEFAULT_RULES];
        // 妥当性: pattern と weight が必須
        return parsed.filter(r =>
            typeof r.pattern === 'string' && r.pattern.length > 0 &&
            typeof r.weight === 'number' && Number.isFinite(r.weight)
        ).map(r => ({
            pattern: r.pattern,
            modality: (r.modality === 'PT' || r.modality === 'CT' || r.modality === 'MR') ? r.modality : 'ANY',
            weight: r.weight,
        }));
    } catch {
        return [...DEFAULT_RULES];
    }
};

export const savePriorityRules = (rules: PriorityRule[]): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
    } catch {
        // localStorage が使えない環境 (private mode 等) では何もしない
    }
};

export const resetPriorityRules = (): void => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
};

// シリーズ評価入力。description は DICOM SeriesDescription / NIfTI filename 等を想定。
export interface SeriesScoreInput {
    description: string;
    modality: 'PT' | 'CT' | 'MR' | string;  // 'OTHER' / '-' 等もあり得る
    attenuationCorrected?: boolean;          // PT のみ
    hasSuvFactor?: boolean;                  // PT のみ
}

// スコア計算。高いほど優先。
export const scoreSeries = (input: SeriesScoreInput, rules: PriorityRule[]): number => {
    let score = 0;
    const m = (input.modality ?? '').toUpperCase();
    const isPt = (m === 'PT' || m === 'PET');
    const ruleMod: RuleModality | null =
        isPt ? 'PT' : (m === 'CT' ? 'CT' : (m === 'MR' ? 'MR' : null));

    // 暗黙ボーナス: PT の attenuation 補正と SUV 変換可否
    if (isPt) {
        if (input.attenuationCorrected) score += 5;
        if (input.hasSuvFactor)         score += 3;
    }

    // ルール適用 (description の substring マッチ、case-insensitive)
    const desc = (input.description ?? '').toUpperCase();
    for (const r of rules) {
        if (r.modality !== 'ANY' && r.modality !== ruleMod) continue;
        const pat = r.pattern.toUpperCase();
        if (pat.length === 0) continue;
        if (desc.includes(pat)) score += r.weight;
    }
    return score;
};
