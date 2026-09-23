import type { Volume } from '../Volume';
import type { VoiLabel } from './voiTemplate';
import type { VoiAssignment } from './voiResample';

// 領域ごとの統計。**純関数**にしてある (store も DOM も触らない) ので、
// 後からバッチ処理や SUVR を足すときにそのまま再利用できる。

export interface VoiStat {
    id: number;
    name: string;
    /** その領域に割り当たった画像 voxel 数 (NaN を含む) */
    voxels: number;
    /** うち値が NaN で統計に使えなかった数。0 でなければ mean 等はそれを除いた値 */
    nanVoxels: number;
    volumeMl: number;
    mean: number;
    sd: number;
    min: number;
    max: number;
}

/**
 * 画像 × ラベル割り当てから領域統計を出す。
 *
 * **2 パスで計算する。** 1 パスで sum と sumSq を貯めると、値が大きい領域で
 * `sumSq - sum^2/n` が桁落ちして SD が負になったり 0 に潰れたりする。
 * 走査対象はたかだか画像 voxel 数 (実測 79x95x79 = 59 万) なので 2 周しても安い。
 *
 * 返すのは **名前表にある領域すべて**。voxel が 0 個の領域も 0 行として残す
 * (黙って消えると「アトラスと合っていない」ことに気付けないため)。
 */
export const computeVoiStats = (
    image: Volume,
    assign: VoiAssignment,
    labels: VoiLabel[],
): VoiStat[] => {
    const nameOf = new Map<number, string>();
    for (const l of labels) nameOf.set(l.id, l.name);

    const lab = assign.labelOf;
    const vox = image.voxel;
    const n = Math.min(lab.length, vox.length);

    // ラベル ID は連番でない (Neuromorphometrics は 4〜207 の飛び飛び) ので、
    // 最大 ID までの配列を確保して直接引く。207 程度なので密配列で十分。
    let maxId = 0;
    for (const l of labels) if (l.id > maxId) maxId = l.id;
    for (let i = 0; i < n; i++) if (lab[i] > maxId) maxId = lab[i];

    const count = new Float64Array(maxId + 1);
    const sum = new Float64Array(maxId + 1);
    const mn = new Float64Array(maxId + 1).fill(Infinity);
    const mx = new Float64Array(maxId + 1).fill(-Infinity);

    // **NaN を除くこと。** SPM の正規化出力は視野外を NaN で埋める
    // (実測 w00r.nii: 0.74% が NaN。この症例ではラベル領域内に 1 つも無かったが、
    //  頭が視野の端に寄った症例では領域内に入りうる)。
    // 1 つでも混じると sum が NaN に伝播し、その領域の統計が丸ごと NaN になる。
    const nanCount = new Float64Array(maxId + 1);
    for (let i = 0; i < n; i++) {
        const id = lab[i];
        if (id === 0) continue;
        const v = vox[i];
        if (!Number.isFinite(v)) { nanCount[id]++; continue; }
        count[id]++;
        sum[id] += v;
        if (v < mn[id]) mn[id] = v;
        if (v > mx[id]) mx[id] = v;
    }

    const mean = new Float64Array(maxId + 1);
    for (let id = 1; id <= maxId; id++) if (count[id] > 0) mean[id] = sum[id] / count[id];

    const ss = new Float64Array(maxId + 1);
    for (let i = 0; i < n; i++) {
        const id = lab[i];
        if (id === 0) continue;
        const v = vox[i];
        if (!Number.isFinite(v)) continue;
        const d = v - mean[id];
        ss[id] += d * d;
    }

    const out: VoiStat[] = [];
    const emit = (id: number, name: string) => {
        const c = count[id];
        const nan = nanCount[id];
        out.push({
            id, name,
            // voxels / volumeMl は **割り当たった全 voxel** (NaN 込み) を数える。
            // 領域の広がりは値の有無と無関係なので、ここで減らすと体積が過少になる。
            voxels: c + nan,
            nanVoxels: nan,
            volumeMl: (c + nan) * assign.voxelVolumeMl,
            // **標本標準偏差 (n-1)** を使う。1 voxel の領域では 0 を返す。
            mean: c > 0 ? mean[id] : NaN,
            sd: c > 1 ? Math.sqrt(ss[id] / (c - 1)) : (c === 1 ? 0 : NaN),
            min: c > 0 ? mn[id] : NaN,
            max: c > 0 ? mx[id] : NaN,
        });
    };
    const emitted = new Set<number>();
    for (const l of labels) { emit(l.id, l.name); emitted.add(l.id); }
    // 名前表に無い ID が画像側に出たら、隠さず "Unnamed" として出す
    for (let id = 1; id <= maxId; id++) {
        if (emitted.has(id) || count[id] === 0) continue;
        emit(id, nameOf.get(id) ?? `Unnamed label ${id}`);
    }
    return out;
};

/** CSV 出力。Excel で開けるよう BOM は呼び出し側で付ける (既存の CSV 出力に合わせる)。 */
export const voiStatsToCsv = (
    stats: VoiStat[],
    meta: { image?: string; template?: string; atlas?: string; unit?: string },
    /** SUVR 参照領域。指定すると suvr 列 (= mean / 参照 mean) を追加する */
    suvrRef?: { id: number; name: string; mean: number } | null,
): string => {
    const esc = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const num = (v: number) => Number.isFinite(v) ? String(+v.toFixed(6)) : '';
    const refOk = !!suvrRef && Number.isFinite(suvrRef.mean) && suvrRef.mean !== 0;
    const lines: string[] = [];
    if (meta.image) lines.push(`# image,${esc(meta.image)}`);
    if (meta.template) lines.push(`# template,${esc(meta.template)}`);
    if (meta.atlas) lines.push(`# atlas,${esc(meta.atlas)}`);
    if (meta.unit) lines.push(`# unit,${esc(meta.unit)}`);
    if (refOk) lines.push(`# suvr_reference,${suvrRef!.id},${esc(suvrRef!.name)},mean,${num(suvrRef!.mean)}`);
    lines.push('id,name,voxels,nan_voxels,volume_ml,mean,sd,min,max' + (refOk ? ',suvr' : ''));
    for (const s of stats) {
        const row = [s.id, esc(s.name), s.voxels, s.nanVoxels, num(s.volumeMl),
                     num(s.mean), num(s.sd), num(s.min), num(s.max)];
        if (refOk) row.push(num(s.mean / suvrRef!.mean));
        lines.push(row.join(','));
    }
    return lines.join('\n');
};
