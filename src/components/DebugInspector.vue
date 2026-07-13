<script setup lang="ts">
defineProps<{
    enabled: boolean;
    rows: Array<{
        seriesIndex: number;
        modality: string;
        description: string;
        i: number; j: number; k: number;
        value: number | null;
        inBounds: boolean;
    }>;
    mask?: {
        i: number; j: number; k: number; inBounds: boolean;
        threshold: number | null;
        manualRaw: number | null;
        manualLabel: string;
        final: number | null;
        finalLabel: string;
        component: number | null;
        componentValid: boolean;
        componentCount: number;
    } | null;
    world: { x: number; y: number; z: number } | null;
    screenX: number;
    screenY: number;
    show: boolean;
}>();
</script>

<template>
    <div
        v-if="enabled && show"
        class="mv-debug-inspector"
        :style="{ left: (screenX + 16) + 'px', top: (screenY + 16) + 'px' }"
    >
        <div class="hdr">
            <v-icon icon="mdi-bug-outline" size="x-small" />
            <span class="ml-1">voxel inspector</span>
            <span class="hdr-hint ml-2">Shift+Click to edit</span>
        </div>
        <div v-if="world" class="world-row mono">
            <span class="world-label">world (mm)</span>
            <span class="world-val">{{ formatMm(world.x) }}, {{ formatMm(world.y) }}, {{ formatMm(world.z) }}</span>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Series</th>
                    <th>i,j,k</th>
                    <th class="num">value</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="r in rows" :key="r.seriesIndex">
                    <td>
                        <span
                            class="modality"
                            :style="{ background: modalityColor(r.modality) }"
                        >{{ r.modality || '-' }}</span>
                        <span class="desc">{{ r.description || `S${r.seriesIndex}` }}</span>
                    </td>
                    <td class="mono">
                        <span v-if="r.inBounds">{{ r.i }},{{ r.j }},{{ r.k }}</span>
                        <span v-else class="dim">out</span>
                    </td>
                    <td class="mono num">
                        <span v-if="r.value !== null">{{ formatVal(r.value) }}</span>
                        <span v-else class="dim">—</span>
                    </td>
                </tr>
                <tr v-if="rows.length === 0">
                    <td colspan="3" class="dim">no volumes loaded</td>
                </tr>
            </tbody>
        </table>

        <!-- Mask / segment 層 (PET 格子)。assign 波及などの診断用。 -->
        <template v-if="mask">
            <div class="mask-hdr">
                mask @ PET
                <span class="mono dim ml-1">
                    <template v-if="mask.inBounds">{{ mask.i }},{{ mask.j }},{{ mask.k }}</template>
                    <template v-else>out of grid</template>
                </span>
            </div>
            <table v-if="mask.inBounds">
                <tbody>
                    <tr>
                        <td class="layer">final (shown)</td>
                        <td class="mono num">
                            <span :class="{ dim: !mask.final }">{{ mask.final ?? 0 }}</span>
                        </td>
                        <td class="mono seg-label">
                            <span :class="{ dim: mask.finalLabel === '-' }">{{ mask.finalLabel }}</span>
                        </td>
                    </tr>
                    <tr>
                        <td class="layer">threshold</td>
                        <td class="mono num"><span :class="{ dim: !mask.threshold }">{{ mask.threshold ?? 0 }}</span></td>
                        <td></td>
                    </tr>
                    <tr>
                        <td class="layer">manual edit</td>
                        <td class="mono num">
                            <span :class="{ dim: !mask.manualRaw, erase: mask.manualRaw === 0xFFFF }">
                                {{ mask.manualRaw === 0xFFFF ? '0xFFFF' : (mask.manualRaw ?? 0) }}
                            </span>
                        </td>
                        <td class="mono seg-label">
                            <span :class="{ dim: mask.manualLabel === '-', erase: mask.manualLabel === 'erase' }">{{ mask.manualLabel }}</span>
                        </td>
                    </tr>
                    <tr>
                        <td class="layer">component</td>
                        <td class="mono num">
                            <span v-if="mask.componentValid" :class="{ dim: !mask.component }">{{ mask.component ?? 0 }}</span>
                            <span v-else class="dim">stale</span>
                        </td>
                        <td class="mono dim">
                            <span v-if="mask.componentValid">/ {{ mask.componentCount }} islands</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </template>
    </div>
</template>

<script lang="ts">
const modalityColor = (m: string): string => {
    if (m === 'PT' || m === 'PET') return '#ff9b3a';
    if (m === 'CT') return '#7ad0ff';
    if (m === 'MR') return '#a78bfa';
    return '#666';
};
const formatVal = (v: number): string => {
    if (Math.abs(v) < 0.01 || Math.abs(v) >= 100000) return v.toExponential(3);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(3);
};
const formatMm = (v: number): string => v.toFixed(1);
</script>

<style scoped>
.mv-debug-inspector {
    position: fixed;
    z-index: 9999;
    background: rgba(15, 20, 25, 0.96);
    border: 1px solid var(--mv-accent-dim);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--mv-text);
    font-size: 11px;
    pointer-events: none;
    box-shadow: var(--mv-shadow);
    min-width: 220px;
    backdrop-filter: blur(4px);
}

.hdr {
    display: flex;
    align-items: center;
    color: var(--mv-accent);
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
}
.hdr-hint {
    color: var(--mv-text-muted);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
}

.world-row {
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 2px 0 4px 0;
    border-bottom: 1px solid var(--mv-border);
    margin-bottom: 4px;
    font-size: 10px;
}
.world-label {
    color: var(--mv-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.world-val {
    color: var(--mv-text);
}

table {
    width: 100%;
    border-collapse: collapse;
}
th {
    text-align: left;
    color: var(--mv-text-muted);
    font-weight: 500;
    padding-right: 8px;
    border-bottom: 1px solid var(--mv-border);
    padding-bottom: 2px;
}
td {
    padding: 2px 8px 2px 0;
    vertical-align: middle;
}
.num {
    text-align: right;
}
.mono {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 10px;
}
.dim {
    color: var(--mv-text-muted);
}
.modality {
    color: #0F1419;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 9px;
    margin-right: 4px;
}
.desc {
    color: var(--mv-text);
}

.mask-hdr {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid var(--mv-border);
    color: var(--mv-accent);
    font-weight: 600;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}
.layer {
    color: var(--mv-text-muted);
    font-size: 10px;
    padding-right: 8px;
}
.seg-label {
    color: var(--mv-text);
}
.erase {
    color: #ff7f7f;
}
.ml-1 {
    margin-left: 4px;
}
</style>
