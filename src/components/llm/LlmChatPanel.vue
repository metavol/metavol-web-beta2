<script setup lang="ts">
// ローカル LLM (Ollama) とのチャットパネル。
//
// **第一段階なので「会話できるだけ」。** 画像操作の実行はまだ繋いでいない。
// 将来 tool-calling で metavol の操作に繋ぐことを見越して、
//   - 会話履歴を messages 配列で保持 (system prompt を先頭に置ける形)
//   - 応答は逐次表示 (4B クラスでも待たされるため)
//   - 思考 (<think> / message.thinking) は畳んで別枠
// にしてある。
//
// 置き場所は右下のフローティング。左右のドロワーは既に埋まっており、
// 画像を見ながら会話したいので、レイアウトを押しのけない形にした。
import { ref, nextTick, watch, onMounted } from 'vue';
import {
  loadSettings, saveSettings, listModels, chatStream, splitThinking,
  type ChatMessage, type LlmSettings, type ToolCall, type ModelInfo,
} from './ollama';
import { TOOL_DEFS, SYSTEM_PROMPT, runTool, type LlmToolContext } from './tools';

const open = defineModel<boolean>({ default: false });
const prop = defineProps<{
  // アプリ状態を読む窓口。未接続なら tool は使えない旨を答えるだけになる。
  toolContext?: LlmToolContext | null;
}>();

// tool 実行 → 再送 の往復上限。4B モデルが同じ tool を呼び続けるのを止める安全弁。
const MAX_TOOL_ROUNDS = 4;

const settings = ref<LlmSettings>(loadSettings());
const models = ref<ModelInfo[]>([]);
// このターンで実際に使うモデルが thinking 対応か。未知なら false (= think を送らない)。
const supportsThinking = (name: string): boolean => !!models.value.find(m => m.name === name)?.thinking;
const connState = ref<'unknown' | 'ok' | 'ng'>('unknown');
const connReason = ref('');
const showSettings = ref(false);

const messages = ref<ChatMessage[]>([]);
const input = ref('');
const busy = ref(false);
const bodyEl = ref<HTMLElement | null>(null);
let abort: AbortController | null = null;

const scrollToEnd = async () => {
  await nextTick();
  if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
};

const checkConnection = async () => {
  connState.value = 'unknown';
  const r = await listModels(settings.value.baseUrl);
  if (r.ok) {
    models.value = r.models;
    connState.value = 'ok';
    connReason.value = '';
    // 設定中のモデルが無ければ、最初に見つかったものへ寄せる (選び直す手間を省く)
    if (r.models.length > 0 && !r.models.some(m => m.name === settings.value.model)) {
      settings.value.model = r.models[0].name;
      saveSettings(settings.value);
    }
  } else {
    connState.value = 'ng';
    connReason.value = r.reason;
    models.value = [];
  }
};

onMounted(() => { if (open.value) void checkConnection(); });
watch(open, (v) => { if (v) void checkConnection(); });

const onSettingsChanged = () => { saveSettings(settings.value); void checkConnection(); };

// 1 回分のモデル呼び出し。tool 呼び出しが返れば true。
const callModel = async (reply: ChatMessage): Promise<boolean> => {
  // 送るのは thinking を除いた本文と tool 往復だけ
  // (思考を履歴に混ぜると次のターンで引きずるうえ、文脈を無駄に食う)。
  const history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.value.slice(0, -1).map(m => ({
      role: m.role, content: m.content, toolCalls: m.toolCalls, toolName: m.toolName,
    })),
  ];
  let raw = '';
  let sawTools = false;
  await chatStream(settings.value, history, {
    onDelta: (d) => {
      // Ollama の qwen3 は thinking を **別フィールド**で返す (実測で確認)。
      // 一方、モデルによっては本文に <think>…</think> を混ぜてくるので両対応にする。
      if (d.thinking) reply.thinking = (reply.thinking ?? '') + d.thinking;
      if (d.content) {
        raw += d.content;
        if (raw.includes('<think>')) {
          const s = splitThinking(raw);
          reply.thinking = s.thinking;
          reply.content = s.content;
        } else {
          reply.content = raw;
        }
      }
      void scrollToEnd();
    },
    onToolCalls: (calls) => {
      sawTools = true;
      reply.toolCalls = [...(reply.toolCalls ?? []), ...calls];
      void scrollToEnd();
    },
    onDone: () => { void scrollToEnd(); },
    onError: (reason) => {
      reply.content = (reply.content ? reply.content + '\n\n' : '') + `⚠ ${reason}`;
      connState.value = 'ng'; connReason.value = reason;
      void scrollToEnd();
    },
  }, abort?.signal, prop.toolContext ? TOOL_DEFS : undefined,
     supportsThinking(activeModel()));
  return sawTools;
};

// このターンで実際に使われるモデル名 (chatStream の選択規則と揃えること)
const activeModel = (): string =>
  (prop.toolContext && settings.value.toolModel) ? settings.value.toolModel : settings.value.model;

const send = async () => {
  const text = input.value.trim();
  if (!text || busy.value) return;
  input.value = '';
  messages.value.push({ role: 'user', content: text });
  busy.value = true;
  abort = new AbortController();
  await scrollToEnd();

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply: ChatMessage = { role: 'assistant', content: '', thinking: '' };
      messages.value.push(reply);
      const wantsTools = await callModel(reply);
      if (!wantsTools || abort == null) break;

      // tool を実行して結果を履歴へ。失敗しても文字列で返し、モデルに判断させる。
      for (const call of reply.toolCalls ?? []) {
        let out: string;
        try {
          out = JSON.stringify(prop.toolContext ? runTool(prop.toolContext, call.name) : { error: 'no context' });
        } catch (e: any) {
          out = JSON.stringify({ error: String(e?.message ?? e) });
        }
        call.result = out;
        messages.value.push({ role: 'tool', toolName: call.name, content: out });
      }
      await scrollToEnd();
      if (round === MAX_TOOL_ROUNDS - 1) {
        messages.value.push({ role: 'assistant', content:
          '⚠ Stopped after too many tool calls. Try asking a more specific question.' });
      }
    }
  } finally {
    busy.value = false;
    abort = null;
    await scrollToEnd();
  }
};

const stop = () => { abort?.abort(); abort = null; busy.value = false; };
const clearChat = () => { stop(); messages.value = []; };

// Enter 送信 / Shift+Enter 改行
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
};

const showThinking = ref<Record<number, boolean>>({});
const showTool = ref<Record<string, boolean>>({});
</script>

<template>
  <div v-if="open" class="mv-llm-panel" @mousedown.stop @wheel.stop @dblclick.stop>
    <div class="mv-llm-head">
      <v-icon icon="mdi-robot-outline" size="x-small" />
      <span class="mv-llm-title">Assistant</span>
      <span class="mv-llm-conn" :class="'is-' + connState"
            :title="connState === 'ng' ? connReason : settings.baseUrl">
        {{ connState === 'ok'
             ? (settings.toolModel ? settings.model + ' + ' + settings.toolModel : settings.model)
             : connState === 'ng' ? 'offline' : '…' }}
      </span>
      <v-btn icon variant="text" size="x-small" @click="showSettings = !showSettings">
        <v-icon icon="mdi-cog-outline" size="x-small" />
        <v-tooltip activator="parent" location="bottom">Connection settings</v-tooltip>
      </v-btn>
      <v-btn icon variant="text" size="x-small" :disabled="messages.length === 0" @click="clearChat">
        <v-icon icon="mdi-broom" size="x-small" />
        <v-tooltip activator="parent" location="bottom">Clear conversation</v-tooltip>
      </v-btn>
      <v-btn icon variant="text" size="x-small" @click="open = false">
        <v-icon icon="mdi-close" size="x-small" />
        <v-tooltip activator="parent" location="bottom">Close</v-tooltip>
      </v-btn>
    </div>

    <div v-if="showSettings" class="mv-llm-settings">
      <label>Server</label>
      <input v-model="settings.baseUrl" @change="onSettingsChanged"
             placeholder="/ollama or http://localhost:11434" />
      <label>Model</label>
      <select v-if="models.length" v-model="settings.model" @change="onSettingsChanged">
        <option v-for="m in models" :key="m.name" :value="m.name">
          {{ m.name }}{{ m.thinking ? ' (reasoning)' : '' }}{{ m.tools ? '' : ' — no tools' }}
        </option>
      </select>
      <input v-else v-model="settings.model" @change="onSettingsChanged" placeholder="qwen3:4b" />
      <label>Tools</label>
      <select v-if="models.length" v-model="settings.toolModel" @change="onSettingsChanged"
              title="Model used for turns where the assistant may inspect the viewer">
        <option value="">(same as above)</option>
        <option v-for="m in models" :key="'t'+m.name" :value="m.name" :disabled="!m.tools">
          {{ m.name }}{{ m.tools ? '' : ' — no tool support' }}
        </option>
      </select>
      <input v-else v-model="settings.toolModel" @change="onSettingsChanged" placeholder="(same as above)" />
      <span></span>
      <span class="mv-llm-hint">
        Reasoning models stall on tool results — qwen3:4b took over 140 s, qwen2.5:3b 10.7 s for the same
        question. Pick a non-reasoning model here.
      </span>

      <label>Think</label>
      <label class="mv-llm-check">
        <!-- thinking 非対応モデルに think を送ると Ollama が 400 を返すので、
             そのときは操作させない (送信側でも送らないようにしてある)。 -->
        <input type="checkbox" v-model="settings.think" :disabled="!supportsThinking(settings.model)"
               @change="onSettingsChanged" />
        <span v-if="supportsThinking(settings.model)">Keep the model's reasoning in a separate, collapsible block.
          Turning this off does not make qwen3 faster — it just mixes the reasoning into the answer.</span>
        <span v-else>{{ settings.model }} has no reasoning mode, so this has no effect.</span>
      </label>
      <div v-if="connState === 'ng'" class="mv-llm-err">
        Cannot reach Ollama: {{ connReason }}<br />
        Start it with <code>ollama serve</code>, then pull a model (<code>ollama pull qwen3:4b</code>).
      </div>
      <div v-else-if="connState === 'ok' && models.length === 0" class="mv-llm-err">
        Connected, but no models are installed. Run <code>ollama pull qwen3:4b</code>.
      </div>
    </div>

    <div class="mv-llm-body" ref="bodyEl">
      <div v-if="messages.length === 0" class="mv-llm-empty">
        Chat with a local model running on this machine.<br />
        Nothing is sent to the internet.
      </div>
      <!-- tool の結果そのものは transcript に出さない (JSON が長く読みにくい)。
           何を見に行ったかは assistant 側の chip に出す。 -->
      <template v-for="(m, i) in messages" :key="i">
      <div v-if="m.role !== 'tool'" class="mv-llm-msg" :class="'is-' + m.role">
        <div class="mv-llm-role">{{ m.role === 'user' ? 'You' : 'Assistant' }}</div>
        <div v-if="m.toolCalls?.length" class="mv-llm-tools">
          <button v-for="(c, ci) in m.toolCalls" :key="ci" class="mv-llm-tool"
                  :title="c.result ? 'Click to show what the tool returned' : 'running…'"
                  @click="showTool[i + ':' + ci] = !showTool[i + ':' + ci]">
            <v-icon icon="mdi-wrench-outline" size="x-small" /> {{ c.name }}
          </button>
          <pre v-for="(c, ci) in m.toolCalls" :key="'r'+ci"
               v-show="showTool[i + ':' + ci] && c.result">{{ c.result }}</pre>
        </div>
        <div v-if="m.thinking" class="mv-llm-think">
          <button class="mv-llm-think-toggle" @click="showThinking[i] = !showThinking[i]">
            {{ showThinking[i] ? '▾' : '▸' }}
            {{ busy && i === messages.length - 1 && !m.content ? 'thinking…' : 'thinking' }}
          </button>
          <pre v-if="showThinking[i]">{{ m.thinking }}</pre>
        </div>
        <!-- 本文が来る前に「無反応」に見えないよう、生成中は必ず何か出す。
             tool だけ呼んで本文が無いターンでは空の吹き出しを出さない。 -->
        <div v-if="m.content" class="mv-llm-text">{{ m.content
          }}<span v-if="busy && i === messages.length - 1" class="mv-llm-caret">▍</span></div>
        <div v-else-if="busy && i === messages.length - 1" class="mv-llm-waiting">
          {{ m.toolCalls?.length ? 'reading the viewer…' : m.thinking ? 'reasoning…' : 'waiting for the model…' }}
        </div>
      </div>
      </template>
    </div>

    <div class="mv-llm-input">
      <textarea v-model="input" :disabled="connState === 'ng'" rows="2"
                placeholder="Ask something… (Enter to send, Shift+Enter for a new line)"
                @keydown="onKeydown"></textarea>
      <v-btn v-if="!busy" icon variant="text" size="small" :disabled="!input.trim() || connState === 'ng'" @click="send">
        <v-icon icon="mdi-send" size="small" />
        <v-tooltip activator="parent" location="top">Send</v-tooltip>
      </v-btn>
      <v-btn v-else icon variant="text" size="small" @click="stop">
        <v-icon icon="mdi-stop" size="small" />
        <v-tooltip activator="parent" location="top">Stop generating</v-tooltip>
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
/* 右下フローティング。resize: both でユーザが好きな大きさにできる。 */
.mv-llm-panel {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 1200;           /* drawer (1006 付近) より前面 */
  width: 380px;
  height: 520px;
  min-width: 260px;
  min-height: 220px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 60px);
  resize: both;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mv-border-strong, #3a4a5c);
  border-radius: 6px;
  background: var(--mv-surface, #1a2028);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  color: var(--mv-text, #e8eef2);
  font-size: 12px;
}
.mv-llm-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 8px;
  border-bottom: 1px solid var(--mv-border, #2a3441);
  color: var(--mv-accent, #00d4aa);
}
.mv-llm-title { font-weight: 700; letter-spacing: 0.04em; }
.mv-llm-conn {
  margin-left: auto;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  border: 1px solid var(--mv-border, #2a3441);
  color: var(--mv-text-dim, #8fa0b0);
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mv-llm-conn.is-ok { color: var(--mv-accent, #00d4aa); border-color: var(--mv-accent-dim, #007e66); }
.mv-llm-conn.is-ng { color: var(--mv-error, #ff5c7a); border-color: var(--mv-error, #ff5c7a); }

.mv-llm-settings {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 4px 6px;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--mv-border, #2a3441);
  background: rgba(255, 255, 255, 0.03);
}
.mv-llm-settings label { font-size: 10px; color: var(--mv-text-muted, #5a6877); }
.mv-llm-settings input,
.mv-llm-settings select {
  background: var(--mv-surface-2, #222b36);
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 3px;
  color: inherit;
  font-size: 11px;
  padding: 3px 5px;
  min-width: 0;
}
.mv-llm-hint {
  font-size: 9px;
  line-height: 1.45;
  color: var(--mv-text-muted, #5a6877);
}
.mv-llm-err {
  grid-column: 1 / -1;
  font-size: 10px;
  line-height: 1.5;
  color: var(--mv-error, #ff5c7a);
}
.mv-llm-err code {
  background: rgba(255, 255, 255, 0.08);
  padding: 0 3px;
  border-radius: 2px;
}

.mv-llm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
.mv-llm-empty {
  color: var(--mv-text-muted, #5a6877);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
  margin-top: 24px;
}
.mv-llm-msg { margin-bottom: 10px; }
.mv-llm-role {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mv-text-muted, #5a6877);
  margin-bottom: 2px;
}
.mv-llm-msg.is-user .mv-llm-text {
  background: rgba(0, 212, 170, 0.10);
  border-color: var(--mv-accent-dim, #007e66);
}
.mv-llm-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
  background: var(--mv-surface-2, #222b36);
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 4px;
  padding: 6px 8px;
}
.mv-llm-tools { margin-bottom: 3px; }
.mv-llm-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0 3px 3px 0;
  padding: 1px 6px;
  border: 1px solid var(--mv-accent-dim, #007e66);
  border-radius: 9px;
  background: rgba(0, 212, 170, 0.10);
  color: var(--mv-accent, #00d4aa);
  font-size: 10px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  cursor: pointer;
}
.mv-llm-tool:hover { background: rgba(0, 212, 170, 0.2); }
.mv-llm-tools pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 10px;
  line-height: 1.45;
  max-height: 180px;
  overflow: auto;
  color: var(--mv-text-dim, #8fa0b0);
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid var(--mv-accent-dim, #007e66);
  margin: 2px 0 4px;
  padding: 4px 6px;
}

.mv-llm-caret { opacity: 0.6; }
.mv-llm-waiting {
  font-size: 11px;
  color: var(--mv-text-muted, #5a6877);
  font-style: italic;
  padding: 4px 2px;
}
.mv-llm-check {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 10px;
  color: var(--mv-text-dim, #8fa0b0);
  line-height: 1.4;
}
.mv-llm-check input { margin-top: 1px; }
.mv-llm-think { margin-bottom: 3px; }
.mv-llm-think-toggle {
  background: transparent;
  border: none;
  color: var(--mv-text-muted, #5a6877);
  font-size: 10px;
  cursor: pointer;
  padding: 0;
}
.mv-llm-think pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 10px;
  line-height: 1.5;
  color: var(--mv-text-dim, #8fa0b0);
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid var(--mv-border-strong, #3a4a5c);
  margin: 3px 0 0;
  padding: 4px 6px;
}

.mv-llm-input {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 6px;
  border-top: 1px solid var(--mv-border, #2a3441);
}
.mv-llm-input textarea {
  flex: 1 1 auto;
  min-width: 0;
  resize: none;
  background: var(--mv-surface-2, #222b36);
  border: 1px solid var(--mv-border, #2a3441);
  border-radius: 4px;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 5px 6px;
}
.mv-llm-input textarea:focus { outline: 1px solid var(--mv-accent-dim, #007e66); }
</style>
