// シリーズが PET/CT fusion 解析に "primary" として使えるかを判定する。
//
// 判定基準 (すべて満たす必要あり):
//   - modality が CT / PT / MR (PR/SR/RTSTRUCT 等の非画像系を除外)
//   - フレーム数が MIN_FRAMES_FOR_PRIMARY 以上 (1 枚 PR / localizer 単発などを除外)
//   - (0028,0004) PhotometricInterpretation が RGB / カラー系ではない
//
// 注: ImageType (0008,0008) による除外は意図的にやらない。
//   ・DERIVED 単独は通常 CT の別カーネル再構成 (B30s 等) でよく使われる正規シリーズ
//   ・SECONDARY も解析に使いたい CT があるとのユーザ運用ポリシー
//   不要な MIP/screenshot 系は枚数フィルタ (~20 枚未満) でだいたい弾ける
//
// NIfTI / 非 DICOM はモダリティ + nz (=nFrames) で判定する。

const MIN_FRAMES_FOR_PRIMARY = 20;

export interface ClassifyParams {
    nFrames: number;          // DICOM: myDicom.length / NIfTI: volume.nz
    modality: string;         // 既に正規化された modality 文字列 ('CT' / 'PT' / 'MR' / etc)
    photometric?: string;     // (0028,0004), DICOM のみ
    imageType?: string;       // (0008,0008), DICOM のみ — 現状は使わないが将来用に保持
}

export const isPrimaryForFusion = (p: ClassifyParams): boolean => {
    const m = (p.modality ?? '').toUpperCase().trim();
    if (m !== 'CT' && m !== 'PT' && m !== 'PET' && m !== 'MR') return false;
    if (p.nFrames < MIN_FRAMES_FOR_PRIMARY) return false;

    const photo = (p.photometric ?? '').toUpperCase().trim();
    if (photo === 'RGB') return false;
    if (photo === 'PALETTE COLOR') return false;
    if (photo === 'YBR_FULL' || photo === 'YBR_FULL_422') return false;
    return true;
};

// RGB 系シリーズか (カード表示で警告するため)
export const isRgbSeries = (photometric?: string): boolean => {
    const p = (photometric ?? '').toUpperCase();
    return p === 'RGB' || p === 'PALETTE COLOR' || p === 'YBR_FULL' || p === 'YBR_FULL_422';
};
