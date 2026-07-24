// MTV 測定の初心者向けガイドツアー。
// 状態変更は demoApi 経由 (実ハンドラ / store)。カーソルは data-demo 要素を指す。
import type { DemoScenario } from '../types';
import type { DemoApi } from '../demoApi';

const sel = (key: string) => ({ kind: 'selector' as const, sel: `[data-demo="${key}"]` });

export const createMtvScenario = (api: DemoApi): DemoScenario => ({
    id: 'mtv',
    title: 'Measure a tumor (MTV)',
    steps: [
        {
            id: 'intro',
            caption: "Welcome! Let's measure a tumor's metabolic volume (MTV) on a PET/CT — step by step.",
            settle: 400,
        },
        {
            id: 'load',
            caption: 'First we load a study. Normally you click Test and pick a folder — here we use a built-in sample PET/CT.',
            target: sel('menu'),
            action: () => api.loadPhantom(),
            settle: 'idle',
        },
        {
            id: 'pet-standard',
            caption: 'PET Standard lays out four linked views: CT, PET, a fused image, and a whole-body MIP.',
            target: sel('pet-standard'),
            action: () => api.petStandard(),
            settle: 'idle',
        },
        {
            id: 'find-tumor',
            caption: 'On the MIP you can spot the hot lesion — that dark focus in the pelvis is our tumor.',
            settle: 1200,
        },
        {
            id: 'open-seg',
            caption: 'The Segmentation panel on the right is where we measure lesions.',
            target: sel('inspector'),
            action: () => api.openSegmentation(),
            settle: 600,
        },
        {
            id: 'apply-physio',
            caption: 'First we threshold the PET at SUV 2.5 and Apply as Physiological — this paints EVERY high-uptake region (brain, kidneys, bladder, tumour…) in one colour.',
            target: sel('apply-threshold'),
            action: () => api.applyPhysiologicalThreshold(2.5),
            settle: 'idle',
        },
        {
            id: 'assign-tumor',
            caption: 'Now we pick out just the tumour: with the Assign tool, click the lesion to relabel that region as Tumor — watch it turn red.',
            action: () => api.assignTumor(),
            settle: 1600,
        },
        {
            id: 'lesion-table',
            caption: 'The Lesions table now reports the tumour separately — its MTV, TLG and SUVpeak. That is the measurement.',
            target: sel('lesion-table'),
            settle: 1600,
        },
        {
            id: 'save',
            caption: 'Finally, save the result as a NIfTI mask (or a PDF report). That is how MTV is measured — you try next!',
            target: sel('save-nifti'),
            settle: 800,
        },
    ],
});
