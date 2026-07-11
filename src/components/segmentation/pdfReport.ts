// Lesion / segmentation report の PDF 出力。
// jsPDF を動的 import して bundle 軽量化。
//
// レイアウト (A4 portrait, 210x297mm):
//   Page 1: header / SUV info / threshold / Deauville / lesion table / totals
//   Page 2..: ImageBox canvas thumbnails (.mv-canvas を全部 grab → grid)
//
// 画像取得は html2canvas を使わず canvas.toDataURL() で直接。これで dependency を 1 個に抑えられる。

import type { LesionStat } from './maskOps';

export interface PdfReportInput {
    seriesUid?: string;
    seriesDescription?: string;
    petModality?: string;
    suvOk: boolean | null;
    suvSourceLabel: string | null;          // "SUVbw (DICOM BQML)" 等
    suvWarning: { reason: string; source: string } | null;
    thresholdMethod: string;                // 'fixed' | 'pctMax' | 'liverPercist' | 'liverPct'
    thresholdValue: number;                 // 表示用の代表値
    thresholdLabel: string;                 // "SUV ≥ 2.5" 等の人間向け短文
    activeTracerName: string | null;
    referenceLiverSuvMean: number | null;
    referenceBloodPoolSuvMean: number | null;
    lesions: Array<LesionStat & { colorRgb: [number, number, number] }>;
    totals: {
        count: number;
        totalMtv: number;
        totalTlg: number;
        totalVox: number;
        maxSuv: number;
    } | null;
    deauvilleHighest: { score: number; label: string } | null;
}

const fmt = (v: number, dp = 2): string =>
    Number.isFinite(v) ? v.toFixed(dp) : '-';

// jsPDF の標準 helvetica は WinAnsi (Latin-1) のみ。Unicode を渡すと
// 画面上の見た目が崩れたり space 化したりする。よく出る記号を ASCII 化。
const sanitize = (s: string): string =>
    s.replace(/≥/g, '>=')
     .replace(/≤/g, '<=')
     .replace(/×/g, 'x')
     .replace(/±/g, '+/-')
     .replace(/σ/g, 'SD')
     .replace(/μ/g, 'u')
     .replace(/—/g, '-')
     .replace(/–/g, '-')
     .replace(/[^\x20-\x7E]/g, '?');   // 残った非 ASCII は ? に

const collectCanvases = (): Array<{ canvas: HTMLCanvasElement; title: string }> => {
    const out: Array<{ canvas: HTMLCanvasElement; title: string }> = [];
    const wraps = document.querySelectorAll('.mv-canvas-wrap');
    wraps.forEach((wrap, idx) => {
        const cv = wrap.querySelector('canvas.mv-canvas') as HTMLCanvasElement | null;
        if (!cv || cv.width === 0 || cv.height === 0) return;
        // titlebar から表示名を取る (なければ index)
        const titleEl = wrap.parentElement?.querySelector('.mv-titlebar-text');
        const title = (titleEl?.textContent ?? `Box ${idx + 1}`).trim();
        out.push({ canvas: cv, title });
    });
    return out;
};

export const generateReport = async (input: PdfReportInput): Promise<void> => {
    const { jsPDF } = await import('jspdf');

    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 12;
    let y = margin;

    // ---- Header ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('metavol PET Segmentation Report', margin, y);
    y += 7;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, margin, y);
    y += 5;
    if (input.seriesDescription) {
        doc.text(sanitize(`Series: ${input.seriesDescription}`), margin, y);
        y += 5;
    }
    if (input.seriesUid) {
        doc.text(sanitize(`UID: ${input.seriesUid}`), margin, y);
        y += 5;
    }
    doc.setTextColor(0, 0, 0);
    y += 2;

    // ---- SUV / threshold rationale ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('SUV & Threshold', margin, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);

    if (input.suvWarning) {
        doc.setTextColor(180, 100, 0);
        doc.text(sanitize(`! SUV warning (${input.suvWarning.source}): ${input.suvWarning.reason}`), margin, y);
        doc.setTextColor(0, 0, 0);
        y += 5;
    } else if (input.suvSourceLabel) {
        doc.text(sanitize(`SUV source: ${input.suvSourceLabel}`), margin, y);
        y += 5;
    }
    doc.text(sanitize(`Threshold method: ${input.thresholdMethod} (${input.thresholdLabel})`), margin, y);
    y += 5;
    if (input.activeTracerName) {
        doc.text(sanitize(`Active tracer preset: ${input.activeTracerName}`), margin, y);
        y += 5;
    }
    if (input.referenceLiverSuvMean != null) {
        doc.text(`Reference liver SUVmean: ${fmt(input.referenceLiverSuvMean)}`, margin, y);
        y += 5;
    }
    if (input.referenceBloodPoolSuvMean != null) {
        doc.text(`Reference blood-pool SUVmean: ${fmt(input.referenceBloodPoolSuvMean)}`, margin, y);
        y += 5;
    }
    if (input.deauvilleHighest) {
        doc.setFont('helvetica', 'bold');
        doc.text(sanitize(`Highest Deauville: ${input.deauvilleHighest.label}`), margin, y);
        doc.setFont('helvetica', 'normal');
        y += 5;
    }
    y += 2;

    // ---- Lesion table ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`Lesions (${input.lesions.length})`, margin, y);
    y += 5;

    if (input.lesions.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(120, 120, 120);
        doc.text('No lesions — apply threshold or paint a polygon.', margin, y);
        doc.setTextColor(0, 0, 0);
        y += 6;
    } else {
        // Column layout (mm). 7 列。残り width = pageW - 2*margin = 186mm
        const cols = [
            { key: '#',       w: 8,  align: 'right' as const },
            { key: 'Label',   w: 50, align: 'left'  as const },
            { key: 'SUVmax',  w: 18, align: 'right' as const },
            { key: 'SUVpeak', w: 22, align: 'right' as const },
            { key: 'SUVmean', w: 22, align: 'right' as const },
            { key: 'MTV cc',  w: 22, align: 'right' as const },
            { key: 'TLG',     w: 22, align: 'right' as const },
            { key: 'Vox',     w: 18, align: 'right' as const },
        ];
        const rowH = 5;
        const drawHeader = () => {
            doc.setFillColor(40, 50, 60);
            doc.setTextColor(230, 230, 230);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.rect(margin, y, pageW - 2 * margin, rowH, 'F');
            let x = margin;
            for (const c of cols) {
                const tx = c.align === 'right' ? x + c.w - 1 : x + 1;
                doc.text(c.key, tx, y + 3.5, { align: c.align });
                x += c.w;
            }
            y += rowH;
            doc.setTextColor(0, 0, 0);
            doc.setFont('helvetica', 'normal');
        };
        drawHeader();

        input.lesions.forEach((l, i) => {
            if (y + rowH > pageH - margin) {
                doc.addPage();
                y = margin;
                drawHeader();
            }
            // 偶数行は薄いゼブラ
            if (i % 2 === 1) {
                doc.setFillColor(245, 246, 248);
                doc.rect(margin, y, pageW - 2 * margin, rowH, 'F');
            }
            // ラベル色 swatch
            const swatchX = margin + cols[0].w + 1;
            doc.setFillColor(l.colorRgb[0], l.colorRgb[1], l.colorRgb[2]);
            doc.rect(swatchX, y + 1, 2.5, 2.5, 'F');

            doc.setFontSize(8);
            const safeName = sanitize(l.labelName);
            const values = [
                String(i + 1),
                ' ' + (safeName.length > 28 ? safeName.slice(0, 27) + '...' : safeName),
                fmt(l.suvMax, 2),
                fmt(l.suvPeak, 2),
                fmt(l.suvMean, 2),
                fmt(l.mtvCc, 2),
                fmt(l.tlg, 1),
                String(l.voxelCount),
            ];
            let x = margin;
            for (let ci = 0; ci < cols.length; ci++) {
                const c = cols[ci];
                const tx = c.align === 'right' ? x + c.w - 1 : x + (ci === 1 ? 5 : 1);
                doc.text(values[ci], tx, y + 3.5, { align: c.align });
                x += c.w;
            }
            y += rowH;
        });

        // ---- Totals row ----
        if (input.totals) {
            if (y + rowH > pageH - margin) { doc.addPage(); y = margin; }
            doc.setFillColor(220, 232, 230);
            doc.rect(margin, y, pageW - 2 * margin, rowH, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            const totalsRow = [
                '',
                ' Total',
                fmt(input.totals.maxSuv, 2),
                '',
                '',
                fmt(input.totals.totalMtv, 2),
                fmt(input.totals.totalTlg, 1),
                String(input.totals.totalVox),
            ];
            let x = margin;
            for (let ci = 0; ci < cols.length; ci++) {
                const c = cols[ci];
                const tx = c.align === 'right' ? x + c.w - 1 : x + (ci === 1 ? 1 : 1);
                doc.text(totalsRow[ci], tx, y + 3.5, { align: c.align });
                x += c.w;
            }
            y += rowH;
            doc.setFont('helvetica', 'normal');
        }
        y += 4;
    }

    // ---- Page 2+: canvas screenshots ----
    const shots = collectCanvases();
    if (shots.length > 0) {
        doc.addPage();
        y = margin;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('Screenshots', margin, y);
        y += 7;

        // 2x2 grid (= 4 / page) — A4 portrait なら 1 セル ≒ 92mm 幅
        const cellW = (pageW - 2 * margin - 4) / 2;
        const cellH = cellW * 1.0;     // 正方形 (canvas は色々比率があるが切らずに letterbox)
        const padCell = 4;

        let col = 0;
        let cellTop = y;
        for (let i = 0; i < shots.length; i++) {
            if (cellTop + cellH + 6 > pageH - margin) {
                doc.addPage();
                y = margin;
                cellTop = y;
                col = 0;
            }
            const cellX = margin + col * (cellW + padCell);

            const cv = shots[i].canvas;
            // canvas のアスペクトに合わせて letterbox 配置
            const aspect = cv.width / Math.max(1, cv.height);
            let imgW = cellW;
            let imgH = cellW / aspect;
            if (imgH > cellH) {
                imgH = cellH;
                imgW = cellH * aspect;
            }
            const imgX = cellX + (cellW - imgW) / 2;
            const imgY = cellTop + (cellH - imgH) / 2;

            // 黒背景 (letterbox の余白を視認しやすく)
            doc.setFillColor(15, 20, 25);
            doc.rect(cellX, cellTop, cellW, cellH, 'F');

            try {
                const dataUrl = cv.toDataURL('image/jpeg', 0.85);
                doc.addImage(dataUrl, 'JPEG', imgX, imgY, imgW, imgH, undefined, 'FAST');
            } catch (err) {
                // canvas tainted など — メッセージだけ出して続行
                doc.setTextColor(255, 100, 100);
                doc.setFontSize(8);
                doc.text('(canvas not exportable)', cellX + 2, cellTop + 4);
                doc.setTextColor(0, 0, 0);
            }

            // タイトル (cell の下)
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(70, 70, 70);
            const rawTitle = sanitize(shots[i].title);
            const title = rawTitle.length > 60
                ? rawTitle.slice(0, 58) + '...'
                : rawTitle;
            doc.text(title, cellX + 1, cellTop + cellH + 3);
            doc.setTextColor(0, 0, 0);

            col++;
            if (col >= 2) {
                col = 0;
                cellTop += cellH + 6;
            }
        }
    }

    // ---- Footer (last page) ----
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(140, 140, 140);
        doc.text(
            `metavol-web — page ${p} / ${totalPages}`,
            pageW - margin, pageH - 4, { align: 'right' }
        );
        doc.setTextColor(0, 0, 0);
    }

    // ---- Save ----
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const safeUid = input.seriesUid
        ? input.seriesUid.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
        : 'report';
    doc.save(`${safeUid}_report_${ts}.pdf`);
};
