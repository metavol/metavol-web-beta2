// Nelder-Mead simplex optimizer (no gradient required).
// Minimizes a scalar-valued function of N parameters.
// 標準パラメータ: α=1 reflection, γ=2 expansion, ρ=0.5 contraction, σ=0.5 shrink.

export interface NelderMeadResult {
    x: number[];
    fx: number;
    iterations: number;
    converged: boolean;
}

export interface NelderMeadOptions {
    maxIter?: number;
    tolFx?: number;        // |best - worst| / (|best| + ε) 以下で収束
    tolX?: number;         // simplex 直径 (最大頂点間距離) 以下で収束
    onIter?: (iter: number, bestFx: number, bestX: number[]) => void;
    abortSignal?: { aborted: boolean };
}

export const optimizeNelderMead = (
    f: (x: number[]) => number,
    x0: number[],
    scales: number[],          // 各次元の初期 step size
    options: NelderMeadOptions = {},
): NelderMeadResult => {
    const N = x0.length;
    const maxIter = options.maxIter ?? 200;
    const tolFx = options.tolFx ?? 1e-5;
    const tolX = options.tolX ?? 1e-3;

    // 初期 simplex: x0 と (x0 + scales[i] * e_i)
    const simplex: number[][] = [x0.slice()];
    for (let i = 0; i < N; i++) {
        const v = x0.slice();
        v[i] += scales[i];
        simplex.push(v);
    }
    const fxs = simplex.map(v => f(v));

    let iter = 0;
    let converged = false;

    const sortIndices = (): number[] => {
        const idx = simplex.map((_, i) => i);
        idx.sort((a, b) => fxs[a] - fxs[b]);
        return idx;
    };

    while (iter < maxIter) {
        if (options.abortSignal?.aborted) break;
        const order = sortIndices();
        const best = order[0];
        const worst = order[N];
        const secondWorst = order[N - 1];

        // 収束チェック (function tolerance)
        const fxBest = fxs[best], fxWorst = fxs[worst];
        const fxSpread = Math.abs(fxWorst - fxBest);
        const fxScale = Math.max(1e-12, Math.abs(fxBest) + Math.abs(fxWorst));
        if (fxSpread / fxScale < tolFx) { converged = true; break; }

        // 収束チェック (simplex size)
        let maxDist = 0;
        for (let i = 0; i <= N; i++) {
            for (let j = i + 1; j <= N; j++) {
                let d2 = 0;
                for (let k = 0; k < N; k++) {
                    const dd = simplex[i][k] - simplex[j][k];
                    d2 += dd * dd;
                }
                if (d2 > maxDist) maxDist = d2;
            }
        }
        if (Math.sqrt(maxDist) < tolX) { converged = true; break; }

        // Centroid (worst を除いて)
        const centroid = new Array(N).fill(0);
        for (let i = 0; i <= N; i++) {
            if (i === worst) continue;
            for (let k = 0; k < N; k++) centroid[k] += simplex[i][k];
        }
        for (let k = 0; k < N; k++) centroid[k] /= N;

        // Reflection
        const reflected = new Array(N);
        for (let k = 0; k < N; k++) reflected[k] = centroid[k] + (centroid[k] - simplex[worst][k]);
        const fxReflected = f(reflected);

        if (fxReflected < fxs[best]) {
            // Expansion
            const expanded = new Array(N);
            for (let k = 0; k < N; k++) expanded[k] = centroid[k] + 2 * (reflected[k] - centroid[k]);
            const fxExpanded = f(expanded);
            if (fxExpanded < fxReflected) {
                simplex[worst] = expanded; fxs[worst] = fxExpanded;
            } else {
                simplex[worst] = reflected; fxs[worst] = fxReflected;
            }
        } else if (fxReflected < fxs[secondWorst]) {
            simplex[worst] = reflected; fxs[worst] = fxReflected;
        } else {
            // Contraction
            const useReflected = fxReflected < fxs[worst];
            const target = useReflected ? reflected : simplex[worst];
            const contracted = new Array(N);
            for (let k = 0; k < N; k++) contracted[k] = centroid[k] + 0.5 * (target[k] - centroid[k]);
            const fxContracted = f(contracted);
            if (fxContracted < (useReflected ? fxReflected : fxs[worst])) {
                simplex[worst] = contracted; fxs[worst] = fxContracted;
            } else {
                // Shrink toward best
                for (let i = 0; i <= N; i++) {
                    if (i === best) continue;
                    for (let k = 0; k < N; k++) {
                        simplex[i][k] = simplex[best][k] + 0.5 * (simplex[i][k] - simplex[best][k]);
                    }
                    fxs[i] = f(simplex[i]);
                }
            }
        }

        iter++;
        options.onIter?.(iter, fxs[best], simplex[best]);
    }

    const finalOrder = sortIndices();
    const bestIdx = finalOrder[0];
    return {
        x: simplex[bestIdx],
        fx: fxs[bestIdx],
        iterations: iter,
        converged,
    };
};
