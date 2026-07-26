// Lesion / segmentation report の PowerPoint (.pptx) 出力。
// pptxgenjs を動的 import して bundle 軽量化 (PDF の jsPDF と同じ方針)。
//
// PDF レポートとの違い (ユーザ指定):
//   - **画像メイン**。スライド 1 枚あたり最大 2 枚の大きな画像を敷く。
//   - 病変テーブルは **サマリーのみ** (全身 MTV 合計など)。病変ごとの行は出さない。
//     → カンファ/スライド発表用。詳細な per-lesion 値が要るときは PDF か CSV を使う。
//
// 入力型は PDF と共通 (PdfReportInput) にして、呼び出し側の組み立てを 1 本化する。

import type { PdfReportInput } from './pdfReport';

// アプリのダークテーマに合わせる (画像が暗いので明るい地だと浮く)
const BG = '0F1419';
const FG = 'E8EEF2';
const DIM = '8FA0B0';
const ACCENT = '00D4AA';

const fmt = (v: number | null | undefined, dp = 2): string =>
    (v != null && Number.isFinite(v)) ? v.toFixed(dp) : '-';

// 画像は各 ImageBox の canvas から直接取る (html2canvas 不要)。
// タイトルは titlebar の説明 (.mv-desc)。
const collectCanvases = (): Array<{ canvas: HTMLCanvasElement; title: string }> => {
    const out: Array<{ canvas: HTMLCanvasElement; title: string }> = [];
    document.querySelectorAll('.mv-canvas-wrap').forEach((wrap, idx) => {
        const cv = wrap.querySelector('canvas.mv-canvas') as HTMLCanvasElement | null;
        if (!cv || cv.width === 0 || cv.height === 0) return;
        const titleEl = wrap.parentElement?.querySelector('.mv-desc');
        const title = (titleEl?.textContent ?? `Box ${idx + 1}`).trim() || `Box ${idx + 1}`;
        out.push({ canvas: cv, title });
    });
    return out;
};

// cell (w x h) に収まる最大の矩形を、画像のアスペクト比を保って中央寄せで返す。
const fitRect = (
    imgW: number, imgH: number,
    cellX: number, cellY: number, cellW: number, cellH: number,
) => {
    const scale = Math.min(cellW / imgW, cellH / imgH);
    const w = imgW * scale;
    const h = imgH * scale;
    return { x: cellX + (cellW - w) / 2, y: cellY + (cellH - h) / 2, w, h };
};

export const generatePptReport = async (input: PdfReportInput): Promise<void> => {
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';          // 10 x 5.625 inch
    const SW = 10, SH = 5.625;
    const M = 0.45;                        // margin

    // ================= Slide 1: サマリー =================
    const s1 = pptx.addSlide();
    s1.background = { color: BG };

    s1.addText('PET Segmentation Report', {
        x: M, y: 0.35, w: SW - M * 2, h: 0.55,
        fontSize: 30, bold: true, color: FG,
    });
    // アクセントの下線
    s1.addShape(pptx.ShapeType.rect, {
        x: M, y: 0.98, w: 1.6, h: 0.045, fill: { color: ACCENT },
    });

    const subtitleParts = [
        input.seriesDescription || null,
        input.petModality || null,
        input.activeTracerName || null,
    ].filter(Boolean);
    s1.addText(subtitleParts.join('  ·  ') || 'metavol-web', {
        x: M, y: 1.12, w: SW - M * 2, h: 0.3,
        fontSize: 13, color: DIM,
    });

    // ---- サマリー表 (全身の合計のみ。per-lesion は出さない) ----
    const t = input.totals;
    const rows: Array<[string, string]> = [
        ['Lesions (count)', t ? String(t.count) : '-'],
        ['Total MTV', t ? `${fmt(t.totalMtv, 1)} ml` : '-'],
        ['Total TLG', t ? fmt(t.totalTlg, 1) : '-'],
        ['Highest SUVmax', t ? fmt(t.maxSuv, 2) : '-'],
        ['Threshold', input.thresholdLabel || '-'],
    ];
    if (input.deauvilleHighest) {
        rows.push(['Deauville (highest)', `${input.deauvilleHighest.score} — ${input.deauvilleHighest.label}`]);
    }
    if (input.referenceLiverSuvMean != null) {
        rows.push(['Liver SUVmean (ref)', fmt(input.referenceLiverSuvMean, 2)]);
    }
    if (input.referenceBloodPoolSuvMean != null) {
        rows.push(['Blood pool SUVmean (ref)', fmt(input.referenceBloodPoolSuvMean, 2)]);
    }
    if (input.suvSourceLabel) rows.push(['SUV source', input.suvSourceLabel]);

    s1.addTable(
        rows.map(([k, v]) => ([
            { text: k, options: { color: DIM, bold: false } },
            { text: v, options: { color: FG, bold: true } },
        ])),
        {
            x: M, y: 1.65, w: SW - M * 2,
            colW: [3.4, SW - M * 2 - 3.4],
            fontSize: 14,
            rowH: 0.34,
            border: { type: 'solid', color: '2A3441', pt: 1 },
            fill: { color: '151C24' },
            valign: 'middle',
            margin: 6,
        },
    );

    if (input.suvWarning) {
        s1.addText(`SUV warning: ${input.suvWarning.reason} (${input.suvWarning.source})`, {
            x: M, y: SH - 0.72, w: SW - M * 2, h: 0.3,
            fontSize: 11, color: 'FFB454',
        });
    }
    s1.addText('metavol-web', {
        x: SW - M - 2, y: SH - 0.42, w: 2, h: 0.25,
        fontSize: 9, color: DIM, align: 'right',
    });

    // ================= Slide 2..: 画像 (メイン) =================
    const shots = collectCanvases();
    const PER_SLIDE = 2;                   // 大きく見せるため 1 枚 2 図
    for (let i = 0; i < shots.length; i += PER_SLIDE) {
        const chunk = shots.slice(i, i + PER_SLIDE);
        const sl = pptx.addSlide();
        sl.background = { color: BG };

        const cellTop = 0.35;
        const cellH = SH - cellTop - 0.75;          // 下にキャプション分を残す
        const gap = 0.3;
        const cellW = (SW - M * 2 - gap * (chunk.length - 1)) / chunk.length;

        chunk.forEach((shot, k) => {
            const cellX = M + k * (cellW + gap);
            const r = fitRect(shot.canvas.width, shot.canvas.height, cellX, cellTop, cellW, cellH);
            sl.addImage({
                data: shot.canvas.toDataURL('image/png'),
                x: r.x, y: r.y, w: r.w, h: r.h,
            });
            sl.addText(shot.title, {
                x: cellX, y: cellTop + cellH + 0.08, w: cellW, h: 0.3,
                fontSize: 12, color: FG, align: 'center',
            });
        });

        sl.addText('metavol-web', {
            x: SW - M - 2, y: SH - 0.35, w: 2, h: 0.22,
            fontSize: 9, color: DIM, align: 'right',
        });
    }

    if (shots.length === 0) {
        const sl = pptx.addSlide();
        sl.background = { color: BG };
        sl.addText('No images were open when this report was generated.', {
            x: M, y: SH / 2 - 0.3, w: SW - M * 2, h: 0.6,
            fontSize: 16, color: DIM, align: 'center',
        });
    }

    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const safeUid = input.seriesUid
        ? input.seriesUid.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
        : 'report';
    await pptx.writeFile({ fileName: `${safeUid}_report_${ts}.pptx` });
};
