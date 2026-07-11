// Radiomics features for a labeled VOI on a PET volume.
//
// 実装範囲:
//   - First-order: mean / std / min / max / median / p10 / p25 / p75 / p90 /
//     skewness / kurtosis / energy / entropy / uniformity / RMS / range / IQR
//   - Shape: voxel count / volume (cc) / surface area (mm^2) / sphericity / compactness
//   - Texture (GLCM, 13 directions averaged):
//       contrast / homogeneity / energy(angular 2nd moment) / correlation
//   - Texture (GLRLM, 13 directions averaged):
//       SRE / LRE / GLN / RLN
//
// pyradiomics と完全互換ではない (gray-level discretization の bin count を 32 に
// 固定、エッジケースの取り扱いを簡略化、IBSI 準拠ではない局所的な定式化を含む)。
// あくまで「研究用の代替簡易実装」であり、論文公開用の数値には pyradiomics 等を併用すべき。
//
// 計算量: GLCM は O(N_voxel × 13 directions) で構築、その後 O(GL × GL) で features 算出。
// GL = 32 で 1024 bin、N_voxel = 数千 voxel なら 1 秒未満。
// VOI が数十万 voxel あるとそれなりに重いので、UI 側で「計算中…」spinner 推奨。

export type Modality = 'PT' | 'CT' | 'MR' | 'OTHER' | string;

export interface VoxelGrid {
    nx: number; ny: number; nz: number;
    voxel: Float32Array | Int16Array;
    spacingMm: [number, number, number];
}

export interface RadiomicsFeatures {
    // first-order
    voxelCount: number;
    volumeCc: number;
    min: number; max: number; mean: number; std: number;
    median: number; p10: number; p25: number; p75: number; p90: number;
    skewness: number; kurtosis: number;
    energy: number; rms: number;
    range: number; iqr: number;
    entropy: number; uniformity: number;
    // shape
    surfaceAreaMm2: number;
    sphericity: number;
    compactness: number;
    surfaceVolumeRatio: number;
    // texture (GLCM)
    glcmContrast: number;
    glcmHomogeneity: number;
    glcmEnergy: number;
    glcmCorrelation: number;
    // texture (GLRLM)
    glrlmSre: number;       // Short Run Emphasis
    glrlmLre: number;       // Long Run Emphasis
    glrlmGln: number;       // Gray Level Non-uniformity
    glrlmRln: number;       // Run Length Non-uniformity
}

const GL_BINS = 32;          // gray-level discretization bins
const NEIGHBORS_26 = (() => {
    const arr: Array<[number, number, number]> = [];
    for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                arr.push([dx, dy, dz]);
            }
        }
    }
    return arr;  // 26
})();
const DIRECTIONS_13 = (() => {
    // GLCM/GLRLM の 13 unique 方向 (反対方向は対称なので片方だけ)
    const out: Array<[number, number, number]> = [];
    const seen = new Set<string>();
    for (const d of NEIGHBORS_26) {
        const neg = `${-d[0]},${-d[1]},${-d[2]}`;
        const key = `${d[0]},${d[1]},${d[2]}`;
        if (seen.has(neg)) continue;
        seen.add(key);
        out.push(d);
    }
    return out;  // 13
})();

// VOI の bounding box voxel index list を抽出。
const collectVoiVoxels = (
    pet: VoxelGrid,
    mask: Uint16Array,
    labelId: number,
): { indices: number[]; values: number[]; bbox: { i0: number; i1: number; j0: number; j1: number; k0: number; k1: number } } | null => {
    const { nx, ny, nz, voxel } = pet;
    const N = nx * ny * nz;
    if (mask.length !== N) return null;
    const indices: number[] = [];
    const values: number[] = [];
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
    let p = 0;
    for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                if (mask[p] === labelId) {
                    indices.push(p);
                    values.push(voxel[p]);
                    if (i < i0) i0 = i; if (i > i1) i1 = i;
                    if (j < j0) j0 = j; if (j > j1) j1 = j;
                    if (k < k0) k0 = k; if (k > k1) k1 = k;
                }
                p++;
            }
        }
    }
    if (indices.length === 0) return null;
    return { indices, values, bbox: { i0, i1, j0, j1, k0, k1 } };
};

// Pearson moments
const computeMoments = (vals: number[]) => {
    const n = vals.length;
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (const v of vals) { s1 += v; s2 += v * v; }
    const mean = s1 / n;
    const variance = Math.max(0, s2 / n - mean * mean);
    const std = Math.sqrt(variance);
    if (std > 0) {
        for (const v of vals) {
            const d = (v - mean) / std;
            s3 += d * d * d;
            s4 += d * d * d * d;
        }
    }
    const skewness = std > 0 ? s3 / n : 0;
    const kurtosis = std > 0 ? s4 / n : 0;  // raw (not excess)
    return { mean, std, skewness, kurtosis, sumSq: s2 };
};

const percentile = (sortedAsc: number[], q: number): number => {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
    return sortedAsc[idx];
};

// VOI 表面積を 6-connectivity の「外向きフェース」面積で近似 (mm^2)。
// 各 voxel face は隣接が VOI 外なら count、その面積は spacing 軸ペア。
const computeSurfaceArea = (
    pet: VoxelGrid,
    mask: Uint16Array,
    labelId: number,
): number => {
    const { nx, ny, nz, spacingMm } = pet;
    const [sx, sy, sz] = spacingMm;
    const aX = sy * sz;  // x-normal face
    const aY = sx * sz;
    const aZ = sx * sy;
    let area = 0;
    let p = 0;
    for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                if (mask[p] === labelId) {
                    if (i === 0      || mask[p - 1]      !== labelId) area += aX;
                    if (i === nx - 1 || mask[p + 1]      !== labelId) area += aX;
                    if (j === 0      || mask[p - nx]     !== labelId) area += aY;
                    if (j === ny - 1 || mask[p + nx]     !== labelId) area += aY;
                    if (k === 0      || mask[p - nx*ny]  !== labelId) area += aZ;
                    if (k === nz - 1 || mask[p + nx*ny]  !== labelId) area += aZ;
                }
                p++;
            }
        }
    }
    return area;
};

// gray-level discretization: VOI 内 voxel を min..max で GL_BINS 等分 → bin index に量子化
const discretize = (values: number[], lo: number, hi: number): Uint8Array => {
    const out = new Uint8Array(values.length);
    if (hi <= lo) return out;
    const inv = (GL_BINS - 1) / (hi - lo);
    for (let i = 0; i < values.length; i++) {
        let b = Math.floor((values[i] - lo) * inv);
        if (b < 0) b = 0; else if (b >= GL_BINS) b = GL_BINS - 1;
        out[i] = b;
    }
    return out;
};

// VOI 全 voxel index → discretized GL を sparse map にして GLCM/GLRLM 計算で使う
const buildVoiGlMap = (
    pet: VoxelGrid,
    mask: Uint16Array,
    labelId: number,
    lo: number,
    hi: number,
): Map<number, number> => {
    const out = new Map<number, number>();
    if (hi <= lo) return out;
    const inv = (GL_BINS - 1) / (hi - lo);
    const { voxel } = pet;
    for (let p = 0; p < mask.length; p++) {
        if (mask[p] !== labelId) continue;
        let b = Math.floor((voxel[p] - lo) * inv);
        if (b < 0) b = 0; else if (b >= GL_BINS) b = GL_BINS - 1;
        out.set(p, b);
    }
    return out;
};

// GLCM (Gray-Level Co-occurrence Matrix) を 13 方向で構築 → 4 features を平均
const computeGlcmFeatures = (
    pet: VoxelGrid,
    voiGlMap: Map<number, number>,
): { contrast: number; homogeneity: number; energy: number; correlation: number } => {
    const { nx, ny, nz } = pet;
    const stride_y = nx, stride_z = nx * ny;
    let contrastAcc = 0, homogAcc = 0, energyAcc = 0, corrAcc = 0;
    let nDirsValid = 0;

    for (const [dx, dy, dz] of DIRECTIONS_13) {
        // GL × GL 共起行列 (Float32Array で 1024 bin)
        const M = new Float32Array(GL_BINS * GL_BINS);
        let total = 0;
        for (const [p, g1] of voiGlMap) {
            const i = p % nx;
            const j = Math.floor(p / nx) % ny;
            const k = Math.floor(p / (nx * ny));
            const ii = i + dx, jj = j + dy, kk = k + dz;
            if (ii < 0 || ii >= nx || jj < 0 || jj >= ny || kk < 0 || kk >= nz) continue;
            const q = kk * stride_z + jj * stride_y + ii;
            const g2 = voiGlMap.get(q);
            if (g2 === undefined) continue;
            // 対称化: (g1, g2) と (g2, g1) を両方 +1
            M[g1 * GL_BINS + g2] += 1;
            M[g2 * GL_BINS + g1] += 1;
            total += 2;
        }
        if (total === 0) continue;
        // normalize
        for (let i = 0; i < M.length; i++) M[i] /= total;
        // marginal sums for correlation
        let mu_i = 0, mu_j = 0;
        for (let i = 0; i < GL_BINS; i++) {
            for (let j = 0; j < GL_BINS; j++) {
                const p = M[i * GL_BINS + j];
                mu_i += i * p; mu_j += j * p;
            }
        }
        let var_i = 0, var_j = 0;
        for (let i = 0; i < GL_BINS; i++) {
            for (let j = 0; j < GL_BINS; j++) {
                const p = M[i * GL_BINS + j];
                var_i += (i - mu_i) * (i - mu_i) * p;
                var_j += (j - mu_j) * (j - mu_j) * p;
            }
        }
        const sd_i = Math.sqrt(var_i), sd_j = Math.sqrt(var_j);
        let contrast = 0, homog = 0, energy = 0, corr = 0;
        for (let i = 0; i < GL_BINS; i++) {
            for (let j = 0; j < GL_BINS; j++) {
                const p = M[i * GL_BINS + j];
                if (p <= 0) continue;
                const d = i - j;
                contrast += d * d * p;
                homog += p / (1 + Math.abs(d));
                energy += p * p;
                if (sd_i > 0 && sd_j > 0) corr += ((i - mu_i) * (j - mu_j) * p) / (sd_i * sd_j);
            }
        }
        contrastAcc += contrast;
        homogAcc += homog;
        energyAcc += energy;
        corrAcc += corr;
        nDirsValid++;
    }
    if (nDirsValid === 0) return { contrast: 0, homogeneity: 0, energy: 0, correlation: 0 };
    return {
        contrast: contrastAcc / nDirsValid,
        homogeneity: homogAcc / nDirsValid,
        energy: energyAcc / nDirsValid,
        correlation: corrAcc / nDirsValid,
    };
};

// GLRLM: 各方向で「同じ GL が連続する run」の長さ分布。
// 4 features: SRE, LRE, GLN, RLN
const computeGlrlmFeatures = (
    pet: VoxelGrid,
    voiGlMap: Map<number, number>,
): { sre: number; lre: number; gln: number; rln: number } => {
    const { nx, ny, nz } = pet;
    const stride_z = nx * ny, stride_y = nx;
    // 各方向ごとに run を抽出
    let sreAcc = 0, lreAcc = 0, glnAcc = 0, rlnAcc = 0;
    let nDirsValid = 0;

    for (const [dx, dy, dz] of DIRECTIONS_13) {
        const visited = new Set<number>();
        // run length × GL の 2D ヒスト (max run length を VOI 最大寸法で見積もる)
        const maxRun = Math.max(nx, ny, nz);
        const RL = new Float32Array(GL_BINS * (maxRun + 1));
        let totalRuns = 0;

        for (const [pStart, gStart] of voiGlMap) {
            if (visited.has(pStart)) continue;
            // run start: previous voxel (-d direction) is NOT same gl in VOI
            const i = pStart % nx;
            const j = Math.floor(pStart / nx) % ny;
            const k = Math.floor(pStart / (nx * ny));
            const pi = i - dx, pj = j - dy, pk = k - dz;
            if (pi >= 0 && pi < nx && pj >= 0 && pj < ny && pk >= 0 && pk < nz) {
                const q = pk * stride_z + pj * stride_y + pi;
                if (voiGlMap.get(q) === gStart) continue;  // not run start
            }
            // walk along +d direction while same gl
            let len = 1;
            visited.add(pStart);
            let ci = i + dx, cj = j + dy, ck = k + dz;
            while (ci >= 0 && ci < nx && cj >= 0 && cj < ny && ck >= 0 && ck < nz) {
                const cp = ck * stride_z + cj * stride_y + ci;
                if (voiGlMap.get(cp) !== gStart) break;
                visited.add(cp);
                len++;
                ci += dx; cj += dy; ck += dz;
            }
            RL[gStart * (maxRun + 1) + len] += 1;
            totalRuns++;
        }
        if (totalRuns === 0) continue;
        // features
        let sre = 0, lre = 0;
        const glSum = new Float32Array(GL_BINS);
        const rlSum = new Float32Array(maxRun + 1);
        for (let g = 0; g < GL_BINS; g++) {
            for (let r = 1; r <= maxRun; r++) {
                const c = RL[g * (maxRun + 1) + r];
                if (c <= 0) continue;
                sre += c / (r * r);
                lre += c * (r * r);
                glSum[g] += c;
                rlSum[r] += c;
            }
        }
        sre /= totalRuns;
        lre /= totalRuns;
        let gln = 0, rln = 0;
        for (let g = 0; g < GL_BINS; g++) gln += glSum[g] * glSum[g];
        for (let r = 1; r <= maxRun; r++) rln += rlSum[r] * rlSum[r];
        gln /= totalRuns;
        rln /= totalRuns;

        sreAcc += sre; lreAcc += lre; glnAcc += gln; rlnAcc += rln;
        nDirsValid++;
    }
    if (nDirsValid === 0) return { sre: 0, lre: 0, gln: 0, rln: 0 };
    return {
        sre: sreAcc / nDirsValid,
        lre: lreAcc / nDirsValid,
        gln: glnAcc / nDirsValid,
        rln: rlnAcc / nDirsValid,
    };
};

export const computeRadiomicsFeatures = (
    pet: VoxelGrid,
    mask: Uint16Array,
    labelId: number,
): RadiomicsFeatures | null => {
    const voi = collectVoiVoxels(pet, mask, labelId);
    if (!voi || voi.values.length === 0) return null;

    // first-order
    const sorted = voi.values.slice().sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const range = max - min;
    const median = percentile(sorted, 0.5);
    const p10 = percentile(sorted, 0.10);
    const p25 = percentile(sorted, 0.25);
    const p75 = percentile(sorted, 0.75);
    const p90 = percentile(sorted, 0.90);
    const iqr = p75 - p25;
    const moments = computeMoments(voi.values);
    const energy = moments.sumSq;
    const rms = Math.sqrt(moments.sumSq / voi.values.length);

    // entropy / uniformity (use discretized GL hist)
    const dis = discretize(voi.values, min, max);
    const histRaw = new Uint32Array(GL_BINS);
    for (const b of dis) histRaw[b]++;
    let entropy = 0, uniformity = 0;
    const N = voi.values.length;
    for (const c of histRaw) {
        if (c === 0) continue;
        const p = c / N;
        entropy -= p * Math.log2(p);
        uniformity += p * p;
    }

    // shape
    const [sx, sy, sz] = pet.spacingMm;
    const voxelVolMm3 = sx * sy * sz;
    const volumeMm3 = voi.values.length * voxelVolMm3;
    const volumeCc = volumeMm3 / 1000;
    const surfaceArea = computeSurfaceArea(pet, mask, labelId);
    const surfaceVolumeRatio = volumeMm3 > 0 ? surfaceArea / volumeMm3 : 0;
    // sphericity = (π^(1/3) * (6V)^(2/3)) / SA   [IBSI; perfect sphere = 1]
    const sphericity = surfaceArea > 0
        ? (Math.cbrt(Math.PI) * Math.pow(6 * volumeMm3, 2 / 3)) / surfaceArea
        : 0;
    // compactness 1 = V / (π^(1/2) * SA^(3/2))  [IBSI compactness1]
    const compactness = surfaceArea > 0
        ? volumeMm3 / (Math.sqrt(Math.PI) * Math.pow(surfaceArea, 1.5))
        : 0;

    // texture (need GL discretization bound by VOI min/max)
    const voiGlMap = buildVoiGlMap(pet, mask, labelId, min, max);
    const glcm = computeGlcmFeatures(pet, voiGlMap);
    const glrlm = computeGlrlmFeatures(pet, voiGlMap);

    return {
        voxelCount: voi.values.length,
        volumeCc,
        min, max, mean: moments.mean, std: moments.std,
        median, p10, p25, p75, p90,
        skewness: moments.skewness, kurtosis: moments.kurtosis,
        energy, rms,
        range, iqr,
        entropy, uniformity,
        surfaceAreaMm2: surfaceArea,
        sphericity,
        compactness,
        surfaceVolumeRatio,
        glcmContrast: glcm.contrast,
        glcmHomogeneity: glcm.homogeneity,
        glcmEnergy: glcm.energy,
        glcmCorrelation: glcm.correlation,
        glrlmSre: glrlm.sre,
        glrlmLre: glrlm.lre,
        glrlmGln: glrlm.gln,
        glrlmRln: glrlm.rln,
    };
};

// 全ラベルに対して radiomics features を計算し CSV 用の行配列を返す。
export const computeAllRadiomics = (
    pet: VoxelGrid,
    mask: Uint16Array,
    labels: Array<{ id: number; name: string }>,
): Array<{ labelId: number; labelName: string; features: RadiomicsFeatures }> => {
    const out: Array<{ labelId: number; labelName: string; features: RadiomicsFeatures }> = [];
    for (const l of labels) {
        const f = computeRadiomicsFeatures(pet, mask, l.id);
        if (f) out.push({ labelId: l.id, labelName: l.name, features: f });
    }
    return out;
};
