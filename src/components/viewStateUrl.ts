// View state を URL query (?state=...) に encode/decode するユーティリティ。
// 用途: Persona 2 (link share) と Persona 1 (PR 発表時のスクリーン再現) 両方。
//
// 制約:
//   - file ロードは別経路 (?url=... or ?dev=... or ?demo=...)。state は layout のみ。
//   - 同じ series が同じ順序で load される前提 (seriesIdx 直接保存)。
//     順序が違うときは modality + seriesUID で resolve するのが理想だが MVP では idx そのまま。
//   - encode 後の長さ目安: 4 box layout で ~200 byte (base64 後)。

export interface SerializedBoxState {
    /** kind: 'd' = dicom slice, 'v' = volume MPR, 'f' = fusion, 'm' = mip */
    k: string;
    /** primary series index */
    s: number;
    /** overlay series index (fusion only) */
    s1?: number;
    /** plane / view: 'axi'|'cor'|'sag'|'mip'|'smip'|'vr' */
    p?: string;
    /** Window Center / Width (primary layer) */
    wc?: number;
    ww?: number;
    /** CLUT id (primary) */
    c?: number;
    /** WC/WW/CLUT (overlay layer, fusion only) */
    wc1?: number;
    ww1?: number;
    c1?: number;
    /** overlay blend alpha (fusion only, 0..1) */
    oa?: number;
    /** MIP/sMIP/VR params */
    mipAngle?: number;
    surfThresh?: number;
    surfDepth?: number;
    alphaScale?: number;
    vrPreset?: string;
    /** interpolation: 'n'|'b' (nearest/bilinear) for base + overlay */
    in?: string;
    in1?: string;
}

export interface SerializedViewState {
    v: 1;                               // schema version
    t: number;                          // tileN
    sync?: boolean;                     // syncImageBox
    bs: SerializedBoxState[];
}

export const encodeViewState = (state: SerializedViewState): string => {
    const json = JSON.stringify(state);
    return btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const decodeViewState = (s: string): SerializedViewState | null => {
    try {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        // atob → byte string → utf8 decode
        const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const json = decodeURIComponent(escape(atob(padded)));
        const parsed = JSON.parse(json);
        if (parsed?.v !== 1) return null;
        return parsed as SerializedViewState;
    } catch {
        return null;
    }
};
