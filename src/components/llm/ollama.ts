// ローカル Ollama クライアント。
//
// 接続先:
//   - dev (localhost)  → '/ollama' (vite の proxy が 127.0.0.1:11434 へ中継。CORS 不要)
//   - それ以外          → 'http://localhost:11434' を直接叩く
//                        (Ollama 側で OLLAMA_ORIGINS にそのオリジンの許可が必要)
// ユーザが設定で上書きでき、localStorage に保持する。

const STORAGE_KEY = 'metavol.llm.settings.v1';

export interface LlmSettings {
    baseUrl: string;
    model: string;
    // tool を使うターンで用いるモデル ('' なら model と同じ)。
    //
    // **なぜ分けるか**: reasoning model (qwen3) は tool 結果を渡されると延々と推論して
    // 実用にならない。同じ質問の実測 (Hirata の 2 series を list_series で読ませて要約):
    //   qwen3:4b   … 1 巡目 24s / 2 巡目 140s でも未完 (909 チャンクが全部 thinking)
    //   qwen2.5:3b … 1 巡目 4.4s / 2 巡目 10.7s、日本語で 76 文字の要約
    // tool の用途は「小さな JSON を 1 文にまとめる」だけなので推論は要らない。
    toolModel: string;
    // reasoning model の思考を分離するか。
    //
    // **既定 true。** qwen3:4b で実測したところ、think:false にしても推論が消えるのではなく
    // **本文に混ざって**出てくる ("We are to say hello... But let's think:" と 2336 文字、
    // 60 秒でも終わらず)。true なら推論は message.thinking に分離されるので UI で畳める。
    // (think:true でも一言あいさつに 35 秒かかる。これは 4B モデルの性質で、切っても速くならない)
    think: boolean;
}

const defaultBaseUrl = (): string => {
    if (typeof location !== 'undefined') {
        const h = location.hostname;
        if (h === 'localhost' || h === '127.0.0.1') return '/ollama';
    }
    return 'http://localhost:11434';
};

export const DEFAULT_SETTINGS = (): LlmSettings => ({
    baseUrl: defaultBaseUrl(),
    model: 'qwen3:4b',
    toolModel: '',
    think: true,
});

export const loadSettings = (): LlmSettings => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_SETTINGS();
        const p = JSON.parse(raw);
        const d = DEFAULT_SETTINGS();
        return { baseUrl:   typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : d.baseUrl,
                 model:     typeof p.model   === 'string' && p.model   ? p.model   : d.model,
                 toolModel: typeof p.toolModel === 'string' ? p.toolModel : d.toolModel,
                 think:     typeof p.think   === 'boolean' ? p.think : d.think };
    } catch { return DEFAULT_SETTINGS(); }
};

export const saveSettings = (s: LlmSettings): void => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
};

export interface ToolCall {
    name: string;
    args: Record<string, unknown>;
    // 実行結果 (tool ロールとしてモデルへ返すもの)。UI でも畳んで見せる。
    result?: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    // qwen3 等の reasoning model が返す思考部分。本文とは分けて畳んで表示する。
    thinking?: string;
    // assistant が要求した tool 呼び出し
    toolCalls?: ToolCall[];
    // role='tool' のとき、どの tool の結果か
    toolName?: string;
}

const join = (base: string, path: string) => base.replace(/\/+$/, '') + path;

export interface ModelInfo {
    name: string;
    // capabilities に 'thinking' があるモデルにしか think を送ってはいけない。
    // 送ると Ollama は 400 を返す: {"error":"\"qwen2.5:3b\" does not support thinking"}
    thinking: boolean;
    tools: boolean;
}

// 起動しているか + 利用可能なモデル一覧。失敗理由はそのまま返す (UI で出す)。
export const listModels = async (
    baseUrl: string,
    signal?: AbortSignal,
): Promise<{ ok: true; models: ModelInfo[] } | { ok: false; reason: string }> => {
    try {
        const res = await fetch(join(baseUrl, '/api/tags'), { signal });
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${baseUrl}` };
        const j = await res.json();
        const models: ModelInfo[] = Array.isArray(j?.models)
            ? j.models.map((m: any) => {
                const caps: string[] = Array.isArray(m?.capabilities) ? m.capabilities.map(String) : [];
                return { name: String(m?.name ?? ''), thinking: caps.includes('thinking'), tools: caps.includes('tools') };
            }).filter((m: ModelInfo) => !!m.name)
            : [];
        return { ok: true, models };
    } catch (e: any) {
        // fetch の失敗はほぼ「起動していない」か「CORS で弾かれた」のどちらか
        return { ok: false, reason: e?.message ? String(e.message) : 'connection failed' };
    }
};

// qwen3 は <think>…</think> で思考を吐くことがある。Ollama が message.thinking を
// 分けて返す場合もあるので、両方に対応して「思考」と「本文」に割る。
export const splitThinking = (text: string): { thinking: string; content: string } => {
    let thinking = '';
    let content = text;
    const open = content.indexOf('<think>');
    if (open >= 0) {
        const close = content.indexOf('</think>', open);
        if (close >= 0) {
            thinking = content.slice(open + 7, close).trim();
            content = (content.slice(0, open) + content.slice(close + 8)).trim();
        } else {
            // まだ閉じていない (ストリーム途中): 全部を思考として扱う
            thinking = content.slice(open + 7).trim();
            content = content.slice(0, open).trim();
        }
    }
    return { thinking, content };
};

export interface ChatStreamHandlers {
    onDelta: (delta: { content?: string; thinking?: string }) => void;
    // モデルが tool 呼び出しを要求したとき (ストリーム中 / 最終メッセージのどちらでも来る)
    onToolCalls: (calls: ToolCall[]) => void;
    onDone: () => void;
    onError: (reason: string) => void;
}

// Ollama へ渡す履歴を組み立てる。tool 呼び出しの往復も含める。
const toWireMessages = (messages: ChatMessage[]): unknown[] =>
    messages.map(m => {
        if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName };
        const o: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
            o.tool_calls = m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args } }));
        }
        return o;
    });

// /api/chat をストリーミングで叩く。NDJSON を 1 行ずつ読む。
// 4B クラスでもトークンが出るまで数秒かかるので、逐次表示は必須。
export const chatStream = async (
    settings: LlmSettings,
    messages: ChatMessage[],
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
    tools?: unknown[],
    // このターンで使うモデルが thinking に対応しているか。
    // **対応していないモデルに think を送ると Ollama は 400 を返す**ので、
    // 対応が確認できたときだけ think を積む (未確認なら送らない = 安全側)。
    supportsThinking?: boolean,
): Promise<void> => {
    const useTools = !!(tools && tools.length);
    const model = (useTools && settings.toolModel) ? settings.toolModel : settings.model;
    // reasoning を切るのは tool ターンだけ: 対話は qwen3 の推論が効くので温存する。
    const wantThink = (useTools && settings.toolModel) ? false : settings.think;
    let res: Response;
    try {
        res = await fetch(join(settings.baseUrl, '/api/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: toWireMessages(messages),
                stream: true,
                ...(supportsThinking ? { think: wantThink } : {}),
                ...(useTools ? { tools } : {}),
            }),
            signal,
        });
    } catch (e: any) {
        handlers.onError(e?.message ? String(e.message) : 'connection failed');
        return;
    }
    if (!res.ok || !res.body) {
        // Ollama は理由を body に入れてくる ("does not support thinking" 等)。
        // HTTP コードだけ出しても原因が分からないので、本文を読んで見せる。
        let detail = '';
        try {
            const t = await res.text();
            const j = JSON.parse(t);
            detail = typeof j?.error === 'string' ? j.error : t;
        } catch { /* ignore */ }
        handlers.onError(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            // NDJSON: 行単位で処理。最後の不完全な行は次回に持ち越す。
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let j: any;
                try { j = JSON.parse(line); } catch { continue; }
                if (j.error) { handlers.onError(String(j.error)); return; }
                const msg = j.message ?? {};
                if (msg.thinking) handlers.onDelta({ thinking: String(msg.thinking) });
                if (msg.content)  handlers.onDelta({ content: String(msg.content) });
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                    handlers.onToolCalls(msg.tool_calls.map((c: any) => {
                        const raw = c?.function?.arguments;
                        // arguments は object のことも JSON 文字列のこともある
                        let args: Record<string, unknown> = {};
                        if (raw && typeof raw === 'object') args = raw;
                        else if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { args = {}; } }
                        return { name: String(c?.function?.name ?? ''), args };
                    }).filter((c: ToolCall) => !!c.name));
                }
                if (j.done) { handlers.onDone(); return; }
            }
        }
        handlers.onDone();
    } catch (e: any) {
        if (e?.name === 'AbortError') { handlers.onDone(); return; }
        handlers.onError(e?.message ? String(e.message) : 'stream failed');
    }
};
