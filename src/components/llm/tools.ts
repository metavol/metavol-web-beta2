// LLM に開放する操作 (tool calling)。
//
// **第一弾は読み取り専用のみ。** 破壊的操作 (マスク編集・レイアウト変更) は入れない。
// 定義 (JSON schema) はここに置き、実体は DicomView が持つ状態に触るので
// LlmToolContext として外から注入する (このファイルは Vue に依存しない)。
//
// 返す JSON は **小さく保つこと**。4B クラスのモデルに 16 series 分の冗長な情報を
// 渡すと、それだけで文脈を食い潰して指示に従えなくなる。

export interface LlmToolContext {
    listSeries: () => unknown;
    describeView: () => unknown;
}

export interface ToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
    };
}

export const TOOL_DEFS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'list_series',
            description:
                'List the image series currently loaded in the viewer (modality, description, matrix size, '
                + 'voxel size, number of slices). Use this to answer questions about what data is open.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'describe_view',
            description:
                'Describe what is on screen right now: how many image boxes there are, which series each one '
                + 'shows, how it is rendered (native slice / MPR / MIP / VR), whether it is a fusion, the current '
                + 'slice, and the window settings. Use this to answer questions about the current display.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

export const runTool = (ctx: LlmToolContext, name: string): unknown => {
    switch (name) {
        case 'list_series':   return ctx.listSeries();
        case 'describe_view': return ctx.describeView();
        default:              return { error: `unknown tool: ${name}` };
    }
};

export const SYSTEM_PROMPT =
    'You are an assistant embedded in metavol-web, a PET/CT DICOM viewer used mainly to measure '
    + 'metabolic tumour volume (MTV).\n'
    + 'You can inspect the application state by calling the provided tools. Call a tool whenever the user '
    + 'asks about the loaded data or what is on screen — do not guess, and do not invent series or values.\n'
    + 'Every tool result starts with a "summary" field that already states the counts and the contents in '
    + 'plain English. Base your answer on that summary and simply restate it in the user\'s language. '
    + 'Do NOT recount the items in the arrays yourself, and do not add anything the summary does not say.\n'
    + 'Series and boxes are numbered from 1.\n'
    + 'You cannot change anything yet: the tools are read-only. If the user asks you to modify the view, '
    + 'say plainly that actions are not wired up yet.\n'
    + 'Answer in the same language the user writes in. Be concise: a few sentences or a short list.';
