export type Modality = "PT" | "CT" | "MR" | "OTHER";

export type SuvSource = 'BQML' | 'Philips' | 'DecayFactor' | 'CNTS_Philips' | 'units_already_SUV' | 'none';

export interface VolumeMetadata {
    modality: Modality;
    seriesUID?: string;
    seriesDescription?: string;

    suvFactor?: number;
    patientWeightKg?: number;
    radionuclideHalfLifeSec?: number;
    radionuclideTotalDoseBq?: number;
    doseStartTimeSec?: number;
    acquisitionTimeSec?: number;
    units?: string;

    // SUV 計算の透明性情報。
    //   suvOk      : 標準 SUV factor が確定したか (false なら表示・解析時に注意喚起)
    //   suvSource  : 採用したパス
    //   suvReason  : ok 時は 'ok'、それ以外は失敗理由 (例: 'missing PatientWeight')
    //   acquisitionDateTimeIso : 計算に使った acq datetime (earliest, ISO)
    //   injectionDateTimeIso   : 計算に使った inj datetime (ISO)
    //   decayCorrection        : DICOM tag (0054,1102) の生値
    suvOk?: boolean;
    suvSource?: SuvSource;
    suvReason?: string;
    acquisitionDateTimeIso?: string;
    injectionDateTimeIso?: string;
    decayCorrection?: string;

    // 元データの voxel datatype label (例 'Int16', 'Uint16', 'Float32')。
    // 内部 voxel は常に Float32 だが、ロード元が何だったかを表示用に保持。
    datatypeName?: string;

    // NIfTI ロード時の元 header (nifti-reader-js NIFTI1 オブジェクト)。
    // 「View NIfTI header」UI で field 一覧表示用。DICOM では undefined。
    niftiHeader?: any;

    // NIfTI ファイル名 (raw bytes inspector / header viewer の表示タイトル用)
    sourceFilename?: string;
}
