// ガイドツアー (デモ) の再生コントローラ。
// 自動再生＋一時停止。ステップを順に: カーソル移動 → キャプション待ち → クリック演出
// → 実アクション → 描画 settle → 次へ。next/prev/pause/restart/stop で制御。
//
// 非同期の途中で next/prev/stop が来たら世代カウンタ (gen) で古いチェーンを打ち切る。

import { reactive, ref, computed } from 'vue';
import type { DemoScenario, DemoStep, DemoTarget } from './types';

const prefersReducedMotion = (): boolean =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const waitForIdle = async (ms = 500): Promise<void> => {
    const t = (window as any).__metavolTest;
    if (t?.waitForIdle) { await t.waitForIdle(ms); return; }
    await delay(ms);
};

export interface ResolvedRect {
    cx: number; cy: number;
    x: number; y: number; w: number; h: number;
}

const resolveTarget = (target?: DemoTarget): ResolvedRect | null => {
    if (!target) return null;
    if (target.kind === 'point') {
        return { cx: target.x, cy: target.y, x: target.x - 8, y: target.y - 8, w: 16, h: 16 };
    }
    const el = document.querySelector(target.sel) as HTMLElement | null;
    if (!el) { console.warn(`[demo] target not found: ${target.sel}`); return null; }
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left, y: r.top, w: r.width, h: r.height };
};

export const useDemoPlayer = () => {
    const MOVE_MS = 650;
    const DEFAULT_PRE_WAIT = 650;
    const DEFAULT_SETTLE = 500;

    const scenario = ref<DemoScenario | null>(null);
    const index = ref(0);
    const active = ref(false);     // オーバーレイ表示中か
    const playing = ref(false);    // 自動送り中か
    const moving = ref(false);     // カーソル移動アニメ中か
    const clicking = ref(false);   // クリック波紋
    const cursor = reactive({ x: window.innerWidth / 2, y: window.innerHeight / 2, visible: false });
    const highlight = ref<ResolvedRect | null>(null);

    const steps = computed<DemoStep[]>(() => scenario.value?.steps ?? []);
    const total = computed(() => steps.value.length);
    const current = computed<DemoStep | null>(() => steps.value[index.value] ?? null);
    const caption = computed(() => current.value?.caption ?? '');
    const atEnd = computed(() => index.value >= total.value - 1);

    let gen = 0;

    const moveCursorTo = async (rect: ResolvedRect | null) => {
        if (!rect) return;
        cursor.visible = true;
        moving.value = true;
        cursor.x = rect.cx;
        cursor.y = rect.cy;
        await delay(prefersReducedMotion() ? 0 : MOVE_MS);
        moving.value = false;
    };

    const doClick = async () => {
        clicking.value = true;
        await delay(prefersReducedMotion() ? 0 : 260);
        clicking.value = false;
    };

    const runStep = async (i: number): Promise<void> => {
        if (i < 0 || i >= total.value) return;
        const myGen = ++gen;
        index.value = i;
        const step = steps.value[i];

        const rect = resolveTarget(step.target);
        highlight.value = rect;
        await moveCursorTo(rect);
        if (myGen !== gen) return;

        await delay(step.preWaitMs ?? DEFAULT_PRE_WAIT);
        if (myGen !== gen) return;

        const gesture = step.gesture ?? (step.action ? 'click' : 'move');
        if (gesture === 'click' && rect) await doClick();
        if (myGen !== gen) return;

        if (step.action) {
            try { await step.action(); }
            catch (e) { console.warn(`[demo] step "${step.id}" action failed`, e); }
        }
        if (myGen !== gen) return;

        if (step.settle === 'idle') await waitForIdle();
        else await delay(typeof step.settle === 'number' ? step.settle : DEFAULT_SETTLE);
        if (myGen !== gen) return;

        // 自動送り
        if (playing.value) {
            if (i + 1 < total.value) runStep(i + 1);
            else finish();
        }
    };

    const finish = () => {
        playing.value = false;
        // 最終ステップのキャプションは残す (Exit を押すまで表示)。
    };

    // ---- 外部 API ----
    const start = (sc: DemoScenario) => {
        scenario.value = sc;
        active.value = true;
        playing.value = true;
        cursor.x = window.innerWidth / 2;
        cursor.y = window.innerHeight / 2;
        cursor.visible = false;
        runStep(0);
    };

    const stop = () => {
        gen++;                     // 進行中チェーンを打ち切る
        active.value = false;
        playing.value = false;
        moving.value = false;
        clicking.value = false;
        cursor.visible = false;
        highlight.value = null;
    };

    const pause = () => { playing.value = false; };

    const play = () => {
        if (!active.value) return;
        playing.value = true;
        // 現ステップは完了済みなので次から。末尾なら現状維持。
        if (index.value + 1 < total.value) runStep(index.value + 1);
    };

    const next = () => {
        if (!active.value) return;
        if (index.value + 1 < total.value) runStep(index.value + 1);
    };

    const prev = () => {
        if (!active.value) return;
        if (index.value > 0) runStep(index.value - 1);
    };

    const restart = () => {
        if (!active.value) return;
        playing.value = true;
        runStep(0);
    };

    return {
        // state (読み取り用)
        active, playing, moving, clicking, cursor, highlight,
        index, total, caption, current, atEnd, scenario,
        // controls
        start, stop, pause, play, next, prev, restart,
    };
};

export type DemoPlayer = ReturnType<typeof useDemoPlayer>;
