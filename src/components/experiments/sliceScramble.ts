// Slice-scramble experiment.
//
// 目的: z スライスをランダムに入れ替えて「ぐちゃぐちゃ」にした volume を、
// スライス間類似度 (ここでは square difference / SSD) だけを頼りに元の順序へ
// 復元できるかを試す。連続する解剖スライスは互いに非常に似ているので、
// 「隣り合うスライスほど似ている」ことを使って 1 次元に並べ直す (seriation /
// open-path TSP) と、元のスタック順が（全体反転を除いて）復元できるはず、という実験。
//
// 使い方 (DicomView 側):
//   const { voxel, perm } = scrambleZSlices(vol);  vol.voxel = voxel;  // ぐちゃぐちゃに
//   const { voxel, order } = recoverZOrder(vol);    vol.voxel = voxel;  // 復元を試す
//   scrambleAccuracy(perm, order) で復元精度をレポート。

import type { Volume } from '../Volume';

// ---- Fisher–Yates シャッフル (Math.random は app runtime では利用可) ----
const shuffledIndices = (n: number): number[] => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
};

// z スライスをランダムに並べ替えた「新しい voxel 配列」と、その並べ替え perm を返す。
//   perm[k] = 並べ替え後の位置 k に来た「元スライス番号」
export const scrambleZSlices = (vol: Volume): { voxel: Float32Array; perm: number[] } => {
  const { nx, ny, nz, voxel } = vol;
  const sliceLen = nx * ny;
  const perm = shuffledIndices(nz);
  const out = new Float32Array(voxel.length);
  for (let k = 0; k < nz; k++) {
    const src = perm[k] * sliceLen;
    out.set(voxel.subarray(src, src + sliceLen), k * sliceLen);
  }
  return { voxel: out, perm };
};

// 各スライスを D×D に平均プーリングした特徴量を作る (pairwise 距離を安く計算するため)。
const buildSliceFeatures = (vol: Volume, D: number): Float32Array[] => {
  const { nx, ny, nz, voxel } = vol;
  const feats: Float32Array[] = [];
  for (let z = 0; z < nz; z++) {
    const f = new Float32Array(D * D);
    const cnt = new Float32Array(D * D);
    const base = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const by = Math.min(D - 1, (y * D / ny) | 0);
      const row = base + y * nx;
      for (let x = 0; x < nx; x++) {
        const bx = Math.min(D - 1, (x * D / nx) | 0);
        const c = by * D + bx;
        f[c] += voxel[row + x];
        cnt[c] += 1;
      }
    }
    for (let c = 0; c < D * D; c++) if (cnt[c] > 0) f[c] /= cnt[c];
    feats[z] = f;
  }
  return feats;
};

const ssd = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
};

// slice-to-slice 類似度 (SSD) を使って 1 次元の順序を復元する。
//   返り値 order[k] = 復元後の位置 k に置く「現在(スクランブル済み)スライス番号」
// 手順: 全ペア SSD → 端点推定 → 最近傍チェイン (NN) → open-path 2-opt で研磨。
export const recoverZOrder = (
  vol: Volume,
  opts: { featureSize?: number; twoOptPasses?: number } = {},
): { voxel: Float32Array; order: number[] } => {
  const { nx, ny, nz, voxel } = vol;
  const D = opts.featureSize ?? 24;
  const feats = buildSliceFeatures(vol, D);

  // 全ペア距離行列 (対称)。nz は最大 ~849 想定 → nz² floats。
  const dist = new Float32Array(nz * nz);
  for (let i = 0; i < nz; i++) {
    for (let j = i + 1; j < nz; j++) {
      const d = ssd(feats[i], feats[j]);
      dist[i * nz + j] = d;
      dist[j * nz + i] = d;
    }
  }
  const D_ = (i: number, j: number) => dist[i * nz + j];

  // 端点推定: 各スライスの「最近傍までの距離」が最大のものは、1 次元多様体の端に
  // いる可能性が高い。そこを NN チェインの開始点にする。
  let startNode = 0, bestMinDist = -1;
  for (let i = 0; i < nz; i++) {
    let mn = Infinity;
    for (let j = 0; j < nz; j++) if (j !== i) { const d = D_(i, j); if (d < mn) mn = d; }
    if (mn > bestMinDist) { bestMinDist = mn; startNode = i; }
  }

  // 最近傍チェイン
  const used = new Uint8Array(nz);
  const order: number[] = new Array(nz);
  order[0] = startNode; used[startNode] = 1;
  for (let k = 1; k < nz; k++) {
    const prev = order[k - 1];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < nz; j++) {
      if (used[j]) continue;
      const d = D_(prev, j);
      if (d < bestD) { bestD = d; best = j; }
    }
    order[k] = best; used[best] = 1;
  }

  // open-path 2-opt: 区間 [i+1..j] を反転して総経路長が縮むなら採用。
  const pathCost = (a: number, b: number) => D_(order[a], order[b]);
  const passes = opts.twoOptPasses ?? 6;
  for (let p = 0; p < passes; p++) {
    let improved = false;
    for (let i = 0; i < nz - 2; i++) {
      const a = order[i];
      for (let j = i + 2; j < nz; j++) {
        // edge (i,i+1) と (j,j+1) を (i,j) と (i+1,j+1) に張り替える
        const b = order[i + 1];
        const c = order[j];
        const d = j + 1 < nz ? order[j + 1] : -1;
        const before = D_(a, b) + (d >= 0 ? D_(c, d) : 0);
        const after = D_(a, c) + (d >= 0 ? D_(b, d) : 0);
        if (after + 1e-6 < before) {
          // reverse order[i+1 .. j]
          let lo = i + 1, hi = j;
          while (lo < hi) { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; lo++; hi--; }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  void pathCost;

  // 復元順で voxel を並べ直す
  const sliceLen = nx * ny;
  const out = new Float32Array(voxel.length);
  for (let k = 0; k < nz; k++) {
    const src = order[k] * sliceLen;
    out.set(voxel.subarray(src, src + sliceLen), k * sliceLen);
  }
  return { voxel: out, order };
};

// 復元精度レポート。
//   perm  : scramble 時の perm (perm[k] = 位置 k の元スライス番号)
//   order : recover が返した order (order[k] = 位置 k に置いた現在スライス番号)
// 復元後の位置 k に来る「元スライス番号」= perm[order[k]] の並びが 0..nz-1 (or 反転)
// になっていれば成功。隣接一致率と Spearman |ρ| を返す。
export const scrambleAccuracy = (perm: number[], order: number[]): {
  adjacency: number; spearmanAbs: number; reversed: boolean; n: number;
} => {
  const n = order.length;
  const seq = order.map(k => perm[k]);   // 復元位置 → 元スライス番号
  // 隣接一致率: |seq[k+1]-seq[k]| == 1 の割合
  let adj = 0;
  for (let k = 0; k < n - 1; k++) if (Math.abs(seq[k + 1] - seq[k]) === 1) adj++;
  const adjacency = n > 1 ? adj / (n - 1) : 1;
  // Spearman: 位置 k (0..n-1) と元スライス番号 seq[k] の順位相関。単調なら ±1。
  let sdx = 0, sdy = 0, sxy = 0;
  const mean = (n - 1) / 2;
  for (let k = 0; k < n; k++) {
    const dx = k - mean;
    const dy = seq[k] - mean;
    sdx += dx * dx; sdy += dy * dy; sxy += dx * dy;
  }
  const rho = (sdx > 0 && sdy > 0) ? sxy / Math.sqrt(sdx * sdy) : 0;
  return { adjacency, spearmanAbs: Math.abs(rho), reversed: rho < 0, n };
};
