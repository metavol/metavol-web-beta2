import type { Volume } from '../Volume';
import type { LabelEntry } from '../../stores/segmentation';

// マスク内の全 voxel を 1 行ずつ書き出す (Persona 1 向け)。
//
// 様式 (ユーザ指定): `island_id label_id x y z value` の空白区切り。
// - **island_id = 病変 (非ゼロ 26-連結成分) の番号。** 「腫瘍だけ取り出して各病変を
//   別々に解析する」ために要る (label だけでは離れた病変が区別できない)。
//   番号は **Lesion table / Lesions CSV と同じ SUVmax 降順** (1 = SUVmax 最大の病変)。
//   呼び出し側が componentMap を summarizeLesions の順位で振り直した islandOf を渡す。
// - **label_id は数値 id**。ラベル名には空白が入る ("Right Cerebral White Matter") ので、
//   名前を列に入れると空白区切りが壊れる。id → 名前の対応は先頭の `#` 行に載せる。
// - **x y z は PET 格子の 0-based voxel index**。矩形 ROI の座標も voxel index で
//   保存している (既存の慣行) のに合わせる。mm へ戻すのに必要な voxel サイズと
//   格子寸法も `#` 行に書く。
// - `#` で始まる行はコメント。numpy.loadtxt / pandas.read_csv(comment='#', sep='\s+')
//   がそのまま読める形にしてある。
//
// **純関数** (store も DOM も触らない)。バッチ処理や別入口から再利用できる。
export const maskVoxelListText = (
    mask: Uint16Array,
    pet: Volume,
    labels: LabelEntry[],
    /** voxel ごとの病変番号 (0 = 背景)。番号は Lesion table と同じ SUVmax 降順で振ってあること */
    islandOf: Uint16Array,
    meta?: { image?: string; unit?: string; islandCount?: number },
): string => {
    const lines: string[] = [];
    const esc = (s: string) => s.replace(/[\r\n]+/g, ' ');
    if (meta?.image) lines.push(`# image ${esc(meta.image)}`);
    lines.push(`# grid ${pet.nx} ${pet.ny} ${pet.nz}`);
    lines.push(`# voxel_mm ${+pet.vectorX.length().toFixed(6)} ${+pet.vectorY.length().toFixed(6)} ${+pet.vectorZ.length().toFixed(6)}`);
    lines.push('# coordinates 0-based voxel indices on the PET grid');
    if (meta?.unit) lines.push(`# unit ${esc(meta.unit)}`);
    if (meta?.islandCount != null) {
        lines.push(`# islands ${meta.islandCount} (26-connected, numbered as in the Lesions table: 1 = highest SUVmax)`);
    }
    // マスクに実在する id だけ対応表を出す (未使用ラベルでコメントを膨らませない)
    const used = new Set<number>();
    for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) used.add(mask[i]);
    for (const l of labels) if (used.has(l.id)) lines.push(`# label ${l.id} ${esc(l.name)}`);
    lines.push('island_id label_id x y z value');

    const vox = pet.voxel;
    const nx = pet.nx, ny = pet.ny, nz = pet.nz;
    const n = Math.min(mask.length, vox.length, islandOf.length, nx * ny * nz);
    // toFixed(6) は丸め誤差 ≤5e-7。SUV/HU の用途では十分で、末尾ゼロは削って軽くする。
    const fmt = (v: number) => Number.isFinite(v) ? String(+v.toFixed(6)) : 'nan';
    for (let idx = 0; idx < n; idx++) {
        const id = mask[idx];
        if (id === 0) continue;
        const x = idx % nx;
        const y = ((idx / nx) | 0) % ny;
        const z = (idx / (nx * ny)) | 0;
        lines.push(`${islandOf[idx]} ${id} ${x} ${y} ${z} ${fmt(vox[idx])}`);
    }
    return lines.join('\n');
};
