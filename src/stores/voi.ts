import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { VoiTemplate, VoiTemplateCheck } from '../components/voi/voiTemplate';
import type { VoiOverlapDiagnostics } from '../components/voi/voiResample';
import type { VoiStat } from '../components/voi/voiStats';

// SPM 標準脳変換後の画像に VOI テンプレートを重ねて領域統計を出す機能の state。
//
// **segmentation store とは分ける。** あちらの mask は PET 格子固定で
// `loadMaskFromNifti` が dims 完全一致を要求する。VOI テンプレートは格子が違う
// (実測: アトラス 1.5mm 121^3 × 正規化画像 2mm 79x95x79) ので、
// 無理に載せると MTV 測定の経路を壊す。

interface VoiState {
    template: VoiTemplate | null;
    templateCheck: VoiTemplateCheck | null;
    stats: VoiStat[];
    diagnostics: VoiOverlapDiagnostics | null;
    warnings: string[];
    /** 解析対象にした series の表示名 (どの画像の数値かを取り違えないため) */
    analyzedLabel: string;
    analyzedSeriesUID: string | null;
    /** 画像の値の単位 (sidecar 相当。PT なら SUV) */
    analyzedUnit: string;
    lastRunMs: number;
    // ===== overlay 表示 =====
    // **重ねるのは「実際に数値を出した割り当て結果」** (画像格子上の labelOf) であって、
    // アトラスそのもの (別格子) ではない。アトラスを直接重ねると
    // 「見た目は合っているのに計算は別物」を見逃す。
    labelOf: Uint16Array | null;
    /** labelOf が乗っている series の index (再解析やジャンプ機能の起点) */
    analyzedSeriesIndex: number;
    /** SUVR の参照領域 id (null = SUVR 列を出さない)。小脳・橋などを想定。
        再解析やテンプレート差し替えでも保持する (複数症例で同じ参照を使い回すため)。 */
    suvrRefId: number | null;
}

export const useVoiStore = defineStore('voi', {
    state: (): VoiState => ({
        template: null,
        templateCheck: null,
        stats: [],
        diagnostics: null,
        warnings: [],
        analyzedLabel: '',
        analyzedSeriesUID: null,
        analyzedUnit: '',
        lastRunMs: 0,
        labelOf: null,
        analyzedSeriesIndex: -1,
        suvrRefId: null,
    }),
    getters: {
        hasTemplate: (s) => !!s.template,
        hasResults: (s) => s.stats.length > 0,
        /** voxel を 1 つも得られなかった領域数。テンプレート不一致の early warning */
        emptyRegionCount: (s) => s.stats.filter(r => r.voxels === 0).length,
    },
    actions: {
        setTemplate(template: VoiTemplate, check: VoiTemplateCheck) {
            // **markRaw を通すこと。** ラベル volume は 200 万 voxel 級で、
            // Pinia の reactive proxy に包むと読み取りのたびに proxy を経由して遅くなる。
            // 中身は差し替えず参照ごと入れ替える運用なので reactive である必要がない。
            this.template = markRaw(template);
            this.templateCheck = check;
            this.clearResults();
        },
        clearResults() {
            this.stats = [];
            this.labelOf = null;
            this.analyzedSeriesIndex = -1;
            this.diagnostics = null;
            this.warnings = [];
            this.analyzedLabel = '';
            this.analyzedSeriesUID = null;
            this.analyzedUnit = '';
            this.lastRunMs = 0;
        },
        setResults(payload: {
            stats: VoiStat[];
            diagnostics: VoiOverlapDiagnostics;
            warnings: string[];
            label: string;
            seriesUID: string | null;
            unit: string;
            elapsedMs: number;
            labelOf: Uint16Array;
            seriesIndex: number;
        }) {
            this.stats = payload.stats;
            this.diagnostics = payload.diagnostics;
            this.warnings = payload.warnings;
            this.analyzedLabel = payload.label;
            this.analyzedSeriesUID = payload.seriesUID;
            this.analyzedUnit = payload.unit;
            this.lastRunMs = payload.elapsedMs;
            // **markRaw で包む。** 60 万〜数百万要素の TypedArray を reactive proxy に
            // 通すと描画のたびに proxy 経由の読み取りが走る。中身は差し替え運用なので不要。
            this.labelOf = markRaw(payload.labelOf) as Uint16Array;
            this.analyzedSeriesIndex = payload.seriesIndex;
        },
        clearAll() {
            this.template = null;
            this.templateCheck = null;
            this.clearResults();
        },
    },
});
