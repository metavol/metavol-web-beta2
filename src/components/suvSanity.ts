// PET/SUV メタデータの妥当性チェック。
//
// SUV の値が信頼できるかどうかを判定するため、以下を確認する:
//   - PatientWeight が常識的範囲か
//   - 投与量 (RadionuclideTotalDose) が常識的範囲か
//   - 半減期 (RadionuclideHalfLife) が既知の PET 核種と一致するか
//   - 注射→撮像の時間が常識的範囲か (FDG 等の WB protocol で典型 60 ± 30 min)
//   - DecayCorrection 値が標準 (START / ADMIN / NONE) か
//   - Units フィールドの欠損
//
// 出力は severity 別の警告リスト。UI 側はこれを yellow / red バナーで表示する。

import type { Volume } from './Volume';

export type SuvSanitySeverity = 'info' | 'warn' | 'error';

export interface SuvSanityWarning {
    severity: SuvSanitySeverity;
    field: string;       // 表示用 (例 "PatientWeight")
    message: string;     // 1 行サマリ
}

// 既知の PET 核種半減期 (秒) — Approximation, ±60s tolerance で照合する。
//   F-18  : 6588.0  (109.8 min)
//   Ga-68 : 4068.0  ( 67.8 min)
//   C-11  : 1224.0  ( 20.4 min)
//   N-13  :  597.6  ( 10.0 min)
//   O-15  :  122.4  (  2.0 min)
//   Cu-64 : 45720   (12.7 hr)
//   Zr-89 : 282672  (78.4 hr ≈ 3.27 d)
//   I-124 : 360864  (100.2 hr ≈ 4.18 d)
//   Rb-82 :   75    (  1.25 min)
const KNOWN_HALFLIVES_SEC: number[] = [
    6588.0, 4068.0, 1224.0, 597.6, 122.4, 45720, 282672, 360864, 75,
];

const HL_TOLERANCE_SEC = 60;

const close = (v: number, target: number, tol: number) => Math.abs(v - target) <= tol;

export const getSuvSanityWarnings = (volume: Volume | null | undefined): SuvSanityWarning[] => {
    const out: SuvSanityWarning[] = [];
    if (!volume) return out;
    const md = volume.metadata;
    if (!md || md.modality !== 'PT') return out;

    // ---- PatientWeight ----
    const w = md.patientWeightKg;
    if (w == null) {
        out.push({ severity: 'error', field: 'PatientWeight', message: 'PatientWeight is missing — SUV cannot be computed' });
    } else if (!Number.isFinite(w) || w <= 0) {
        out.push({ severity: 'error', field: 'PatientWeight', message: `PatientWeight = ${w} is invalid` });
    } else if (w < 20) {
        out.push({ severity: 'warn', field: 'PatientWeight', message: `PatientWeight = ${w} kg — unusually low (pediatric?)` });
    } else if (w > 300) {
        out.push({ severity: 'warn', field: 'PatientWeight', message: `PatientWeight = ${w} kg — unusually high` });
    }

    // ---- RadionuclideTotalDose ----
    const dose = md.radionuclideTotalDoseBq;
    if (dose == null) {
        out.push({ severity: 'error', field: 'RadionuclideTotalDose', message: 'Injected dose is missing' });
    } else if (!Number.isFinite(dose) || dose <= 0) {
        out.push({ severity: 'error', field: 'RadionuclideTotalDose', message: `Injected dose = ${dose} is invalid` });
    } else {
        const mbq = dose / 1e6;
        if (mbq < 30) {
            out.push({ severity: 'warn', field: 'RadionuclideTotalDose', message: `Injected dose = ${mbq.toFixed(0)} MBq — unusually low` });
        } else if (mbq > 1000) {
            out.push({ severity: 'warn', field: 'RadionuclideTotalDose', message: `Injected dose = ${mbq.toFixed(0)} MBq — unusually high` });
        }
    }

    // ---- RadionuclideHalfLife ----
    const hl = md.radionuclideHalfLifeSec;
    if (hl == null) {
        out.push({ severity: 'error', field: 'RadionuclideHalfLife', message: 'Half-life is missing' });
    } else if (!Number.isFinite(hl) || hl <= 0) {
        out.push({ severity: 'error', field: 'RadionuclideHalfLife', message: `Half-life = ${hl}s is invalid` });
    } else {
        const matched = KNOWN_HALFLIVES_SEC.some(h => close(hl, h, HL_TOLERANCE_SEC));
        if (!matched) {
            out.push({
                severity: 'info',
                field: 'RadionuclideHalfLife',
                message: `Half-life = ${hl.toFixed(1)}s — does not match any common PET radionuclide`,
            });
        }
    }

    // ---- Uptake time (acquisition - injection) ----
    if (md.acquisitionDateTimeIso && md.injectionDateTimeIso) {
        const acq = new Date(md.acquisitionDateTimeIso).getTime();
        const inj = new Date(md.injectionDateTimeIso).getTime();
        const dtMin = (acq - inj) / 60000;
        if (!Number.isFinite(dtMin)) {
            out.push({ severity: 'error', field: 'UptakeTime', message: 'Cannot compute uptake time — invalid date/time' });
        } else if (dtMin < 0) {
            out.push({
                severity: 'error', field: 'UptakeTime',
                message: `Acquisition before injection (${dtMin.toFixed(0)} min) — bad date/time`,
            });
        } else if (dtMin < 30) {
            out.push({
                severity: 'warn', field: 'UptakeTime',
                message: `Uptake time = ${dtMin.toFixed(0)} min — unusually short for whole-body PET`,
            });
        } else if (dtMin > 180) {
            out.push({
                severity: 'warn', field: 'UptakeTime',
                message: `Uptake time = ${dtMin.toFixed(0)} min — unusually long`,
            });
        }
    } else if (md.suvOk === true) {
        // suvOk=true なら計算には使えたはず。ISO が無いのは情報欠落のみ。
        out.push({
            severity: 'info', field: 'UptakeTime',
            message: 'Uptake time not available (acquisition or injection date/time missing in tags)',
        });
    }

    // ---- DecayCorrection ----
    const dc = md.decayCorrection;
    if (dc) {
        const ok = ['START', 'ADMIN', 'NONE'].includes(dc.toUpperCase().trim());
        if (!ok) {
            out.push({
                severity: 'info', field: 'DecayCorrection',
                message: `DecayCorrection = "${dc}" — non-standard (expected START / ADMIN / NONE)`,
            });
        }
    } else if (md.suvOk === true) {
        out.push({
            severity: 'info', field: 'DecayCorrection',
            message: 'DecayCorrection tag is missing (assumed START)',
        });
    }

    // ---- Units ----
    if (!md.units) {
        out.push({ severity: 'info', field: 'Units', message: 'Units tag (0054,1001) is missing' });
    }

    return out;
};

// 表示用に「主要な数値メタデータ」をまとめて返すヘルパ。
// Inspector の Details 展開で値の確認に使う。
export interface SuvMetadataSummary {
    patientWeightKg: number | null;
    doseMBq: number | null;
    halfLifeMin: number | null;
    uptakeMin: number | null;
    decayCorrection: string | null;
    units: string | null;
    suvFactor: number | null;
    suvSource: string | null;
    acquisitionDateTime: string | null;
    injectionDateTime: string | null;
}

export const getSuvMetadataSummary = (volume: Volume | null | undefined): SuvMetadataSummary => {
    const empty: SuvMetadataSummary = {
        patientWeightKg: null,
        doseMBq: null,
        halfLifeMin: null,
        uptakeMin: null,
        decayCorrection: null,
        units: null,
        suvFactor: null,
        suvSource: null,
        acquisitionDateTime: null,
        injectionDateTime: null,
    };
    if (!volume?.metadata) return empty;
    const md = volume.metadata;
    let uptakeMin: number | null = null;
    if (md.acquisitionDateTimeIso && md.injectionDateTimeIso) {
        const dt = (new Date(md.acquisitionDateTimeIso).getTime() - new Date(md.injectionDateTimeIso).getTime()) / 60000;
        if (Number.isFinite(dt)) uptakeMin = dt;
    }
    return {
        patientWeightKg: md.patientWeightKg ?? null,
        doseMBq: md.radionuclideTotalDoseBq != null ? md.radionuclideTotalDoseBq / 1e6 : null,
        halfLifeMin: md.radionuclideHalfLifeSec != null ? md.radionuclideHalfLifeSec / 60 : null,
        uptakeMin,
        decayCorrection: md.decayCorrection ?? null,
        units: md.units ?? null,
        suvFactor: md.suvFactor ?? null,
        suvSource: md.suvSource ?? null,
        acquisitionDateTime: md.acquisitionDateTimeIso ?? null,
        injectionDateTime: md.injectionDateTimeIso ?? null,
    };
};
