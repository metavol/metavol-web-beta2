// CLUT (color lookup table) と wc/ww から CSS gradient + min/max ラベル付きの
// "凡例 (legend)" 構造体を作るヘルパ。Volume / Fusion / MIP の box 右下に
// 半透明オーバーレイで表示する用途。

import { cluts } from './Clut';

export interface ClutLegend {
    gradient: string;   // CSS linear-gradient 文字列
    minLabel: string;   // 例 "0.0" / "-700 HU" / "0.0 SUV"
    maxLabel: string;
}

const SAMPLES = 10; // 11 stops で gradient

export const buildClutLegend = (
    clutId: number,
    wc: number,
    ww: number,
    suffix?: string,
): ClutLegend => {
    const c = cluts[clutId] ?? cluts[0];
    const stops: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
        const idx = Math.min(255, Math.floor((i / SAMPLES) * 255));
        const rgb = c[idx];
        if (rgb) {
            stops.push(`rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${(i * 100 / SAMPLES).toFixed(1)}%`);
        }
    }
    const lo = wc - ww / 2;
    const hi = wc + ww / 2;
    const fmt = (v: number): string => {
        if (!Number.isFinite(v)) return '?';
        if (Math.abs(v) >= 100) return v.toFixed(0);
        return v.toFixed(1);
    };
    const sfx = suffix ? ' ' + suffix : '';
    return {
        gradient: `linear-gradient(to right, ${stops.join(',')})`,
        minLabel: fmt(lo) + sfx,
        maxLabel: fmt(hi) + sfx,
    };
};
