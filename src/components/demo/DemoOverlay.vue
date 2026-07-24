<script setup lang="ts">
// ガイドツアーのオーバーレイ。カーソル / スポットライト / キャプション / コントロール。
// pointer-events は既定 none (下のアプリを誤操作しない)。コントロールバーだけ有効。
import type { DemoPlayer } from './useDemoPlayer';

const props = defineProps<{ demo: DemoPlayer }>();
const d = props.demo;
</script>

<template>
  <Teleport to="body">
    <div v-if="d.active.value" class="mv-demo-root" aria-live="polite">
      <!-- スポットライト: 対象矩形以外を暗転 -->
      <div
        v-if="d.highlight.value"
        class="mv-demo-spot"
        :style="{
          left: d.highlight.value.x - 6 + 'px',
          top: d.highlight.value.y - 6 + 'px',
          width: d.highlight.value.w + 12 + 'px',
          height: d.highlight.value.h + 12 + 'px',
        }"
      />
      <!-- カーソル -->
      <div
        v-if="d.cursor.visible"
        class="mv-demo-cursor"
        :class="{ moving: d.moving.value }"
        :style="{ transform: `translate(${d.cursor.x}px, ${d.cursor.y}px)` }"
      >
        <span v-if="d.clicking.value" class="mv-demo-ripple" />
        <svg width="28" height="28" viewBox="0 0 28 28" class="mv-demo-arrow" aria-hidden="true">
          <path d="M5 3 L5 22 L10 17 L13.5 24 L16.5 22.5 L13 15.5 L20 15.5 Z"
                fill="#ffffff" stroke="#0b0d12" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </div>

      <!-- キャプション + 進捗 -->
      <div class="mv-demo-caption">
        <div class="mv-demo-progress">Step {{ d.index.value + 1 }} / {{ d.total.value }}</div>
        <div class="mv-demo-text">{{ d.caption.value }}</div>
      </div>

      <!-- コントロール -->
      <div class="mv-demo-controls">
        <button class="mv-demo-btn" title="Restart" @click="d.restart()">
          <v-icon icon="mdi-restart" size="20" />
        </button>
        <button class="mv-demo-btn" title="Previous" :disabled="d.index.value === 0" @click="d.prev()">
          <v-icon icon="mdi-skip-previous" size="20" />
        </button>
        <button v-if="d.playing.value" class="mv-demo-btn primary" title="Pause" @click="d.pause()">
          <v-icon icon="mdi-pause" size="22" />
        </button>
        <button v-else class="mv-demo-btn primary" title="Play" @click="d.play()">
          <v-icon icon="mdi-play" size="22" />
        </button>
        <button class="mv-demo-btn" title="Next" :disabled="d.atEnd.value" @click="d.next()">
          <v-icon icon="mdi-skip-next" size="20" />
        </button>
        <div class="mv-demo-sep" />
        <button class="mv-demo-btn exit" title="Exit tour (Esc)" @click="d.stop()">
          <v-icon icon="mdi-close" size="20" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mv-demo-root {
  position: fixed;
  inset: 0;
  z-index: 4000;
  pointer-events: none;
  font-family: 'Inter', system-ui, sans-serif;
}

/* スポットライト: 巨大 box-shadow で周囲を暗転、対象だけ切り抜く */
.mv-demo-spot {
  position: fixed;
  border-radius: 8px;
  box-shadow: 0 0 0 9999px rgba(4, 6, 10, 0.55);
  outline: 2px solid #00d4aa;
  outline-offset: 0;
  transition: left 0.5s ease, top 0.5s ease, width 0.5s ease, height 0.5s ease;
}

/* カーソル */
.mv-demo-cursor {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  will-change: transform;
}
.mv-demo-cursor.moving {
  transition: transform 0.65s cubic-bezier(0.4, 0.0, 0.2, 1);
}
.mv-demo-arrow {
  position: absolute;
  left: -3px;
  top: -2px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}
.mv-demo-ripple {
  position: absolute;
  left: 0;
  top: 0;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid #00d4aa;
  animation: mv-demo-ripple 0.5s ease-out;
}
@keyframes mv-demo-ripple {
  0% { transform: scale(0.4); opacity: 0.9; }
  100% { transform: scale(3.2); opacity: 0; }
}

/* キャプション */
.mv-demo-caption {
  position: fixed;
  left: 50%;
  bottom: 84px;
  transform: translateX(-50%);
  max-width: min(680px, 88vw);
  background: rgba(15, 20, 25, 0.94);
  border: 1px solid rgba(0, 212, 170, 0.35);
  border-radius: 12px;
  padding: 14px 20px;
  color: #e8eef2;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  text-align: center;
  pointer-events: none;
}
.mv-demo-progress {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #00d4aa;
  margin-bottom: 4px;
}
.mv-demo-text {
  font-size: 16px;
  line-height: 1.55;
}

/* コントロール */
.mv-demo-controls {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(15, 20, 25, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 6px 10px;
  pointer-events: auto;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.mv-demo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #cdd6dc;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.mv-demo-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); color: #fff; }
.mv-demo-btn:disabled { opacity: 0.35; cursor: default; }
.mv-demo-btn.primary { background: #00d4aa; color: #05110d; width: 40px; height: 40px; }
.mv-demo-btn.primary:hover { background: #16e6bd; }
.mv-demo-btn.exit:hover { background: rgba(229, 77, 77, 0.25); color: #ff6b6b; }
.mv-demo-sep { width: 1px; height: 22px; background: rgba(255, 255, 255, 0.15); margin: 0 4px; }

@media (prefers-reduced-motion: reduce) {
  .mv-demo-cursor.moving { transition: none; }
  .mv-demo-spot { transition: none; }
  .mv-demo-ripple { animation: none; }
}
</style>
