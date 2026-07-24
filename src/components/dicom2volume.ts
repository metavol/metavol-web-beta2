// 2024/6/9
//
// homework: MyDataSet is dupulicated with DicomView.vue

import { DataSet } from "dicom-parser";
import * as THREE from '@/lib/threeMath';
import { Volume } from "./Volume";
import type { VolumeMetadata, Modality, SuvSource } from "../types/VolumeMetadata";
import * as DecompressJpegLossless from "./decompressJpegLossless";
import { readDicomPixels } from "./dicomPixels";

interface MyDataSet extends DataSet {
    decompressed?: ArrayBuffer;
  }

export interface SuvResult {
    factor: number;            // 適用する factor (既定 = voxBase = 整数秒切り捨て)
    factorPrecise?: number;    // 小数秒まで使う "より正確" 版 (BQML のみ差が出る。無ければ factor と同じ)
    ok: boolean;
    reason: string;
    source: SuvSource;
    acquisitionDt?: Date;
    injectionDt?: Date;
    decayCorrection?: string;
}

const detectModality = (d: MyDataSet): Modality => {
    const m = (d.string("x00080060") ?? "").toUpperCase();
    if (m === "PT" || m === "PET") return "PT";
    if (m === "CT") return "CT";
    if (m === "MR") return "MR";
    return "OTHER";
}

export const generateVolumeFromDicom = (dcmList: MyDataSet[]) => {


    // Modality + 減衰補正 (Attenuation Correction) 状態を先に判定。
    // NonAC (NAC) PT は SUV 換算不可 (減衰補正なしの voxel は SUV 値として無意味)。
    // → suvFactor = 1 を強制し、voxel は Bq/ml (raw × slope) のまま保持する。
    const modalityEarly = detectModality(dcmList[0]);
    const correctedTag = (dcmList[0].string('x00280051') ?? '').toUpperCase();
    const isAttnCorrected = correctedTag.includes('ATTN');
    const isNacPt = (modalityEarly === 'PT') && !isAttnCorrected;

    // SUV factor を **構造化結果**で取得 (失敗理由・採用パスを保持)
    let suvResult: SuvResult;
    try {
        suvResult = getSuvFactor(dcmList);
    } catch (err) {
        suvResult = { factor: 1, ok: false, reason: `exception: ${(err as Error)?.message ?? err}`, source: 'none' };
    }
    // NAC PT は SUV 適用不可。取得した factor を破棄して 1 に戻す。
    if (isNacPt) {
        suvResult = { factor: 1, ok: false, reason: 'NonAC PT — SUV not applicable (attenuation correction required)', source: 'none' };
    }
    const suvFactor = suvResult.factor;

    const d = dcmList[0];
    const d1 = dcmList[1]; // 1 スライスのみの場合は undefined

    const nx = d.int16("x00280011")!; // columns
    const ny = d.int16("x00280010")!; // rows
    const nz = dcmList.length;

    // --- 幾何タグ (PixelSpacing / ImageOrientation / ImagePosition) ---
    // CT/MR/PET の通常シリーズは全て備える。一方 DX や Secondary Capture などの
    // 平面画像はこれらを欠くことが多い。欠落時は「軸平行・等方 1mm・原点 0」の
    // 既定で Volume 化する (1 スライスでも MPR/表示できるようにするため)。

    // ImageOrientationPatient (0020,0037): 行/列方向の単位ベクトル。
    const hasOrient = d.floatString("x00200037", 0) != null;
    const ox = (k: number) => d.floatString("x00200037", k) ?? 0;
    const vx = hasOrient
        ? new THREE.Vector3(ox(0), ox(1), ox(2))
        : new THREE.Vector3(1, 0, 0); // 列方向 = +X
    const vy = hasOrient
        ? new THREE.Vector3(ox(3), ox(4), ox(5))
        : new THREE.Vector3(0, 1, 0); // 行方向 = +Y

    // PixelSpacing (0028,0030): [row spacing, col spacing] (mm)。
    // ImagerPixelSpacing (0018,1164) は DX の代替タグ。両方無ければ 1mm。
    const px = d.floatString("x00280030", 0)
        ?? d.floatString("x00181164", 0)
        ?? 1;
    const py = d.floatString("x00280030", 1)
        ?? d.floatString("x00181164", 1)
        ?? 1;
    vx.multiplyScalar(px / vx.length());
    vy.multiplyScalar(py / vy.length());

    // slice locationは、たまに、image positionのz座標と符号が反対のことがある。
    // そのため、下記の式は使えない。
    // const sl = d.floatString("x00201041")!; // slice location
    // const sl1 = d1.floatString("x00201041")!; // slice location

    // ImagePositionPatient (0020,0032): 先頭スライスの原点 (mm)。欠落時は 0。
    const hasPos0 = d.floatString("x00200032", 0) != null;
    const pos0 = hasPos0
        ? new THREE.Vector3(
            d.floatString("x00200032", 0)!,
            d.floatString("x00200032", 1)!,
            d.floatString("x00200032", 2)!,
          )
        : new THREE.Vector3(0, 0, 0);

    // スライス方向ベクトル vz。
    //   - 2 スライス以上 + 両方に position あり: pos1 - pos0 (実測の slice pitch)
    //   - それ以外 (単一スライス / position 欠落): vx × vy の単位ベクトル
    //     (SliceThickness があればその長さ、無ければ 1mm)
    let vz: THREE.Vector3;
    const pos1HasTag = d1 != null && d1.floatString("x00200032", 0) != null;
    if (d1 != null && hasPos0 && pos1HasTag) {
        const pos1 = new THREE.Vector3(
            d1.floatString("x00200032", 0)!,
            d1.floatString("x00200032", 1)!,
            d1.floatString("x00200032", 2)!,
        );
        vz = pos1.clone().sub(pos0);
    } else {
        const thickness = d.floatString("x00180050") ?? 1; // SliceThickness
        vz = new THREE.Vector3()
            .crossVectors(vx, vy)
            .normalize()
            .multiplyScalar(thickness);
    }

    // let buffer = new ArrayBuffer(nx*ny*nz*4);
    // let dv = new DataView(buffer);

    let vox = new Float32Array(nx*ny*nz);

    let ad = 0;
    for (let i = 0; i<nz; i++){
        const dataSet = dcmList[i];
        const intercept = Number(dataSet.string("x00281052") ?? "0");
        const slope = Number(dataSet.string("x00281053") ?? "1");

        // JPEG Lossless 圧縮なら decompress (キャッシュ済みなら再利用)
        if (DecompressJpegLossless.check(dataSet) && dataSet.decompressed == null){
            dataSet.decompressed = DecompressJpegLossless.decode(dataSet);
        }
        // BitsAllocated に従って 8/16-bit を読み分ける。
        // Int16 固定読みだと 8-bit DX 等で画素数・値が壊れる。
        const aaa = readDicomPixels(dataSet).pixels;


        for (let j = 0; j<ny; j++){
            for (let k = 0; k<nx; k++){
                const v = (aaa[j*nx+k] * slope + intercept)*suvFactor;
                vox[ad] = v;
                ad+=1;
            }
        }
    }

    const modality = detectModality(d);
    // DICOM datatype: BitsAllocated (0028,0100) + PixelRepresentation (0028,0103)
    //   bits 8/16/32 × signed/unsigned。BitsStored (0028,0101) は通常 same or smaller
    const bits = d.int16("x00280100") ?? 16;
    const isSigned = (d.int16("x00280103") ?? 0) === 1;
    const datatypeName = `${isSigned ? 'Int' : 'Uint'}${bits}`;
    const metadata: VolumeMetadata = {
        modality,
        seriesUID: d.string("x0020000e") ?? undefined,
        seriesDescription: d.string("x0008103e") ?? undefined,
        suvFactor,
        units: d.string("x00541001") ?? undefined,
        patientWeightKg: d.floatString("x00101030") ?? undefined,
        datatypeName,
    };
    if (modality === "PT") {
        try {
            const acq = d.string("x00080032");
            if (acq) metadata.acquisitionTimeSec = parseSecond6digits(acq);
            let hl = d.floatString("x00181075");
            if (hl == null && d.elements.x00540016?.items?.[0]?.dataSet) {
                hl = d.elements.x00540016.items[0].dataSet.floatString("x00181075") ?? undefined;
            }
            if (hl != null) metadata.radionuclideHalfLifeSec = hl;
            let dose = d.floatString("x00181074");
            if (dose == null && d.elements.x00540016?.items?.[0]?.dataSet) {
                dose = d.elements.x00540016.items[0].dataSet.floatString("x00181074") ?? undefined;
            }
            if (dose != null) metadata.radionuclideTotalDoseBq = dose;
            let dst = d.string("x00181072");
            if (dst == null && d.elements.x00540016?.items?.[0]?.dataSet) {
                dst = d.elements.x00540016.items[0].dataSet.string("x00181072") ?? undefined;
            }
            if (dst) metadata.doseStartTimeSec = parseSecond6digits(dst);
        } catch {}
        // SUV 計算結果のメタ情報 (UI 警告表示用)
        metadata.suvOk = suvResult.ok;
        metadata.suvSource = suvResult.source;
        metadata.suvReason = suvResult.reason;
        if (suvResult.acquisitionDt) metadata.acquisitionDateTimeIso = suvResult.acquisitionDt.toISOString();
        if (suvResult.injectionDt) metadata.injectionDateTimeIso = suvResult.injectionDt.toISOString();
        if (suvResult.decayCorrection) metadata.decayCorrection = suvResult.decayCorrection;
        // SUV mode 切替用の 2 factor。voxel は voxBase (整数秒) で bake 済み (= 既定)。
        // 小数秒の差が実在する (BQML で 2 factor が異なる) ときだけモードを設定 → UI トグル表示。
        if (suvResult.source === 'BQML'
            && suvResult.factorPrecise != null
            && Math.abs(suvResult.factorPrecise - suvResult.factor) > Math.abs(suvResult.factor) * 1e-9) {
            metadata.suvFactorVoxBase = suvResult.factor;
            metadata.suvFactorPrecise = suvResult.factorPrecise;
            metadata.suvMode = 'voxbase';
        }
    }

    const dicomVolume: Volume = {
        nx: nx,
        ny: ny,
        nz: nz,
        imagePosition: pos0,
        vectorX: vx,
        vectorY: vy,
        vectorZ: vz,
        voxel: vox,
        metadata,
    };

    return dicomVolume;
}




// HHMMSS[.FFFFFF] → 0時0分0秒からの秒数 (主に metadata 用、計算には Date を使用)
const parseSecond6digits = (str: string): number => {
    const t = str.trim();
    const h = Number(t.substring(0, 2));
    const m = Number(t.substring(2, 4));
    const s = Number(t.substring(4, 6));
    return h * 3600 + m * 60 + s;
};

// DICOM DA: "YYYYMMDD" → {y, m, d}
const parseDicomDate = (s: string | null | undefined): { y: number; m: number; d: number } | null => {
    if (!s) return null;
    const t = s.trim();
    if (t.length < 8) return null;
    const y = Number(t.slice(0, 4));
    const m = Number(t.slice(4, 6));
    const d = Number(t.slice(6, 8));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d) || y < 1900) return null;
    return { y, m, d };
};

// DICOM TM: "HHMMSS[.FFFFFF]"
const parseDicomTime = (s: string | null | undefined): { h: number; m: number; s: number; ms: number } | null => {
    if (!s) return null;
    const t = s.trim();
    if (t.length < 4) return null;
    const h = Number(t.slice(0, 2));
    const m = Number(t.slice(2, 4));
    const sec = t.length >= 6 ? Number(t.slice(4, 6)) : 0;
    let ms = 0;
    const dot = t.indexOf('.');
    if (dot >= 0) {
        const frac = t.slice(dot + 1);
        if (frac) ms = Math.round(Number('0.' + frac) * 1000);
    }
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
    return { h, m, s: sec, ms };
};

// DICOM DT: "YYYYMMDDHHMMSS[.FFFFFF][&ZZXX]"
const parseDicomDateTime = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const t = s.trim().replace(/[+-]\d{4}$/, ''); // タイムゾーン suffix は無視
    if (t.length < 8) return null;
    const ymd = parseDicomDate(t.slice(0, 8));
    if (!ymd) return null;
    const tt = t.length > 8 ? parseDicomTime(t.slice(8)) : { h: 0, m: 0, s: 0, ms: 0 };
    if (!tt) return null;
    return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, tt.h, tt.m, tt.s, tt.ms));
};

const combineDateAndTime = (
    dateStr: string | null | undefined,
    timeStr: string | null | undefined,
): Date | null => {
    const ymd = parseDicomDate(dateStr ?? null);
    const tt = parseDicomTime(timeStr ?? null);
    if (!ymd || !tt) return null;
    return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, tt.h, tt.m, tt.s, tt.ms));
};

// Series 全 DICOM を走査し、最も早い acquisition datetime を返す。
// 優先順位: AcquisitionDateTime > AcquisitionDate+Time > SeriesDate+Time。
const findEarliestAcquisitionDateTime = (dd: MyDataSet[]): Date | null => {
    let best: Date | null = null;
    const consider = (dt: Date | null) => {
        if (dt && (!best || dt < best)) best = dt;
    };
    for (const d of dd) {
        consider(parseDicomDateTime(d.string("x0008002a")));               // AcquisitionDateTime
        consider(combineDateAndTime(d.string("x00080022"), d.string("x00080032"))); // AcqDate + AcqTime
        consider(combineDateAndTime(d.string("x00080021"), d.string("x00080031"))); // SeriesDate + SeriesTime
    }
    return best;
};

// RadiopharmaceuticalInformationSequence (0054,0016) の最初の item
const getRadiopharmSeq = (d: MyDataSet) => {
    return d.elements.x00540016?.items?.[0]?.dataSet ?? null;
};

const getRadioFloat = (d: MyDataSet, tag: string): number | null => {
    let v = d.floatString(tag);
    if (v == null) {
        const seq = getRadiopharmSeq(d);
        if (seq) v = seq.floatString(tag);
    }
    return v ?? null;
};

const getRadioStr = (d: MyDataSet, tag: string): string | null => {
    let v = d.string(tag);
    if (v == null) {
        const seq = getRadiopharmSeq(d);
        if (seq) v = seq.string(tag);
    }
    return v ?? null;
};

// 注射 datetime: RadiopharmaceuticalStartDateTime (combined) → StartTime + acq date
const getInjectionDateTime = (d: MyDataSet, acqFallback: Date): Date | null => {
    const rdt = getRadioStr(d, "x00181078"); // RadiopharmaceuticalStartDateTime (DT)
    const parsed = parseDicomDateTime(rdt);
    if (parsed) return parsed;

    const rtime = getRadioStr(d, "x00181072"); // RadiopharmaceuticalStartTime (TM)
    const tt = parseDicomTime(rtime);
    if (tt) {
        return new Date(Date.UTC(
            acqFallback.getUTCFullYear(),
            acqFallback.getUTCMonth(),
            acqFallback.getUTCDate(),
            tt.h, tt.m, tt.s, tt.ms,
        ));
    }
    return null;
};

const tryBqmlSuvFactor = (dd: MyDataSet[]): SuvResult => {
    const d = dd[0];
    const unitRaw = (d.string("x00541001") ?? "").trim();
    const unit = unitRaw.toUpperCase();
    if (unit !== "BQML" && unit !== "BQ/CC" && unit !== "BQM") {
        return { factor: 1, ok: false, reason: `units not BQML: "${unitRaw}"`, source: 'none' };
    }

    const bw = d.floatString("x00101030");
    if (bw == null || Number(bw) <= 0) {
        return { factor: 1, ok: false, reason: 'missing or invalid PatientWeight', source: 'none' };
    }

    const hl = getRadioFloat(d, "x00181075");
    if (hl == null || Number(hl) <= 0) {
        return { factor: 1, ok: false, reason: 'missing or invalid radionuclide half-life', source: 'none' };
    }

    const dose = getRadioFloat(d, "x00181074");
    if (dose == null || Number(dose) <= 0) {
        return { factor: 1, ok: false, reason: 'missing or invalid radionuclide total dose', source: 'none' };
    }

    const acq_dt = findEarliestAcquisitionDateTime(dd);
    if (!acq_dt) {
        return { factor: 1, ok: false, reason: 'missing acquisition date/time', source: 'none' };
    }

    const inj_dt = getInjectionDateTime(d, acq_dt);
    if (!inj_dt) {
        return { factor: 1, ok: false, reason: 'missing radiopharmaceutical start time', source: 'none' };
    }

    // Δt を 2 通り計算する:
    //   dt_trunc : inj/acq を整数秒に切り捨て (= Vox-BASE と一致。既定で適用)
    //   dt_frac  : 小数秒まで使う (= より正確)
    // 参照ビューア (Vox-BASE 等) は減衰補正時刻を整数秒 (HH:MM:SS) で扱うため、既定は
    // 整数秒版に合わせる。両者は SUV 全体で定数比 (F-18 half-life に対し <0.02%) だけ異なる。
    const floorToSec = (t: Date) => Math.floor(t.getTime() / 1000) * 1000;
    const dt_sec = (floorToSec(acq_dt) - floorToSec(inj_dt)) / 1000;   // 整数秒 Δt (voxBase)
    const dt_sec_frac = (acq_dt.getTime() - inj_dt.getTime()) / 1000;  // 小数秒 Δt (precise)
    const dc = (d.string("x00541102") ?? "").toUpperCase().trim();

    // DecayCorrection の解釈:
    //   START : pixel は scan start 基準で decay-corrected → dose を inj→acq に decay
    //   ADMIN : pixel は admin (inj) 基準で decay-corrected → dose は raw (decay 不要)
    //   NONE  : pixel は acq 時の活性 (補正なし)            → dose を inj→acq に decay
    //   missing: START と仮定 (もっとも一般的)
    let dose_at_ref: number;
    let dose_at_ref_frac: number;
    if (dc === "ADMIN") {
        dose_at_ref = Number(dose);
        dose_at_ref_frac = Number(dose);
    } else {
        if (dt_sec < 0) {
            return {
                factor: 1, ok: false,
                reason: `acquisition before injection (dt=${dt_sec.toFixed(0)}s) — bad date/time?`,
                source: 'none',
                acquisitionDt: acq_dt, injectionDt: inj_dt, decayCorrection: dc || undefined,
            };
        }
        dose_at_ref = Number(dose) * Math.pow(0.5, dt_sec / Number(hl));
        dose_at_ref_frac = Number(dose) * Math.pow(0.5, dt_sec_frac / Number(hl));
    }

    if (!Number.isFinite(dose_at_ref) || dose_at_ref <= 0) {
        return { factor: 1, ok: false, reason: 'computed dose_at_ref invalid', source: 'none' };
    }

    const factor = (Number(bw) * 1000.0) / dose_at_ref;
    const factorPrecise = (dose_at_ref_frac > 0 && Number.isFinite(dose_at_ref_frac))
        ? (Number(bw) * 1000.0) / dose_at_ref_frac
        : factor;
    return {
        factor, factorPrecise, ok: true, reason: 'ok', source: 'BQML',
        acquisitionDt: acq_dt, injectionDt: inj_dt, decayCorrection: dc || undefined,
    };
};

// メイン: BQML → DecayFactor タグ → Philips factor → CNTS+Philips → 失敗。
// PET volume 構築時に **必ず** 1 回呼ばれ、失敗時も factor=1 で fall-through (raw 値のまま表示) する。
const getSuvFactor = (dd: MyDataSet[]): SuvResult => {
    const d = dd[0];
    const unitRaw = (d.string("x00541001") ?? "").trim();
    const unit = unitRaw.toUpperCase();

    if (unit.includes("SUV")) {
        return { factor: 1, ok: true, reason: 'units already SUV', source: 'units_already_SUV' };
    }

    // Path A: Units = CNTS は Philips factor が "本来の" 計算経路。
    // (Philips PET の生 raw データ単位。BQML 計算は無関係なので最初に判定する)
    if (unit === "CNTS") {
        const pf = d.floatString("x70531000");
        if (pf != null && Number(pf) > 0) {
            return { factor: Number(pf), ok: true, reason: 'CNTS units, Philips SUV factor', source: 'CNTS_Philips' };
        }
        return { factor: 1, ok: false, reason: 'CNTS units but no Philips factor (7053,1000)', source: 'none' };
    }

    // Path B: BQML 標準計算
    const bqml = tryBqmlSuvFactor(dd);
    if (bqml.ok) return bqml;

    // Path C: DecayFactor タグ (0054,1321) フォールバック
    //   注射時刻が欠損していても、メーカが事前計算済みの DecayFactor で代替できることがある。
    if (unit === "BQML" || unit === "BQ/CC" || unit === "BQM") {
        const df = d.floatString("x00541321");
        const bw = d.floatString("x00101030");
        const dose = getRadioFloat(d, "x00181074");
        if (df != null && bw != null && dose != null && Number(df) > 0 && Number(bw) > 0 && Number(dose) > 0) {
            const dose_at_acq = Number(dose) * Number(df);
            if (dose_at_acq > 0) {
                return {
                    factor: (Number(bw) * 1000.0) / dose_at_acq,
                    ok: true, reason: 'used DICOM DecayFactor tag', source: 'DecayFactor',
                };
            }
        }
    }

    // Path D: BQML 失敗 + Manufacturer=PHILIPS の場合は Philips proprietary factor (7053,1000)
    const manuf = (d.string("x00080070") ?? "").toUpperCase();
    if (manuf.includes("PHILIPS")) {
        const pf = d.floatString("x70531000");
        if (pf != null && Number(pf) > 0) {
            return { factor: Number(pf), ok: true, reason: `BQML failed (${bqml.reason}); used Philips factor`, source: 'Philips' };
        }
    }

    return { factor: 1, ok: false, reason: bqml.reason, source: 'none' };
};


