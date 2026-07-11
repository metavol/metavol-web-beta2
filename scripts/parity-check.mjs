// CPU vs GPU 描画 parity test (CLI / CI 用)。
//
// 前提: dev server を起動しておく (npm run dev)。デフォルトで :3000 を見る。
//
// 使い方:
//   node scripts/parity-check.mjs
//   node scripts/parity-check.mjs --port 3005 --max-diff 16 --max-ratio 0.05
//
// 終了コード:
//   0  全 box 許容範囲内 (pass)
//   1  許容範囲を超える box が 1 個以上 (fail)
//   2  実行エラー (server に届かない、test API が無い、等)
//
// 出力:
//   各 box の {kind, plane, w×h, max channel diff, mismatch pixel ratio} を表で出力。

import { chromium } from 'playwright';

// ---- CLI args ----
const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const PORT = parseInt(opt('port', '3000'), 10);
const BASE = opt('base', '/metavol-web-beta');
const TEST_CASE = opt('case', 'parity');         // ?test=parity
const LOAD_TIMEOUT_MS = parseInt(opt('load-timeout', '60000'), 10);
const WAIT_RENDER_MS = parseInt(opt('wait-render', '2000'), 10);
const MAX_DIFF = parseInt(opt('max-diff', '16'), 10);
const MAX_RATIO = parseFloat(opt('max-ratio', '0.05'));

const URL = `http://localhost:${PORT}${BASE}/?test=${TEST_CASE}`;

console.log(`[parity] launching headless Chromium → ${URL}`);
console.log(`[parity] thresholds: max-channel-diff <= ${MAX_DIFF}, mismatch-ratio < ${MAX_RATIO}`);

// Playwright bundled Chromium は通常 WebGPU adapter 無し (headless shell)。
// 解決: --channel chrome で OS にインストール済みの Chrome を使う。
// 失敗時は --channel="" / --browser="chromium-headed" 等で手動指定。
const HEADLESS = opt('headless', 'false') !== 'false';   // default headed (WebGPU 取得しやすい)
const CHANNEL = opt('channel', 'chrome');                 // 'chrome' | 'msedge' | ''
const browser = await chromium.launch({
    headless: HEADLESS,
    channel: CHANNEL || undefined,
    args: [
        '--enable-features=Vulkan,WebGPU',
        '--enable-unsafe-webgpu',
    ],
});

let exitCode = 0;
try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    page.on('console', (msg) => {
        const t = msg.type();
        if (t === 'error') console.error(`[browser:${t}]`, msg.text());
    });

    await page.goto(URL, { waitUntil: 'load' });

    // WebGPU detect
    const gpuStatus = await page.evaluate(async () => {
        const out = { hasNavigatorGpu: 'gpu' in navigator, adapter: false };
        if (out.hasNavigatorGpu) {
            try {
                const a = await navigator.gpu.requestAdapter();
                out.adapter = !!a;
            } catch (e) { out.error = String(e); }
        }
        return out;
    });
    console.log(`[parity] WebGPU: navigator.gpu=${gpuStatus.hasNavigatorGpu}, adapter=${gpuStatus.adapter}${gpuStatus.error ? ` (${gpuStatus.error})` : ''}`);
    if (!gpuStatus.adapter) {
        console.error('[parity] FATAL: WebGPU not available — mode=gpu would fall back. Aborting (test would be meaningless).');
        await browser.close();
        process.exit(2);
    }

    // Wait until __metavolTest is exposed AND boxes set up (PET Standard 4-up)
    const startWait = Date.now();
    while (Date.now() - startWait < LOAD_TIMEOUT_MS) {
        const ready = await page.evaluate(() => {
            const h = window.__metavolTest;
            if (!h) return { reason: 'no helper' };
            const boxes = h.getBoxes();
            const hasMip = boxes.some(b => b.kind === 'mip');
            const allHaveCanvas = boxes.length >= 4 && boxes.every(b => b.canvas && b.canvas.width > 0);
            return { reason: '', ready: hasMip && allHaveCanvas, boxCount: boxes.length };
        });
        if (ready.ready) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    // Run parity check
    console.log(`[parity] running parityCheck (waitMs=${WAIT_RENDER_MS}, may take ~${WAIT_RENDER_MS * 2 / 1000}s)...`);
    const result = await page.evaluate((waitMs) => window.__metavolTest.parityCheck(waitMs), WAIT_RENDER_MS);

    console.log(`[parity] elapsed: ${result.elapsedMs.toFixed(0)} ms\n`);

    // Pretty print
    const pad = (s, n) => String(s).padEnd(n);
    const padR = (s, n) => String(s).padStart(n);
    console.log(`${pad('id', 3)} ${pad('kind', 12)} ${pad('plane', 6)} ${padR('w×h', 11)} ${padR('maxDiff', 8)} ${padR('mismatch%', 10)} status`);
    console.log('-'.repeat(70));
    let allPass = true;
    for (const b of result.boxes) {
        const wh = `${b.w}×${b.h}`;
        const ratioPct = b.mismatchRatio < 0 ? '-' : (b.mismatchRatio * 100).toFixed(2);
        const pass = b.maxDiff <= MAX_DIFF && b.mismatchRatio < MAX_RATIO;
        if (!pass) allPass = false;
        const tag = b.status === 'no-data' ? 'no-data' : (pass ? 'PASS' : 'FAIL');
        console.log(`${pad(b.id, 3)} ${pad(b.kind, 12)} ${pad(b.plane, 6)} ${padR(wh, 11)} ${padR(b.maxDiff, 8)} ${padR(ratioPct + '%', 10)} ${tag}`);
    }

    if (!allPass) {
        console.error(`\n[parity] FAIL: 1 or more boxes exceed thresholds (max-diff > ${MAX_DIFF} or mismatch >= ${MAX_RATIO * 100}%)`);
        exitCode = 1;
    } else {
        console.log(`\n[parity] PASS: all boxes within thresholds`);
    }
} catch (err) {
    console.error(`[parity] ERROR:`, err);
    exitCode = 2;
} finally {
    await browser.close();
}

process.exit(exitCode);
