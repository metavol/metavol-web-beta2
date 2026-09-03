import type { Volume } from '../Volume';

// 画像 voxel に VOI テンプレートのラベルを割り当てる。
//
// **向きは「画像の格子を主とし、各画像 voxel の中心をテンプレートへ写す」。** 逆向き
// (画像をテンプレート格子へ resample) にしないのは:
//   - 画像の値を補間すると **測定値が変質する**
//   - 1 voxel が複数領域に分配されると **二重計上**になる
//   - 体積が画像 voxel 単位で出る方が SPM/MarsBaR の慣行と一致する
//
// **ラベルは必ず最近傍で引くこと。** 線形補間するとラベル 3 と 5 の間に存在しない 4 が生まれる。
//
// 実測の前提 (2026-08): アトラス 121x145x121 @1.5mm、SPM 既定の正規化出力 79x95x79 @2mm。
// **格子は一致しない**ので、world 経由の写像は省略できない。

export interface VoiAssignment {
    /** 画像 voxel ごとのラベル ID。0 = ラベル無し / テンプレート範囲外 */
    labelOf: Uint16Array;
    /** テンプレートの格子内に落ちた画像 voxel 数 */
    insideCount: number;
    /** 実際にラベル (非 0) が付いた画像 voxel 数 */
    labeledCount: number;
    totalCount: number;
    /** 画像 voxel の体積 (ml)。体積換算はこれを使う */
    voxelVolumeMl: number;
}

/**
 * 画像 voxel index → テンプレート voxel index の合成アフィンを作る。
 *
 * image voxel (i,j,k) --A_img--> world --A_tpl^-1--> template voxel
 * を 1 本の 3x4 に畳んでおき、走査は **増分** で回す。
 * voxel ごとに行列を作り直すと数十万〜数千万回の割り当てで実用速度が出ない
 * (体マスクの crop で同じ轍を踏んだ)。
 */
const composeImageToTemplate = (image: Volume, tpl: Volume) => {
    // A_tpl の逆行列 (3x3)。列ベクトル vectorX/Y/Z が基底。
    const a = tpl.vectorX, b = tpl.vectorY, c = tpl.vectorZ;
    const det =
        a.x * (b.y * c.z - b.z * c.y) -
        b.x * (a.y * c.z - a.z * c.y) +
        c.x * (a.y * b.z - a.z * b.y);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    // inv[row][col]
    const inv = [
        [(b.y * c.z - b.z * c.y) * id, (c.x * b.z - b.x * c.z) * id, (b.x * c.y - c.x * b.y) * id],
        [(c.y * a.z - a.y * c.z) * id, (a.x * c.z - c.x * a.z) * id, (a.y * c.x - a.x * c.y) * id],
        [(a.y * b.z - b.y * a.z) * id, (b.x * a.z - a.x * b.z) * id, (a.x * b.y - a.y * b.x) * id],
    ];
    const applyInv = (x: number, y: number, z: number) => [
        inv[0][0] * x + inv[0][1] * y + inv[0][2] * z,
        inv[1][0] * x + inv[1][1] * y + inv[1][2] * z,
        inv[2][0] * x + inv[2][1] * y + inv[2][2] * z,
    ] as [number, number, number];

    // 画像 voxel (0,0,0) の world から template voxel 座標へ
    const d0 = applyInv(
        image.imagePosition.x - tpl.imagePosition.x,
        image.imagePosition.y - tpl.imagePosition.y,
        image.imagePosition.z - tpl.imagePosition.z,
    );
    // 画像 index を 1 進めたときの template voxel 座標の増分
    const di = applyInv(image.vectorX.x, image.vectorX.y, image.vectorX.z);
    const dj = applyInv(image.vectorY.x, image.vectorY.y, image.vectorY.z);
    const dk = applyInv(image.vectorZ.x, image.vectorZ.y, image.vectorZ.z);
    return { origin: d0, di, dj, dk };
};

export const assignVoiLabels = (image: Volume, tpl: Volume): VoiAssignment | null => {
    const m = composeImageToTemplate(image, tpl);
    if (!m) return null;
    const { nx, ny, nz } = image;
    const total = nx * ny * nz;
    const labelOf = new Uint16Array(total);
    const tnx = tpl.nx, tny = tpl.ny, tnz = tpl.nz;
    const tv = tpl.voxel;
    const tnxny = tnx * tny;

    let inside = 0, labeled = 0;
    let ad = 0;
    for (let k = 0; k < nz; k++) {
        const kx = m.origin[0] + m.dk[0] * k;
        const ky = m.origin[1] + m.dk[1] * k;
        const kz = m.origin[2] + m.dk[2] * k;
        for (let j = 0; j < ny; j++) {
            let x = kx + m.dj[0] * j;
            let y = ky + m.dj[1] * j;
            let z = kz + m.dj[2] * j;
            for (let i = 0; i < nx; i++, ad++, x += m.di[0], y += m.di[1], z += m.di[2]) {
                // **最近傍は floor(v + 0.5)**。アプリの overlay サンプリングと同じ規約に揃える
                // (Math.round は負値で挙動が変わるため使わない)。
                const ti = Math.floor(x + 0.5);
                if (ti < 0 || ti >= tnx) continue;
                const tj = Math.floor(y + 0.5);
                if (tj < 0 || tj >= tny) continue;
                const tk = Math.floor(z + 0.5);
                if (tk < 0 || tk >= tnz) continue;
                inside++;
                const lab = tv[tk * tnxny + tj * tnx + ti];
                if (lab > 0) { labelOf[ad] = lab; labeled++; }
            }
        }
    }
    const voxelVolumeMl =
        Math.abs(image.vectorX.length() * image.vectorY.length() * image.vectorZ.length()) / 1000;
    return { labelOf, insideCount: inside, labeledCount: labeled, totalCount: total, voxelVolumeMl };
};

// ---------------------------------------------------------------------------
// 診断 — 「正規化されていない画像」を黙って処理しないための材料
// ---------------------------------------------------------------------------

export interface VoiOverlapDiagnostics {
    /** 画像 voxel のうちテンプレート格子内に落ちた割合 (0..1) */
    insideFraction: number;
    /** 画像 voxel のうちラベルが付いた割合 (0..1) */
    labeledFraction: number;
    imageBoxMm: [number, number][];
    templateBoxMm: [number, number][];
    /** world bbox が重なっている体積の割合 (画像 bbox に対する比) */
    bboxOverlapFraction: number;
}

const worldBox = (v: Volume): [number, number][] => {
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (const i of [0, v.nx - 1]) for (const j of [0, v.ny - 1]) for (const k of [0, v.nz - 1]) {
        xs.push(v.imagePosition.x + v.vectorX.x * i + v.vectorY.x * j + v.vectorZ.x * k);
        ys.push(v.imagePosition.y + v.vectorX.y * i + v.vectorY.y * j + v.vectorZ.y * k);
        zs.push(v.imagePosition.z + v.vectorX.z * i + v.vectorY.z * j + v.vectorZ.z * k);
    }
    return [
        [Math.min(...xs), Math.max(...xs)],
        [Math.min(...ys), Math.max(...ys)],
        [Math.min(...zs), Math.max(...zs)],
    ];
};

export const diagnoseOverlap = (
    image: Volume, tpl: Volume, a: VoiAssignment,
): VoiOverlapDiagnostics => {
    const ib = worldBox(image), tb = worldBox(tpl);
    let inter = 1, imgVol = 1;
    for (let r = 0; r < 3; r++) {
        const lo = Math.max(ib[r][0], tb[r][0]);
        const hi = Math.min(ib[r][1], tb[r][1]);
        inter *= Math.max(0, hi - lo);
        imgVol *= Math.max(1e-9, ib[r][1] - ib[r][0]);
    }
    return {
        insideFraction: a.totalCount ? a.insideCount / a.totalCount : 0,
        labeledFraction: a.totalCount ? a.labeledCount / a.totalCount : 0,
        imageBoxMm: ib,
        templateBoxMm: tb,
        bboxOverlapFraction: imgVol > 0 ? inter / imgVol : 0,
    };
};

/**
 * 「この組み合わせは怪しい」と言うべきかの判定。
 * **黙って数値を返さない**ためのもので、処理は止めない (ユーザが承知で使う場合もある)。
 */
export const overlapWarnings = (d: VoiOverlapDiagnostics, labeledRegions: number, totalRegions: number): string[] => {
    const w: string[] = [];
    if (d.bboxOverlapFraction < 0.5) {
        w.push(`Only ${(d.bboxOverlapFraction * 100).toFixed(0)}% of the image bounding box overlaps the template. `
             + 'The image may not be spatially normalised, or it may be in a different space.');
    }
    if (d.labeledFraction < 0.05) {
        w.push(`Only ${(d.labeledFraction * 100).toFixed(1)}% of image voxels received a label.`);
    }
    if (totalRegions > 0 && labeledRegions < totalRegions * 0.5) {
        w.push(`${totalRegions - labeledRegions} of ${totalRegions} regions received no voxels at all.`);
    }
    return w;
};
