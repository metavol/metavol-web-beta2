// VR opacity transfer function (TF) と presets。
//
// 旧来の VR は alpha = (v - lo) / ww * alphaScale の単純 ramp 1 本だったが、
// 「骨だけ」「PET hot だけ」のような表現を出すには非単調な TF が要る。
// 設計:
//   - control points: { v: 0..1 (WC/WW で正規化済み), a: 0..1 }
//   - 描画時に 256 entry LUT に展開して shader / CPU に渡す (cache 効くし高速)
//   - alphaScale (popover の数値入力) は LUT 値の上にかける global multiplier

export interface OpacityPoint { v: number; a: number; }
export type OpacityTF = OpacityPoint[];

export interface TfPreset {
    id: string;
    label: string;
    description: string;
    tf: OpacityTF;
    // 推奨 alphaScale (preset と組で使う想定値)
    suggestedAlphaScale: number;
}

export const TF_PRESETS: TfPreset[] = [
    {
        id: 'ramp',
        label: 'Ramp (default)',
        description: 'Linear from 0 to 1 — preserves backward compat behavior',
        tf: [{ v: 0, a: 0 }, { v: 1, a: 1 }],
        suggestedAlphaScale: 0.06,
    },
    {
        id: 'soft',
        label: 'Soft tissue',
        description: 'Broad mid-range; gentle silhouette + internals',
        tf: [{ v: 0, a: 0 }, { v: 0.3, a: 0.25 }, { v: 0.7, a: 0.7 }, { v: 1, a: 1 }],
        suggestedAlphaScale: 0.08,
    },
    {
        id: 'bone',
        label: 'Bone (sharp top)',
        description: 'High-value voxels only — bone-like surface look',
        tf: [{ v: 0, a: 0 }, { v: 0.65, a: 0 }, { v: 0.85, a: 1 }, { v: 1, a: 1 }],
        suggestedAlphaScale: 0.20,
    },
    {
        id: 'pet-hot',
        label: 'PET hot (skip noise)',
        description: 'Skip low SUV background, accumulate high uptake',
        tf: [{ v: 0, a: 0 }, { v: 0.20, a: 0 }, { v: 0.40, a: 0.7 }, { v: 1, a: 1 }],
        suggestedAlphaScale: 0.15,
    },
    {
        id: 'mr-t1',
        label: 'MR T1',
        description: 'Mid-bright tissue emphasized',
        tf: [{ v: 0, a: 0 }, { v: 0.30, a: 0.2 }, { v: 0.55, a: 0.7 }, { v: 0.85, a: 1 }],
        suggestedAlphaScale: 0.10,
    },
    {
        id: 'silhouette',
        label: 'Silhouette',
        description: 'Body outline only (skin/air boundary)',
        tf: [{ v: 0, a: 0 }, { v: 0.05, a: 0 }, { v: 0.10, a: 0.6 }, { v: 0.30, a: 0.05 }, { v: 1, a: 0.05 }],
        suggestedAlphaScale: 0.50,
    },
];

export const DEFAULT_TF: OpacityTF = TF_PRESETS[0].tf;
export const DEFAULT_TF_PRESET_ID = TF_PRESETS[0].id;

// 256-entry lookup table を生成。CPU でも GPU でも同じ table を使えば parity OK。
export const buildOpacityLut = (tf: OpacityTF): Float32Array => {
    const lut = new Float32Array(256);
    if (!tf || tf.length === 0) return lut;
    const sorted = [...tf].sort((a, b) => a.v - b.v);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        if (t <= sorted[0].v) { lut[i] = sorted[0].a; continue; }
        if (t >= sorted[sorted.length - 1].v) { lut[i] = sorted[sorted.length - 1].a; continue; }
        // 区間検索
        let j = 0;
        while (j < sorted.length - 1 && sorted[j + 1].v <= t) j++;
        const p0 = sorted[j];
        const p1 = sorted[j + 1];
        const span = p1.v - p0.v;
        if (span <= 0) { lut[i] = p1.a; continue; }
        const f = (t - p0.v) / span;
        lut[i] = p0.a + f * (p1.a - p0.a);
    }
    return lut;
};

export const findPresetById = (id: string | undefined): TfPreset | null => {
    if (!id) return null;
    return TF_PRESETS.find(p => p.id === id) ?? null;
};
