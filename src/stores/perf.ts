// Renderer mode + drawing performance store。
//
// rendererMode:
//   'auto' (default): GPU 利用可なら GPU、駄目なら CPU fallback
//   'cpu':            常に CPU (GPU pipeline を bypass)
//   'gpu':            常に GPU (失敗時は何も描かない / parity テスト用)
//
// samples:
//   各 draw kind × backend ごとに直近 N 件のラップタイムを ring buffer で保持。
//   median で表示・regression 検知に使う。

import { defineStore } from 'pinia';

export type RendererMode = 'auto' | 'cpu' | 'gpu';
export type DrawKind = 'mpr' | 'fusion-mpr' | 'mip' | 'smip' | 'vr' | 'mip-multi' | 'vr-multi';
export type Backend = 'cpu' | 'gpu';

interface Sample {
    ms: number;
    ts: number;
}

interface KindStats {
    cpu: Sample[];
    gpu: Sample[];
}

const RING_SIZE = 30;

const emptyStats = (): KindStats => ({ cpu: [], gpu: [] });

export const usePerfStore = defineStore('perf', {
    state: () => ({
        rendererMode: 'auto' as RendererMode,
        samples: {} as Record<string, KindStats>,
    }),
    getters: {
        // GPU を使って良いか (mode + 利用可能性は呼び元で判定)
        gpuAllowed(): boolean {
            return this.rendererMode !== 'cpu';
        },
        // CPU fallback して良いか (mode が 'gpu' のときは fallback しない = 何も描かない)
        cpuFallbackAllowed(): boolean {
            return this.rendererMode !== 'gpu';
        },
    },
    actions: {
        setMode(m: RendererMode) {
            this.rendererMode = m;
        },
        record(kind: DrawKind, backend: Backend, ms: number) {
            if (!this.samples[kind]) this.samples[kind] = emptyStats();
            const arr = this.samples[kind][backend];
            arr.push({ ms, ts: Date.now() });
            if (arr.length > RING_SIZE) arr.shift();
        },
        median(kind: DrawKind, backend: Backend): number | null {
            const arr = this.samples[kind]?.[backend];
            if (!arr || arr.length === 0) return null;
            const sorted = arr.map(s => s.ms).sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        },
        clearSamples() {
            this.samples = {};
        },
    },
});
