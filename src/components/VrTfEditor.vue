<script setup lang="ts">
// VR Opacity Transfer Function 視覚エディタ。
// Popover 内に置くために小さい canvas (~280x84) で control points を draggable に表示。
//
// 操作:
//   - 既存ポイントを drag で v/a 同時編集
//   - 空白部分を click → 新規ポイント追加
//   - 既存ポイントを Shift-click → 削除 (両端は削除しない)
//   - 折れ線で接続 (LUT 補間と同じ linear)
//
// 親への通知は @update:points (新しい配列) と、編集が開始/終了したときの
// @editingChange (drag 中は逐次描画したいので毎フレーム emit するため、scrub の
// throttle は親側で responsibility)。

import { computed, ref, watch } from 'vue';

interface Point { v: number; a: number; }

const props = defineProps<{
    points: Point[];
    width?: number;     // canvas px (default 280)
    height?: number;    // canvas px (default 84)
}>();
const emit = defineEmits<{
    (e: 'update:points', pts: Point[]): void;
}>();

const W = computed(() => props.width ?? 280);
const H = computed(() => props.height ?? 84);
const PAD = 4;   // 内側パディング (handle が canvas 端で隠れないよう)

// 描画 state
const cv = ref<HTMLCanvasElement | null>(null);
const dragIdx = ref<number | null>(null);

// 0..1 range (v, a) ↔ canvas px の座標変換
const vToX = (v: number) => PAD + v * (W.value - 2 * PAD);
const aToY = (a: number) => (H.value - PAD) - a * (H.value - 2 * PAD);
const xToV = (x: number) => Math.max(0, Math.min(1, (x - PAD) / (W.value - 2 * PAD)));
const yToA = (y: number) => Math.max(0, Math.min(1, ((H.value - PAD) - y) / (H.value - 2 * PAD)));

// 制御点を v 昇順で正規化 (両端は v=0 と v=1 を強制)
const normalizePoints = (pts: Point[]): Point[] => {
    const sorted = [...pts].sort((a, b) => a.v - b.v);
    if (sorted.length === 0) return [{ v: 0, a: 0 }, { v: 1, a: 1 }];
    if (sorted[0].v > 0.001) sorted.unshift({ v: 0, a: 0 });
    if (sorted[sorted.length - 1].v < 0.999) sorted.push({ v: 1, a: 1 });
    // 端点の v は 0/1 に固定
    sorted[0].v = 0;
    sorted[sorted.length - 1].v = 1;
    return sorted;
};

const draw = () => {
    if (!cv.value) return;
    const ctx = cv.value.getContext('2d');
    if (!ctx) return;
    const w = W.value, h = H.value;
    ctx.clearRect(0, 0, w, h);

    // 背景: 暗いグリッド
    ctx.fillStyle = '#15191F';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const x = PAD + (w - 2 * PAD) * i / 4;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        const y = PAD + (h - 2 * PAD) * i / 4;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const pts = normalizePoints(props.points);

    // 曲線下部のフィル (alpha 視覚化のため)
    ctx.fillStyle = 'rgba(0, 212, 170, 0.18)';
    ctx.beginPath();
    ctx.moveTo(vToX(pts[0].v), aToY(0));
    for (const p of pts) ctx.lineTo(vToX(p.v), aToY(p.a));
    ctx.lineTo(vToX(pts[pts.length - 1].v), aToY(0));
    ctx.closePath();
    ctx.fill();

    // 折れ線
    ctx.strokeStyle = '#00D4AA';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(vToX(pts[0].v), aToY(pts[0].a));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(vToX(pts[i].v), aToY(pts[i].a));
    ctx.stroke();

    // 制御点
    for (let i = 0; i < pts.length; i++) {
        const x = vToX(pts[i].v);
        const y = aToY(pts[i].a);
        ctx.fillStyle = (i === dragIdx.value) ? '#FFD24A' : '#00D4AA';
        ctx.strokeStyle = '#0F1419';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
};

// 制御点 array が外部から変わったら再描画
watch(() => props.points, () => draw(), { deep: true });
watch([W, H], () => draw());

// canvas mount したら 1 度描画
const onCanvasMounted = (el: HTMLCanvasElement | null) => {
    cv.value = el;
    if (el) requestAnimationFrame(draw);
};

const findHitIndex = (pts: Point[], px: number, py: number, hitR = 8): number => {
    for (let i = 0; i < pts.length; i++) {
        const dx = vToX(pts[i].v) - px;
        const dy = aToY(pts[i].a) - py;
        if (dx * dx + dy * dy <= hitR * hitR) return i;
    }
    return -1;
};

const onMouseDown = (e: MouseEvent) => {
    if (!cv.value) return;
    const rect = cv.value.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const pts = normalizePoints(props.points);
    const hit = findHitIndex(pts, px, py);

    if (hit >= 0) {
        if (e.shiftKey) {
            // 両端 (i=0, last) は v 固定だが alpha 編集は許可。完全削除は中点のみ。
            if (hit > 0 && hit < pts.length - 1) {
                const next = pts.filter((_, j) => j !== hit);
                emit('update:points', next);
            }
            return;
        }
        dragIdx.value = hit;
        e.preventDefault();
        return;
    }
    // 空白 click → 新規ポイント挿入
    const newPt = { v: xToV(px), a: yToA(py) };
    const next = normalizePoints([...pts, newPt]);
    // 新規挿入後 drag を続けられるように、対応 index を見つけて dragIdx に
    const newIdx = next.findIndex(p => Math.abs(p.v - newPt.v) < 0.0001 && Math.abs(p.a - newPt.a) < 0.0001);
    dragIdx.value = newIdx >= 0 ? newIdx : null;
    emit('update:points', next);
    e.preventDefault();
};

const onMouseMove = (e: MouseEvent) => {
    if (dragIdx.value == null || !cv.value) return;
    const rect = cv.value.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const pts = normalizePoints(props.points);
    const i = dragIdx.value;
    if (i < 0 || i >= pts.length) return;

    let newV = xToV(px);
    let newA = yToA(py);
    // 両端は v 固定
    if (i === 0) newV = 0;
    else if (i === pts.length - 1) newV = 1;
    else {
        // 隣接点と必ず入れ替えなしで 0.001 以上離す
        const minV = pts[i - 1].v + 0.005;
        const maxV = pts[i + 1].v - 0.005;
        if (newV < minV) newV = minV;
        if (newV > maxV) newV = maxV;
    }
    pts[i] = { v: newV, a: newA };
    emit('update:points', pts);
};

const onMouseUpOrLeave = () => {
    if (dragIdx.value != null) {
        dragIdx.value = null;
        draw();
    }
};

// global mouseup を捕まえて drag 終了 (canvas 外で離しても止まる)
if (typeof window !== 'undefined') {
    window.addEventListener('mouseup', onMouseUpOrLeave);
    window.addEventListener('mousemove', (e) => { if (dragIdx.value != null) onMouseMove(e); });
}
</script>

<template>
    <div class="mv-tf-editor">
        <canvas
            :ref="(el) => onCanvasMounted(el as HTMLCanvasElement | null)"
            :width="W" :height="H"
            class="mv-tf-canvas"
            @mousedown="onMouseDown"
        />
        <div class="mv-tf-hint">
            Drag points · click empty area to add · Shift-click to delete
        </div>
    </div>
</template>

<style scoped>
.mv-tf-editor {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.mv-tf-canvas {
    display: block;
    width: 100%;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    cursor: crosshair;
}
.mv-tf-hint {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1.3;
}
</style>
