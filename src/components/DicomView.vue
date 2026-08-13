<script setup lang="ts">

//5/21 今後付け加える機能
// backup用の別URL
// ここまでを常田先生の講義(6/27)に間に合わせたい
//
// fusion
// シリーズ切り替えコンボボックス
// 学生用にpixel mappingやマウス下のCT値を表示するシステム
// DicomView.vueが肥大化しているので他ファイルに分散
// Nrrdも
// 1つでもエラーの出るファイルがあると開けない
// 上下さかさま　spinal tumor
// できれば位置合わせ　ブラウザ上で果たして出来るか
// 断面指示線
// ROIツール
//
// MIP/surfaceMIP -> done
// Niftiの読み込み -> done
// rainbowCLUTが遅い -> done
// phantomボタン -> done
// pagingボタン、シリーズ切り替えボタン -> done
// 2Dの表示、右上に -> done
// スライス←→ボタンがsyncに対応していない -> done
// 画像をクローズするボタン -> done
// 画像をもっと大きくしたいので、サイドバーを隠したり画像サイズをレスポンシブに -> done
//
// PNGを読み込めるように→ボツ

import { ref, watch, onUnmounted } from "vue";
import { DataSet, parseDicom } from "dicom-parser";
import sidebar from "./Sidebar.vue";
import imagebox from "./ImageBox.vue";
import { ImageBoxInfoBase, DicomSliceImageBoxInfo, VolumeImageBoxInfo, defaultInfo, pushVolume, FusedVolumeImageBoxInfo, makeMipState } from "./DicomImageBoxInfo";
import { getAllFilesRecursive } from "./DragAndDropUtil";
import { generateVolumeFromDicom } from './dicom2volume.ts';
import { readDicomPixels, readDicomPixelsAsInt16, autoWindowFromPixels } from './dicomPixels.ts';
import * as DecompressJpegLossless from "./decompressJpegLossless";
import { getSeriesTransferSyntaxInfo } from "./transferSyntax";
import { isPrimaryForFusion, isRgbSeries } from "./seriesClassify";
import { surfaceThresholdFor } from "./surfaceThreshold";
import { guessModalityFromVoxels } from "./modalityGuess";
import { loadPriorityRules, scoreSeries } from "./seriesPriorityRules";
import { buildClutLegend, type ClutLegend } from "./clutLegend";
import { ensureWasmCodecsReady, isWasmCodecsReady } from "./wasmCodec";
import { Volume, voxelToWorld, worldToVoxel, volumeCenterWorld } from "./Volume.ts";
import { writeNiftiFloat32, buildVolumeSidecarJson } from "./niftiVolumeWriter";
import { triggerDownload } from "./segmentation/niftiWriter";
import { solve } from "./linalg";
import * as THREE from '@/lib/threeMath';
// 手動 alignment はドラッグ中に毎フレーム呼ぶので静的 import (小さく、重い依存も無い)。
// registerMrPt / mi は重いので従来どおり動的 import のまま。
import * as regTf from './registration/transform';
import {cluts, labelClut} from './Clut.ts';
import * as nifti from 'nifti-reader-js';
import { gunzip as fflateGunzip } from 'fflate';

// gunzip 進捗の表示用 reactive state (App.vue から defineExpose 経由で参照)。
// 並列 gunzip でもまず最も新しいファイル名を表示する単一 chip 想定。
const niftiGunzipInProgress = ref(false);
const niftiGunzipName = ref<string>('');
const niftiGunzipBytes = ref(0);

// gzip 解凍を Promise 化。優先度: native DecompressionStream → fflate (worker) フォールバック。
//
// DecompressionStream (Chrome 80+ / FF 113+ / Safari 16.4+):
//   - browser 内蔵、追加 dep なし、native コードで高速
//   - 進捗は ReadableStream の TransformStream で chunk 経過バイト数を tap
//   - メインスレッド非ブロック (内部で background thread)
//
// fflate fallback (古い browser):
//   - inline blob worker で gunzip。進捗 callback なし
const gunzipAsync = async (data: Uint8Array, filename?: string): Promise<Uint8Array> => {
    if (typeof DecompressionStream !== 'undefined') {
        try {
            niftiGunzipInProgress.value = true;
            niftiGunzipName.value = filename ?? '';
            niftiGunzipBytes.value = 0;
            // Blob → ReadableStream → DecompressionStream → progress tap → arrayBuffer。
            const blob = new Blob([data]);
            let bytes = 0;
            const tap = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    bytes += chunk.byteLength;
                    // Vue reactivity の trigger 頻度を抑える (chunk あたりではなく ~5MB 毎に更新)
                    if (bytes - niftiGunzipBytes.value > 5 * 1024 * 1024) {
                        niftiGunzipBytes.value = bytes;
                    }
                    controller.enqueue(chunk);
                },
            });
            const decompressed = blob.stream()
                .pipeThrough(new DecompressionStream('gzip'))
                .pipeThrough(tap);
            const buf = await new Response(decompressed).arrayBuffer();
            niftiGunzipBytes.value = bytes;
            niftiGunzipInProgress.value = false;
            return new Uint8Array(buf);
        } catch (err) {
            niftiGunzipInProgress.value = false;
            console.warn('[loadNii] DecompressionStream failed, falling back to fflate:', err);
        }
    }
    // fflate fallback (no progress callback)
    return new Promise((resolve, reject) => {
        fflateGunzip(data, (err, out) => err ? reject(err) : resolve(out));
    });
};
import * as Phantom from './phantom.ts';
import { scrambleZSlices, recoverZOrder, scrambleAccuracy } from './experiments/sliceScramble';
import { evictVolumeTexture } from './webgpu/volumeCache';
import { useSegmentationStore } from '../stores/segmentation';
import { usePerfStore } from '../stores/perf';
import { isWebGpuAvailable, getGpuDeviceSync } from './webgpu/gpuContext';
import { updateMaskTextureSlice } from './webgpu/maskCache';
import { sphereStatsInPet, fillPolygonOnSlice, findMaximumAxis as maxAxis } from './segmentation/maskOps';
import { TRACER_PRESETS, tracerById, detectTracer, type TracerPreset } from './tracerPresets';
import { buildOpacityLut, DEFAULT_TF, TF_PRESETS } from './vrTf';
import { VrDemo } from './vrDemo';
import { type SerializedViewState, type SerializedBoxState } from './viewStateUrl';
import SegmentationPanel from './SegmentationPanel.vue';
import DebugInspector from './DebugInspector.vue';
import { computed, onMounted, nextTick, provide } from 'vue';
import { useAutoSave } from '../composables/useAutoSave';
import { useDebugInspector } from '../composables/useDebugInspector';
import { useSnapshotIo, type RectRoiJson } from '../composables/useSnapshotIo';
import { loadSession, deleteSession, type SessionPayload } from '../stores/persistence';

const segStore = useSegmentationStore();
// voxel brush の即時 GPU 反映 (updateMaskTextureSlice) で gpuAllowed を参照するため保持。
const perfStore = usePerfStore();


const closingImages = defineModel<boolean>("closingImages");
const drawer = defineModel<boolean>("drawer");
const inspector = defineModel<boolean>("inspector");
const leftButtonFunction = defineModel<LeftButtonFunction>("leftButtonFunction");

const imageBoxW = defineModel<number>("imageBoxW");
const imageBoxH = defineModel<number>("imageBoxH");
const tileN = defineModel<number>("tileN");
const syncImageBox = defineModel<boolean>("syncImageBox");
// 4 隅 patient/exam info overlay のグローバルトグル
const showOverlayInfo = defineModel<boolean>("showOverlayInfo", { default: true });
// 「全体化」(タイル間の隙間を 0 にして画像エリアを最大化) トグル。
// autoFitMode と直交し、autoFit 計算時に gap/safety を 0 に切り替える。
// default true: image area を常に N tile で埋め切る (gap=0)
const noGapMode = defineModel<boolean>("noGapMode", { default: true });

const setTimeOutInitAndShow = () => {
  setTimeout(() => {
    for (let a of imb.value!){
      a.init();
    }
    show();
  }, 10);
}

// box の表示サイズが変わったら、**画像の倍率もその比で追従させる**。
// これが無いと、タイトルバーの double-click で最大化しても canvas だけ大きくなり、
// 画像は元の大きさのまま真ん中に residual として残る (ユーザ報告)。
//
// 「再 fit」ではなく **比例スケール** にしてあるのは、ユーザが手で拡大していた場合に
// その拡大率を失わせないため。fit のままなら fit のまま、2 倍で見ていたなら 2 倍のまま追従する。
// 倍率は縦横で厳しい方 (min) を採り、収まっていたものが溢れないようにする。
// **比率は「表示領域」で採ること。** fit 計算 (showImage) が
//   fitH = (imageBoxH - TITLEBAR_PX) / rows
// と titlebar 分を引いているので、こちらが生の imageBoxH で比を採ると
// fit 状態の box が resize のたびに少しずつ fit からずれる (実測 1.14 倍)。
const TITLEBAR_PX = 22;
let lastBoxW: number | null = null;
let lastBoxH: number | null = null;

const scaleBoxContentsToNewSize = () => {
  const w = imageBoxW.value ?? 0;
  const h = Math.max(1, (imageBoxH.value ?? 0) - TITLEBAR_PX);
  if (w <= 0 || (imageBoxH.value ?? 0) <= 0) { lastBoxW = w; lastBoxH = h; return; }
  if (lastBoxW == null || lastBoxH == null || lastBoxW <= 0 || lastBoxH <= 0) {
    lastBoxW = w; lastBoxH = h; return;    // 初回は基準を覚えるだけ
  }
  const lastW = lastBoxW, lastH = lastBoxH;
  const r = Math.min(w / lastW, h / lastH);
  lastBoxW = w; lastBoxH = h;
  if (!Number.isFinite(r) || r <= 0 || Math.abs(r - 1) < 1e-6) return;
  for (let i = 0; i < imageBoxInfos.value.length; i++) {
    const info = imageBoxInfos.value[i] as any;
    if (!info) continue;
    if (isDicomSliceImageBoxInfo(i)) {
      // zoom = box px / 画像 px。まだ fit 前 (null) なら触らない (次の描画で fit される)。
      if (info.zoom == null) continue;
      if (info.imgW && info.imgH) {
        // 画像サイズが分かっているなら **fit の変化率** で更新する。
        // 単純な min(幅比, 高さ比) だと縦横比が変わる resize で fit から外れる
        // (16 分割 → 最大化で box は横 4.0 倍・縦 5.1 倍 → 画像は 4.0 倍しか伸びず
        //  埋まりきらない)。fit 比なら「fit のままは fit のまま、2 倍で見ていたら 2 倍のまま」。
        const fitOld = Math.min(lastW / info.imgW, lastH / info.imgH);
        const fitNew = Math.min(w / info.imgW, h / info.imgH);
        if (fitOld > 0 && fitNew > 0) info.zoom *= (fitNew / fitOld);
        else info.zoom *= r;
      } else {
        info.zoom *= r;
      }
    } else if (isAnyVolumeBox(i)) {
      // vecx/vecy は「1 画面 px あたりの world mm」なので、box が大きくなるほど小さくする
      if (info.vecx) info.vecx.multiplyScalar(1 / r);
      if (info.vecy) info.vecy.multiplyScalar(1 / r);
    }
  }
  boxStateVersion.value++;
};

const imageBoxSizeChanged = () => {
  scaleBoxContentsToNewSize();
  setTimeOutInitAndShow();
}

// **W と H はまとめて 1 回で監視する。** 個別 watch にすると、両方同時に変わったとき
// 「W だけ新・H は旧」の中間状態で先に呼ばれ、min(newW/oldW, 1)=1 となって倍率追従が
// 打ち消される (100×100 → 200×200 で何も起きない)。配列 watch なら 1 tick 1 回。
watch([imageBoxW, imageBoxH], imageBoxSizeChanged);
watch(closingImages, () => {
  if (closingImages.value){
    initializeDicomListsImagesBoxInfos();
    closingImages.value = false;
    setTimeOutInitAndShow();
  }
});

interface MyDicom extends DataSet {
  decompressed: ArrayBuffer;
}
interface Nii {
  niftiHeader: nifti.NIFTI1,
  pixelData: Float32Array,
  filename?: string,    // 元ファイル名 (拡張子込み) — modality 推定に使用
  datatypeName?: string, // 元の datatype label (例 'Float32', 'Uint16')、card 表示用
}

type OtherFile = Uint8Array;

let bagOfFiles: (MyDicom | Nii | OtherFile)[];

const selectedImageBoxId = ref(0);
const isLoading = ref(false);
const isEnter = ref(false);

const imb = ref<InstanceType<typeof imagebox>[]>();

interface SeriesList { // 複数のDICOMファイル、もしくはVolumeデータ、もしくは両方（同一画像）、、ということはnx,ny,nzを共有するという案もあるが・・
  myDicom: MyDicom[] | null,
  volume: Volume | null,
}
let seriesList: SeriesList[];

// Volume cardリスト用の reactive サマリ（doSort 後に rebuildSeriesSummaries で更新）
export interface SeriesSummary {
  index: number;
  description: string;
  modality: string;
  matrixSize: string;       // "rows x cols x slices"
  voxelSize: string;        // "dx x dy x dz mm"
  fileCount: number;
  hasVolume: boolean;
  thumbnail: string | null; // dataURL
  seriesUID: string;        // for active-for-segmentation matching
  // 圧縮対応状況 (★1)
  transferSyntaxName: string;
  transferSyntaxSupported: boolean;
  transferSyntaxReason?: string;
  // PT 識別用フィールド (★3)
  acquisitionTime?: string;     // "08:34"
  studyDate?: string;           // "2026-04-15"
  studyUID?: string;
  attenuationCorrected?: boolean; // true/false (PT only) / undefined for non-PT
  // PET-CT fusion 解析に使えるか (false なら Sidebar の Other セクションに分類)
  isPrimary: boolean;
  isRgb: boolean;     // RGB / カラー画像 (thumbnail 生成・表示の警告用)
  sourceType: 'DICOM' | 'NIFTI';  // 読み込み元ファイル種別 (Sidebar カードに表示)
  datatypeName?: string;          // 元データの voxel datatype label (例 'Int16', 'Uint16', 'Float32')
}
const seriesSummaries = ref<SeriesSummary[]>([]);

// ===== デバッグ機能 =====
// Voxel inspector (旧 debugMode) — App-bar からも toggle 可能なよう defineModel で公開
const debugMode = defineModel<boolean>('debugMode', { default: false });
// Voxel inspector 本体 (hover 情報収集 / マスク層読み取り / shift+click 編集) は
// useDebugInspector composable に分離。ref 群と関数はこの下の方 (deps 定義後) で
// 生成し、debugShow など再エクスポートする。

// 「画像が画面にちょうど収まる」モード。autoFitMode=true のとき
// drawer 開閉やウィンドウリサイズで imageBoxW/H を再計算する。
// default true: tileN / drawer / window resize に追従して image area を埋める
const autoFitMode = ref(true);
// image area の実サイズ変化を監視して autoFit を再実行する observer (onMounted で生成)。
let imageAreaResizeObserver: ResizeObserver | null = null;
onUnmounted(() => { imageAreaResizeObserver?.disconnect(); imageAreaResizeObserver = null; });

const applyAutoFit = () => {
  if (!autoFitMode.value) return;
  if ((tileN.value ?? 0) <= 0) return;     // box が無いときは fit 計算しない
  const { w, h } = fitBoxSizeForCurrentTile();
  imageBoxW.value = w;
  imageBoxH.value = h;
};

// URL params:
//   ?debug=1       voxel inspector を初期有効化
//   ?dev=case001   sample-data/case001 を自動 fetch + loadFiles (dev middleware 経由、ローカル開発限定)
//   ?url=https://...  外部 URL から DICOM/NIfTI を fetch + loadFiles
//                     複数指定: ?url=u1&url=u2 もしくは ?url=u1,u2 (カンマ区切り)
//                     CORS 必須: ホスト側で Access-Control-Allow-Origin を返すこと
// Ctrl+Shift+D で voxel inspector を toggle
onMounted(() => {
  // Parity test 用 window globals: Playwright や DevTools console から叩ける。
  // - isReady(): 全ボックスが描画準備完了か
  // - setMode(m): renderer mode を強制 + 全 box redraw
  // - getBoxes(): 各 box の canvas (HTMLCanvasElement) と種別
  // - waitForIdle(ms): 全ての非同期 draw が落ち着くまで待つ
  // - parityCheck(): cpu / gpu を順に切り替えてピクセル diff を計測 → 結果オブジェクトを返す
  (window as any).__metavolTest = {
    isReady: () => imb.value != null && imb.value.length > 0 && imageBoxInfos.value.length > 0,
    setMode: (m: 'auto' | 'cpu' | 'gpu') => {
      usePerfStore().setMode(m);
      show();
    },
    getBoxes: () => {
      const out: Array<{ id: number; rendering: string; fused: boolean; plane: string; canvas: HTMLCanvasElement | null }> = [];
      if (!imb.value) return out;
      // imb.value[i].cv1 は Vue の auto-unwrap で canvas 要素 (HTMLCanvasElement) が直接得られる。
      // ただし fallback として DOM から `.drop_area canvas` を直接拾う経路も持つ。
      const domCanvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.drop_area canvas'));
      for (let i = 0; i < imb.value.length; i++) {
        const box = imb.value[i] as any;
        let canvas: HTMLCanvasElement | null = null;
        const cv1 = box?.cv1;
        if (cv1) {
          canvas = (cv1.value ?? cv1) as HTMLCanvasElement;
          if (!(canvas instanceof HTMLCanvasElement)) canvas = null;
        }
        if (!canvas && domCanvases[i]) canvas = domCanvases[i];
        out.push({
          id: i,
          rendering: getBoxRendering(i),
          fused: isBoxFused(i),
          plane: getBoxCurrentPlane(i) ?? '?',
          canvas,
        });
      }
      return out;
    },
    waitForIdle: (ms: number = 800) => new Promise(r => setTimeout(r, ms)),
    perfStats: () => {
      const ps = usePerfStore();
      const out: Record<string, any> = { mode: ps.rendererMode, samples: {} };
      for (const [k, v] of Object.entries(ps.samples)) {
        const cpus = (v as any).cpu.map((s: any) => s.ms);
        const gpus = (v as any).gpu.map((s: any) => s.ms);
        const med = (a: number[]) => {
          if (a.length === 0) return null;
          const s = [...a].sort((x, y) => x - y);
          return s[Math.floor(s.length / 2)];
        };
        out.samples[k] = {
          cpuN: cpus.length, gpuN: gpus.length,
          cpuMed: med(cpus), gpuMed: med(gpus),
          cpuMin: cpus.length ? Math.min(...cpus) : null,
          gpuMin: gpus.length ? Math.min(...gpus) : null,
        };
      }
      return out;
    },
    parityCheck: async (waitMs: number = 800) => {
      const helper = (window as any).__metavolTest;
      const t0 = performance.now();
      // 1) CPU 描画 → snapshot
      helper.setMode('cpu');
      await helper.waitForIdle(waitMs);
      const cpuShots: Array<{ id: number; kind: string; plane: string; w: number; h: number; data: Uint8ClampedArray | null }> = [];
      for (const b of helper.getBoxes()) {
        if (b.canvas) {
          const ctx = b.canvas.getContext('2d');
          const img = ctx?.getImageData(0, 0, b.canvas.width, b.canvas.height);
          cpuShots.push({ id: b.id, kind: b.kind, plane: b.plane, w: b.canvas.width, h: b.canvas.height, data: img?.data ?? null });
        } else {
          cpuShots.push({ id: b.id, kind: b.kind, plane: b.plane, w: 0, h: 0, data: null });
        }
      }
      // 2) GPU 描画 → snapshot
      helper.setMode('gpu');
      await helper.waitForIdle(waitMs);
      const gpuShots: typeof cpuShots = [];
      for (const b of helper.getBoxes()) {
        if (b.canvas) {
          const ctx = b.canvas.getContext('2d');
          const img = ctx?.getImageData(0, 0, b.canvas.width, b.canvas.height);
          gpuShots.push({ id: b.id, kind: b.kind, plane: b.plane, w: b.canvas.width, h: b.canvas.height, data: img?.data ?? null });
        } else {
          gpuShots.push({ id: b.id, kind: b.kind, plane: b.plane, w: 0, h: 0, data: null });
        }
      }
      // 3) Diff 計算
      const results = [];
      for (let i = 0; i < cpuShots.length; i++) {
        const c = cpuShots[i];
        const g = gpuShots[i];
        if (!c.data || !g.data || c.w !== g.w || c.h !== g.h) {
          results.push({ id: c.id, kind: c.kind, plane: c.plane, w: c.w, h: c.h, status: 'no-data', maxDiff: -1, mismatchRatio: -1 });
          continue;
        }
        let maxDiff = 0;
        let mismatched = 0;
        const total = c.w * c.h;
        const cd = c.data, gd = g.data;
        for (let p = 0; p < total; p++) {
          const off = p * 4;
          const d0 = Math.abs(cd[off] - gd[off]);
          const d1 = Math.abs(cd[off + 1] - gd[off + 1]);
          const d2 = Math.abs(cd[off + 2] - gd[off + 2]);
          const m = Math.max(d0, d1, d2);
          if (m > maxDiff) maxDiff = m;
          if (m > 4) mismatched++;
        }
        results.push({
          id: c.id, kind: c.kind, plane: c.plane, w: c.w, h: c.h,
          status: 'ok', maxDiff, mismatchRatio: mismatched / total,
        });
      }
      // 元の mode に戻す (Auto)
      helper.setMode('auto');
      return { elapsedMs: performance.now() - t0, boxes: results };
    },
  };
  console.log('[parity] window.__metavolTest exposed');

  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('debug') === '1') debugMode.value = true;
    const devCase = p.get('dev');
    if (devCase) loadDevCase(devCase);
    // ?demo=<id>: production-build にも入る公開デモデータ (public/demo/<id>/manifest.json)
    const demoCase = p.get('demo');
    if (demoCase) loadDemoCase(demoCase);
    // ?test=parity: multiplebonemets を auto load + PET Standard layout を組む
    if (p.get('test') === 'parity') {
      // ロード→自動レイアウトが終わってから PET Standard を強制起動。
      // loadFiles 内 isLoading=false のタイミングを watch、その後 setupPetStandardView。
      const stopWatch = watch(isLoading, async (v) => {
        if (v === false) {
          stopWatch();
          await nextTick();
          const list = seriesSummaries.value;
          const hasPt = list.some(s => s.modality === 'PT' || s.modality === 'PET');
          const hasCt = list.some(s => s.modality === 'CT');
          if (hasPt && hasCt) {
            tileN.value = 4;
            await nextTick();
            await setupPetStandardView();
            console.log('[parity] PET Standard setup complete');
          } else {
            console.warn('[parity] PT or CT missing — cannot setup PET Standard');
          }
        }
      });
      loadDevCase('multiplebonemets');
    }
    // 外部 URL ロード (公開デモ / リンク共有用)
    const urlParams = p.getAll('url');
    if (urlParams.length > 0) {
      const all: string[] = [];
      for (const u of urlParams) {
        for (const x of u.split(',')) {
          const t = x.trim();
          if (t) all.push(t);
        }
      }
      if (all.length > 0) loadFromExternalUrls(all);
    }
  } catch {}
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')){
      e.preventDefault();
      debugMode.value = !debugMode.value;
      if (!debugMode.value) debugShow.value = false;
      console.log('[debug] mode =', debugMode.value);
    }
  });
  window.addEventListener('resize', applyAutoFit);
  // Sidebar / Inspector の開閉には CSS transition があるため、drawer フラグ変化直後に
  // applyAutoFit しても .mv-imagearea の実寸はまだ古い → box サイズが最適化されない。
  // ResizeObserver で image area の実サイズ変化 (アニメ完了後を含む) を監視し、
  // autoFitMode 有効時のみ rAF debounce で再フィットする。window resize もこれで拾える。
  const ia = document.querySelector('.mv-imagearea');
  if (ia && typeof ResizeObserver !== 'undefined') {
    // debounce は setTimeout で行う。**requestAnimationFrame は使わない**:
    // タブ/ペインが非表示のとき rAF は 1 度も発火しない (実測: hidden 状態で 1.5 秒間 0 回)。
    // rAF に頼ると、非表示中のリサイズが永久に反映されないままになる。
    let pending: any = null;
    imageAreaResizeObserver = new ResizeObserver(() => {
      if (!autoFitMode.value) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; applyAutoFit(); }, 16);
    });
    imageAreaResizeObserver.observe(ia);
  }
  // 矩形 ROI ドラッグが box の外で離されても確定できるよう、window でも mouseup を拾う。
  window.addEventListener('mouseup', () => {
    if (rectRoiDraft.value) rectRoiMouseUp();
    if (brushStroke.value) brushMouseUp();
  });
});

// Vite dev middleware (vite.config.mts の devSampleDataPlugin) 経由で
// sample-data/<caseId>/ 配下を fetch、loadFiles に流し込む。
// 完了後に PET Standard layout を自動セットアップする。
const loadDevCase = async (caseId: string) => {
  try {
    const listRes = await fetch(`/api/cases/${encodeURIComponent(caseId)}/files`);
    if (!listRes.ok) {
      console.warn(`[dev-case] case "${caseId}" not found (HTTP ${listRes.status})`);
      return;
    }
    const fileNames: string[] = await listRes.json();
    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      console.warn(`[dev-case] case "${caseId}" has no files`);
      return;
    }
    console.log(`[dev-case] loading ${fileNames.length} files from "${caseId}"...`);
    const t0 = performance.now();
    const files: File[] = [];
    // 並列 fetch (10 並列まで)。File オブジェクトに変換して loadFiles へ。
    const concurrency = 10;
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < fileNames.length) {
        const my = idx++;
        const name = fileNames[my];
        // 大量ファイル (2000 超) では 200 のまま空ボディが返ることがあったので、
        // **0 バイトもエラー扱いにしてリトライ**する。取りこぼすとシリーズが欠落して
        // 「PT が見つからない」等の別問題に化けて分かりにくい。
        const url = `/samples/${encodeURIComponent(caseId)}/${name.split('/').map(encodeURIComponent).join('/')}`;
        let buf: ArrayBuffer | null = null;
        for (let attempt = 0; attempt < 3 && !buf; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 50 * attempt));
          try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const b = await r.arrayBuffer();
            if (b.byteLength > 0) buf = b;
          } catch { /* retry */ }
        }
        if (!buf) { console.warn(`[dev-case] fetch failed (empty after retries): ${name}`); continue; }
        files[my] = new File([buf], name.split('/').pop() ?? name, { type: 'application/octet-stream' });
      }
    });
    await Promise.all(workers);
    const t1 = performance.now();
    console.log(`[dev-case] fetched ${files.length} files in ${(t1 - t0).toFixed(0)}ms`);
    loadFiles(files.filter(Boolean));
  } catch (err) {
    console.warn('[dev-case] failed', err);
  }
};

// ?demo=<id>: production build にも入る公開デモデータ。
//   public/demo/<id>/manifest.json   → { "files": ["ct.nii.gz", "pet.nii.gz"], "description": "..." }
//   public/demo/<id>/<file>          → 実体
// dev-case と違い vite middleware を通さず static 配信なので GitHub Pages でも動く。
// base path は import.meta.env.BASE_URL を使う (vite.config.mts の base= '/metavol-web-beta2/')。
const loadDemoCase = async (caseId: string) => {
  try {
    const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
    const manifestUrl = `${base}/demo/${encodeURIComponent(caseId)}/manifest.json`;
    const mf = await fetch(manifestUrl);
    if (!mf.ok) {
      console.warn(`[demo] manifest not found: ${manifestUrl} (HTTP ${mf.status})`);
      alert(`Demo case "${caseId}" not found. Place public/demo/${caseId}/manifest.json + files.`);
      return;
    }
    const manifest = await mf.json() as { files: string[]; description?: string };
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      console.warn(`[demo] manifest has no files`);
      return;
    }
    console.log(`[demo] loading ${manifest.files.length} files for "${caseId}"...`);
    const t0 = performance.now();
    const files: File[] = [];
    const concurrency = Math.min(4, manifest.files.length);
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < manifest.files.length) {
        const my = idx++;
        const name = manifest.files[my];
        const r = await fetch(`${base}/demo/${encodeURIComponent(caseId)}/${name.split('/').map(encodeURIComponent).join('/')}`);
        if (!r.ok) { console.warn(`[demo] fetch failed: ${name}`); continue; }
        const buf = await r.arrayBuffer();
        files[my] = new File([buf], name.split('/').pop() ?? name, { type: 'application/octet-stream' });
      }
    });
    await Promise.all(workers);
    const t1 = performance.now();
    console.log(`[demo] fetched ${files.length} files in ${(t1 - t0).toFixed(0)}ms`);
    loadFiles(files.filter(Boolean));
  } catch (err) {
    console.warn('[demo] failed', err);
  }
};

// 外部 URL (?url=https://...) から fetch + loadFiles。Persona 2 (quick viewer) 用 shareable link。
// CORS 必須。ホストが Access-Control-Allow-Origin を返さないと fetch 失敗する。
// 複数 URL を並列 fetch (concurrency=4)、すべて File 化してから一括 loadFiles。
const loadFromExternalUrls = async (urls: string[]) => {
  if (urls.length === 0) return;
  console.log(`[ext-url] loading ${urls.length} file(s)...`);
  const t0 = performance.now();
  const files: File[] = [];
  const concurrency = Math.min(4, urls.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < urls.length) {
      const my = idx++;
      const u = urls[my];
      try {
        const r = await fetch(u);
        if (!r.ok) {
          console.warn(`[ext-url] fetch failed (HTTP ${r.status}): ${u}`);
          continue;
        }
        const buf = await r.arrayBuffer();
        // basename を URL の最終 segment から取得 (NIfTI の filename modality 推定に使う)
        const baseName = u.split(/[?#]/)[0].split('/').pop() || `remote-${my}`;
        files[my] = new File([buf], baseName, { type: 'application/octet-stream' });
      } catch (err) {
        console.warn(`[ext-url] fetch error for ${u}:`, err);
      }
    }
  });
  await Promise.all(workers);
  const t1 = performance.now();
  const ok = files.filter(Boolean);
  console.log(`[ext-url] fetched ${ok.length}/${urls.length} files in ${(t1 - t0).toFixed(0)}ms`);
  if (ok.length === 0) {
    alert(`Failed to fetch any of the ${urls.length} URL(s). Check the browser console for details (CORS / network).`);
    return;
  }
  loadFiles(ok);
};

// ===== 自動保存 + リカバリ (IndexedDB persistence) =====
useAutoSave();   // composable: maskVersion 等を watch して debounce 保存

const recoveryCandidate = ref<SessionPayload | null>(null);
const showRecoveryDialog = ref(false);
const lastCheckedRecoveryUid = ref<string | null>(null);

// PT volume が変わったときにやるのは **tracer の自動判定だけ**。
//
// リカバリのダイアログはここでは出さない。PT volume ref は「CT に PET を d&d で重ねた」
// だけでも張り替わるので、単に見比べたいユーザにまで「前回の測定を復元しますか」を
// 突きつけることになる (ユーザ報告: 過剰)。復元が意味を持つのは MTV 測定に入るときだけなので、
// ダイアログは checkRecoveryForCurrentPet() を MTV measurement の入口から明示的に呼ぶ。
watch(() => segStore.petVolumeRef?.metadata?.seriesUID ?? null, (uid) => {
  if (!uid) return;
  // Auto-detect tracer from SeriesDescription / StudyDescription.
  // user が tracer を明示選択していない (activeTracerId null) ときだけ走る。
  // Recovery dialog で user が Recover を選ぶと labels/threshold は上書きされるので、
  // ここでの先行適用は副作用にならない。
  if (segStore.activeTracerId == null) {
    const md = segStore.petVolumeRef?.metadata;
    const sd = md?.seriesDescription;
    const detected = detectTracer(sd);
    if (detected) {
      console.log(`[tracer] auto-detected "${detected.name}" from "${sd}"`);
      applyTracerPreset(detected);
    }
  }

});

// MTV 測定に入るときだけ「前回の続きを復元しますか」を尋ねる。
// 同じ PT について一度尋ねたら再度は訊かない (lastCheckedRecoveryUid)。
const checkRecoveryForCurrentPet = async () => {
  const uid = segStore.petVolumeRef?.metadata?.seriesUID ?? null;
  if (!uid || uid === lastCheckedRecoveryUid.value) return;
  lastCheckedRecoveryUid.value = uid;
  try {
    const session = await loadSession(uid);
    if (!session) return;
    // 直前 (10 秒以内) に自動保存されたばかりのものは出さない (現セッション継続)
    if (segStore.lastAutoSavedAt && session.savedAt <= segStore.lastAutoSavedAt + 10000) return;
    recoveryCandidate.value = session;
    showRecoveryDialog.value = true;
  } catch (err) {
    console.warn('[auto-save] loadSession failed', err);
  }
};

const formatRelativeTime = (ts: number): string => {
  const dt = Math.max(0, Date.now() - ts);
  const sec = Math.floor(dt / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  return `${day} d ago`;
};

const onRecoverYes = () => {
  if (!recoveryCandidate.value) return;
  const res = segStore.restoreFromPersistence(recoveryCandidate.value);
  if (!res.ok) {
    alert('Could not recover the session: ' + res.reason);
  } else {
    // restoreFromPersistence は registration を store に写すだけ (volume を持たないため)。
    // 実際の幾何に掛け直すのはここ。
    applyStoredRegistrations();
    show();
  }
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};
const onRecoverDiscard = async () => {
  if (recoveryCandidate.value) {
    try { await deleteSession(recoveryCandidate.value.seriesUID); } catch {}
  }
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};
const onRecoverSkip = () => {
  // 削除も復元もしない (次回ロード時にまた聞かれる)
  recoveryCandidate.value = null;
  showRecoveryDialog.value = false;
};

// drawer / inspector / tileN の変化に追従して fit。
//
// **即時 applyAutoFit だけでは足りない**: drawer 開閉には CSS transition があり、
// フラグが変わった直後の .mv-imagearea はまだ変化前の幅を返す。そのため即時計算だと
// 常に「1 ステップ古い幅」で box サイズが決まり、サイドバーを開いたときに box が
// 広すぎて画像エリアから溢れ、右サイドバーに潜り込む (PET/CT+MIP 3x2 で顕在化)。
// ResizeObserver で拾う設計だったが、この要素では発火しないことを実測で確認したため
// (v-main の padding 変化では RO が呼ばれない)、transition 完了後に再 fit する。
let autoFitTimer: any = null;
const scheduleAutoFit = () => {
  if (!autoFitMode.value) return;
  applyAutoFit();                       // 即時 (粗い。tileN 変化はこれで足りる)
  if (autoFitTimer) clearTimeout(autoFitTimer);
  autoFitTimer = setTimeout(() => {     // transition 完了後 (Vuetify drawer は ~0.2s)
    autoFitTimer = null;
    applyAutoFit();
  }, 280);
};
onUnmounted(() => { if (autoFitTimer) { clearTimeout(autoFitTimer); autoFitTimer = null; } });

watch([drawer, inspector, tileN], () => {
  scheduleAutoFit();
});

// 「全体化」モード切替時は autoFit を有効にして即時 fit を走らせる
// (OFF 化されても直前の box サイズはそのまま保持し、ユーザが手動で fit するまで動かない)。
watch(noGapMode, () => {
  autoFitMode.value = true;
  applyAutoFit();
});

// tileN 変更後は ImageBox 群が再構成されるため、init して再描画
watch(tileN, async () => {
  await nextTick();
  if (imb.value){
    for (const a of imb.value){ a.init(); }
  }
  show();
});


const imageBoxInfos = ref<ImageBoxInfoBase[]>([]);
const getDicomSliceImageBoxInfo = (index: number) => imageBoxInfos.value[index] as DicomSliceImageBoxInfo;
const getVolumeImageBoxInfo = (index: number) => imageBoxInfos.value[index] as VolumeImageBoxInfo;
// **必ず null 安全にすること。** これらは template から (crossRefLinesFor 等を通じて) 呼ばれる。
// imageBoxInfos に穴 (undefined) があると `in` が TypeError を投げ、
// **render 関数全体が毎回失敗して画面が更新されなくなる** (実測: レイアウト変更後も古い box が
// 表示され続け、boxStateVersion の bump も show() も効かない状態になった)。
// 穴は tileN を増やした直後や配列途中の未初期化で普通に起こりうる。
const boxInfoAt = (i: number): any | null => {
  const arr = imageBoxInfos.value;
  if (i == null || i < 0 || i >= arr.length) return null;
  return arr[i] ?? null;
};
// box 種別の判定は **その型だけが持つ固有フィールド** で行う。
//   DICOM box  : currentSliceNumber (生スライス表示。Volume/Fusion は持たない)
//   Volume 系  : centerInWorld      (3D 幾何。DicomSlice は持たない)
//   Fusion box : clut1              (overlay レイヤ)
//
// **clut を判定に使ってはいけない。** defaultInfo() (= DICOM box) も stray な `clut: 0` を
// 持つため、旧実装 (`"clut" in info && !("clut1" in info)`) は plain な DICOM box でも
// true を返していた。getBoxKind は先に DicomSlice を見るので表面化しなかったが、
// isAnyVolumeBox を直接呼ぶ箇所 (40 以上) は誤判定していた
// (「plain viewer なのに右 Inspector が開く」等の実害あり)。
const isDicomSliceImageBoxInfo = (i:number) => {
  const info = boxInfoAt(i);
  return !!info && ("currentSliceNumber" in info);
}
const isVolumeImageBoxInfo = (i:number) => {
  const info = boxInfoAt(i);
  return !!info && ("centerInWorld" in info) && !("clut1" in info);
}
const isFusedImageBoxInfo = (i:number) => {
  const info = boxInfoAt(i);
  return !!info && ("centerInWorld" in info) && ("clut1" in info);
}
// Volume 系（単独 Volume または Fusion）の判定
const isAnyVolumeBox = (i:number) => isVolumeImageBoxInfo(i) || isFusedImageBoxInfo(i);

const getSelectedInfo = () => getVolumeImageBoxInfo(selectedImageBoxId.value);

// ---- Title bar 用 helpers ----
// ===== box の語彙: Rendering (描画方式) + fused (融合の有無) =====
//
// 放射線科の標準語に合わせた 1 軸 + 1 フラグ。用語定義は CLAUDE.md「ImageBox の用語」参照。
//   Rendering: native = 元スライスをそのまま表示 (再構成なし)
//              mpr    = 再構成して任意断面
//              mip    = 最大値投影 / smip = surface MIP / vr = ボリュームレンダリング
//   fused    : overlay 層を持つか (base + overlay の 2 層)。mpr/mip/smip/vr のどれとも組み合わさる。
//
// 以前は Kind(dicom|volume|fusion) × Mode(slice|mip|smip|vr) の 2 軸だったが、
// 「dicom なら必ず slice」という非直交な制約があり、かつ fusion が Kind と Mode の
// 両方の意味を持っていた。native/mpr は「描画方式の違い」なので 1 軸にまとめられる。
type BoxRendering = 'native' | 'mpr' | 'mip' | 'smip' | 'vr';

const getBoxRendering = (i: number): BoxRendering => {
  if (!isAnyVolumeBox(i)) return 'native';       // DICOM box = 元スライス表示
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (d.isVr) return 'vr';
  if (d.isMip) return d.mip?.isSurface ? 'smip' : 'mip';
  return 'mpr';
};

const isBoxFused = (i: number): boolean => isFusedImageBoxInfo(i);

// 断面を持たない描画か (= 投影系: mip / smip / vr)。
// paging・融合の受け先・cross-ref 線・crosshair が使えないのは、すべてこの条件。
const isProjectionRendering = (r: BoxRendering): boolean => r === 'mip' || r === 'smip' || r === 'vr';
// box info 版 (`isMip || isVr` が 12 箇所に散在していたのを 1 つの意味に集約)
const isProjectionInfo = (a: { isMip?: boolean; isVr?: boolean } | null | undefined): boolean =>
  !!a && (!!a.isMip || !!a.isVr);

const getBoxModalityLabel = (i: number): string => {
  // template から呼ばれるので **throw させない** (undefined な box があっても render を止めない)
  const infoAny = boxInfoAt(i);
  if (!infoAny) return '';
  const rendering = getBoxRendering(i);
  if (isBoxFused(i)) return 'Fused';
  if (rendering === 'mip') return 'MIP';
  if (rendering === 'native') {
    const info = infoAny as DicomSliceImageBoxInfo;
    const s = seriesList[info.currentSeriesNumber];
    if (s && s.myDicom && s.myDicom.length > 0) {
      const m = (s.myDicom[0].string('x00080060') ?? '').toUpperCase();
      if (m === 'PT' || m === 'PET') return 'PT';
      if (m === 'CT' || m === 'MR') return m;
    }
    return '2D';
  }
  // volume 系
  const v = seriesList[(infoAny as VolumeImageBoxInfo).currentSeriesNumber]?.volume;
  return (v?.metadata?.modality ?? 'VOL').toUpperCase();
};

const getBoxDescription = (i: number): string => {
  const info = imageBoxInfos.value[i];
  return info?.description ?? '';
};

// 現在の plane を box state から導出。Volume の vecx/vecy/vecz を見て
// determinePlaneDirection で軸面を判別、isMip / isVr を見て MIP/sMIP/VR を判別。
// 判定は centerInWorld ベースになったので defaultInfo (DICOM box) が volume 扱いされることは
// 無くなったが、vecx 等が未設定の途中状態はあり得るので defensive check は残す。
const getBoxCurrentPlane = (i: number): 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr' | null => {
  if (i < 0 || i >= imageBoxInfos.value.length) return null;
  if (!isAnyVolumeBox(i)) return null;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!d.vecx || !d.vecy || !d.vecz) return null;
  if (d.isVr) return 'vr';
  if (d.isMip) return d.mip?.isSurface ? 'smip' : 'mip';
  const dir = determinePlaneDirection(d);
  if (dir === 'axial')    return 'axi';
  if (dir === 'coronal')  return 'cor';
  if (dir === 'sagittal') return 'sag';
  return null;
};
const getBoxCurrentClut = (i: number): number | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).clut;
};

// suffix 判定: PT は表示単位 (SUV / Bq/ml)、CT は HU、それ以外は無印
// 第二引数 suvOk: false (NAC PT 等 SUV 換算不可) のときは強制 'Bq/ml'
const suffixForModality = (m: string, suvOk?: boolean): string => {
  const u = (m ?? '').toUpperCase();
  if (u === 'PT' || u === 'PET') {
    if (suvOk === false) return 'Bq/ml';  // NAC PT etc.
    return segStore.petDisplayUnit === 'BqMl' ? 'Bq/ml' : 'SUV';
  }
  if (u === 'CT') return 'HU';
  return '';
};

// PT 表示単位の換算係数: voxel を表示単位に変換するための multiplier。
// SUV mode: 1。Bq/ml mode: 1/suvFactor。
// NAC PT (suvOk === false): voxel は既に Bq/ml なので multiplier = 1。
const petDisplayMul = (volMod: string, suvFactor: number | null | undefined, suvOk?: boolean): number => {
  const m = (volMod ?? '').toUpperCase();
  if (m !== 'PT' && m !== 'PET') return 1;
  // NAC PT は voxel が Bq/ml (suvFactor=1 強制済み)。換算不要。
  if (suvOk === false) return 1;
  if (segStore.petDisplayUnit !== 'BqMl') return 1;
  if (!suvFactor || !isFinite(suvFactor) || suvFactor <= 0) return 1;
  return 1 / suvFactor;
};

// box id の primary series が PT のとき表示単位 multiplier を返す。
// Window/Level drag で「1 pixel = +1 display unit」を実現するため drag delta を 1/dmul 倍する。
const getBoxPetDisplayMul = (id: number): number => {
  if (id < 0 || id >= imageBoxInfos.value.length) return 1;
  const info = imageBoxInfos.value[id];
  const sIdx = info?.currentSeriesNumber;
  if (sIdx == null || sIdx < 0 || sIdx >= seriesList.length) return 1;
  const series = seriesList[sIdx];
  const mod = series?.volume?.metadata?.modality
    ?? (series?.myDicom?.[0]?.string('x00080060') ?? '');
  return petDisplayMul(mod, series?.volume?.metadata?.suvFactor, series?.volume?.metadata?.suvOk);
};

// 主レイヤ legend (DICOM Slice / Volume / Fusion / MIP)。
// DICOM Slice box: 常にグレー (clut=0)。WC/WW は info の値、無ければ DICOM tag (0028,1050/1051) から導出。
const getBoxLegend = (i: number): ClutLegend | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (isDicomSliceImageBoxInfo(i)) {
    const info = imageBoxInfos.value[i] as DicomSliceImageBoxInfo;
    const series = seriesList[info.currentSeriesNumber];
    const ds = series?.myDicom?.[info.currentSliceNumber];
    if (!ds) return undefined;
    const wc = info.myWC ?? Number(ds.string('x00281050', 0) ?? '0');
    const ww = info.myWW ?? Number(ds.string('x00281051', 0) ?? '1');
    if (!isFinite(wc) || !isFinite(ww) || ww <= 0) return undefined;
    const mod = (ds.string('x00080060') ?? '').toUpperCase();
    // DICOM 2D box: volume 未生成段階では DICOM タグ (0028,0051) Corrected Image から
    // 直接 NAC 判定 (PT で ATTN を含まない → suvOk=false)
    let suvOk = series?.volume?.metadata?.suvOk;
    if (suvOk === undefined && (mod === 'PT' || mod === 'PET')) {
      const corrected = (ds.string('x00280051') ?? '').toUpperCase();
      if (!corrected.includes('ATTN')) suvOk = false;
    }
    const mul = petDisplayMul(mod, series?.volume?.metadata?.suvFactor, suvOk);
    return buildClutLegend(0, wc * mul, ww * mul, suffixForModality(mod, suvOk));
  }
  if (!isAnyVolumeBox(i)) return undefined;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (info.myWC == null || info.myWW == null) return undefined;
  // Fusion box の場合: legend (主レイヤ) は CT (PT が base のときもあり得る)
  if (isFusedImageBoxInfo(i)) {
    const f = info as FusedVolumeImageBoxInfo;
    const baseSeries = seriesList[f.currentSeriesNumber];
    const baseMod = baseSeries?.volume?.metadata?.modality
      ?? (baseSeries?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
    const baseSuvOk = baseSeries?.volume?.metadata?.suvOk;
    const baseMul = petDisplayMul(baseMod, baseSeries?.volume?.metadata?.suvFactor, baseSuvOk);
    return buildClutLegend(f.clut, f.myWC! * baseMul, f.myWW! * baseMul, suffixForModality(baseMod, baseSuvOk));
  }
  // Volume / MIP box
  const series = seriesList[info.currentSeriesNumber];
  const mod = series?.volume?.metadata?.modality
    ?? (series?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
  const suvOk = series?.volume?.metadata?.suvOk;
  const mul = petDisplayMul(mod, series?.volume?.metadata?.suvFactor, suvOk);
  return buildClutLegend(info.clut, info.myWC! * mul, info.myWW! * mul, suffixForModality(mod, suvOk));
};

// Crosshair の screen 投影 (Volume / Fusion box のみ意味あり)
const getBoxCrosshairX = (i: number): number | null => {
  void segStore.crosshairVersion;     // reactive 依存
  const w = segStore.crosshairWorld;
  if (!w) return null;
  const s = worldToScreen(i, w);
  return s ? s.sx : null;
};
const getBoxCrosshairY = (i: number): number | null => {
  void segStore.crosshairVersion;
  const w = segStore.crosshairWorld;
  if (!w) return null;
  const s = worldToScreen(i, w);
  return s ? s.sy : null;
};

// 4 隅 patient/exam info overlay の各 box 用ヘルパ。
// グローバルトグル (showOverlayInfo) が OFF なら undefined。
// 情報は currentSeriesNumber の先頭 DICOM (患者/検査) + 各 box タイプ別 slice 情報から構築。
interface CornerInfo {
  tl?: string[]; tr?: string[]; bl?: string[]; br?: string[];
}
const formatDicomDate = (s: string | null | undefined): string => {
  if (!s || s.length < 8) return s ?? '';
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
};
const planeLabel = (p: 'axi'|'cor'|'sag'|'mip'|'smip'|'vr'|null): string => {
  switch (p) {
    case 'axi': return 'Axial';
    case 'cor': return 'Coronal';
    case 'sag': return 'Sagittal';
    case 'mip': return 'MIP';
    case 'smip': return 'sMIP';
    case 'vr': return 'VR';
    default: return '';
  }
};
const cornerInfoFor = (i: number): CornerInfo | undefined => {
  // boxStateVersion 依存で paging / load 完了時に再計算 (seriesList は非 reactive のため必須)
  void boxStateVersion.value;
  if (!showOverlayInfo.value) return undefined;
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  const info = imageBoxInfos.value[i];
  const j = info.currentSeriesNumber;
  if (j == null || j < 0 || j >= seriesList.length) return undefined;
  const series = seriesList[j];
  const firstDs = series?.myDicom?.[0];
  if (!firstDs) return undefined;   // NIfTI のみ等は当面 corner info 非対応

  const patientName = (firstDs.string('x00100010') ?? '').replace(/\^/g, ' ').trim();
  const patientId   = firstDs.string('x00100020') ?? '';
  const studyDate   = formatDicomDate(firstDs.string('x00080020'));
  const modality    = (firstDs.string('x00080060') ?? '').toUpperCase();
  const seriesDesc  = firstDs.string('x0008103e') ?? '';

  const tl: string[] = [];
  if (patientName) tl.push(patientName);
  if (patientId)   tl.push(`ID: ${patientId}`);

  const tr: string[] = [];
  if (studyDate) tr.push(studyDate);
  if (modality)  tr.push(modality);

  const bl: string[] = [];
  if (seriesDesc) bl.push(seriesDesc);
  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    const total = series?.myDicom?.length ?? 0;
    if (total > 0) bl.push(`Image ${d.currentSliceNumber + 1}/${total}`);
  } else if (isAnyVolumeBox(i)) {
    const p = getBoxCurrentPlane(i);
    const lbl = planeLabel(p);
    if (lbl) bl.push(lbl);
  }

  const br: string[] = [];
  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    if (d.zoom != null && isFinite(d.zoom)) br.push(`Zoom: ${d.zoom.toFixed(2)}x`);
  }

  return { tl, tr, bl, br };
};

// 第二レイヤ legend (Fusion box の PET レイヤのみ。それ以外は undefined)
const getBoxLegend2 = (i: number): ClutLegend | undefined => {
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isFusedImageBoxInfo(i)) return undefined;
  const f = imageBoxInfos.value[i] as FusedVolumeImageBoxInfo;
  if (f.myWC1 == null || f.myWW1 == null) return undefined;
  const petSeries = seriesList[f.currentSeriesNumber1];
  const petMod = petSeries?.volume?.metadata?.modality
    ?? (petSeries?.myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
  const petSuvOk = petSeries?.volume?.metadata?.suvOk;
  const mul = petDisplayMul(petMod, petSeries?.volume?.metadata?.suvFactor, petSuvOk);
  return buildClutLegend(f.clut1, f.myWC1! * mul, f.myWW1! * mul, suffixForModality(petMod, petSuvOk));
};

// Cross-reference lines: box i 上に他の Volume/Fusion box の slice plane を直線投影。
// MIP / VR は flat slice plane を持たないので除外。
// box_j の plane equation: (P - c_j) · n_j = 0 (n_j = vecz_j)
// box_i の screen pixel (sx, sy) に対し world P = c_i + (sx-cx)*vx_i + (sy-cy)*vy_i
// 代入: A*(sx-cx) + B*(sy-cy) + C = 0  where
//   A = vx_i · n_j, B = vy_i · n_j, C = (c_i - c_j) · n_j
// この A*sx + B*sy = K (K = A*cx + B*cy - C) を canvas 端 (0,0)-(W,H) と clip して 2 点抽出。
const crossRefLinesFor = (i: number): Array<{ x1: number; y1: number; x2: number; y2: number }> | undefined => {
  void boxStateVersion.value;     // reactive 依存
  if (i < 0 || i >= imageBoxInfos.value.length) return undefined;
  if (!isAnyVolumeBox(i)) return undefined;
  const ai = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (isProjectionInfo(ai)) return undefined;
  if (!ai.vecx || !ai.vecy || !ai.centerInWorld) return undefined;

  const W = imageBoxW.value ?? 0;
  const H = imageBoxH.value ?? 0;
  if (W <= 0 || H <= 0) return undefined;
  const cx = W / 2;
  const cy = H / 2;
  const eps = 1e-9;
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  for (let j = 0; j < imageBoxInfos.value.length; j++){
    if (j === i) continue;
    if (!isAnyVolumeBox(j)) continue;
    const aj = imageBoxInfos.value[j] as VolumeImageBoxInfo;
    if (isProjectionInfo(aj)) continue;
    if (!aj.vecz || !aj.centerInWorld) continue;

    const nj = aj.vecz;
    const A = ai.vecx.x*nj.x + ai.vecx.y*nj.y + ai.vecx.z*nj.z;
    const B = ai.vecy.x*nj.x + ai.vecy.y*nj.y + ai.vecy.z*nj.z;
    const dxc = ai.centerInWorld.x - aj.centerInWorld.x;
    const dyc = ai.centerInWorld.y - aj.centerInWorld.y;
    const dzc = ai.centerInWorld.z - aj.centerInWorld.z;
    const C = dxc*nj.x + dyc*nj.y + dzc*nj.z;
    if (Math.abs(A) < eps && Math.abs(B) < eps) continue; // 平行 / 同一面
    const K = A*cx + B*cy - C;

    const pts: Array<[number, number]> = [];
    if (Math.abs(A) > eps){
      // top edge sy=0
      const sx0 = K / A;
      if (sx0 >= 0 && sx0 <= W) pts.push([sx0, 0]);
      // bottom edge sy=H
      const sxH = (K - B*H) / A;
      if (sxH >= 0 && sxH <= W) pts.push([sxH, H]);
    }
    if (Math.abs(B) > eps){
      // left edge sx=0
      const sy0 = K / B;
      if (sy0 >= 0 && sy0 <= H) pts.push([0, sy0]);
      // right edge sx=W
      const syW = (K - A*W) / B;
      if (syW >= 0 && syW <= H) pts.push([W, syW]);
    }
    if (pts.length < 2) continue;
    // 異なる端点 2 つを抽出 (corner で重複があるので最初と最後)
    lines.push({ x1: pts[0][0], y1: pts[0][1], x2: pts[pts.length-1][0], y2: pts[pts.length-1][1] });
  }

  return lines.length > 0 ? lines : undefined;
};

// per-box Sync opt-out
const boxSyncEnabled = ref<boolean[]>([true, true, true, true, true, true, true, true]);
const isBoxSyncEnabled = (i: number) => boxSyncEnabled.value[i] ?? true;

// per-box mask overlay opt-out (true = この Box ではマスク非表示)
const boxOverlayDisabled = ref<boolean[]>([false, false, false, false, false, false, false, false]);
const isBoxOverlayEnabled = (i: number) => !boxOverlayDisabled.value[i];

// MIP 高速モード: ホイールで角度を変えている間だけ fast=true で描画 (4x speedup)。
// 静止 (200ms) で full-res で再描画。box ごとに独立 timer を持つ。
const mipFastBoxes = new Set<number>();
const mipIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const triggerMipFast = (i: number) => {
  mipFastBoxes.add(i);
  const old = mipIdleTimers.get(i);
  if (old != null) clearTimeout(old);
  mipIdleTimers.set(i, setTimeout(() => {
    mipFastBoxes.delete(i);
    mipIdleTimers.delete(i);
    showImage(i);  // full-res で再描画
  }, 200));
};

// ---- Title bar emit ハンドラ ----
const onTitlebarClose = (i: number) => {
  // Box 自体を消す (旧仕様 = defaultInfo に戻して空 box を残す、を撤回)。
  // 残った box は applyAutoFit で自動的にレイアウトを再計算 → 残り box が拡大する。
  if (i < 0 || i >= imageBoxInfos.value.length) return;
  imageBoxInfos.value.splice(i, 1);
  if (boxOverlayDisabled.value.length > i) boxOverlayDisabled.value.splice(i, 1);
  if (boxSyncEnabled.value.length > i) boxSyncEnabled.value.splice(i, 1);
  // Set<number> 内の i 以降をデクリメント
  const newMipFast = new Set<number>();
  for (const k of mipFastBoxes) {
    if (k < i) newMipFast.add(k);
    else if (k > i) newMipFast.add(k - 1);
  }
  mipFastBoxes.clear();
  for (const k of newMipFast) mipFastBoxes.add(k);
  // tileN を 1 減らし autoFit で残り box を拡大。0 になったら空状態 (No image placeholder へ戻す)
  if ((tileN.value ?? 0) > 0) tileN.value = (tileN.value ?? 1) - 1;
  applyAutoFit();
  // selectedImageBoxId が範囲外になったらリセット
  if (selectedImageBoxId.value >= (tileN.value ?? 0)) selectedImageBoxId.value = -1;
};

// Box i を複製して新しい box として末尾に追加。
// THREE.Vector3 等の参照型は clone してインスタンス独立性を保つ。
// 複製後は別箇所のサイズ計算 (autoFit) を再計算するため tileN++ で reactive 更新。
const onTitlebarDuplicate = async (i: number) => {
  if (i < 0 || i >= imageBoxInfos.value.length) return;
  const src = imageBoxInfos.value[i];
  if (!src) return;

  // shallow copy + 参照型を clone して独立化
  const cloned: any = { ...src };
  if (isAnyVolumeBox(i)) {
    const v = src as VolumeImageBoxInfo;
    cloned.centerInWorld = v.centerInWorld?.clone();
    cloned.vecx = v.vecx?.clone();
    cloned.vecy = v.vecy?.clone();
    cloned.vecz = v.vecz?.clone();
    if (v.mip) cloned.mip = { ...v.mip };
  }
  // currentSliceNumber / currentSeriesNumber は値型なので shallow copy で OK

  // 現在の visible 末尾 (= tileN) に追加。imageBoxInfos は 8 つ pre-allocated されているので
  // tileN < 8 ならその位置を上書き、それ以上なら push で拡張。
  const newId = tileN.value ?? 1;
  if (newId >= imageBoxInfos.value.length) {
    imageBoxInfos.value.push(cloned);
  } else {
    imageBoxInfos.value[newId] = cloned;
  }
  while (boxOverlayDisabled.value.length <= newId) boxOverlayDisabled.value.push(false);
  while (boxSyncEnabled.value.length <= newId) boxSyncEnabled.value.push(true);
  tileN.value = newId + 1;

  // 新 box の ImageBox 子コンポーネントを init してから render
  await nextTick();
  if (imb.value && imb.value[newId]) imb.value[newId].init();
  showImage(newId);
};

// Volume box の Reset W/L で使う、modality と SUV スケールを尊重した既定窓。
// SUV 化された PT volume では DICOM タグの WC/WW (Bq/ml) はそのままだと真っ暗 / 飽和に
// なるため、suvFactor 倍してから採用する。CT/MR は voxel と同スケールなのでそのまま。
const defaultWcWwForVolume = (vol: { metadata?: { modality?: string; suvOk?: boolean; suvFactor?: number } } | null | undefined): { wc: number; ww: number } => {
  const mod = (vol?.metadata?.modality ?? '').toUpperCase();
  if (mod === 'PT' || mod === 'PET') return { wc: 3, ww: 6 };
  if (mod === 'CT') return { wc: 40, ww: 400 };
  if (mod === 'MR') return { wc: 500, ww: 1000 };
  return { wc: 0, ww: 1000 };
};

const onTitlebarResetView = (i: number) => {
  const info = imageBoxInfos.value[i];
  if (!info) return;

  if (isDicomSliceImageBoxInfo(i)) {
    const d = info as DicomSliceImageBoxInfo;
    d.myWC = null;
    d.myWW = null;
    d.centerX = 0;
    d.centerY = 0;
    d.zoom = null;
  } else if (isAnyVolumeBox(i)) {
    const d = info as VolumeImageBoxInfo;
    const vol = seriesList[d.currentSeriesNumber]?.volume;
    // Volume の WC/WW は modality に応じた既定値を入れる (null → 0 で真っ暗化を避ける)。
    // PT は SUV 既定 3/6、CT は abdominal 40/400、MR は適当な 500/1000、他は 0/1000。
    const def = defaultWcWwForVolume(vol);
    d.myWC = def.wc;
    d.myWW = def.ww;
    if (isFusedImageBoxInfo(i)) {
      const f = d as FusedVolumeImageBoxInfo;
      // Fusion: base = currentSeriesNumber、overlay = currentSeriesNumber1。
      const ovVol = seriesList[f.currentSeriesNumber1]?.volume;
      const ovDef = defaultWcWwForVolume(ovVol);
      f.myWC1 = ovDef.wc;
      f.myWW1 = ovDef.ww;
    }
    if (vol) {
      // 中心を volume 中点へ
      const p0 = voxelToWorld(new THREE.Vector3(0, 0, 0), vol);
      const p1 = voxelToWorld(new THREE.Vector3(vol.nx, vol.ny, vol.nz), vol);
      d.centerInWorld = p0.add(p1).divideScalar(2);
      // 現在 plane の canonical 軸でリセット (zoom=1)
      const plane = getBoxCurrentPlane(i);
      if (plane === 'axi' || plane == null) {
        d.vecx = vol.vectorX.clone();
        d.vecy = vol.vectorY.clone();
        d.vecz = vol.vectorZ.clone();
      } else if (plane === 'cor') {
        d.vecx = vol.vectorX.clone();
        d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorX.length()));
        d.vecz = vol.vectorY.clone();
      } else if (plane === 'sag') {
        d.vecx = vol.vectorY.clone();
        d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorY.length()));
        d.vecz = vol.vectorX.clone();
      }
      // MIP は angle のみリセット (mode は維持)
      if (d.isMip && d.mip) {
        d.mip.mipAngle = 0;
      }
    }
  }
  showImage(i);
};

const setPlaneOnBox = (i: number, plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr') => {
  if (!isAnyVolumeBox(i)) return;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;

  if (plane === 'mip' || plane === 'smip') {
    d.isMip = true;
    d.isVr = false;
    if (d.mip == null) {
      d.mip = makeMipState(plane === 'smip');
    } else {
      d.mip.isSurface = (plane === 'smip');
    }
    // MIP / VR 用 coronal-like reorient: canvas y = head-foot (vecy = volume vecZ),
    // 投影軸 = vecz = volume vecY (anterior-posterior)。これで MIP の正面像が出る。
    const vol = seriesList[d.currentSeriesNumber]?.volume;
    if (vol) {
      d.vecx = vol.vectorX.clone();
      d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorX.length()));
      d.vecz = vol.vectorY.clone();
    }
    showImage(i);
    return;
  }

  if (plane === 'vr') {
    d.isMip = false;
    d.isVr = true;
    if (d.mip == null) {
      d.mip = makeMipState();
    }
    const vol = seriesList[d.currentSeriesNumber]?.volume;
    if (vol) {
      d.vecx = vol.vectorX.clone();
      d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(vol.vectorX.length()));
      d.vecz = vol.vectorY.clone();
    }
    showImage(i);
    return;
  }

  // axi / cor / sag: 元 volume の canonical 軸を起点に再構築
  d.isMip = false;
  d.isVr = false;
  const vol = seriesList[d.currentSeriesNumber]?.volume;
  if (!vol) {
    showImage(i);
    return;
  }
  // ズーム倍率 (現 vec 長 / canonical 長) を保持して再構築
  const xZoom = d.vecx.length() / Math.max(1e-9, vol.vectorX.length());
  const yZoom = d.vecy.length() / Math.max(1e-9, vol.vectorY.length());

  if (plane === 'axi') {
    d.vecx = vol.vectorX.clone().multiplyScalar(xZoom);
    d.vecy = vol.vectorY.clone().multiplyScalar(yZoom);
    d.vecz = vol.vectorZ.clone();
  } else if (plane === 'cor') {
    d.vecx = vol.vectorX.clone().multiplyScalar(xZoom);
    d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(d.vecx.length()));
    d.vecz = vol.vectorY.clone();
  } else if (plane === 'sag') {
    d.vecx = vol.vectorY.clone().multiplyScalar(xZoom);
    d.vecy = headUpVecy(vol.vectorZ.clone().normalize().multiplyScalar(d.vecx.length()));
    d.vecz = vol.vectorX.clone();
  }
  showImage(i);
};

const setClutOnBox = (i: number, clutId: number) => {
  if (!isAnyVolumeBox(i)) return;
  const d = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (clutId === -1) {
    // Reverse: ペアトグル (0↔1, 2↔3, 4↔5)
    if (d.clut % 2 === 0) d.clut = d.clut + 1;
    else d.clut = d.clut - 1;
  } else {
    d.clut = clutId;
  }
  showImage(i);
};

// Fusion box の overlay (PET 側) CLUT 設定。base 側は setClutOnBox を継続使用。
const setClut1OnBox = (i: number, clutId: number) => {
  if (!isFusedImageBoxInfo(i)) return;
  const d = imageBoxInfos.value[i] as FusedVolumeImageBoxInfo;
  if (clutId === -1) {
    if (d.clut1 % 2 === 0) d.clut1 = d.clut1 + 1;
    else d.clut1 = d.clut1 - 1;
  } else {
    d.clut1 = clutId;
  }
  showImage(i);
};

const onTitlebarSetPlane = (i: number, plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr') => {
  setPlaneOnBox(i, plane);
};
const onTitlebarSetClut = (i: number, clut: number) => {
  setClutOnBox(i, clut);
};
const onTitlebarSetClut1 = (i: number, clut: number) => {
  setClut1OnBox(i, clut);
};

// Fusion box の base / overlay の modality 文字列 (titlebar CLUT badge 表示用)
const getBoxBaseModality = (i: number): string => {
  if (!isFusedImageBoxInfo(i)) return '';
  const f = imageBoxInfos.value[i] as FusedVolumeImageBoxInfo;
  const s = seriesList[f.currentSeriesNumber];
  return (s?.volume?.metadata?.modality
    ?? (s?.myDicom?.[0]?.string('x00080060') ?? '')).toUpperCase();
};
const getBoxOverlayModality = (i: number): string => {
  if (!isFusedImageBoxInfo(i)) return '';
  const f = imageBoxInfos.value[i] as FusedVolumeImageBoxInfo;
  const s = seriesList[f.currentSeriesNumber1];
  return (s?.volume?.metadata?.modality
    ?? (s?.myDicom?.[0]?.string('x00080060') ?? '')).toUpperCase();
};
const getBoxOverlayClut = (i: number): number | undefined => {
  if (!isFusedImageBoxInfo(i)) return undefined;
  return (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).clut1;
};
const onTitlebarToggleSync = (i: number) => {
  if (i < 0) return;
  while (boxSyncEnabled.value.length <= i) boxSyncEnabled.value.push(true);
  boxSyncEnabled.value[i] = !boxSyncEnabled.value[i];
};

// ---- Maximize / Restore ----
// tileN を 1 に切り替え、選んだ box info を slot 0 に swap する。
// 復元時は swap し戻して元 tileN に戻す。
let maximizedState: { prevTileN: number; originalSlot: number } | null = null;

const onTitlebarMaximize = (i: number) => {
  if (maximizedState !== null) {
    // Restore
    const slot = maximizedState.originalSlot;
    if (slot !== 0) {
      const tmp = imageBoxInfos.value[0];
      imageBoxInfos.value[0] = imageBoxInfos.value[slot];
      imageBoxInfos.value[slot] = tmp;
    }
    tileN.value = maximizedState.prevTileN;
    maximizedState = null;
    nextTick(() => show());
    return;
  }

  // Maximize
  maximizedState = {
    prevTileN: tileN.value ?? 1,
    originalSlot: i,
  };
  if (i !== 0) {
    const tmp = imageBoxInfos.value[0];
    imageBoxInfos.value[0] = imageBoxInfos.value[i];
    imageBoxInfos.value[i] = tmp;
  }
  tileN.value = 1;
  nextTick(() => show());
};
const onTitlebarToggleOverlay = (i: number) => {
  if (i < 0) return;
  while (boxOverlayDisabled.value.length <= i) boxOverlayDisabled.value.push(false);
  boxOverlayDisabled.value[i] = !boxOverlayDisabled.value[i];
  showImage(i);
};

// Fusion box の overlay blend (0..1) を取得 / 設定。Fusion 以外は undefined を返す。
const getBoxOverlayAlpha = (i: number): number | undefined => {
  if (!isFusedImageBoxInfo(i)) return undefined;
  return (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).overlayAlpha ?? 0.5;
};

// Fusion box の W/L drag 対象レイヤ取得 / 設定 ('base' | 'overlay')。default 'overlay'。
const getBoxActiveWindowLayer = (i: number): 'base' | 'overlay' | undefined => {
  if (!isFusedImageBoxInfo(i)) return undefined;
  return (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).activeWindowLayer ?? 'overlay';
};
const onSetActiveWindowLayer = (i: number, layer: 'base' | 'overlay') => {
  if (!isFusedImageBoxInfo(i)) return;
  (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).activeWindowLayer = layer;
};
const onSetOverlayAlpha = (i: number, v: number) => {
  if (!isFusedImageBoxInfo(i)) return;
  (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).overlayAlpha = v;
  showImage(i);
};

// 補間モード getter / setter (slice/MPR 用)。DICOM slice / Volume / Fusion 全対応。
const getBoxInterpolation = (i: number): 'nearest' | 'bilinear' | undefined => {
  if (isDicomSliceImageBoxInfo(i)) {
    return (imageBoxInfos.value[i] as DicomSliceImageBoxInfo).interpolation;
  }
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).interpolation;
};
const getBoxInterpolation1 = (i: number): 'nearest' | 'bilinear' | undefined => {
  if (!isFusedImageBoxInfo(i)) return undefined;
  return (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).interpolation1;
};
const onSetInterpolation = (i: number, payload: { layer: 'base' | 'overlay'; mode: 'nearest' | 'bilinear' }) => {
  if (isDicomSliceImageBoxInfo(i)) {
    // DICOM slice: layer は 'base' のみ意味あり (overlay は無いので無視)
    (imageBoxInfos.value[i] as DicomSliceImageBoxInfo).interpolation = payload.mode;
    showImage(i);
    return;
  }
  if (!isAnyVolumeBox(i)) return;
  if (payload.layer === 'overlay') {
    if (!isFusedImageBoxInfo(i)) return;
    (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo).interpolation1 = payload.mode;
  } else {
    (imageBoxInfos.value[i] as VolumeImageBoxInfo).interpolation = payload.mode;
  }
  showImage(i);
};

// この volume に適用すべき CT 寝台除去マスクを返す。
// Pinia Proxy 回避のため seriesUID で照合する (voxel 参照同一でも可)。
const ctBodyMaskForVolume = (vol: Volume.Volume | undefined | null): Uint8Array | undefined => {
  if (!vol || !segStore.ctBodyMaskEnabled || !segStore.ctBodyMask) return undefined;
  const ctUid = segStore.ctVolumeRef?.metadata?.seriesUID;
  const uid = vol.metadata?.seriesUID;
  // seriesUID を持たない volume (NIfTI 等) は voxel 参照で照合する
  const same = (!!ctUid && ctUid === uid) || segStore.ctVolumeRef?.voxel === vol.voxel;
  return same ? (segStore.ctBodyMask as Uint8Array) : undefined;
};

// sMIP / VR パラメータ getter / setter (titlebar 歯車 popover)
const getBoxMipThreshold = (i: number): number | null | undefined => {
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.thresholdSurfaceMip;
};
// 自動閾値の算出結果 (スライダのレンジと "auto" 表示に使う)
const getBoxMipAutoInfo = (i: number) => {
  if (!isAnyVolumeBox(i)) return null;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  const vol = seriesList[info.currentSeriesNumber]?.volume;
  return vol ? surfaceThresholdFor(vol) : null;
};
const getBoxMipShade = (i: number) => {
  if (!isAnyVolumeBox(i)) return null;
  const m = (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip;
  if (!m) return null;
  return { on: m.shadeSurface !== false, ambient: m.shadeAmbient ?? 0.25,
           specular: m.shadeSpecular ?? 0.35, depthCue: m.shadeDepthCue ?? 0.35 };
};
const getBoxMipDepth = (i: number): number | undefined => {
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.depthSurfaceMip;
};
const getBoxMipAlphaScale = (i: number): number | undefined => {
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.alphaScale;
};
const onSetMipParam = (
  i: number,
  payload: { key: 'thresholdSurfaceMip' | 'depthSurfaceMip' | 'alphaScale'
                 | 'shadeSurface' | 'shadeAmbient' | 'shadeSpecular' | 'shadeDepthCue';
             value: number | null | boolean },
) => {
  if (!isAnyVolumeBox(i)) return;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!info.mip) return;
  // thresholdSurfaceMip = null は「自動に戻す」の意味なのでそのまま入れる
  (info.mip as any)[payload.key] = payload.value;
  showImage(i);
};

// VR TF preset 切替: vrOpacityTF と vrOpacityPresetId を更新、suggestedAlphaScale も推奨値に。
const getBoxVrTfPresetId = (i: number): string | undefined => {
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.vrOpacityPresetId;
};
const vrTfPresetsView = TF_PRESETS.map(p => ({ id: p.id, label: p.label, description: p.description }));
const onSetVrTfPreset = (i: number, presetId: string) => {
  if (!isAnyVolumeBox(i)) return;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!info.mip) return;
  const preset = TF_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  info.mip.vrOpacityTF = preset.tf.map(pt => ({ ...pt }));
  info.mip.vrOpacityPresetId = presetId;
  // 推奨 alphaScale もセット (preset 切替時の良い既定値)
  info.mip.alphaScale = preset.suggestedAlphaScale;
  showImage(i);
};

// D15: visual editor から制御点を直接更新。preset id は 'custom' 化 (UI で badge 表示)。
const getBoxVrTfPoints = (i: number): { v: number; a: number }[] | undefined => {
  if (!isAnyVolumeBox(i)) return undefined;
  return (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.vrOpacityTF;
};
const onSetVrTfPoints = (i: number, pts: { v: number; a: number }[]) => {
  if (!isAnyVolumeBox(i)) return;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!info.mip) return;
  info.mip.vrOpacityTF = pts.map(p => ({ ...p }));
  info.mip.vrOpacityPresetId = 'custom';
  showImage(i);
};

// Phase B: shading 状態の getter / setter
const ensureVrShading = (i: number) => {
  if (!isAnyVolumeBox(i)) return null;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!info.mip) return null;
  if (!info.mip.vrShading) {
    info.mip.vrShading = {
      enabled: false, ambient: 0.3, diffuse: 0.7, specularInt: 0.4, specularPower: 16,
    };
  }
  return info.mip.vrShading;
};
const getVrShadingField = (i: number, key: 'enabled' | 'ambient' | 'diffuse' | 'specularInt' | 'specularPower') => {
  if (!isAnyVolumeBox(i)) return undefined;
  const sh = (imageBoxInfos.value[i] as VolumeImageBoxInfo).mip?.vrShading;
  if (!sh) return undefined;
  return sh[key];
};
const onSetVrShading = (
  i: number,
  payload: { key: 'enabled' | 'ambient' | 'diffuse' | 'specularInt' | 'specularPower'; value: number | boolean },
) => {
  const sh = ensureVrShading(i);
  if (!sh) return;
  if (payload.key === 'enabled') sh.enabled = !!payload.value;
  else (sh as any)[payload.key] = Number(payload.value);
  showImage(i);
};


// ===== VR auto demo =====
// VrDemo は box 単位でしか持たないので、現在再生中の box id と controller 1 つ。
const vrDemoBoxId = ref<number>(-1);
let vrDemoController: VrDemo | null = null;
const onToggleVrDemo = (i: number) => {
  if (!isAnyVolumeBox(i)) return;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  if (!info.isVr) return;
  if (vrDemoController?.isRunning() && vrDemoBoxId.value === i) {
    // stop
    vrDemoController.stop();
    return;
  }
  // 別 box が走ってれば止めてから新規開始
  if (vrDemoController?.isRunning()) vrDemoController.stop();
  vrDemoBoxId.value = i;
  vrDemoController = new VrDemo(
    {
      onFrame: () => showImage(i),
      onStop: () => { vrDemoBoxId.value = -1; },
    },
    (id: string) => {
      const preset = TF_PRESETS.find(p => p.id === id);
      return preset ? preset.tf.map(p => ({ ...p })) : null;
    },
  );
  vrDemoController.start({
    info,
    isFusion: isFusedImageBoxInfo(i),
    resolvePresetTF: (id) => {
      const preset = TF_PRESETS.find(p => p.id === id);
      return preset ? preset.tf.map(p => ({ ...p })) : null;
    },
  });
};
const isVrDemoRunningOnBox = (i: number) => vrDemoController?.isRunning() && vrDemoBoxId.value === i;
const onTitlebarMakeMpr = (i: number, plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr' = 'axi') => {
  if (!isDicomSliceImageBoxInfo(i)) return;
  const info = getDicomSliceImageBoxInfo(i);
  const seriesIdx = info.currentSeriesNumber;
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return;
  if (!seriesList[seriesIdx].myDicom || seriesList[seriesIdx].myDicom!.length === 0) return;
  // box i (= 操作中の box) を Volume 化。mpr_ 内で旧 box の wc/ww/CLUT を継承するので
  // CT lung window 等が PT 既定 (3/6) に書き換わる事故が起きない。
  mpr_(seriesIdx, i);
  // 指定 plane に切替 (default = axi)。axi のままなら setPlaneOnBox の noop。
  if (plane !== 'axi') setPlaneOnBox(i, plane);
  showImage(i);
};

// Volume / Fusion box が DICOM-origin 系列 (myDicom > 0) を持つかどうか。
// Fusion は currentSeriesNumber (base) で判定。NIfTI のみは false。
const getCanRevertToDicom = (i: number): boolean => {
  if (i < 0 || i >= imageBoxInfos.value.length) return false;
  if (!isAnyVolumeBox(i)) return false;
  const info = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  const sIdx = info.currentSeriesNumber;
  if (sIdx == null || sIdx < 0 || sIdx >= seriesList.length) return false;
  const dlist = seriesList[sIdx].myDicom;
  return !!dlist && dlist.length > 0;
};

// Volume box → DICOM slice (2D) box に戻す。
// 元 Volume の WC/WW を継承するが、PT は SUV → raw count スケールに戻す
// (volume voxel は SUV 倍されているため、DICOM raw 表示窓は myWC / suvFactor)。
// CLUT は捨て (DICOM slice は常に gray)。中心 slice は元 Volume の centerInWorld を
// world→voxel 逆射影して z 軸 index に置く。
const onBackToDicom = (i: number) => {
  if (i < 0 || i >= imageBoxInfos.value.length) return;
  if (!isAnyVolumeBox(i)) return;
  const old = imageBoxInfos.value[i] as VolumeImageBoxInfo;
  const sIdx = old.currentSeriesNumber;
  const series = seriesList[sIdx];
  if (!series?.myDicom || series.myDicom.length === 0) {
    alert('This series has no original DICOM frames — cannot revert to 2D view.');
    return;
  }
  const vol = series.volume;
  // 旧 centerInWorld から最寄り slice index を求める。volume が無いケースは index 0。
  let sliceIdx = 0;
  if (vol && old.centerInWorld) {
    const v = worldToVoxel(old.centerInWorld, vol);
    sliceIdx = Math.max(0, Math.min(series.myDicom.length - 1, Math.floor(v.z + 0.5)));
  }
  // PT で SUV 化されているなら DICOM 表示窓は myWC / suvFactor で raw counts に戻す
  let wc: number | null = old.myWC ?? null;
  let ww: number | null = old.myWW ?? null;
  const mod = (vol?.metadata?.modality ?? '').toUpperCase();
  if ((mod === 'PT' || mod === 'PET') && vol?.metadata?.suvOk && vol?.metadata?.suvFactor) {
    if (wc != null) wc = wc / vol.metadata.suvFactor;
    if (ww != null) ww = ww / vol.metadata.suvFactor;
  }
  imageBoxInfos.value[i] = {
    currentSeriesNumber: sIdx,
    currentSliceNumber: sliceIdx,
    imageNumberOfDicomTag: null,
    description: old.description ?? '',
    myWC: wc,
    myWW: ww,
    centerX: 0,
    centerY: 0,
    zoom: null,
    interpolation: old.interpolation,
  } as DicomSliceImageBoxInfo;
  showImage(i);
};

// Box の primary series を Float32 NIfTI で書き出す。
// PT は SUV 単位 (voxel に suvFactor 適用済み)、CT は HU、MR は raw。
// Volume が無いシリーズ (DicomSlice 未 MPR) は mpr_ で先に生成する。
// .nii と .json sidecar (modality / suvFactor / metadata) を 2 ファイル同時ダウンロード。
const onTitlebarSaveVolumeNifti = (i: number) => {
  if (i < 0 || i >= imageBoxInfos.value.length) return;
  const info = imageBoxInfos.value[i];
  const sIdx = info?.currentSeriesNumber;
  if (sIdx == null || sIdx < 0 || sIdx >= seriesList.length) return;
  const series = seriesList[sIdx];
  if (!series.volume) {
    // ensureVolume_: box[sIdx] を巻き込まず volume だけ生成
    if (!ensureVolume_(sIdx)) {
      alert('Failed to build Volume from this series.');
      return;
    }
  }
  const vol = series.volume;
  if (!vol) { alert('No volume to export.'); return; }

  const niftiBlob = writeNiftiFloat32(vol);
  const sidecarBlob = new Blob([buildVolumeSidecarJson(vol)], { type: 'application/json' });

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const uidTail = (vol.metadata?.seriesUID ?? `series-${sIdx}`).slice(-32);
  const baseName = `${uidTail}_${ts}`.replace(/[^A-Za-z0-9._-]/g, '_');
  triggerDownload(niftiBlob,   `${baseName}.nii`);
  triggerDownload(sidecarBlob, `${baseName}.json`);
};

// 矩形 ROI (store の RectROI) → JSON 表現。voxel 座標。series UID も埋める。
const rectRoiToJson = (r: import('../stores/segmentation').RectROI): RectRoiJson => {
  const series = seriesList[r.seriesIndex];
  const seriesUID = series?.volume?.metadata?.seriesUID
    ?? series?.myDicom?.[0]?.string('x0020000e')
    ?? null;
  return {
    id: r.id,
    label: r.label ?? null,
    seriesIndex: r.seriesIndex,
    seriesUID,
    topLeft:     { x: r.topLeft[0],     y: r.topLeft[1],     z: r.topLeft[2] },
    bottomRight: { x: r.bottomRight[0], y: r.bottomRight[1], z: r.bottomRight[2] },
  };
};

// JSON 表現を store の rectRois に復元する。defensive にパースする。
// 戻り値は復元できた矩形数。
const importRectRoisFromJson = (arr: unknown): number => {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, any>;
    const tl = o.topLeft, br = o.bottomRight;
    if (!tl || !br) continue;
    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);
    const a: [number, number, number] | null =
      num(tl.x) != null && num(tl.y) != null && num(tl.z) != null
        ? [tl.x, tl.y, tl.z] : null;
    const b: [number, number, number] | null =
      num(br.x) != null && num(br.y) != null && num(br.z) != null
        ? [br.x, br.y, br.z] : null;
    if (!a || !b) continue;
    const seriesIndex = typeof o.seriesIndex === 'number' ? o.seriesIndex : 0;
    const label = typeof o.label === 'string' && o.label.length > 0 ? o.label : undefined;
    // recordUndo=false: 一括 import を 1 件ずつ undo できてしまうのを防ぐ
    segStore.addRectRoi(seriesIndex, a, b, label, false);
    n++;
  }
  return n;
};

// 画像上に配置した ROI 群を JSON で書き出す。
// 矩形 ROI は左上 (topLeft) / 右下 (bottomRight) を voxel 座標で表現する (default、world ではない)。
// sphere ROI が存在すれば参考情報として併記する (sphere は world 座標が本来の保持形式)。
const exportRoisAsJson = () => {
  const rects = segStore.rectRois;
  if (rects.length === 0 && !segStore.sphere) {
    alert('No ROI to export. Place a Rectangle ROI first.');
    return;
  }

  const payload: Record<string, unknown> = {
    type: 'metavol-roi',
    version: 1,
    created: new Date().toISOString(),
    coordinateSystem: 'voxel',
    rectangles: rects.map(rectRoiToJson),
  };

  // sphere は world 座標で保持しているため、その旨を明記して併記。
  if (segStore.sphere) {
    const s = segStore.sphere;
    payload.sphere = {
      coordinateSystem: 'world-mm',
      centerWorld: { x: s.centerWorld.x, y: s.centerWorld.y, z: s.centerWorld.z },
      radiusMm: s.radiusMm,
    };
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  triggerDownload(blob, `metavol-roi_${ts}.json`);
};

// metavol-roi JSON を読み込んで矩形 ROI を復元する (round-trip)。
// 既存の矩形はクリアしてから読み込む (重複を避ける)。
const importRoisFromJsonFile = async (file: File): Promise<{ ok: boolean; info: string }> => {
  let parsed: any;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return { ok: false, info: 'Invalid JSON: ' + ((e as Error)?.message ?? e) };
  }
  if (!parsed || parsed.type !== 'metavol-roi') {
    return { ok: false, info: 'Not a metavol-roi file.' };
  }
  segStore.clearRectRois();
  const n = importRectRoisFromJson(parsed.rectangles);
  show();
  return { ok: true, info: `${n} rectangle ROI(s) imported` };
};

type LeftButtonFunction = "window" | "pan" | "zoom" | "page" | "sphereROI" | "rectROI" | "polygonROI" | "brushROI" | "assignLabel";
// NOTE: leftButtonFunctionChanged / changeSlice_ は Sidebar 専用のハンドラだったが、
// Sidebar をシリーズ一覧だけに絞った際に呼び出し元が無くなったので削除した
// (ツール選択は app-bar、slice 送りは縦スライダ / ホイール / カーソルキー)。

const initializeDicomListsImagesBoxInfos = () => {
  bagOfFiles = [];
  seriesList = [];
  imageBoxInfos.value = [defaultInfo(0), defaultInfo(1), defaultInfo(2), defaultInfo(3),defaultInfo(4),defaultInfo(5),defaultInfo(6),defaultInfo(7)];
  seriesSummaries.value = [];
  segStore.setPetVolume(null);
  segStore.setCtVolume(null);
};
initializeDicomListsImagesBoxInfos();

// スライダ上端を「解剖学的に固定」するための反転フラグ。
//
// **なぜ必要か**: paging index は volume ごとの voxel 添字なので、添字が増える向きが
// 頭側か足側かは撮像/ソート順に依存する。PET と CT でスライス順が逆の症例では、
// 同じ解剖に対して 2 つのスライダが逆向きに動いて不自然になる (ユーザ報告)。
// そこで index ではなく **world 方向** で上端を決め、どの box でも一致させる。
//   through-plane が Z (体軸)  → 上端 = 頭側 (world +Z)
//   through-plane が Y (LPS: +Y=背側) → 上端 = 腹側 (world -Y)
//   through-plane が X (LPS: +X=左)   → 上端 = 右   (world -X)
// 引数は「voxel index が 1 増えたとき world で動く向き」(volume の軸ベクトル)。
// 戻り値 true = 「スライダ上端は index の最大側」。
const pagingInvertFor = (axisVec: THREE.Vector3): boolean => {
  const ax = maxAxis(axisVec);
  const comp = [axisVec.x, axisVec.y, axisVec.z][ax];
  const topSign = (ax === 2) ? 1 : -1;   // 上端に来る world 方向の符号
  return comp * topSign > 0;
};

// 画像右端の縦 paging スライダ用: 現在 index と範囲を返す。
// MIP / VR は wheel が角度回転に割り当てられており「スライス」の概念が無いので null。
const getBoxPaging = (i: number): { index: number; min: number; max: number; invert: boolean } | null => {
  // Volume box の paging は centerInWorld を **in-place で mutate** するため Vue の reactive
  // proxy では検知されない (CLAUDE.md の既知の落とし穴)。描画ごとに bump される
  // boxStateVersion に依存させて、ホイール paging でもスライダーが追従するようにする。
  void boxStateVersion.value;
  if (i < 0 || i >= imageBoxInfos.value.length) return null;
  if (isDicomSliceImageBoxInfo(i)) {
    const info = getDicomSliceImageBoxInfo(i);
    const s = seriesList[info.currentSeriesNumber];
    const dlist = s?.myDicom;
    if (!dlist || dlist.length <= 1) return null;
    // 生スライス box も、volume が既にあればその vectorZ で向きを揃える
    // (無い場合は従来どおり「先頭スライスが上」)。
    const vz = s?.volume?.vectorZ;
    return {
      index: info.currentSliceNumber, min: 0, max: dlist.length - 1,
      invert: vz ? pagingInvertFor(vz) : false,
    };
  }
  if (!isAnyVolumeBox(i)) return null;
  const a = getVolumeImageBoxInfo(i);
  if (isProjectionInfo(a)) return null;
  const seriesIdx = a.currentSeriesNumber;
  const vol = seriesList[seriesIdx]?.volume;
  if (!vol || !a.vecz || !a.centerInWorld) return null;
  // through-plane 軸 = vecz が最も強く向いている voxel 軸 (brush/polygon と同じ規則)
  const axis = maxAxis(a.vecz);
  const dim = [vol.nx, vol.ny, vol.nz][axis];
  if (!dim || dim <= 1) return null;
  const vc = worldToVoxel_(a.centerInWorld, seriesIdx);
  const cur = Math.round([vc.x, vc.y, vc.z][axis]);
  // index は voxel 座標なので、向きを決めるのは **volume の軸ベクトル** (index→world の対応)。
  // box の vecz (paging ステップ) ではない点に注意 (現行レイアウトでは一致するが意味が違う)。
  const axisVec = [vol.vectorX, vol.vectorY, vol.vectorZ][axis];
  return {
    index: Math.min(dim - 1, Math.max(0, cur)), min: 0, max: dim - 1,
    invert: axisVec ? pagingInvertFor(axisVec) : false,
  };
};

// スライダで絶対 index を指定 → 現在位置との差分を wheel と同じ経路 (applySyncPaging) に流す。
// こうすることで sync 中の他 box への追従も wheel paging と完全に同じ挙動になる。
const onSetPagingIndex = (i: number, target: number) => {
  const p = getBoxPaging(i);
  if (!p) return;
  const clamped = Math.min(p.max, Math.max(p.min, Math.round(target)));
  const delta = clamped - p.index;
  if (delta === 0) return;
  selectedImageBoxId.value = i;
  applySyncPaging(i, delta);
};

const changeSlice = (index: number, add_number: number) => {
  if (isDicomSliceImageBoxInfo(index)){
    const info = getDicomSliceImageBoxInfo(index);
    let temp = info.currentSliceNumber + add_number;
    const len = seriesList[info.currentSeriesNumber].myDicom!.length
    if (temp < 0) temp = 0;
    if (temp >= len) temp = len - 1;
    info.currentSliceNumber = temp;
  }else{
    const a = getVolumeImageBoxInfo(index);
    if (isProjectionInfo(a) && a.mip != null){
      // MIP / sMIP / VR は wheel で view angle を回転 (slice paging ではない)
      a.mip.mipAngle += 5*add_number;
      // 角度変更時は fast モードに切替 + 200ms idle で full-res 再描画
      triggerMipFast(index);
    }else{
      a.centerInWorld.addScaledVector(a.vecz, add_number);
    }
  }
};

// Sync group 内の target volume box の断面を、world 点 srcCenter を通る位置へ揃える。
// スライス厚 (vecz の長さ) が box ごとに違っても world 座標で一致させるのが狙い。
// pan (面内位置) は保持し、through-plane 成分だけ動かす:
//   centerInWorld += n * ((srcCenter - centerInWorld)·n)   (n = vecz 単位ベクトル)
const alignBoxThroughPlaneToWorld = (i: number, srcCenter: THREE.Vector3) => {
  const a = getVolumeImageBoxInfo(i);
  if (isProjectionInfo(a) || !a.vecz) return;
  const n = a.vecz.clone().normalize();
  const d = srcCenter.clone().sub(a.centerInWorld).dot(n);
  a.centerInWorld.addScaledVector(n, d);
};

// paging を sync group 全体へ world 座標同期で適用する。
//   - source box は add_number 分だけ通常送り。
//   - Volume↔Volume は「同じ world 断面」に一致させる (スライス厚差を吸収)。
//   - DICOM slice 等、world 断面を持たない box は従来通り同数送り。
// MIP/VR は isSyncPagingCompatible が false を返すため対象外 (回転と混ざらない)。
const applySyncPaging = (srcId: number, add_number: number) => {
  changeSlice(srcId, add_number);
  showImage(srcId);
  if (!syncImageBox.value) return;

  // source が Volume (非 MIP/VR) なら、その新しい断面中心を同期の基準にする。
  let srcCenter: THREE.Vector3 | null = null;
  if (isAnyVolumeBox(srcId)) {
    const sa = getVolumeImageBoxInfo(srcId);
    if (!sa.isMip && !sa.isVr) srcCenter = sa.centerInWorld;
  }

  for (let i = 0; i < imb.value!.length; i++) {
    if (i === srcId) continue;
    if (!isBoxSyncEnabled(i)) continue;
    if (!isSyncPagingCompatible(srcId, i)) continue;
    if (srcCenter && isAnyVolumeBox(i)) {
      alignBoxThroughPlaneToWorld(i, srcCenter);
    } else {
      changeSlice(i, add_number);
    }
    showImage(i);
  }
};

const setMyWCWW = (i:number, wc:number | null, ww: number | null) => {
  imageBoxInfos.value[i].myWC= wc;
  imageBoxInfos.value[i].myWW= ww;
}

const getMyWCWW = (i:number) => {
  return [imageBoxInfos.value[i].myWC, imageBoxInfos.value[i].myWW];
}
const getMyWCWW1 = (i:number) => {
  const info = (imageBoxInfos.value[i] as FusedVolumeImageBoxInfo);
  return [info.myWC1, info.myWW1];
}

// modality を見て「どのレイヤに window を当てるか」を決める。
// Fused box は base = CT/MR (myWC/myWW)、overlay = PT (myWC1/myWW1) の 2 レイヤ持ちなので、
// PT preset を常に myWC に書くと **MR/CT 側の window が変わってしまう** (実バグだった)。
const modalityOfSeries = (idx: number): string => {
  const s = seriesList[idx];
  if (!s) return '';
  const dl = s.myDicom;
  if (dl && dl.length > 0) return (dl[0].string('x00080060') ?? '').toUpperCase();
  return (s.volume?.metadata?.modality ?? '').toUpperCase();
};

// kind='pt' → PT レイヤ、'anat' → CT/MR レイヤ に wc/ww を設定する。
const setWindowForKind = (i: number, kind: 'pt' | 'anat', wc: number | null, ww: number | null) => {
  const info = imageBoxInfos.value[i] as any;
  if (!info) return;
  const isFused = 'clut1' in info;
  if (!isFused) { info.myWC = wc; info.myWW = ww; return; }   // 単一レイヤ box

  const isPt = (m: string) => m === 'PT' || m === 'PET';
  const baseIsPt = isPt(modalityOfSeries(info.currentSeriesNumber));
  const overlayIsPt = isPt(modalityOfSeries(info.currentSeriesNumber1));

  // 目的のレイヤ: 'pt' なら PT 側、'anat' なら PT でない側 (CT/MR)。
  // 判定できないときは従来どおり base (overlay は PT という通常構成に合わせる)。
  let useOverlay: boolean;
  if (kind === 'pt') useOverlay = overlayIsPt || !baseIsPt;
  else               useOverlay = baseIsPt && !overlayIsPt;

  if (useOverlay) { info.myWC1 = wc; info.myWW1 = ww; }
  else            { info.myWC = wc;  info.myWW = ww; }
};

// app-bar の Window preset ボタンが「どの modality のプリセットを出すか」を決めるのに使う。
// 選択中 box が fusion なら **overlay ではなく active layer** を見る (PT preset が
// MR/CT 側に当たってしまう不具合を過去に踏んでいるので、W/L の当たり先と揃える)。
const selectedBoxModality = computed<string>(() => {
  void boxStateVersion.value;
  const i = selectedImageBoxId.value;
  const info = boxInfoAt(i) as any;
  if (!info) return '';
  let sIdx = info.currentSeriesNumber;
  if (isFusedImageBoxInfo(i) && info.activeWindowLayer !== 'base') {
    sIdx = info.currentSeriesNumber1;
  }
  const s = seriesList[sIdx];
  if (!s) return '';
  const dl = s.myDicom;
  if (dl && dl.length > 0) return (dl[0].string('x00080060') ?? '').toUpperCase();
  return (s.volume?.metadata?.modality ?? '').toUpperCase();
});

const presetSelected = (e: string) => {
  const id = selectedImageBoxId.value;
  // CT/MR (解剖) presets → base レイヤ
  if (e === "Lung") setWindowForKind(id, 'anat', -700, 1800);
  if (e === "Abd")  setWindowForKind(id, 'anat', 30, 200);
  if (e === "Med")  setWindowForKind(id, 'anat', 0, 320);
  if (e === "Fat")  setWindowForKind(id, 'anat', 10, 275);
  if (e === "Bone") setWindowForKind(id, 'anat', 200, 2000);
  if (e === "Brain") setWindowForKind(id, 'anat', 30, 80);
  // PET (SUV / Bq/ml) presets — WC = (lo+hi)/2, WW = hi-lo → PT レイヤ
  if (e === "SUV-0-3")     setWindowForKind(id, 'pt', 1.5,    3);
  if (e === "SUV-0-6")     setWindowForKind(id, 'pt', 3,      6);
  if (e === "SUV-0-10")    setWindowForKind(id, 'pt', 5,     10);
  if (e === "SUV-0-15")    setWindowForKind(id, 'pt', 7.5,   15);
  if (e === "SUV-0-100")   setWindowForKind(id, 'pt', 50,   100);
  if (e === "SUV-0-1000")  setWindowForKind(id, 'pt', 500, 1000);
  if (e === "SUV-0-10000") setWindowForKind(id, 'pt', 5000, 10000);
  // MR は固定 HU のような絶対値が無いので、volume の分位点から自動で決める。
  if (e.startsWith('MR-AUTO')) {
    const pct = e === 'MR-AUTO-TIGHT' ? 0.05 : e === 'MR-AUTO-WIDE' ? 0.001 : 0.01;
    const info = imageBoxInfos.value[id] as any;
    const volIdx = info?.currentSeriesNumber ?? -1;
    const v = seriesList[volIdx]?.volume;
    if (v) {
      const stride = Math.max(1, Math.floor(v.voxel.length / 20000));
      const vals: number[] = [];
      for (let t = 0; t < v.voxel.length; t += stride) vals.push(v.voxel[t]);
      vals.sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * pct)] ?? vals[0];
      const hi = vals[Math.floor(vals.length * (1 - pct))] ?? vals[vals.length - 1];
      setWindowForKind(id, 'anat', (lo + hi) / 2, Math.max(1, hi - lo));
    }
  }
  if (e === "Reset") { setWindowForKind(id, 'anat', null, null); setWindowForKind(id, 'pt', null, null); }
  show();
};

// Tracer preset 適用: PT 表示窓 / CLUT を全 PT/Fusion box に書き換え + segStore の
// threshold + label preset を更新。Mask 数や label 数が変わると mask 全消去 (store 側で実施)。
//
// 注意: ImageBoxInfo は volume 直接ではなく `currentSeriesNumber` で seriesList を参照する設計。
// Volume が PT かどうかは seriesList[currentSeriesNumber].volume.metadata.modality で判定する。
const applyTracerPreset = (preset: TracerPreset) => {
  segStore.applyTracerLabelsAndThreshold(preset.id, preset.suvThreshold, preset.labels);

  const isPtSeries = (idx: number | undefined): boolean => {
    if (idx == null || idx < 0 || idx >= seriesList.length) return false;
    const v = seriesList[idx].volume;
    if (v?.metadata?.modality === 'PT') return true;
    // volume 未生成でも DICOM タグだけは確認できる
    const dlist = seriesList[idx].myDicom;
    const m = dlist?.[0]?.string("x00080060")?.toUpperCase();
    return m === 'PT' || m === 'PET';
  };

  for (let i = 0; i < imageBoxInfos.value.length; i++) {
    if (!isAnyVolumeBox(i)) continue;
    const info = imageBoxInfos.value[i];
    if (isFusedImageBoxInfo(i)) {
      // Fusion: PT layer は currentSeriesNumber1 のレイヤ。固定で myWC1/myWW1/clut1 を更新。
      const fi = info as FusedVolumeImageBoxInfo;
      fi.myWC1 = preset.suvWindow.wc;
      fi.myWW1 = preset.suvWindow.ww;
      fi.clut1 = preset.petClut;
    } else if (isVolumeImageBoxInfo(i)) {
      // Volume: そのボックスが参照する series が PT のときだけ更新 (CT/MR は触らない)
      const v = info as VolumeImageBoxInfo;
      if (isPtSeries(v.currentSeriesNumber)) {
        v.myWC = preset.suvWindow.wc;
        v.myWW = preset.suvWindow.ww;
        v.clut = preset.petClut;
      }
    }
  }
  show();
};

// applyTracerById は App.vue から呼び出される入口 (defineExpose 経由)。
const applyTracerById = (id: string) => {
  const p = tracerById(id);
  if (p) applyTracerPreset(p);
};

// DICOM tag viewer 用: 現在選択中の Box が指す series の **現スライス** を返す。
//   - DICOM 2D box: currentSliceNumber 直接
//   - Volume / Fusion box: centerInWorld を voxel に逆変換 → 最寄り slice index
//   - MIP / 不明: スライス 0
// reactive にしたいので computed として exposed する (function 形式は legacy として残す)。
interface TagContext {
    dataset: DataSet;
    label: string;
    sliceIndex: number;
    sliceCount: number;
}

const computeTagContext = (): TagContext | null => {
  const id = selectedImageBoxId.value;
  if (id < 0 || id >= imageBoxInfos.value.length) return null;
  // Volume / Fusion / MIP は DICOM tag view 非対応 (1 frame のタグが意味をなさないため)
  if (!isDicomSliceImageBoxInfo(id)) return null;
  const info = imageBoxInfos.value[id] as DicomSliceImageBoxInfo;
  const idx = info.currentSeriesNumber;
  if (idx == null || idx < 0 || idx >= seriesList.length) return null;
  const series = seriesList[idx];
  if (!series?.myDicom?.length) return null;
  const dlist = series.myDicom;

  let sliceIdx = info.currentSliceNumber ?? 0;
  if (sliceIdx < 0) sliceIdx = 0;
  if (sliceIdx >= dlist.length) sliceIdx = dlist.length - 1;

  const ds = dlist[sliceIdx];
  const desc = ds.string("x0008103e") ?? ds.string("x00081030") ?? '(no description)';
  return { dataset: ds, label: desc, sliceIndex: sliceIdx, sliceCount: dlist.length };
};

// reactive ref として外部に渡す (paging 時に dialog が自動更新)。
// imageBoxInfos.value の中の centerInWorld / currentSliceNumber が変わると再評価される。
const activeTagContext = computed<TagContext | null>(() => {
  // imageBoxInfos / selectedImageBoxId への依存を Vue に伝えるため明示参照
  void imageBoxInfos.value;
  void selectedImageBoxId.value;
  return computeTagContext();
});

// Function 形式 (open 時の一回限りの取得) — backward compat
const getActiveTagContext = (): TagContext | null => computeTagContext();
const getTagContextForSeries = (idx: number): TagContext | null => {
  if (idx < 0 || idx >= seriesList.length) return null;
  const series = seriesList[idx];
  if (!series?.myDicom?.length) return null;
  const ds = series.myDicom[0];
  const desc = ds.string("x0008103e") ?? ds.string("x00081030") ?? '(no description)';
  return { dataset: ds, label: desc, sliceIndex: 0, sliceCount: series.myDicom.length };
};

const dragEnter = () => { isEnter.value = true; }
const dragLeave = () => { isEnter.value = false; }

// drop は 2 種類:
//  (a) ファイル/フォルダ drop → loadFiles
//  (b) Sidebar の series card drop → 受けた box の series を差し替え
const dropFile = async (e: DragEvent, boxId?: number) => {
  isEnter.value = false;
  // 1. Fusion drag (modality chip): box 内のドラッグハンドルから来た「fuse this series here」要求
  const fusionSrcStr = e.dataTransfer?.getData('application/x-metavol-fusion-source');
  if (fusionSrcStr) {
    const srcSeriesIdx = Number(fusionSrcStr);
    const tgt = boxId ?? selectedImageBoxId.value;
    if (!isNaN(srcSeriesIdx) && srcSeriesIdx >= 0 && srcSeriesIdx < seriesList.length) {
      fuseSeriesIntoBox(srcSeriesIdx, tgt);
    }
    return;
  }
  // 2. Sidebar series card drag。
  //    - box の上に落ちた   → その box に表示 (modality が補完関係なら fusion に昇格)
  //    - box の無い所に落ちた → **新しい box を作って**そこに表示 (選択中 box を勝手に
  //      書き換えていたのが「挙動が不安定」の一因だった)
  const seriesIdxStr = e.dataTransfer?.getData('application/x-metavol-series');
  if (seriesIdxStr) {
    const idx = Number(seriesIdxStr);
    if (isNaN(idx) || idx < 0 || idx >= seriesList.length) return;
    if (boxId == null) {
      appendSeriesAsNewBox(idx);
      return;
    }
    // PT を CT/MR の box へ (またはその逆) → 重ねたいはず、と解釈して fusion。
    // 同 modality なら単純に差し替え。
    if (shouldFuseOnDrop(idx, boxId)) fuseSeriesIntoBox(idx, boxId);
    else onSelectSeriesIntoBox(idx, boxId);
    return;
  }
  // 3. OS からのファイルドロップ
  const files = await getAllFilesRecursive(e);
  if (files && files.length > 0) loadFiles(files);
};

// Modality chip dragstart ハンドラ。Volume / Fusion / DicomSlice いずれの box からも起動可。
// dataTransfer に source series index を載せて drop ハンドラに引き渡す。
// DicomSlice 経路では volume が無くても良い (drop 側で MPR される)。
const onModalityDragStart = (e: DragEvent, srcBoxId: number) => {
  if (!e.dataTransfer) return;
  if (srcBoxId < 0 || srcBoxId >= imageBoxInfos.value.length) { e.preventDefault(); return; }

  // DicomSlice: currentSeriesNumber を直接 source seriesIdx として使う
  if (isDicomSliceImageBoxInfo(srcBoxId)) {
    const info = imageBoxInfos.value[srcBoxId] as DicomSliceImageBoxInfo;
    const seriesIdx = info.currentSeriesNumber;
    if (seriesIdx == null || seriesIdx < 0 || seriesIdx >= seriesList.length) { e.preventDefault(); return; }
    if (!seriesList[seriesIdx]?.myDicom || seriesList[seriesIdx].myDicom!.length === 0) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/x-metavol-fusion-source', String(seriesIdx));
    e.dataTransfer.effectAllowed = 'copy';
    return;
  }

  // Volume / Fusion 経路 (MIP/VR は除外)
  if (!isAnyVolumeBox(srcBoxId)) { e.preventDefault(); return; }
  const a = imageBoxInfos.value[srcBoxId] as VolumeImageBoxInfo;
  if (isProjectionInfo(a)) { e.preventDefault(); return; }
  const seriesIdx = a.currentSeriesNumber;
  if (seriesIdx == null || seriesIdx < 0 || seriesIdx >= seriesList.length) { e.preventDefault(); return; }
  if (!seriesList[seriesIdx]?.volume) { e.preventDefault(); return; }
  e.dataTransfer.setData('application/x-metavol-fusion-source', String(seriesIdx));
  e.dataTransfer.effectAllowed = 'copy';
};

// Fusion 構築: src series を tgtBoxId の box に重ねる。
// PT は overlay、CT/MR は base に自動振り分け。
// target box が:
//   - Volume / Fusion: その plane (centerInWorld / vecx,y,z) を保持
//   - DicomSlice: target series を MPR して axial を既定 plane とする
//   - MIP / VR: alert で reject
// ===== Fusion 相手の提案 =====
//
// 「読み込み時に全シリーズを役割分類して絞る」のは副作用が大きいので採らない。
// 代わりに **重ねたい瞬間に候補を提案する**。同じ FrameOfReferenceUID (= 同じ撮影機で
// 位置合わせ済み) の PT×CT が最有力で、実運用ではまずこれを選びたい。
// ただしイレギュラーな組み合わせ (別 study の診断 CT に PET を重ねる等) も選べるよう、
// 候補は除外せず「推奨」バッジと理由を付けて並べるだけにする。
const frameOfRefOf = (idx: number): string => {
  const dl = seriesList[idx]?.myDicom;
  if (!dl || dl.length === 0) return '';
  return (dl[0].string('x00200052') ?? '').trim();
};

// ImageType (0008,0008) が ORIGINAL\PRIMARY か = 撮影そのもの。
// DERIVED / SECONDARY は再構成 (PET CORONAL 等) や MIP / コンソール保存画なので、
// **候補から外しはしないが順位を下げる**(ユーザは変則的な組み合わせも選びたいため)。
const isOriginalPrimary = (idx: number): boolean => {
  const dl = seriesList[idx]?.myDicom;
  if (!dl || dl.length === 0) return true;   // NIfTI 等は判定材料が無いので不利にしない
  const t = (dl[0].string('x00080008') ?? '').toUpperCase();
  if (!t) return true;
  return t.includes('ORIGINAL') && t.includes('PRIMARY');
};

interface FusionCandidate {
  idx: number; label: string; modality: string; nFrames: number;
  sameFrameOfRef: boolean; sameStudy: boolean; recommended: boolean; reason: string;
  original: boolean;        // ImageType が ORIGINAL\PRIMARY (再構成/MIP でない)
  complementary: boolean;   // base と PT/解剖の補完関係
}

const fusionDialog = ref<{ open: boolean; boxId: number; baseLabel: string; candidates: FusionCandidate[] }>(
  { open: false, boxId: -1, baseLabel: '', candidates: [] },
);

const getFusionCandidatesForBox = (boxId: number): { baseIdx: number; list: FusionCandidate[] } | null => {
  const info = imageBoxInfos.value[boxId] as any;
  if (!info) return null;
  const baseIdx: number = info.currentSeriesNumber;
  if (baseIdx == null) return null;
  const baseMod = seriesModality(baseIdx);
  const baseFor = frameOfRefOf(baseIdx);
  const baseStudy = seriesSummaries.value[baseIdx]?.studyUID ?? '';

  const list: FusionCandidate[] = [];
  for (let i = 0; i < seriesList.length; i++) {
    if (i === baseIdx) continue;
    const s = seriesList[i];
    if (!s) continue;
    const nFrames = s.myDicom?.length ?? s.volume?.nz ?? 0;
    if (nFrames < 2) continue;                       // 単発 (localizer / dose report) は重ねられない
    if (seriesSummaries.value[i]?.isRgb) continue;   // RGB (コンソールの合成画) は定量にも表示にも不適
    const mod = seriesModality(i);
    const sameFor = !!baseFor && frameOfRefOf(i) === baseFor;
    const sameStudy = !!baseStudy && (seriesSummaries.value[i]?.studyUID ?? '') === baseStudy;
    const complementary = isPtModality(mod) !== isPtModality(baseMod);
    const original = isOriginalPrimary(i);
    const reasons: string[] = [];
    if (sameFor) reasons.push('same frame of reference (hardware-aligned)');
    else if (sameStudy) reasons.push('same study, different frame of reference — needs registration');
    else reasons.push('different study — needs registration');
    if (complementary) reasons.push(isPtModality(mod) ? 'PT overlay on anatomy' : 'anatomy under PT');
    if (!original) reasons.push('derived (reformat / MIP)');
    list.push({
      idx: i, modality: mod, nFrames,
      label: seriesSummaries.value[i]?.description || `Series ${i}`,
      sameFrameOfRef: sameFor, sameStudy,
      recommended: false,               // 下で最良の 1 件だけ true にする
      reason: reasons.join(' · '),
      original, complementary,
    });
  }
  // 同 FoR → 補完 modality → 撮影そのもの (ORIGINAL\PRIMARY) → 同 study → 枚数
  // 枚数まで見るのは、PET CORONAL(146) や PET MIP(36) より PET TRANSAXIAL(413) を上に出すため。
  list.sort((a, b) =>
    Number(b.sameFrameOfRef) - Number(a.sameFrameOfRef) ||
    Number(b.complementary) - Number(a.complementary) ||
    Number(b.original) - Number(a.original) ||
    Number(b.sameStudy) - Number(a.sameStudy) ||
    b.nFrames - a.nFrames);
  // 「これを選べばまず正解」を 1 件だけ推奨表示する (全部に付けると選択の助けにならない)
  const best = list[0];
  if (best && best.sameFrameOfRef && best.complementary && best.original) best.recommended = true;
  return { baseIdx, list };
};

const onOpenFusionPicker = (boxId: number) => {
  const r = getFusionCandidatesForBox(boxId);
  if (!r || r.list.length === 0) { alert('No other series available to fuse.'); return; }
  fusionDialog.value = {
    open: true, boxId,
    baseLabel: seriesSummaries.value[r.baseIdx]?.description || `Series ${r.baseIdx}`,
    candidates: r.list,
  };
};

const onPickFusionCandidate = (idx: number) => {
  const boxId = fusionDialog.value.boxId;
  fusionDialog.value.open = false;
  if (boxId >= 0) fuseSeriesIntoBox(idx, boxId);
};

// ===== Fusion box 単位の auto-registration =====
//
// 既存の「Auto-register MR ↔ PET」(App のハンバーガー) は store の mrVolumeRef/petVolumeRef に
// 固定されている。ここでは **その box の base / overlay** を対象にするので、
// 別 study の CT と PET を d&d で重ねたケース (FrameOfReference が違うのでズレる) も直せる。
// 動かすのは overlay 側 volume の幾何 (imagePosition / vector*)。snapshot は volume に紐づけて保持。
const boxRegisterBusy = ref<number | null>(null);
const registerSnapshots = new WeakMap<Volume.Volume, any>();

// opts.fromCurrent = true: **いまの姿勢 (手動調整の結果) を開始点**にして MI 最適化する。
//   手で大まかに合わせてから機械に詰めさせる用途。ユーザが明示的に押したときだけなので
//   同一 FrameOfReference のスキップも適用しない。
const onBoxAutoRegister = async (boxId: number, opts?: { fromCurrent?: boolean }) => {
  const info = imageBoxInfos.value[boxId] as FusedVolumeImageBoxInfo | undefined;
  if (!info || !('clut1' in (info as any))) { alert('This box is not a fusion box.'); return; }
  const fixed = seriesList[info.currentSeriesNumber]?.volume;
  const moving = seriesList[info.currentSeriesNumber1]?.volume;
  if (!fixed || !moving) { alert('Both series need a reconstructed volume.'); return; }
  if (fixed === moving) return;

  boxRegisterBusy.value = boxId;
  try {
    const [{ registerMrToPt, centroidInitParams, assessFeasibility }, tf] = await Promise.all([
      import('./registration/registerMrPt'),
      import('./registration/transform'),
    ]);
    let snap = registerSnapshots.get(moving);
    if (!snap) { snap = tf.captureRegistrationSnapshot(moving); registerSnapshots.set(moving, snap); }
    // MI は moving の **現在の幾何** に params を掛けて評価するので、開始姿勢は
    // 必ず identity に戻し、「どこから探すか」は params (startParams) で表現する。
    const startParams = (opts?.fromCurrent ? [...(snap.currentParams as number[])] : [0, 0, 0, 0, 0, 0]) as any;
    // auto-register 全体で 1 undo ステップ。以降この関数内は setVolumeRegistration しか
    // 呼ばない (= push しない) ので、ここで 1 回積めば過不足ない。
    regUndoLastUid = null;   // 直前の手動 nudge と同一ステップにまとめない
    pushRegUndo(moving);
    regUndoLastUid = null;   // 次の手動操作も新しいステップから始める
    // 元の姿勢に戻してから開始。**store 側も同時に戻す**ので、下の early return
    // (同一 FoR) で抜けても画面と保存内容が食い違わない。
    setVolumeRegistration(moving, [0, 0, 0, 0, 0, 0]);
    await new Promise(r => setTimeout(r, 30));                 // spinner を反映

    // **同一 FrameOfReference なら位置合わせしない。**
    // 同 FoR = 同一装置が同一座標系で撮ったもの (PET/CT 一体機など) で、**既に正解**。
    // ここに MI 最適化を掛けると、MI が装置の位置合わせより「良い」と誤判定して壊す。
    //   実測 (Hirata の PET TRANSAXIAL × CT TRANSAXIAL+, 同 FoR):
    //     重心+粗探索あり → 311.6mm 移動 / identity から最適化のみ → それでも 115.2mm 移動。
    //   MI は全身 PET/CT では十分に鋭くないので、ハードウェアの位置合わせを覆させない。
    const sameFor = !!frameOfRefOf(info.currentSeriesNumber) &&
                    frameOfRefOf(info.currentSeriesNumber) === frameOfRefOf(info.currentSeriesNumber1);
    if (sameFor && !opts?.fromCurrent) {
      alert('These two series share the same frame of reference — they are already aligned by the scanner. '
          + 'Auto-registration was skipped so the existing alignment is not disturbed.');
      return;
    }

    // 別 FoR (別スキャナ / 別 study を drag&drop で重ねた等) のみ位置合わせする。
    const mi = await import('./registration/mi');
    const samples = mi.generateFixedSamples(fixed, 8000, 20260728);
    const stats = mi.estimateIntensityRange(fixed, moving, samples);
    const scoreOf = (p: any) => mi.computeNegativeMI(fixed, moving, samples, stats, p);

    // ===== 適用可否の判定 → ① 重心で粗く → ② MI で精密に =====
    //
    // **視野が大きく食い違うペアでは自動位置合わせを走らせない。**
    // hirata2 (CT=胸部のみ × PET=全身) の実測では、MI/NMI/形状のどの指標も正解を指さず、
    // 走らせると 48mm 悪化した (読み込み時点ではほぼ合っていた)。詳細は
    // registration/registerMrPt.ts の assessFeasibility のコメント。
    const feas = assessFeasibility(fixed, moving);
    if (!feas.ok && !opts?.fromCurrent) {
      alert([
        'Auto-registration was not run.',
        '',
        feas.reason,
        '',
        'Use "Adjust alignment manually" instead. In this situation the images are often',
        'already close as acquired, and automatic registration tends to make them worse.',
      ].join('\n'));
      return;
    }
    const startScore = scoreOf(startParams);
    let start: any = startParams;
    if (!opts?.fromCurrent && feas.centroidUsable) {
      // 重心合わせは **視野が同等のときだけ** 有効。
      // 一方が他方の一部しか写していないと、両者の体重心は別の解剖学的高さを指す
      // (実測 hirata2: tz=+159.8mm と出た)。
      const centroid = centroidInitParams(fixed, moving);
      // 重なりが無い姿勢では MI が 0 を返し、重なった姿勢の負の値より必ず大きい (= 悪い)
      // ので、この比較で自然に「寄せた方」が選ばれる。
      if (scoreOf(centroid) < startScore) start = centroid;
    }

    const res = registerMrToPt(fixed, moving, start);
    // **最終結果が開始位置より悪ければ適用しない。** registration が状況を悪化させないための保険。
    const finalScore = scoreOf(res.params);
    const chosen = finalScore <= startScore ? res.params : start;
    // 実測上、この MI は全身 PET/CT では補正力が乏しく「ほとんど動かない」ことがある。
    // 何も起きなかったように見えて不信感を招くので、動かなかったときは手動調整へ誘導する。
    const movedMm = Math.hypot(chosen[0] - startParams[0], chosen[1] - startParams[1], chosen[2] - startParams[2]);
    if (movedMm < 2) {
      alert('Auto-registration could not improve the alignment (it moved the overlay by less than 2 mm).\n\n'
          + 'Mutual-information registration is weak on whole-body PET/CT. '
          + 'Use "Adjust alignment manually" to line them up by hand, then "Refine with auto" to polish.');
    }
    // NOTE: ここで evictVolumeTexture は **不要**。GPU texture が持つのは voxel だけで、
    // 幾何 (p00/v01/v10) は描画ごとに CPU 側で volume から作り直して uniform で渡している。
    // 捨てると数百 MB の再アップロードが走るだけ (手動調整をリアルタイムにするため撤去)。
    setVolumeRegistration(moving, chosen);
    show();
  } catch (err: any) {
    alert('Registration failed: ' + (err?.message ?? err));
  } finally {
    boxRegisterBusy.value = null;
  }
};

const onBoxResetRegister = async (boxId: number) => {
  const info = imageBoxInfos.value[boxId] as FusedVolumeImageBoxInfo | undefined;
  const moving = info ? seriesList[info.currentSeriesNumber1]?.volume : null;
  if (!moving) return;
  const snap = registerSnapshots.get(moving);
  if (!snap) return;
  pushRegUndo(moving);
  setVolumeRegistration(moving, [0, 0, 0, 0, 0, 0]);
  show();
};

// ===== LLM に開放する読み取り専用ツールの実体 =====
//
// 定義 (JSON schema) は components/llm/tools.ts。ここは状態を持つ側なので実装だけ置く。
// **返す JSON は小さく保つこと。** 4B クラスのモデルでは、16 series 分の冗長な情報だけで
// 文脈を食い潰して指示に従えなくなる。数値は丸め、UID のような長い文字列は返さない。
// **番号は 1 始まり**で返す。0 始まりだと小さいモデルが「PET が 2 枚」のように
// 誤読する (実測: qwen2.5:3b が box 0/1 の 2 box を「CT 1 枚 + PET 2 枚」と答えた)。
// 将来 LLM から操作させるときは、この 1 始まりを内部の 0 始まりへ戻すこと。
const llmListSeries = () => {
  const list = seriesSummaries.value;
  // 要約文を **先に** 置く。小さいモデルは配列を数え直すのが苦手なので、
  // 数える作業をこちらで済ませて、モデルには言い換えだけさせる。
  const summary = list.length === 0
    ? 'No series are loaded.'
    : `${list.length} series ${list.length === 1 ? 'is' : 'are'} loaded: `
      + list.map((s, i) => `(${i + 1}) ${s.modality} "${s.description || 'no description'}", ${s.fileCount} slices`)
            .join('; ') + '.';
  return {
    summary,
    count: list.length,
    series: list.map((s, i) => ({
      no: i + 1,
      modality: s.modality,
      description: s.description || '(no description)',
      slices: s.fileCount,
      matrix: s.matrixSize,
      voxelMm: s.voxelSize,
      source: s.sourceType,
      reconstructed: !!s.hasVolume,
    })),
  };
};

const llmDescribeView = () => {
  const n = tileN.value ?? 0;
  const boxes: Record<string, unknown>[] = [];
  const phrases: string[] = [];
  for (let i = 0; i < n; i++) {
    const info = boxInfoAt(i) as any;
    if (!info) continue;
    const rendering = getBoxRendering(i);
    const paging = getBoxPaging(i);
    const fused = isBoxFused(i);
    const shows = seriesSummaries.value[info.currentSeriesNumber]?.description || `series ${info.currentSeriesNumber + 1}`;
    // rendering と modality を 1 つの語にまとめる。別々に出すと
    // 「CT が native で PT が 2 枚」のように取り違えられる。
    const kind = fused
      ? `fusion of ${getBoxModalityLabel(i)} with "${seriesSummaries.value[info.currentSeriesNumber1]?.description ?? '?'}"`
      : `${getBoxModalityLabel(i)} ${rendering === 'native' ? 'slice' : rendering.toUpperCase()}`;
    const slice = paging ? `, slice ${paging.index - paging.min + 1}/${paging.max - paging.min + 1}` : '';
    const sel = i === selectedImageBoxId.value ? ' (selected)' : '';
    phrases.push(`box ${i + 1} shows ${kind} "${shows}"${slice}${sel}`);

    const b: Record<string, unknown> = {
      no: i + 1,
      selected: i === selectedImageBoxId.value,
      shows,
      modality: getBoxModalityLabel(i),
      rendering,                       // native | mpr | mip | smip | vr
      fused,
    };
    if (fused) b.overlay = seriesSummaries.value[info.currentSeriesNumber1]?.description ?? '?';
    if (rendering !== 'native') b.plane = getBoxCurrentPlane(i);
    if (paging) b.slice = `${paging.index - paging.min + 1}/${paging.max - paging.min + 1}`;
    if (info.myWC != null && info.myWW != null) b.window = { wc: Math.round(info.myWC), ww: Math.round(info.myWW) };
    boxes.push(b);
  }
  const mask = segStore.finalMask ? { present: true, labels: segStore.labels.map(l => l.name) }
                                  : { present: false };
  const summary = boxes.length === 0
    ? 'No image boxes are displayed.'
    : `${boxes.length} image ${boxes.length === 1 ? 'box is' : 'boxes are'} on screen: `
      + phrases.join('; ') + '.'
      + (mask.present ? ' A segmentation mask is loaded.' : ' No segmentation mask yet.');
  return {
    summary,
    boxCount: boxes.length,
    syncPaging: !!syncImageBox.value,
    selectedBox: selectedImageBoxId.value + 1,
    petLoaded: !!segStore.petVolumeRef,
    ctLoaded: !!segStore.ctVolumeRef,
    segmentation: mask,
    boxes,
  };
};

// ===== 手動 alignment =====
//
// auto-registration が外したとき (MI の局所解、FOV の食い違い、体位差など) に
// **人が見て直せる**手段。動かすのは fusion box の overlay 側 volume。
// 操作は「画面で見えている向き」で行う: box の vecx (右) / vecy (下) / vecz (奥) を基準に
// world の平行移動を作るので、axial でも coronal でも直感どおりに動く。
const manualAlignBoxId = ref<number | null>(null);
const manualStepMm = ref(2);
const manualStepDeg = ref(2);
// 幾何は THREE.Vector3 の in-place mutation なので Vue は変化を検知できない。
// パネルの数値表示を追従させるための version カウンタ (boxStateVersion と同じ作法)。
const manualAlignVersion = ref(0);

const fusedMovingVolume = (boxId: number): Volume.Volume | null => {
  if (!isFusedImageBoxInfo(boxId)) return null;
  const info = imageBoxInfos.value[boxId] as FusedVolumeImageBoxInfo;
  return seriesList[info.currentSeriesNumber1]?.volume ?? null;
};

const regSnapshotOf = (vol: Volume.Volume) => {
  let s = registerSnapshots.get(vol);
  if (!s) { s = regTf.captureRegistrationSnapshot(vol); registerSnapshots.set(vol, s); }
  return s;
};

// ===== registration の undo =====
//
// mask 編集の履歴 (store の history) とは別建てにしてある。あちらは voxel の sparse diff で、
// 位置合わせは 6 個の数値なので、同じ仕組みに載せる利点が無く、
// 「マスクを戻したいのか位置を戻したいのか」が混ざると分かりにくいため。
// 手動 alignment 中の Ctrl+Z とパネルの ↶ ボタンから引く。永続化はしない。
const REG_UNDO_MAX = 50;
const REG_UNDO_COALESCE_MS = 400;
const regUndoStack = ref<Array<{ seriesUID: string; params: number[] }>>([]);
let regUndoLastAt = 0;
let regUndoLastUid: string | null = null;

// 変更の **直前** の姿勢を積む。ドラッグやキーリピートで 1px ずつ積むと使い物にならないので、
// 同じ series への連続操作が 400ms 以内なら 1 ステップにまとめる。
const pushRegUndo = (vol: Volume.Volume) => {
  const uid = vol.metadata?.seriesUID;
  if (!uid) return;
  const now = performance.now();
  if (uid === regUndoLastUid && now - regUndoLastAt < REG_UNDO_COALESCE_MS) {
    regUndoLastAt = now;
    return;
  }
  const cur = registerSnapshots.get(vol)?.currentParams ?? [0, 0, 0, 0, 0, 0];
  regUndoStack.value.push({ seriesUID: uid, params: [...(cur as number[])] });
  if (regUndoStack.value.length > REG_UNDO_MAX) regUndoStack.value.shift();
  regUndoLastAt = now;
  regUndoLastUid = uid;
};

const canUndoRegistration = () => regUndoStack.value.length > 0;

const undoRegistration = (): boolean => {
  const e = regUndoStack.value.pop();
  if (!e) return false;
  regUndoLastUid = null;    // 次の操作は必ず新しいステップとして積む
  for (const s of seriesList) {
    const v = s?.volume;
    if (!v || v.metadata?.seriesUID !== e.seriesUID) continue;
    setVolumeRegistration(v, e.params);
    show();
    return true;
  }
  return false;
};

// volume の幾何を params に合わせ、**永続化用の写しも同時に更新**する。
// registration を変える経路は必ずここを通すこと (auto / 手動 / reset / snapshot 復元)。
// そうしないと画面と .mvs / auto-save の内容が食い違う。
const setVolumeRegistration = (vol: Volume.Volume, params: readonly number[]) => {
  const snap = regSnapshotOf(vol);
  regTf.applyRigidToVolume(vol, snap, params as any);
  segStore.setRegistration(vol.metadata?.seriesUID, params);
  manualAlignVersion.value++;
};

// snapshot / auto-save から復元した registration を、いま読み込まれている volume に掛け直す。
// 対応は **seriesUID**。該当シリーズが無ければ黙って飛ばす (別症例を開いている場合)。
const applyStoredRegistrations = (): number => {
  let n = 0;
  for (const rec of segStore.registrations) {
    for (const s of seriesList) {
      const v = s?.volume;
      if (!v || v.metadata?.seriesUID !== rec.seriesUID) continue;
      regTf.applyRigidToVolume(v, regSnapshotOf(v), rec.params as any);
      n++;
    }
  }
  if (n > 0) { manualAlignVersion.value++; show(); }
  return n;
};

// 手動 alignment を出してよい box か。
// **投影系 (MIP/sMIP/VR) は除外する。** 断面が無いので
//   - through-plane 移動が投影方向そのもので、MIP では見た目がほとんど変わらない
//   - そもそも投影像では「合っているか」を目視で判断できない
// ため、調整の場として不適切 (paging を null にしているのと同じ理由)。
const canManualAlign = (boxId: number): boolean =>
  isFusedImageBoxInfo(boxId) && !isProjectionInfo(boxInfoAt(boxId));

// パネル表示用: overlay の現在オフセット (translation mm / rotation deg)
const getBoxManualAlign = (boxId: number) => {
  void manualAlignVersion.value;
  if (!canManualAlign(boxId)) return null;
  const vol = fusedMovingVolume(boxId);
  const p = (vol ? registerSnapshots.get(vol)?.currentParams : null) ?? [0, 0, 0, 0, 0, 0];
  const deg = (r: number) => r * 180 / Math.PI;
  return {
    active: manualAlignBoxId.value === boxId,
    stepMm: manualStepMm.value,
    stepDeg: manualStepDeg.value,
    canUndo: regUndoStack.value.length > 0,
    tx: p[0], ty: p[1], tz: p[2],
    rx: deg(p[3]), ry: deg(p[4]), rz: deg(p[5]),
    shift: Math.hypot(p[0], p[1], p[2]),
    overlayName: vol?.metadata?.seriesDescription ?? 'overlay',
  };
};

const applyRegDelta = (boxId: number, delta: THREE.Matrix4) => {
  const vol = fusedMovingVolume(boxId);
  if (!vol) return;
  const snap = regSnapshotOf(vol);
  pushRegUndo(vol);
  setVolumeRegistration(vol, regTf.composeWorldDelta(snap.currentParams, delta));
  show();   // 同じ overlay を映している他の box も一緒に更新する
};

// 画面基準の平行移動 (mm)。right = box の vecx 方向、up = 画面上方向 (= -vecy)、
// through = vecz 方向 (奥へ)。
const nudgeRegister = (boxId: number, rightMm: number, upMm: number, throughMm: number) => {
  const info = imageBoxInfos.value[boxId] as VolumeImageBoxInfo | undefined;
  if (!info?.vecx || !info.vecy || !info.vecz) return;
  const d = info.vecx.clone().normalize().multiplyScalar(rightMm)
    .add(info.vecy.clone().normalize().multiplyScalar(-upMm))
    .add(info.vecz.clone().normalize().multiplyScalar(throughMm));
  applyRegDelta(boxId, regTf.translationDelta(d));
};

// 面内回転。回転中心は **いま見えている断面の中心** (centerInWorld)。
// volume 重心にすると画面外を軸に回ることがあり、手で合わせる操作としては直感に反する。
//
// 回転軸に **vecz を使ってはいけない**。vecz の符号はデータ依存 (スライス順が
// 頭→足か足→頭か) なので、同じ「⟳」ボタンが症例によって逆回りになる。
// 画面の右 (vecx) × 下 (vecy) = 奥向き を軸にすれば、正の角度が常に画面上の
// 時計回りになる (右手系で vecx が vecy 側へ倒れる = right→down = 時計回り)。
const rotateRegister = (boxId: number, deg: number) => {
  const info = imageBoxInfos.value[boxId] as VolumeImageBoxInfo | undefined;
  if (!info?.vecx || !info.vecy || !info.centerInWorld) return;
  const intoScreen = info.vecx.clone().cross(info.vecy);
  if (intoScreen.lengthSq() === 0) return;
  applyRegDelta(boxId, regTf.rotationDeltaAbout(intoScreen, deg * Math.PI / 180, info.centerInWorld));
};

const onBoxToggleManualAlign = (boxId: number) => {
  if (manualAlignBoxId.value === boxId) { manualAlignBoxId.value = null; return; }
  if (!canManualAlign(boxId)) return;   // 投影系 / 非 fusion では開かない
  manualAlignBoxId.value = boxId;
  selectedImageBoxId.value = boxId;
};

const onBoxManualNudge = (boxId: number, e: { right?: number; up?: number; through?: number; rot?: number }) => {
  if (e.rot) { rotateRegister(boxId, e.rot * manualStepDeg.value); return; }
  nudgeRegister(boxId,
    (e.right ?? 0) * manualStepMm.value,
    (e.up ?? 0) * manualStepMm.value,
    (e.through ?? 0) * manualStepMm.value);
};

// series の modality (DICOM タグ優先、無ければ volume metadata)
const seriesModality = (idx: number): string => {
  const s = seriesList[idx];
  if (!s) return '';
  const dl = s.myDicom;
  if (dl && dl.length > 0) return (dl[0].string('x00080060') ?? '').toUpperCase();
  return (s.volume?.metadata?.modality ?? '').toUpperCase();
};
const isPtModality = (m: string) => m === 'PT' || m === 'PET';

// サイドバーから box へ drop したとき「差し替え」か「重ねる」かの判定。
// PT を CT/MR の box に落とした (またはその逆) なら、重ねたい意図と解釈して fusion に昇格する。
// 同じ modality 同士なら単純な差し替え。
const shouldFuseOnDrop = (srcSeriesIdx: number, tgtBoxId: number): boolean => {
  const info = imageBoxInfos.value[tgtBoxId] as any;
  if (!info) return false;
  if ('clut1' in info) return true;              // 既に Fusion box → overlay を差し替える形で融合継続
  if (isProjectionInfo(info)) return false;     // MIP/VR には重ねられない
  const tgtSeriesIdx = info.currentSeriesNumber;
  if (tgtSeriesIdx == null || tgtSeriesIdx === srcSeriesIdx) return false;
  const src = seriesModality(srcSeriesIdx);
  const tgt = seriesModality(tgtSeriesIdx);
  if (!src || !tgt) return false;
  return isPtModality(src) !== isPtModality(tgt);   // 片方だけ PT = 補完関係
};

// box が無い場所に drop されたとき: tile を 1 つ増やして末尾の新 box に表示する。
const appendSeriesAsNewBox = (seriesIdx: number) => {
  const newId = tileN.value ?? 0;
  tileN.value = newId + 1;
  // tileN を増やしただけでは infos が伸びないので、appendNewSeriesAsBoxes と同じ作法で埋める
  while (imageBoxInfos.value.length <= newId) {
    imageBoxInfos.value.push(defaultInfo(imageBoxInfos.value.length));
  }
  nextTick().then(() => {
    onSelectSeriesIntoBox(seriesIdx, newId);
    selectedImageBoxId.value = newId;
    autoFitMode.value = true;
    applyAutoFit();
  });
};

const fuseSeriesIntoBox = (srcSeriesIdx: number, tgtBoxId: number) => {
  if (tgtBoxId < 0 || tgtBoxId >= imageBoxInfos.value.length) return;

  let tgtSeriesIdx: number;
  let tgtCenter: THREE.Vector3, tgtVecx: THREE.Vector3, tgtVecy: THREE.Vector3, tgtVecz: THREE.Vector3;

  if (isDicomSliceImageBoxInfo(tgtBoxId)) {
    // DicomSlice target: 当該 series を MPR してから Volume center/vec を導出 (axial 既定)
    const tInfo = imageBoxInfos.value[tgtBoxId] as DicomSliceImageBoxInfo;
    tgtSeriesIdx = tInfo.currentSeriesNumber;
    if (tgtSeriesIdx == null || tgtSeriesIdx < 0 || tgtSeriesIdx >= seriesList.length) return;
    if (srcSeriesIdx === tgtSeriesIdx) return;  // 同 series 早期 return
    // ensureVolume_ は box[i] を巻き込まずに volume だけ生成 (mpr_ と異なり imageBoxInfos[i] を上書きしない)
    if (!ensureVolume_(tgtSeriesIdx)) {
      alert('Cannot create volume for the target series — fusion aborted.');
      return;
    }
    const v = seriesList[tgtSeriesIdx].volume!;
    // **落とされた側 (通常 CT) の見え方を変えない。**
    // DICOM box は「zoom = box px / 画像 px」で拡大率を持ち、Volume box は
    // 「vecx = 1 画面 px あたりの world mm」で持つ。単位が違うので v.vectorX を
    // そのまま使うと融合した瞬間に倍率が飛ぶ (ユーザ報告)。
    //   |vectorX| = voxel pitch(mm/画像px) なので、mm/画面px = pitch / zoom。
    const tgtZoom = tInfo.zoom ?? 1;
    tgtVecx = v.vectorX.clone().multiplyScalar(1 / tgtZoom);
    tgtVecy = v.vectorY.clone().multiplyScalar(1 / tgtZoom);
    tgtVecz = v.vectorZ.clone();
    // 表示中のスライスも保つ (中央スライスへ飛ばない)。pan (centerX/Y) も画像 px なので world へ。
    const k = Math.min(Math.max(0, tInfo.currentSliceNumber ?? 0), Math.max(0, v.nz - 1));
    tgtCenter = voxelToWorld_(
      new THREE.Vector3(v.nx / 2 + (tInfo.centerX ?? 0), v.ny / 2 + (tInfo.centerY ?? 0), k),
      tgtSeriesIdx);
  } else if (isAnyVolumeBox(tgtBoxId)) {
    // Volume / Fusion target: 既存 plane を保持
    const tgtInfoBefore = imageBoxInfos.value[tgtBoxId] as VolumeImageBoxInfo;
    if (isProjectionInfo(tgtInfoBefore)) {
      alert('Cannot fuse onto MIP or VR boxes.');
      return;
    }
    tgtSeriesIdx = tgtInfoBefore.currentSeriesNumber;
    if (srcSeriesIdx === tgtSeriesIdx) return;
    tgtCenter = tgtInfoBefore.centerInWorld.clone();
    tgtVecx = tgtInfoBefore.vecx.clone();
    tgtVecy = tgtInfoBefore.vecy.clone();
    tgtVecz = tgtInfoBefore.vecz.clone();
  } else {
    alert('Drop target box is not supported.');
    return;
  }

  // src の Volume が無ければ生成 (DICOM 必須)。box[srcSeriesIdx] は触らないので drag 元 box は不変。
  if (!ensureVolume_(srcSeriesIdx)) {
    alert('Cannot create volume for the dragged series — fusion aborted.');
    return;
  }

  const srcMod = (seriesList[srcSeriesIdx].volume?.metadata?.modality ?? '').toUpperCase();
  const tgtMod = (seriesList[tgtSeriesIdx].volume?.metadata?.modality ?? '').toUpperCase();

  // 振り分け: PT は overlay、CT/MR/OTHER は base
  let baseIdx: number, overlayIdx: number;
  if (srcMod === 'PT' || srcMod === 'PET') {
    baseIdx = tgtSeriesIdx; overlayIdx = srcSeriesIdx;
  } else if (tgtMod === 'PT' || tgtMod === 'PET') {
    baseIdx = srcSeriesIdx; overlayIdx = tgtSeriesIdx;
  } else {
    baseIdx = tgtSeriesIdx; overlayIdx = srcSeriesIdx;
  }

  const baseModFinal = (seriesList[baseIdx].volume?.metadata?.modality ?? '').toUpperCase();
  const overlayModFinal = (seriesList[overlayIdx].volume?.metadata?.modality ?? '').toUpperCase();

  // Base: gray CLUT。CT は HU 40/400, それ以外は 0/1000 既定
  const baseClut = 0;
  const baseWC = baseModFinal === 'CT' ? 40 : 0;
  const baseWW = baseModFinal === 'CT' ? 400 : 1000;
  // Overlay: PT なら rainbow + SUV 3/6、それ以外は gray 0/1000
  const isPtOverlay = (overlayModFinal === 'PT' || overlayModFinal === 'PET');
  const overlayClut = isPtOverlay ? 2 : 0;
  const overlayWC = isPtOverlay ? 3 : 0;
  const overlayWW = isPtOverlay ? 6 : 1000;

  imageBoxInfos.value[tgtBoxId] = {
    centerInWorld: tgtCenter,
    vecx: tgtVecx,
    vecy: tgtVecy,
    vecz: tgtVecz,
    clut: baseClut,
    clut1: overlayClut,
    currentSeriesNumber: baseIdx,
    currentSeriesNumber1: overlayIdx,
    description: 'Fusion',
    myWC: baseWC, myWW: baseWW,
    myWC1: overlayWC, myWW1: overlayWW,
    isMip: false,
    mip: null,
    overlayAlpha: 0.5,  // 既定 50/50。titlebar slider で変更可。
  } as FusedVolumeImageBoxInfo;

  refreshSegStoreVolumeRefs();
  showImage(tgtBoxId);
};

// 融合の解除: overlay 層を捨てて **base 単独の Volume box** に戻す。
// d&d で重ねたあと元に戻す手段が無い、というユーザ報告への対応。
// 断面・倍率・pan はそのまま引き継ぐ (解除で視野が飛ばない)。
const unfuseBox = (boxId: number) => {
  if (!isFusedImageBoxInfo(boxId)) return;
  const f = imageBoxInfos.value[boxId] as FusedVolumeImageBoxInfo;
  if (manualAlignBoxId.value === boxId) manualAlignBoxId.value = null;
  imageBoxInfos.value[boxId] = {
    clut: f.clut ?? 0,
    myWC: f.myWC ?? null,
    myWW: f.myWW ?? null,
    description: seriesSummaries.value[f.currentSeriesNumber]?.description ?? '',
    currentSeriesNumber: f.currentSeriesNumber,
    centerInWorld: f.centerInWorld.clone(),
    vecx: f.vecx.clone(),
    vecy: f.vecy.clone(),
    vecz: f.vecz.clone(),
    interpolation: f.interpolation,
    isMip: false,
    mip: null,
  } as VolumeImageBoxInfo;
  refreshSegStoreVolumeRefs();
  boxStateVersion.value++;
  showImage(boxId);
};

const doOneOrAll = (id: number, action: (i:number) => void ) => {
  if (syncImageBox.value){
    for (let i=0; i<imb.value!.length; i++){
      // 発信元 (id) は常に実行、それ以外は per-box opt-out 判定
      if (i !== id && !isBoxSyncEnabled(i)) continue;
      action(i);
    }
  }else{
    action(id);
  }
}

// Sync paging compatibility: src と tgt が「同じ plane で paging できる」関係にあるか。
// MIP / VR は paging ではなく回転なので連動しない (axial で paging しているのに MIP が
// 勝手に回転するのを防ぐ)。Volume/Fusion 同士なら vecz が平行 (cosθ > 0.95、約 18°以内) で同 plane。
// DicomSlice は plane 概念を持たないので常に許可。
const isSyncPagingCompatible = (srcId: number, tgtId: number): boolean => {
  if (srcId === tgtId) return true;
  const src = imageBoxInfos.value[srcId] as VolumeImageBoxInfo | undefined;
  const tgt = imageBoxInfos.value[tgtId] as VolumeImageBoxInfo | undefined;
  if (!src || !tgt) return false;
  // src or tgt が MIP/VR なら paging 連動しない (回転と paging が混在しないように)
  if (isProjectionInfo(src) || isProjectionInfo(tgt)) return false;
  // DicomSlice は paging 概念に互換性あり
  if (isDicomSliceImageBoxInfo(srcId) || isDicomSliceImageBoxInfo(tgtId)) return true;
  // Volume/Fusion: vecz の方向が平行なら同 plane
  if (!src.vecz || !tgt.vecz) return true;  // 不明なら許可
  const sn = src.vecz.clone().normalize();
  const tn = tgt.vecz.clone().normalize();
  const cosT = Math.abs(sn.x * tn.x + sn.y * tn.y + sn.z * tn.z);
  return cosT > 0.95;
};

// 同 plane の paging 同期版 doOneOrAll (wheel paging / mouseMove page tool 用)
const doOneOrAllSamePlane = (id: number, action: (i:number) => void) => {
  if (syncImageBox.value){
    for (let i=0; i<imb.value!.length; i++){
      if (i !== id && !isBoxSyncEnabled(i)) continue;
      if (i !== id && !isSyncPagingCompatible(id, i)) continue;
      action(i);
    }
  } else {
    action(id);
  }
}

// Pan の実体ロジック（左ボタン pan ツール / Ctrl+中ボタン から共通利用）
// 注意: target box i ごとに DICOM/Volume を判定する。source id では sync 群内で
// 混合 (DICOM + Volume) すると panning が破綻するため。
const doPan = (id: number, dx: number, dy: number) => {
  const info = getDicomSliceImageBoxInfo;
  const infoV = getVolumeImageBoxInfo;
  // sync pan は同 plane の box のみ連動 (axial を pan したときに MIP/直交断面が
  // 一緒に動かないように)。paging と同じ isSyncPagingCompatible 判定を使う。
  doOneOrAllSamePlane(id, (i:number) => {
    if (isDicomSliceImageBoxInfo(i)){
      const zoom = info(i).zoom!;
      info(i).centerX -= dx / zoom;
      info(i).centerY -= dy / zoom;
    }else{
      const a = infoV(i);
      a.centerInWorld.x -= (dx * a.vecx.x + dy * a.vecy.x);
      a.centerInWorld.y -= (dx * a.vecx.y + dy * a.vecy.y);
      a.centerInWorld.z -= (dx * a.vecx.z + dy * a.vecy.z);
    }
    showImage(i);
  });
};

// Window/Level drag を実体化したヘルパ。
//   - leftButtonFunction = 'window' の左ドラッグ
//   - 任意のツール中の右クリックドラッグ
//   いずれからも呼び出される。
const applyWindowLevelDrag = (id: number, mvX: number, mvY: number) => {
  const info = getDicomSliceImageBoxInfo;
  // Fusion box かつ active layer = overlay なら overlay 側 (myWC1/myWW1) を変更
  // それ以外 (Volume / DicomSlice / Fusion-base) は myWC/myWW を変更
  const isFusionOverlay = isFusedImageBoxInfo(id)
    && (imageBoxInfos.value[id] as FusedVolumeImageBoxInfo).activeWindowLayer !== 'base';
  let wc: number | null, ww: number | null;
  if (isFusionOverlay) {
    const f = imageBoxInfos.value[id] as FusedVolumeImageBoxInfo;
    wc = f.myWC1; ww = f.myWW1;
  } else {
    [wc, ww] = getMyWCWW(id);
  }
  // 旧 fallback: DICOM タグから値を読む。DICOM slice box でだけ意味がある。
  if (wc === null && isDicomSliceImageBoxInfo(id)) {
    const ds = seriesList[info(id).currentSeriesNumber]?.myDicom?.[info(id).currentSliceNumber];
    if (ds) wc = Number(ds.string('x00281050', 0)) || 0;
    else wc = 0;
  }
  if (ww === null && isDicomSliceImageBoxInfo(id)) {
    const ds = seriesList[info(id).currentSeriesNumber]?.myDicom?.[info(id).currentSliceNumber];
    if (ds) ww = Number(ds.string('x00281051', 0)) || 1;
    else ww = 1;
  }
  if (wc === null) wc = 0;
  if (ww === null) ww = 1;
  const dmul = getBoxPetDisplayMul(id);
  const minWW = dmul !== 0 ? 1 / dmul : 1;
  wc += mvY / dmul;
  ww += mvX / dmul;
  if (ww < minWW) ww = minWW;
  if (isFusionOverlay) {
    const f = imageBoxInfos.value[id] as FusedVolumeImageBoxInfo;
    f.myWC1 = wc; f.myWW1 = ww;
  } else {
    setMyWCWW(id, wc, ww);
  }
  show();
};

// 右クリックドラッグ中フラグ。mouseup で false に戻す。
// onContextMenu でこのフラグが true なら menu を抑止 (drag 完了で menu 出さない)。
const rightDragActive = ref(false);

// 矩形 ROI ドラッグ中の一時状態 (screen 座標)。null = ドラッグ中でない。
// 確定すると segStore.rectRois に voxel 座標で push される。
const rectRoiDraft = ref<{ boxId: number; x0: number; y0: number; x1: number; y1: number } | null>(null);

// Polygon 描画中に「最後の確定頂点 → カーソル」を結ぶラバーバンド線のプレビュー座標。
// null = プレビューなし。頂点確定 / finalize / cancel でクリアする。
const polygonCursor = ref<[number, number] | null>(null);

// Voxel brush ツール選択中の、カーソル位置のブラシ円プレビュー (canvas 座標)。
// box から出たら null。ブラシサイズを視覚化する目的。
const brushCursor = ref<{ boxId: number; x: number; y: number } | null>(null);

const mouseMove = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  const infoV = getVolumeImageBoxInfo;

  // デバッグ: マウス位置の voxel 値を更新
  if (debugMode.value && e.buttons === 0){
    updateDebugHover(id, e);
  }

  // 中ボタンドラッグで常時 Pan（ツール選択に関係なく）
  // e.buttons のビット: 1=左, 2=右, 4=中。
  if ((e.buttons & 4) !== 0){
    doPan(id, e.movementX, e.movementY);
    return;
  }

  // 手動 alignment 中の box: **Shift + 左ドラッグ**で overlay を面内移動。
  // Shift 必須にしてあるのは、調整中でも window/pan など通常ツールを使えるようにするため。
  if (manualAlignBoxId.value === id && (e.buttons & 1) !== 0 && e.shiftKey && canManualAlign(id)){
    const a = imageBoxInfos.value[id] as VolumeImageBoxInfo | undefined;
    if (a?.vecx && a.vecy){
      // px → mm は box の vec 長 (1 px あたりの world 距離) で換算。zoom しても手応えが一致する。
      nudgeRegister(id, e.movementX * a.vecx.length(), -e.movementY * a.vecy.length(), 0);
    }
    return;
  }

  // 右ボタンドラッグで常時 Window/Level (ツール選択に関係なく)。
  // OHIF / RadiAnt 等の DICOM viewer の標準操作に揃える。
  if ((e.buttons & 2) !== 0){
    rightDragActive.value = true;
    applyWindowLevelDrag(id, e.movementX, e.movementY);
    return;
  }

  // Polygon 描画中: カーソルまでのラバーバンド線をライブ表示 (hover, ボタン非押下)。
  if (leftButtonFunction.value === "polygonROI" && segStore.polygon?.inProgress
      && segStore.polygon.imageBoxId === id && e.buttons === 0) {
    const [x, y] = getCanvasXY(e);
    polygonCursor.value = [x, y];
    showImage(id);   // base を再描画してから drawAnnotationOverlays でラバーバンドを重ねる
    return;
  }

  // Voxel brush: カーソル円プレビューを追従表示しつつ、左ドラッグ中は描画する。
  if (leftButtonFunction.value == "brushROI" && isVolumeImageBoxInfo(id)) {
    const [x, y] = getCanvasXY(e);
    brushCursor.value = { boxId: id, x, y };
    if ((e.buttons & 1) !== 0 && brushStroke.value?.boxId === id) {
      paintBrushAt(x, y);   // paintBrushAt 内で showImage する (カーソル円も一緒に再描画)
    } else if (e.buttons === 0) {
      showImage(id);        // hover: ブラシ円だけ追従再描画
    }
    return;
  }

  // 矩形 ROI: 左ボタンドラッグ中なら対角隅を追従。
  if (leftButtonFunction.value == "rectROI" && rectRoiDraft.value && (e.buttons & 1) !== 0) {
    if (rectRoiDraft.value.boxId === id) {
      const [x, y] = getCanvasXY(e);
      rectRoiDraft.value.x1 = x;
      rectRoiDraft.value.y1 = y;
      showImage(id);
    }
    return;
  }

  if (leftButtonFunction.value == "window") {
    if (e.buttons == 1) {
      applyWindowLevelDrag(id, e.movementX, e.movementY);
    }
  }

  if (leftButtonFunction.value == "page") {
    if (e.buttons == 1) {
      const srcInfo = imageBoxInfos.value[id] as VolumeImageBoxInfo | undefined;
      if (srcInfo?.isVr) {
        // VR: trackball 自由回転。
        //   左右 drag (movementX): camera up 軸 (vecy) 周りに回転 → vecx, vecz を回す
        //   上下 drag (movementY): camera right 軸 (vecx) 周りに回転 → vecy, vecz を回す
        //   Shift+drag movementX: camera forward 軸 (vecz) 周りに roll → vecx, vecy を回す
        const dx = e.movementX, dy = e.movementY;
        const rotSpeed = 0.005;    // rad / pixel
        const yaw   = dx * rotSpeed;
        const pitch = dy * rotSpeed;
        const roll  = e.shiftKey ? dx * rotSpeed : 0;
        const upAxis    = srcInfo.vecy.clone().normalize();
        const rightAxis = srcInfo.vecx.clone().normalize();
        const fwdAxis   = srcInfo.vecz.clone().normalize();
        if (yaw !== 0 && !e.shiftKey) {
          srcInfo.vecx.applyAxisAngle(upAxis, yaw);
          srcInfo.vecz.applyAxisAngle(upAxis, yaw);
        }
        if (pitch !== 0) {
          srcInfo.vecy.applyAxisAngle(rightAxis, pitch);
          srcInfo.vecz.applyAxisAngle(rightAxis, pitch);
        }
        if (roll !== 0) {
          srcInfo.vecx.applyAxisAngle(fwdAxis, roll);
          srcInfo.vecy.applyAxisAngle(fwdAxis, roll);
        }
        showImage(id);
      } else {
        // page tool drag は MIP/sMIP/通常スライスでは plane-aware paging
        doOneOrAllSamePlane(id, (i:number) => changeSlice(i, e.movementY));
        show();
      }
    }
  }

  if (leftButtonFunction.value == "zoom") {
    if (e.buttons == 1) {
      // 同 plane の box にだけ伝播 (MIP / VR は除外)。Ctrl+wheel zoom と同じ方針。
      doOneOrAllSamePlane(id, (i:number) => {
        if (isDicomSliceImageBoxInfo(i)){
          let r = 1.02;
          if (e.movementY > 0) r = 1 / r;
          const zoom = info(i).zoom ?? 1;
          info(i).zoom = zoom * r;
          showImage(i);
        }else{
          let r = Math.pow(1.02, e.movementY);
          const a = infoV(i);
          a.vecx.multiplyScalar(r);
          a.vecy.multiplyScalar(r);
          showImage(i);
        }
      });
    }
  }

  if (leftButtonFunction.value == "pan") {
    if (e.buttons == 1) {
      doPan(id, e.movementX, e.movementY);
    }
  }
}

const wheel = (e: WheelEvent) => {
  const id = getIdOfEventOccured(e);

  // Ctrl/Cmd + wheel → 即時ズーム（視野中心固定）
  // 同 plane の box にだけ伝播 (MIP / VR は除外)。axial をズームしているのに
  // MIP まで縮小してしまうのを防ぐ。
  if (e.ctrlKey || e.metaKey){
    e.preventDefault();
    const r = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    doOneOrAllSamePlane(id, (i: number) => {
      if (isDicomSliceImageBoxInfo(i)){
        const dInfo = getDicomSliceImageBoxInfo(i);
        const zoom = dInfo.zoom ?? 1;
        dInfo.zoom = zoom * r;
      } else if (isAnyVolumeBox(i)){
        // Volume / Fusion 共通: vecx/vecy を縮小すると画面上の mm 解像度が上がり拡大表示。
        // FusedVolumeImageBoxInfo にも vecx/vecy があるため同じ処理で OK。
        const a = getVolumeImageBoxInfo(i);
        a.vecx.multiplyScalar(1 / r);
        a.vecy.multiplyScalar(1 / r);
      }
      showImage(i);
    });
    return;
  }

  // 球 ROI ツール active かつ、マウスが球内 → 半径変更
  if (leftButtonFunction.value === "sphereROI" && segStore.sphere && segStore.petVolumeRef && isVolumeImageBoxInfo(id)){
    const [x, y] = getCanvasXY(e as unknown as MouseEvent);
    const w = screenToWorld(id, x, y);
    const c = segStore.sphere.centerWorld;
    const dx = w.x - c.x, dy = w.y - c.y, dz = w.z - c.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < segStore.sphere.radiusMm){
      const step = e.deltaY > 0 ? -2 : 2;
      let r = segStore.sphere.radiusMm + step;
      // 最小 5mm: これ未満だと球が小さすぎて再度大きくする際にカーソルが球内に入れられない。
      if (r < 5) r = 5;
      if (r > 200) r = 200;
      segStore.sphere.radiusMm = r;
      recomputeSphereStats();
      show();
      return;
    }
  }

  // wheel paging は plane-aware + world 座標同期 (axial paging で MIP が回転しない、
  // かつスライス厚が違う box 同士でも同じ world 断面に揃う)
  const change = e.deltaY > 0 ? 1 : -1;
  applySyncPaging(id, change);
  // crosshair を source box の through-plane vec で連動 (1 回だけ実行)
  if (segStore.crosshairWorld && isAnyVolumeBox(id)) {
    const src = imageBoxInfos.value[id] as VolumeImageBoxInfo;
    if (src.vecz && !src.isMip) {
      segStore.advanceCrosshair(src.vecz, change);
      // sync が ON で他 box が描画済みの後に crosshair が動いたので再描画
      doOneOrAll(id, (i: number) => showImage(i));
    }
  }
};

const getIdOfEventOccured = (e:MouseEvent | WheelEvent) => 
  Number((e.currentTarget! as any).getAttribute("imageBoxId"));; // anyじゃないほうがいいのだけど

const imageBoxClicked = (e:MouseEvent) => {
  const id = getIdOfEventOccured(e);
  selectedImageBoxId.value = id;

  // デバッグ: Shift+クリックで voxel 編集（debug mode のときのみ）
  if (debugMode.value && e.shiftKey){
    if (handleDebugEditClick(id, e)) return;
  }

  if (leftButtonFunction.value === "sphereROI") {
    handleSphereClick(e);
  } else if (leftButtonFunction.value === "polygonROI") {
    handlePolygonClick(e);
  } else if (leftButtonFunction.value === "assignLabel") {
    handleAssignLabelClick(e);
  }
}

const handleAssignLabelClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  // assignLabelAtVoxel はクリック位置からの局所 flood fill でその島だけを塗るため、
  // 事前の Find islands (componentMap 計算) は不要。初回クリックからそのまま反映される。
  if (!segStore.petVolumeRef) return;
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) return;
  const [x, y] = getCanvasXY(e);
  const w = screenToWorld(id, x, y);
  const v = worldToVoxel_(w, petIdx);
  const i = Math.round(v.x), j = Math.round(v.y), k = Math.round(v.z);
  const pet = segStore.petVolumeRef;
  if (i < 0 || i >= pet.nx || j < 0 || j >= pet.ny || k < 0 || k >= pet.nz) return;
  segStore.assignLabelAtVoxel(i, j, k, segStore.currentLabelId);
  show();
};

// Lesion table などから world 座標へ「ジャンプ」する。全 Volume/Fusion box の断面が
// その点を通るよう centerInWorld を移動し (= 正しいスライスへ移動 + 画面中央に配置)、
// crosshair も設定する。MIP/VR は投影/回転ビューなので視点を動かさない。
const jumpToWorld = (p: THREE.Vector3) => {
  for (let i = 0; i < imageBoxInfos.value.length; i++){
    if (!isAnyVolumeBox(i)) continue;
    const a = getVolumeImageBoxInfo(i);
    if (isProjectionInfo(a) || !a.centerInWorld) continue;   // 未初期化 box を防御
    a.centerInWorld.copy(p);
  }
  segStore.setCrosshairWorld(p);
  show();
};

// SegmentationPanel からツールを切り替える (例: "Assign label" を有効化)。
const onPanelSetTool = (tool: LeftButtonFunction) => {
  leftButtonFunction.value = tool;
};

// ===== 矩形 ROI ツール =====
// mousedown でドラッグ開始、mousemove で対角隅を追従、mouseup で確定。
// 確定時に screen 2 隅 → series voxel 座標へ変換して segStore.rectRois に追加。
const rectRoiMouseDown = (e: MouseEvent) => {
  if (leftButtonFunction.value !== "rectROI") return;
  if (e.button !== 0) return;  // 左ボタンのみ
  const id = getIdOfEventOccured(e);
  // DICOM slice / Volume / Fusion box のみ対応 (voxel 変換が定義される box)
  if (!isDicomSliceImageBoxInfo(id) && !isAnyVolumeBox(id)) return;
  const [x, y] = getCanvasXY(e);
  rectRoiDraft.value = { boxId: id, x0: x, y0: y, x1: x, y1: y };
  selectedImageBoxId.value = id;
};

const rectRoiMouseUp = () => {
  const d = rectRoiDraft.value;
  rectRoiDraft.value = null;
  if (!d) return;
  // 面積ゼロ (クリックのみ) は無視
  if (Math.abs(d.x1 - d.x0) < 2 && Math.abs(d.y1 - d.y0) < 2) {
    show();
    return;
  }
  const vA = screenToVoxelAny(d.boxId, d.x0, d.y0);
  const vB = screenToVoxelAny(d.boxId, d.x1, d.y1);
  const seriesIdx = seriesIndexOfBox(d.boxId);
  if (!vA || !vB || seriesIdx < 0) {
    show();
    return;
  }
  // 配置直後は未命名 (label なし)。表示名は配列位置から `#N` が自動で算出される。
  // リネームは右パネルの ✏️ から行う。
  segStore.addRectRoi(seriesIdx, vA, vB);
  show();
};

const getCanvasXY = (e: MouseEvent): [number, number] => {
  const target = e.currentTarget as HTMLElement;
  const cv = target.querySelector('canvas') as HTMLCanvasElement | null;
  if (cv) {
    const rect = cv.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  return [e.offsetX, e.offsetY];
};

// ===== Voxel brush ツール =====
// 左ドラッグで manualEdits に円形ブラシを描く。stroke 開始時に slice を確定し、
// undo 用に 1 度だけ before スライスを退避 (= stroke 全体が 1 undo)。stroke 中は
// 同一スライス・同一 box に描き続ける。半径は mm 指定 → PET voxel pitch で換算。
const brushStroke = ref<{ boxId: number; petIdx: number; sliceAxis: 0|1|2; sliceIndex: number } | null>(null);

const brushMouseDown = (e: MouseEvent) => {
  if (leftButtonFunction.value !== "brushROI") return;
  if (e.button !== 0) return;
  const id = getIdOfEventOccured(e);
  // polygon と同じく pure Volume box (PT/CT/MR の単独スライス) のみ。MIP/VR は slice 概念が無い。
  if (!isVolumeImageBoxInfo(id)) return;
  const a = getVolumeImageBoxInfo(id);
  if (isProjectionInfo(a)) return;
  if (!segStore.petVolumeRef) return;
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) return;
  segStore.ensureMaskAllocated();
  if (!segStore.manualEdits || !segStore.finalMask) return;
  // slice 確定: 画面中央画素を world→PET voxel し、overlay サンプリング (floor(mv+0.5)=round)
  // と同じ round 規則で決定。polygon と揃える。
  const sliceAxis = maxAxis(a.vecz);
  const wCenter = screenToWorld(id, imageBoxW.value!/2, boxRenderHeight(id)/2);
  const vc = worldToVoxel_(wCenter, petIdx);
  const arr = [vc.x, vc.y, vc.z];
  const sliceIndex = Math.round(arr[sliceAxis]);
  // stroke 全体を 1 つの履歴エントリにする (描き始める前に snapshot)
  segStore.beginMaskEdit();
  brushStroke.value = { boxId: id, petIdx, sliceAxis, sliceIndex };
  selectedImageBoxId.value = id;
  const [x, y] = getCanvasXY(e);
  paintBrushAt(x, y);
};

// 1 点ぶんのブラシ円を描く。manualEdits と finalMask を inline 更新し (full recompute を
// 避けて mousemove 連打でも軽い)、即 redraw。lesion 統計は重いので stroke 終了時にまとめて更新。
const paintBrushAt = (sx: number, sy: number) => {
  const st = brushStroke.value;
  const pet = segStore.petVolumeRef;
  const m = segStore.manualEdits;
  const fmask = segStore.finalMask;
  if (!st || !pet || !m || !fmask) return;
  const { nx, ny, nz } = pet;
  const w = screenToWorld(st.boxId, sx, sy);
  const v = worldToVoxel_(w, st.petIdx);
  // in-plane 2 軸の center voxel と voxel pitch (mm) を sliceAxis から決める。
  let cu: number, cv: number, pitchU: number, pitchV: number, dimU: number, dimV: number;
  if (st.sliceAxis === 2){ cu = v.x; cv = v.y; pitchU = pet.vectorX.length(); pitchV = pet.vectorY.length(); dimU = nx; dimV = ny; }
  else if (st.sliceAxis === 1){ cu = v.x; cv = v.z; pitchU = pet.vectorX.length(); pitchV = pet.vectorZ.length(); dimU = nx; dimV = nz; }
  else { cu = v.y; cv = v.z; pitchU = pet.vectorY.length(); pitchV = pet.vectorZ.length(); dimU = ny; dimV = nz; }
  cu = Math.round(cu); cv = Math.round(cv);
  const rMm = segStore.brushRadiusMm;
  const ru = Math.max(0, Math.floor(rMm / (pitchU || 1)));
  const rv = Math.max(0, Math.floor(rMm / (pitchV || 1)));
  // Brush は「既存ラベルを選択ラベルへ塗り替える」用途のみ (Add/Erase は廃止)。
  const writeValue = segStore.currentLabelId;
  const fval = writeValue;
  for (let dv = -rv; dv <= rv; dv++){
    for (let du = -ru; du <= ru; du++){
      const fu = ru > 0 ? du / ru : 0;
      const fvv = rv > 0 ? dv / rv : 0;
      if (fu*fu + fvv*fvv > 1) continue;   // 物理的に円形 (anisotropic voxel 補正済み)
      const u = cu + du, vv = cv + dv;
      if (u < 0 || u >= dimU || vv < 0 || vv >= dimV) continue;
      let idx: number;
      if (st.sliceAxis === 2) idx = st.sliceIndex * nx * ny + vv * nx + u;
      else if (st.sliceAxis === 1) idx = vv * nx * ny + st.sliceIndex * nx + u;
      else idx = vv * nx * ny + u * nx + st.sliceIndex;
      // Brush は既存ラベルの修正用途。ブラシ円内でも背景 (ラベル無し) は変更しない。
      if (fmask[idx] === 0) continue;
      m[idx] = writeValue;
      fmask[idx] = fval;   // recomputeFinalMask と同じ結果を inline 反映
    }
  }

  // ブラシは「カーソルと同時に画面へ反映」がユーザ期待値。ここを軽くするのが重要:
  //  ★ stroke 中は maskVersion を bump しない。bump すると lesionRows (summarizeLesions =
  //    全 volume 26-CC, ~30ms) / labelHistogram / volumesByLabel 等の重い reactive computed が
  //    毎 mousemove で再計算され、これがブラシ遅延の主因だった。統計は brushMouseUp で 1 回だけ更新。
  //  ・GPU 有効時は変更した 1 スライスだけを直接テクスチャに部分アップロードして表示を更新する
  //    (reactive version には依存しない。現在の maskVersion をそのまま渡せば cache が整合する)。
  //  ・CPU パスは overlay が finalMask を直接サンプルするので showImage だけで即反映される。
  //  ・全 box (高価な MIP 含む) ではなく描いている box だけ再描画する。
  if (perfStore.gpuAllowed && isWebGpuAvailable()) {
    const device = getGpuDeviceSync();
    if (device) {
      updateMaskTextureSlice(device, fmask, nx, ny, nz, segStore.maskVersion, st.sliceAxis, st.sliceIndex);
    }
  }
  showImage(st.boxId);
};

const brushMouseUp = () => {
  if (!brushStroke.value) return;
  brushStroke.value = null;
  // canonical state へ同期 + lesion 統計/component map を更新 (stroke 終了時に 1 回だけ)。
  segStore.recomputeFinalMask();
  segStore.markManualEditsChanged();
  // stroke 全体を 1 履歴エントリに確定 (何も塗られなければ commit は false で無視される)
  segStore.commitMaskEdit('Brush relabel');
  show();
};

// rectROI / brushROI の左ボタン down/up を tool に応じて振り分ける。
const onBoxMouseDown = (e: MouseEvent) => {
  // 手動 alignment の Shift+ドラッグ中は ROI 系ツールを起動しない (誤って描かないように)
  if (e.shiftKey && manualAlignBoxId.value === getIdOfEventOccured(e)) return;
  if (leftButtonFunction.value === "rectROI") rectRoiMouseDown(e);
  else if (leftButtonFunction.value === "brushROI") brushMouseDown(e);
};
const onBoxMouseUp = () => {
  if (rectRoiDraft.value) rectRoiMouseUp();
  if (brushStroke.value) brushMouseUp();
};

// box から出たらデバッグ hover を消し、ブラシカーソル円も消す (残像防止)。
const onBoxMouseLeave = (id: number) => {
  debugShow.value = false;
  if (brushCursor.value){
    brushCursor.value = null;
    showImage(id);   // ブラシ円を消すため再描画
  }
};

const handlePolygonClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  if (!segStore.petVolumeRef) return;

  const [x, y] = getCanvasXY(e);
  const cur = segStore.polygon;
  if (!cur || !cur.inProgress || cur.imageBoxId !== id){
    // 新規開始
    const a = getVolumeImageBoxInfo(id);
    const sliceAxis = maxAxis(a.vecz);
    const planeName = determinePlaneDirection(a) as ('axial'|'coronal'|'sagittal'|'unknown');
    // PET ボクセル空間でのスライスインデックス（描画と同じ floor 規則で決定）
    // drawNiftiSlice は p00 + v01*y + v10*x を floor して voxel を決めるため、
    // 画面中央画素 (W/2, H/2) の voxel index も同様に floor するのが正しい。
    const petIdx = findPetSeriesIndex();
    let sliceIndexInPet = 0;
    if (petIdx >= 0){
      const wCenter = screenToWorld(id, imageBoxW.value!/2, boxRenderHeight(id)/2);
      const vc = worldToVoxel_(wCenter, petIdx);
      const arr = [vc.x, vc.y, vc.z];
      // overlay の mask サンプリングは shader/CPU とも floor(mv + 0.5) = round-to-nearest。
      // ここを floor にすると表示スライスと書き込みスライスが 1 ずれ、描いた面と別の面に
      // ROI が出る (小数部 ≥0.5 のとき)。round に統一して表示スライスへ確実に書き込む。
      sliceIndexInPet = Math.round(arr[sliceAxis]);
    }
    segStore.polygon = {
      plane: planeName,
      sliceAxis,
      sliceIndexInPet,
      screenVertices: [[x, y]],
      mode: 'add',   // Add/Erase 廃止: polygon は選択ラベルへの塗り替えのみ
      inProgress: true,
      imageBoxId: id,
    };
  } else {
    cur.screenVertices.push([x, y]);
  }
  show();
};

const finalizePolygon = () => {
  const p = segStore.polygon;
  if (!p || !p.inProgress) return;
  if (p.screenVertices.length < 3){
    segStore.polygon = null;
    show();
    return;
  }
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0){
    segStore.polygon = null;
    show();
    return;
  }
  segStore.ensureMaskAllocated();
  if (!segStore.manualEdits || !segStore.petVolumeRef){
    segStore.polygon = null;
    show();
    return;
  }

  // screen → PET voxel (u,v) 投影：sliceAxis 以外の 2 軸を採用
  const polyVoxelUV: Array<[number, number]> = [];
  for (const [sx, sy] of p.screenVertices){
    const w = screenToWorld(p.imageBoxId, sx, sy);
    const v = worldToVoxel_(w, petIdx);
    let u: number, vv: number;
    if (p.sliceAxis === 2){ u = v.x; vv = v.y; }
    else if (p.sliceAxis === 1){ u = v.x; vv = v.z; }
    else { u = v.y; vv = v.z; }
    polyVoxelUV.push([u, vv]);
  }

  // 操作前状態を履歴 (undo/redo) 用に snapshot
  segStore.beginMaskEdit();

  // Add/Erase 廃止: polygon は選択ラベルへの塗り替えのみ。
  const writeValue = segStore.currentLabelId;

  fillPolygonOnSlice({
    pet: segStore.petVolumeRef,
    target: segStore.manualEdits,
    sliceAxis: p.sliceAxis,
    sliceIndex: p.sliceIndexInPet,
    polygonVoxelXY: polyVoxelUV,
    writeValue,
    // Polygon は既存ラベルの修正用途。polygon 内でも背景 (finalMask==0) は触らない。
    gate: segStore.finalMask ?? undefined,
  });

  segStore.recomputeFinalMask();
  segStore.markManualEditsChanged();
  segStore.commitMaskEdit('Polygon relabel');
  segStore.polygon = null;
  polygonCursor.value = null;
  show();
};

const cancelPolygon = () => {
  if (segStore.polygon){
    segStore.polygon = null;
    polygonCursor.value = null;
    show();
  }
};

// 統合 Undo / Redo: マスク編集 (Apply/Clear/polygon/brush/assign) と 矩形 ROI 追加/削除を
// 1 本の履歴で巻き戻す/やり直す。マスク復元は store 側 (diff + recompute) が担当するので、
// ここは再描画のみ。Undo ボタン / Ctrl+Z / History パネル共通のエントリポイント。
const undoLastAction = () => {
  if (segStore.undo()) show();
};
const redoLastAction = () => {
  if (segStore.redo()) show();
};
// History パネルから任意地点へジャンプ
const gotoHistoryStep = (targetAppliedLen: number) => {
  segStore.gotoHistory(targetAppliedLen);
  show();
};

const onContextMenu = (e: MouseEvent) => {
  // 右ドラッグ直後 (= W/L drag が終わった) のときは context menu を抑止し、フラグだけリセット。
  if (rightDragActive.value){
    e.preventDefault();
    rightDragActive.value = false;
    return;
  }
  if (leftButtonFunction.value === "polygonROI" && segStore.polygon?.inProgress){
    e.preventDefault();
    finalizePolygon();
    return;
  }
  // 右クリック単独 (ドラッグなし) でも、誤って context menu が出ると操作が中断するため
  // 画像エリアでは常に抑止する。
  e.preventDefault();
};

const onDblClick = (e: MouseEvent) => {
  if (leftButtonFunction.value === "polygonROI" && segStore.polygon?.inProgress){
    e.preventDefault();
    finalizePolygon();
  }
};

// カーソルキー paging: 選択中 (フォーカスのある) box を 1 スライスずつ送る。
// 方向は **右端の縦スライダと一致**させる (↑ = スライダ上端 = 頭側/腹側/右側)。
// index の増減で決めると PET と CT でスライス順が逆の症例で上下が食い違うため、
// getBoxPaging().invert を通して world 基準に揃える (スライダと同じ規則)。
const PAGING_KEY_STEP: Record<string, number> = {
  ArrowUp: -1, ArrowLeft: -1,
  ArrowDown: 1, ArrowRight: 1,
  PageUp: -10, PageDown: 10,
};

// 文字入力中 (threshold の数値欄, ラベル rename 等) にキーを奪わない
const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  // Vuetify の slider は input[type=range]。フォーカス時は slider 自身の
  // 矢印キー処理 (= 同じ paging) に任せる。
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
};

const onPagingKey = (e: KeyboardEvent): boolean => {
  const dir = PAGING_KEY_STEP[e.key];
  if (dir === undefined) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;   // ショートカットは奪わない
  if (isTypingTarget(e.target)) return false;
  const i = selectedImageBoxId.value;
  // 投影系 (MIP/sMIP/VR) は断面が無いので null → 何もしない (既定のスクロールも妨げない)
  const p = getBoxPaging(i);
  if (!p) return false;
  const step = p.invert ? -dir : dir;
  e.preventDefault();
  onSetPagingIndex(i, p.index + step);
  return true;
};

// 手動 alignment 中は、その box に限りカーソルキーを **overlay の移動** に割り当てる。
// (paging より優先。モードは明示的に ON にしたときだけなので取り違えは起きない)
const MANUAL_ALIGN_KEY: Record<string, { right?: number; up?: number; through?: number }> = {
  ArrowLeft: { right: -1 }, ArrowRight: { right: 1 },
  ArrowUp: { up: 1 }, ArrowDown: { up: -1 },
  PageUp: { through: 1 }, PageDown: { through: -1 },
};

const onManualAlignKey = (e: KeyboardEvent): boolean => {
  const boxId = manualAlignBoxId.value;
  if (boxId == null || boxId !== selectedImageBoxId.value) return false;
  // box が閉じられた / fusion でなくなった / MIP に切り替えられた場合はモードを畳んで
  // paging に戻す (そうしないとカーソルキーが何もしないまま吸われ続ける)
  if (!canManualAlign(boxId)) { manualAlignBoxId.value = null; return false; }
  const d = MANUAL_ALIGN_KEY[e.key];
  if (!d) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (isTypingTarget(e.target)) return false;
  e.preventDefault();
  onBoxManualNudge(boxId, d);
  return true;
};

const onKeyDown = (e: KeyboardEvent) => {
  if (onManualAlignKey(e)) return;
  if (onPagingKey(e)) return;
  if (e.key === "Escape" && segStore.polygon?.inProgress){
    cancelPolygon();
  } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && e.shiftKey){
    // Ctrl+Shift+Z = redo
    e.preventDefault();
    redoLastAction();
  } else if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)){
    // Ctrl+Y = redo (Windows 慣習)
    e.preventDefault();
    redoLastAction();
  } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)){
    e.preventDefault();
    // 手動 alignment 中は **位置合わせ**を 1 ステップ戻す。
    // マスク編集の履歴とは別建てなので、モードを閉じれば従来どおりマスクの undo に戻る。
    if (manualAlignBoxId.value != null && undoRegistration()) return;
    // Ctrl+Z = undo。マスク編集 (Apply/Clear/polygon/brush/assign) と 矩形 ROI をまとめて巻き戻す
    undoLastAction();
  }
};

if (typeof window !== "undefined"){
  window.addEventListener("keydown", onKeyDown);
}

const handleSphereClick = (e: MouseEvent) => {
  const id = getIdOfEventOccured(e);
  if (!isVolumeImageBoxInfo(id)) return;
  if (!segStore.petVolumeRef) return;
  const [x, y] = getCanvasXY(e);
  const w = screenToWorld(id, x, y);

  // Reference sphere 配置モード (liver / bloodPool) なら通常の sphere ROI 経路を bypass
  if (segStore.referencePlacementMode) {
    const kind = segStore.referencePlacementMode;
    // PERCIST 既定: liver = 30mm 球 (3cm)、bloodPool = 10mm 球 (1cm)
    const refRadius = kind === 'liver' ? 15 : 5;
    const stats = sphereStatsInPet(segStore.petVolumeRef, w, refRadius);
    segStore.setReferenceSphere(kind, w, refRadius, {
      suvMean: stats.suvMean, suvStd: stats.suvStd, voxelCount: stats.voxelCount,
    });
    show();
    return;
  }

  const radius = segStore.sphere?.radiusMm ?? 10;
  // sphere が無ければ作成、あれば center だけ更新 (crosshair も同位置に)
  if (!segStore.sphere) segStore.setSphere(w, radius);
  segStore.setCrosshairWorld(w);  // 内部で sphere center 同期 + stats 再計算
  show();
};

const recomputeSphereStats = () => {
  const s = segStore.sphere;
  const pet = segStore.petVolumeRef;
  if (!s || !pet) return;
  const stats = sphereStatsInPet(pet, s.centerWorld, s.radiusMm);
  s.suvMax = stats.suvMax;
  s.suvMean = stats.suvMean;
  s.suvStd = stats.suvStd;
  s.voxelCount = stats.voxelCount;
};

// シリーズ idx を box id にロードする (drop ハンドラから呼ばれる)。
// DICOM box に **別シリーズを載せ替えたとき**は zoom / pan を捨てる。
// zoom は「box px ÷ 画像 px」の実数で、画像サイズが変われば意味が変わる。
// 持ち越すと、512² の CT を見ていた box に別マトリクスの Scout が入ったときに
// 拡大されたまま表示され、全体が見えなくなる (ユーザ報告)。null にしておけば
// showImage 側の fit 計算 (Math.min(fitW, fitH)) が新しい画像で引き直される。
const resetDicomBoxView = (info: DicomSliceImageBoxInfo) => {
  info.zoom = null;
  info.centerX = 0;
  info.centerY = 0;
};

const onSelectSeriesIntoBox = (idx: number, id: number) => {
  if (idx < 0 || idx >= seriesList.length) return;
  if (id < 0 || id >= imageBoxInfos.value.length) return;
  selectedImageBoxId.value = id;
  const info = imageBoxInfos.value[id];
  // 既存の Box が DICOM 表示中なら currentSeriesNumber を切替、Volume 表示中なら mpr_ で再構築
  if (isDicomSliceImageBoxInfo(id)){
    (info as DicomSliceImageBoxInfo).currentSeriesNumber = idx;
    (info as DicomSliceImageBoxInfo).currentSliceNumber = 0;
    (info as DicomSliceImageBoxInfo).description = seriesSummaries.value[idx]?.description ?? "";
    resetDicomBoxView(info as DicomSliceImageBoxInfo);
  } else {
    // Volume 表示中: 該当シリーズが volume を持たないなら生成 (box[idx] には影響させない)
    if (!seriesList[idx].volume && seriesList[idx].myDicom){
      if (!ensureVolume_(idx)) return;
    }
    if (seriesList[idx].volume){
      const v = seriesList[idx].volume!;
      const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), idx);
      const p1 = voxelToWorld_(new THREE.Vector3(v.nx, v.ny, v.nz), idx);
      const center = p0.add(p1).divideScalar(2);
      imageBoxInfos.value[id] = {
        clut: (info as VolumeImageBoxInfo).clut ?? 0,
        myWC: info.myWC ?? null,
        myWW: info.myWW ?? null,
        description: seriesSummaries.value[idx]?.description ?? "",
        currentSeriesNumber: idx,
        centerInWorld: center,
        vecx: v.vectorX.clone(),
        vecy: v.vectorY.clone(),
        vecz: v.vectorZ.clone(),
        isMip: false,
        mip: null,
      } as VolumeImageBoxInfo;
    }
  }
  show();
};

const hasNonZeroMask = (m: Uint16Array | null): boolean => {
  if (!m) return false;
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== 0) return true;
  }
  return false;
};

const onSetActiveForSeg = (payload: { index: number; modality: 'PT' | 'CT' }) => {
  const { index, modality } = payload;
  if (index < 0 || index >= seriesList.length) return;
  const s = seriesList[index];
  if (!s) return;

  // Volume が未生成なら生成 (DICOM 必須)。未対応圧縮なら ensureVolume_ が false を返す。
  // ★ active 切替の副作用として box[index] を Volume box に上書きしないよう ensureVolume_ を使う。
  if (!s.volume) {
    if (!s.myDicom || s.myDicom.length === 0) {
      alert('Cannot activate: this series has no volume and no DICOM files.');
      return;
    }
    if (!ensureVolume_(index)) return;
  }
  const v = s.volume;
  if (!v) return;

  // 切り替え先 seriesUID と現在 active が同じならノーオペで OK (mask 保持される)。
  const targetUid = v.metadata?.seriesUID ?? '';
  const currentRef = modality === 'PT' ? segStore.petVolumeRef : segStore.ctVolumeRef;
  const currentUid = currentRef?.metadata?.seriesUID ?? '';
  const isSwitch = !!targetUid && !!currentUid && targetUid !== currentUid;

  // PT を別 series に切り替え + マスク編集が乗っているとき: confirm
  if (isSwitch && modality === 'PT') {
    const dirty = hasNonZeroMask(segStore.finalMask) || hasNonZeroMask(segStore.manualEdits);
    if (dirty) {
      const ok = window.confirm(
        'Switching the active PT will discard the current segmentation mask and labels.\n\nProceed?'
      );
      if (!ok) return;
    }
  }

  if (modality === 'PT') {
    segStore.setPetVolume(v);
  } else {
    segStore.setCtVolume(v);
  }
  rebuildSeriesSummaries();
  show();
};

const onSetSeriesModality = (payload: { index: number; modality: 'PT' | 'CT' | 'MR' }) => {
  const { index, modality } = payload;
  if (index < 0 || index >= seriesList.length) return;
  const v = seriesList[index].volume;
  if (!v) return;
  const existing = v.metadata;
  v.metadata = {
    modality,
    seriesUID: existing?.seriesUID ?? `nii-${index}-${Date.now()}`,
    seriesDescription: existing?.seriesDescription,
    suvFactor: existing?.suvFactor,
    patientWeightKg: existing?.patientWeightKg,
    radionuclideHalfLifeSec: existing?.radionuclideHalfLifeSec,
    radionuclideTotalDoseBq: existing?.radionuclideTotalDoseBq,
    doseStartTimeSec: existing?.doseStartTimeSec,
    acquisitionTimeSec: existing?.acquisitionTimeSec,
    units: existing?.units,
  };
  if (modality === 'PT') {
    segStore.setPetVolume(v);
  } else if (modality === 'CT') {
    segStore.setCtVolume(v);
  } else {
    segStore.setMrVolume(v);
  }
  rebuildSeriesSummaries();
  show();
};

const doSort = () => {
  // 既存 seriesList を seed: DICOM 系には実 UID を、それ以外には unique sentinel を入れて
  // append load 時に新ファイルが既存と同 SeriesUID なら同 series に統合、別 UID なら新 series 化、
  // という挙動を保つ (sentinel は indexOf で当たらない一意文字列)。
  let serieses: string[] = [];
  for (let i = 0; i < seriesList.length; i++) {
    const sl = seriesList[i];
    if (sl?.myDicom && sl.myDicom.length > 0) {
      const suid = sl.myDicom[0].string("x0020000e") ?? "";
      const sd = sl.myDicom[0].string("x0008103e") ?? "";
      serieses[i] = suid + sd;
    } else {
      serieses[i] = `__nondicom_${i}__`;
    }
  }
  for (const f of bagOfFiles){

    if (f instanceof Uint8Array){
      console.log(`otherfile: ${f.length} bytes`);
    }else if ("niftiHeader" in f){
      const dim = f['niftiHeader']['dims'];
      const af = f['niftiHeader']['affine'];
      // NIfTI-1 description (80 char) を seriesDescription に流用。
      // 空ならカード上は "Series N" にフォールバック。
      const niftiDesc = ((f['niftiHeader'] as { description?: string })['description'] ?? '').trim();

      // NIfTI affine → 本アプリの world (DICOM LPS) 変換。
      //
      // 1) **方向ベクトルは affine の「列」**。af[r][c] は row-major なので、voxel index c を
      //    1 進めたときの world 変位は (af[0][c], af[1][c], af[2][c])。
      //    以前は「行」を取っていたため、回転を含む affine で軸が混ざり voxel pitch まで狂った
      //    (brain MR/PET の qform データで発覚: PET の実ピッチ 0.53/0.53/3.05 が 0.58/0.65/3.02 に化けた)。
      //    軸平行 (対角 affine) のデータでは行と列が一致するため、これまで表面化しなかった。
      // 2) **NIfTI は RAS+、本アプリ world は LPS** → x,y 成分の符号を反転 (diag(-1,-1,1))。
      //    方向ベクトルだけでなく **原点にも同じ変換が要る**。原点を変換していなかったため、
      //    NIfTI 同士 / NIfTI と DICOM を並べると x,y 方向にずれていた。
      const affCol = (c: number) => new THREE.Vector3(-af[0][c], -af[1][c], af[2][c]);
      const vx = affCol(0);
      const vy = affCol(1);
      const vz = affCol(2);
      const pos = new THREE.Vector3(-af[0][3], -af[1][3], af[2][3]);

      const niftiIdx = seriesList.length;
      // modality 推定: ファイル名 (003PT00.nii → 'PT') を優先し、
      // ヒントが無ければ **voxel 値の分布**から判定する (kitty.nii のように名前で分からない場合)。
      // 分布からは CT だけが確度高く言える (空気 -1000 の指紋)。PT/MR は互いに区別できないので
      // 推定せず 'OTHER' のままにする。UI の Set as PT/CT/MR で上書き可能。
      const guessed = guessModalityFromVoxels(f.pixelData);
      const inferredModality = detectModalityFromFilename(f.filename) ?? guessed.modality ?? 'OTHER';
      if (!detectModalityFromFilename(f.filename)) {
        console.log(`[modality] ${f.filename}: ${inferredModality} — ${guessed.reason}`);
      }
      seriesList.push({
        myDicom: null,
        volume:{
          nx: dim[1],
          ny: dim[2],
          nz: dim[3],
          imagePosition: pos,
          vectorX: vx,
          vectorY: vy,
          vectorZ: vz,
          voxel: f.pixelData,
          metadata: {
            modality: inferredModality,
            seriesUID: `nii-${niftiIdx}-${Date.now()}`,
            seriesDescription: niftiDesc || (f.filename ?? undefined),
            datatypeName: f.datatypeName,
            niftiHeader: f.niftiHeader,    // header viewer 用に保持
            sourceFilename: f.filename,
          },
        }
      });

    }else{

      const suid = f.string("x0020000e") ?? ""; // series instance uid
      const sd = f.string("x0008103e") ?? ""; // series description
      const name = suid+sd;

      let id = serieses.indexOf(name);
      if (id === -1){
        id = serieses.length;
        serieses.push(name);
      }
      if (seriesList[id] == null){
        seriesList[id] = {myDicom:null, volume:null};
      }
      if (seriesList[id].myDicom == null){
        seriesList[id].myDicom = [];
      }
      seriesList[id].myDicom!.push(f);
    }

  }
  bagOfFiles=[];

  for (const d of seriesList){
    if (d.myDicom != null){
      d.myDicom.sort((a: DataSet, b: DataSet) => {
        return Number(a.string("x00200013")) - Number(b.string("x00200013"));
      });
    }
  }

  detectPetCtFromDicom();
  rebuildSeriesSummaries();
};


const loadFile = async (file: File) => {
  loadFiles([file]);
};

// NIfTI raw byte view: 元シリーズの voxel array をそのまま使い、affine を unit vector
// に置換した synthetic Volume を新シリーズとして seriesList に追加する。
// innermost dim → screen X (左→右)、middle → screen Y (上→下)、outermost → paging。
// modality / SUV factor も無視 (raw counts そのまま)。
// WC/WW は voxel min/max を簡易サンプリング (10000 step) で推定。
// Persona 2 (NIfTI orientation 検証) 用。
// NIfTI header dialog 用 reactive state (volume card の "..." メニュー → "View NIfTI header")
const niftiHeaderDialog = ref<{
  open: boolean;
  filename: string;
  modality: string;
  seriesUID: string;
  datatypeName: string;
  rows: Array<{ key: string; value: string }>;
}>({
  open: false, filename: '', modality: '', seriesUID: '', datatypeName: '', rows: [],
});

const onViewNiftiHeader = (sourceSeriesIdx: number) => {
  if (sourceSeriesIdx < 0 || sourceSeriesIdx >= seriesList.length) return;
  const src = seriesList[sourceSeriesIdx];
  const v = src.volume;
  const meta = v?.metadata as any;
  if (!meta?.niftiHeader) {
    alert('No NIfTI header available for this series (DICOM origin or load-time data not preserved).');
    return;
  }
  // niftiHeader を field 一覧に整形 (内部表現は nifti-reader-js NIFTI1 オブジェクト)。
  const hdr = meta.niftiHeader;
  const rows: Array<{ key: string; value: string }> = [];
  const fmt = (val: any): string => {
    if (val == null) return '';
    if (Array.isArray(val)) {
      // matrix (2D array)
      if (Array.isArray(val[0])) {
        return val.map(row => row.map((x: number) => Number(x).toFixed(4)).join(', ')).join(' | ');
      }
      return val.map((x: any) => typeof x === 'number' ? Number(x).toFixed(4) : String(x)).join(', ');
    }
    if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(6);
    return String(val);
  };
  // 既知の主要 field を順番に並べる + その他はアルファベット順で末尾に
  const priorityKeys = [
    'magic', 'sizeof_hdr', 'datatypeCode', 'numBitsPerVoxel',
    'dims', 'pixDims', 'qform_code', 'sform_code',
    'affine', 'quatern_b', 'quatern_c', 'quatern_d',
    'qoffset_x', 'qoffset_y', 'qoffset_z',
    'srow_x', 'srow_y', 'srow_z',
    'scl_slope', 'scl_inter', 'cal_min', 'cal_max',
    'slice_code', 'slice_start', 'slice_end', 'slice_duration',
    'xyzt_units', 'intent_code', 'intent_name', 'intent_p1', 'intent_p2', 'intent_p3',
    'description', 'aux_file',
    'toffset', 'glmin', 'glmax',
  ];
  const seen = new Set<string>();
  for (const k of priorityKeys) {
    if (k in hdr) {
      rows.push({ key: k, value: fmt(hdr[k]) });
      seen.add(k);
    }
  }
  // それ以外の field
  const others = Object.keys(hdr).filter(k => !seen.has(k) && typeof hdr[k] !== 'function').sort();
  for (const k of others) {
    rows.push({ key: k, value: fmt(hdr[k]) });
  }
  niftiHeaderDialog.value = {
    open: true,
    filename: meta.sourceFilename ?? `Series ${sourceSeriesIdx}`,
    modality: meta.modality ?? '',
    seriesUID: meta.seriesUID ?? '',
    datatypeName: meta.datatypeName ?? '',
    rows,
  };
};

const inspectNiftiRaw = async (sourceSeriesIdx: number) => {
  if (sourceSeriesIdx < 0 || sourceSeriesIdx >= seriesList.length) return;
  const src = seriesList[sourceSeriesIdx];
  if (!src.volume) {
    alert('Source series has no volume data.');
    return;
  }
  const v = src.volume;
  // voxel min/max sampling (大きい volume で全 scan するとフリーズするので step sampling)
  let mn = Infinity, mx = -Infinity;
  const step = Math.max(1, Math.floor(v.voxel.length / 100000));
  for (let i = 0; i < v.voxel.length; i += step) {
    const x = v.voxel[i];
    if (x < mn) mn = x;
    if (x > mx) mx = x;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) { mn = 0; mx = 1; }
  const wc = (mn + mx) / 2;
  const ww = Math.max(1e-6, mx - mn);

  const newIdx = seriesList.length;
  const baseDesc = v.metadata?.seriesDescription ?? `Series ${sourceSeriesIdx}`;
  seriesList.push({
    myDicom: null,
    volume: {
      nx: v.nx,
      ny: v.ny,
      nz: v.nz,
      // 物理座標を正規 unit vector に置換 → 「ファイル byte 順」が画面と完全一致
      imagePosition: new THREE.Vector3(0, 0, 0),
      vectorX: new THREE.Vector3(1, 0, 0),
      vectorY: new THREE.Vector3(0, 1, 0),
      vectorZ: new THREE.Vector3(0, 0, 1),
      voxel: v.voxel,  // 同じ Float32Array を共有 (read-only 用途)
      metadata: {
        modality: 'OTHER',  // raw 表示なので modality 概念を持たせない
        seriesUID: `raw-${newIdx}-${Date.now()}`,
        seriesDescription: `RAW: ${baseDesc}`,
      },
    },
  });
  rebuildSeriesSummaries();

  // 末尾に新 box を追加して raw view を表示
  const newBoxId = tileN.value ?? 1;
  const center = new THREE.Vector3(v.nx / 2, v.ny / 2, v.nz / 2);
  const newInfo = {
    clut: 0,
    myWC: wc,
    myWW: ww,
    description: `RAW: ${baseDesc}`,
    currentSeriesNumber: newIdx,
    centerInWorld: center,
    vecx: new THREE.Vector3(1, 0, 0),
    vecy: new THREE.Vector3(0, 1, 0),
    vecz: new THREE.Vector3(0, 0, 1),
    isMip: false,
    mip: null,
  } as VolumeImageBoxInfo;
  // **穴を作らないこと。** push は「配列末尾」に入るので、newBoxId が length より 2 以上先だと
  // 途中の index が undefined のまま tileN だけ伸び、template から呼ばれる box 判定関数が
  // `'clut' in undefined` で throw して **render 全体が停止**する (実測: レイアウト変更が
  // 画面に反映されなくなり、DicomView 内の右ドロワーも描画されなくなった)。
  while (imageBoxInfos.value.length < newBoxId) {
    imageBoxInfos.value.push(defaultInfo(imageBoxInfos.value.length));
  }
  if (newBoxId >= imageBoxInfos.value.length) {
    imageBoxInfos.value.push(newInfo);
  } else {
    imageBoxInfos.value[newBoxId] = newInfo;
  }
  while (boxOverlayDisabled.value.length <= newBoxId) boxOverlayDisabled.value.push(false);
  while (boxSyncEnabled.value.length <= newBoxId) boxSyncEnabled.value.push(true);
  tileN.value = newBoxId + 1;
  await nextTick();
  if (imb.value && imb.value[newBoxId]) imb.value[newBoxId].init();
  showImage(newBoxId);
};

// NIfTI series 一覧 (☰ メニュー → Inspect NIfTI raw bytes 用)。
// myDicom が null かつ volume を持つもの。
const getNiftiSeriesList = (): { idx: number; description: string }[] => {
  const out: { idx: number; description: string }[] = [];
  for (let i = 0; i < seriesList.length; i++) {
    const s = seriesList[i];
    if (s.myDicom == null && s.volume) {
      out.push({ idx: i, description: s.volume.metadata?.seriesDescription ?? `Series ${i}` });
    }
  }
  return out;
};

// JPEG Lossless 圧縮されている全フレームを WASM (dcmjs-codecs) で復号する。
// WASM は main thread で sync 実行され純 JS 比 5-20x 速いため Web Worker は不要。
// frame ごとに setTimeout(0) で event loop に譲り UI 応答性を保つ。
// 完了後は rebuildSeriesSummaries() でサムネを再生成し、show() で即時反映。
const jpegDecompressInProgress = ref(false);
const jpegDecompressDone = ref(0);
const jpegDecompressTotal = ref(0);

const decompressAllJpegLossless = async (): Promise<void> => {
  // 対象フレーム収集
  const targets: MyDicom[] = [];
  for (const s of seriesList) {
    if (!s.myDicom) continue;
    for (const ds of s.myDicom) {
      if (DecompressJpegLossless.check(ds) && (ds as MyDicom).decompressed == null) {
        targets.push(ds as MyDicom);
      }
    }
  }
  if (targets.length === 0) return;

  // WASM プリウォーム (初回のみ実 fetch + instantiate; ~500ms 程度)。
  try {
    await ensureWasmCodecsReady();
  } catch (err) {
    console.warn('[jpeg-lossless] WASM init failed; using JS fallback for all frames', err);
  }

  jpegDecompressInProgress.value = true;
  jpegDecompressTotal.value = targets.length;
  jpegDecompressDone.value = 0;
  const t0 = performance.now();
  const backend = isWasmCodecsReady() ? 'WASM (dcmjs-codecs)' : 'JS (jpeg-lossless-decoder-js)';
  console.log(`[jpeg-lossless] decompressing ${targets.length} frames via ${backend}...`);

  for (const ds of targets) {
    try {
      ds.decompressed = DecompressJpegLossless.decode(ds);
    } catch (err) {
      console.warn('[jpeg-lossless] frame decode failed', err);
    }
    jpegDecompressDone.value++;
    // 8 frame ごとに event loop へ譲る (UI 応答性確保、WASM は速いので頻度低めで OK)
    if (jpegDecompressDone.value % 8 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const t1 = performance.now();
  const ms = (t1 - t0);
  const perFrame = (ms / targets.length).toFixed(2);
  console.log(`[jpeg-lossless] decompressed ${jpegDecompressDone.value} frames in ${ms.toFixed(0)}ms (${perFrame} ms/frame, ${backend})`);
  jpegDecompressInProgress.value = false;
};

// "Load files…" ボタンから開く隠し input。drag&drop と同じ loadFiles に流す。
// folder picker は File System Access API がブラウザによって挙動差があるため、
// ここではシンプルに multiple file picker を採用 (.dcm / .nii / .nii.gz)。
const hiddenLoadInput = ref<HTMLInputElement | null>(null);
const onClickLoad = () => {
  hiddenLoadInput.value?.click();
};
const onHiddenLoadInputChange = (e: Event) => {
  const inp = e.target as HTMLInputElement;
  if (inp.files && inp.files.length > 0) {
    loadFiles(inp.files);
  }
  // 同じファイルを連続で選び直せるように value をクリア
  inp.value = '';
};

const loadFiles = (files: FileList | File[]) => {
  const localFileList = Array.from(files);
  if (localFileList.length === 0) return;

  // 既に series が存在する場合は append モード: 既存 box / sync 状態を保持し、
  // 新 series を追加 box として並べる。空状態 (初回ロード) はリセット。
  const isAppend = seriesList.length > 0;
  const startSeriesCount = seriesList.length;
  const startBagLength = bagOfFiles.length;

  if (!isAppend) {
    initializeDicomListsImagesBoxInfos();
    if ((tileN.value ?? 0) <= 0) tileN.value = 1;
  }

  isLoading.value = true;
  for (const f of localFileList) {
    loadFromLocal(f);
  }

  // loadFromLocalは非同期に読み込むので、この段階では全部読み込み終了していない。
  // setIntervalで定期的にチェックして、読み込みが終了していたらソートしてインターバルをキャンセルする。
  let intervalId : any | null = null;
  const expectedBagLength = startBagLength + localFileList.length;
  const callback = () => {
    const loadedThisRun = bagOfFiles.length - startBagLength;
    const msg = `${loadedThisRun} / ${localFileList.length}`;
    if (imb.value && imb.value[0]) imb.value[0].clear(msg);
    if (bagOfFiles.length >= expectedBagLength){
      clearInterval(intervalId!);
      doSort();
      if (isAppend) {
        // 追加された series だけを末尾の新 box に並べる (既存 box は触らない)
        appendNewSeriesAsBoxes(startSeriesCount);
      } else {
        // 自動レイアウト (初回ロード):
        //   - primary シリーズ数に応じて tileN を引き上げ各 Box にシリーズを割り当て
        //   - NIfTI volume-only は Volume Box に昇格 (myDicom 必須の DicomSlice では描画不可)
        autoLayoutAfterLoad();
      }
      // series が入ったら左サイドバー (series 一覧 / 表示設定) を出す。
      // 起動直後は空なので隠してあり、drag&drop や Load files で初めて意味を持つ。
      // append 時も新しい series が増えるので同様に開く。
      if (seriesList.length > 0) drawer.value = true;
      show();
      isLoading.value = false;
      // 背景で全 JPEG Lossless frame を decompress。完了後にサムネ再生成 + 再描画。
      decompressAllJpegLossless().then(() => {
        rebuildSeriesSummaries();
        show();
      });
    }
  };
  intervalId = setInterval(callback, 100);
};

// append load 完了後: startSeriesCount 以降の新 series を末尾の box に追加する。
// 既存 box (0..tileN-1) は触らない。MAX_AUTO_TILES を超える分はユーザに手動で
// tile 数を増やしてもらう前提で省略。
const appendNewSeriesAsBoxes = (startSeriesCount: number) => {
  if (seriesList.length <= startSeriesCount) return;
  // 追加分も **全シリーズ** を box にする (isPrimary で選別しない。初回ロードと同じ方針)
  const newPrimaryIdxs: number[] = [];
  for (let i = startSeriesCount; i < seriesList.length; i++) newPrimaryIdxs.push(i);
  if (newPrimaryIdxs.length === 0) return;

  const oldTileN = tileN.value ?? 0;
  const targetTileN = Math.min(MAX_AUTO_TILES, oldTileN + newPrimaryIdxs.length);
  tileN.value = targetTileN;

  for (let k = 0; k < newPrimaryIdxs.length && oldTileN + k < targetTileN; k++) {
    const boxIdx = oldTileN + k;
    const seriesIdx = newPrimaryIdxs[k];
    const s = seriesList[seriesIdx];
    if (!s) continue;
    while (imageBoxInfos.value.length <= boxIdx) {
      imageBoxInfos.value.push(defaultInfo(imageBoxInfos.value.length));
    }
    const isNiftiOnly = (!s.myDicom || s.myDicom.length === 0) && !!s.volume;
    if (isNiftiOnly) {
      promoteBoxToVolume(boxIdx, seriesIdx);
    } else {
      const info = imageBoxInfos.value[boxIdx] as DicomSliceImageBoxInfo;
      info.currentSeriesNumber = seriesIdx;
      info.currentSliceNumber = 0;
      info.description = seriesSummaries.value[seriesIdx]?.description ?? '';
    }
  }
  applyAutoFit();
};

// loadFiles 完了後に呼ぶ自動レイアウト:
//   - DICOM / NIfTI ともに「最初は raw 表示」が原則。auto PET Standard は行わない。
//     ユーザが PET Standard ボタン / Layouts / drag-and-drop で明示的に Fusion を起動する。
//   - **読み込んだ全シリーズ**を tile に並べる (isPrimary による選別はしない)。
//   - NIfTI volume-only シリーズには Box 自体を Volume Box に昇格させる
//     (DicomSlice Box は myDicom 必須のため、NIfTI を入れても黒画面になる)。
//   tileN の上限は MAX_AUTO_TILES。超える分はユーザに手動で tile 数を増やしてもらう。
const MAX_AUTO_TILES = 24;
const autoLayoutAfterLoad = () => {
  if (seriesList.length === 0) return;

  // **全シリーズを対象にする。** 以前は isPrimary (枚数 20 以上 + 非 RGB) で絞っていたが、
  // MIP や RGB の合成画も「読み込んだのに出てこない」と分かりにくいので分類をやめた
  // (左サイドバーの Primary/Other 分けも同時に廃止。ユーザ指定 2026-07)。
  const idxs = seriesList.map((_, i) => i);

  const N = Math.min(MAX_AUTO_TILES, idxs.length);
  if (N <= 0) return;
  tileN.value = N;

  // **tileN を伸ばす前に infos を N 個まで埋める。**
  // imageBoxInfos の初期長は 8 なので、9 個以上のシリーズを並べると 9 番目以降が
  // undefined になり、下の `info.currentSeriesNumber = ...` が throw して
  // **render 関数ごと停止**する (画面が更新されなくなる)。
  while (imageBoxInfos.value.length < N) {
    imageBoxInfos.value.push(defaultInfo(imageBoxInfos.value.length));
  }

  // 各 Box i に idxs[i] のシリーズを割り当て。
  // NIfTI volume-only は DicomSlice Box では描画できないため Volume Box に昇格。
  for (let i = 0; i < N; i++) {
    const seriesIdx = idxs[i];
    const s = seriesList[seriesIdx];
    if (!s) continue;
    const isNiftiOnly = (!s.myDicom || s.myDicom.length === 0) && !!s.volume;
    if (isNiftiOnly) {
      promoteBoxToVolume(i, seriesIdx);
    } else {
      // DICOM 系: defaultInfo は currentSeriesNumber=i を返すため、ここで明示的に書き換え
      const info = imageBoxInfos.value[i] as DicomSliceImageBoxInfo;
      info.currentSeriesNumber = seriesIdx;
      info.currentSliceNumber = 0;
      info.description = seriesSummaries.value[seriesIdx]?.description ?? '';
      // 逐次ロード中は同じ box に別シリーズが順に載るので、前のシリーズ用の zoom を捨てる
      resetDicomBoxView(info);
    }
  }

  // image area を埋め切る (tileN 未変化や single-series ロード時にも fit)
  autoFitMode.value = true;
  nextTick().then(() => applyAutoFit());

  // ロード直後は Segmentation パネルを出さない (plain viewer が既定なので用が無い)。
  // 開くのは MTV measurement を選んだときだけ。
  inspector.value = false;
};

// MTV measurement 経路から呼ぶ: Segmentation パネルを開く。
// (drag&drop fusion では開かない ← ユーザ指定)
const openInspectorForMtv = () => { inspector.value = true; };

// 既存 box[boxId] を seriesIdx の Volume を表示する VolumeImageBoxInfo に置換する。
// onSelectSeriesIntoBox の Volume 経路と同等の処理を、auto-promotion 用に切り出した。
const promoteBoxToVolume = (boxId: number, seriesIdx: number) => {
  const v = seriesList[seriesIdx]?.volume;
  if (!v) return;
  const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), seriesIdx);
  const p1 = voxelToWorld_(new THREE.Vector3(v.nx, v.ny, v.nz), seriesIdx);
  const center = p0.add(p1).divideScalar(2);
  const m = (v.metadata?.modality ?? '').toUpperCase();
  // CT は HU 40/400, PT は SUV 0-6, それ以外は 0/1000 (生 NIfTI 想定)
  const isPt = (m === 'PT' || m === 'PET');
  const isCt = (m === 'CT');
  const wc = isCt ? 40 : (isPt ? 3 : 0);
  const ww = isCt ? 400 : (isPt ? 6 : 1000);
  const clut = isPt ? 1 : 0;  // PT は white2black、それ以外は gray
  imageBoxInfos.value[boxId] = {
    clut,
    myWC: wc,
    myWW: ww,
    description: v.metadata?.seriesDescription ?? `Series ${seriesIdx}`,
    currentSeriesNumber: seriesIdx,
    centerInWorld: center,
    vecx: v.vectorX.clone(),
    vecy: v.vectorY.clone(),
    vecz: v.vectorZ.clone(),
    isMip: false,
    mip: null,
  } as VolumeImageBoxInfo;
};

const loadFromLocal = (f: File) => {
  const reader = new FileReader();
  // async: NIfTI .nii.gz の場合 loadNii 内で fflate gunzip を Worker で行い、
  // 372MB クラスでも main thread を block しない。
  reader.onload = async () => {
    if (reader.result === null) {
      // result null: push placeholder so the load-completion poll never hangs
      bagOfFiles.push(new Uint8Array(0));
      return;
    }
    const buf = reader.result as ArrayBuffer;
    const u8a = new Uint8Array(buf);
    try {
      const dataSet = parseDicom(u8a) as MyDicom;
      bagOfFiles.push(dataSet);
    } catch {
      try {
        await loadNii(buf, f.name);
      } catch (err) {
        console.warn(`[loadFromLocal] not DICOM and not NIfTI: ${f.name}`, err);
        bagOfFiles.push(u8a);
      }
    }
  };
  reader.onerror = () => {
    // FileReader 失敗 (corrupted file 等) も poll 進行のため必ず push
    console.warn(`[loadFromLocal] FileReader error: ${f.name}`, reader.error);
    bagOfFiles.push(new Uint8Array(0));
  };
  reader.onabort = () => {
    bagOfFiles.push(new Uint8Array(0));
  };
  reader.readAsArrayBuffer(f);
};

const loadNii = async (arraybuffer: ArrayBuffer, filename?: string) => {

  // .nii.gz は native DecompressionStream (FF/Chrome/Safari 内蔵) で gunzip。
  // chunk-by-chunk read で進捗が取れるので app-bar に MB 表示を出せる。
  // 旧 nifti.decompress() は fflate.decompressSync (sync, blocking) を呼んでいて
  // 372MB クラスで 3-7s UI freeze していたのを解消。
  if (nifti.isCompressed(arraybuffer)){
    const t0 = performance.now();
    const u8 = new Uint8Array(arraybuffer);
    const decompressed = await gunzipAsync(u8, filename);
    arraybuffer = decompressed.buffer.slice(
      decompressed.byteOffset,
      decompressed.byteOffset + decompressed.byteLength,
    );
    const ms = performance.now() - t0;
    const mb = (decompressed.byteLength / 1024 / 1024).toFixed(1);
    console.log(`[loadNii] gunzip ${filename ?? '?'}: ${mb} MB in ${ms.toFixed(0)}ms (worker)`);
  }

  if (nifti.isNIFTI(arraybuffer)) {
    const hdr = nifti.readHeader(arraybuffer) as nifti.NIFTI1;
    const px: ArrayBuffer = nifti.readImage(hdr, arraybuffer);

    // NIFTI datatype code (numBitsPerVoxel だけでは uint8/int8/uint16 等を区別不能)
    //   2 Uint8 / 4 Int16 / 8 Int32 / 16 Float32 / 64 Float64
    //   256 Int8 / 512 Uint16 / 768 Uint32 / 1024 Int64
    const dt = (hdr as any).datatypeCode ?? (hdr as any).datatype ?? -1;
    let typed: Uint8Array | Int8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null = null;
    let datatypeName = '?';
    switch (dt) {
      case 2:    typed = new Uint8Array(px);   datatypeName = 'Uint8';   break;
      case 4:    typed = new Int16Array(px);   datatypeName = 'Int16';   break;
      case 8:    typed = new Int32Array(px);   datatypeName = 'Int32';   break;
      case 16:   typed = new Float32Array(px); datatypeName = 'Float32'; break;
      case 64:   typed = new Float64Array(px); datatypeName = 'Float64'; break;
      case 256:  typed = new Int8Array(px);    datatypeName = 'Int8';    break;
      case 512:  typed = new Uint16Array(px);  datatypeName = 'Uint16';  break;
      case 768:  typed = new Uint32Array(px);  datatypeName = 'Uint32';  break;
      // 1024/1280 (Int64/Uint64), 32/1792 (Complex), 128/2304 (RGB), 1536 (Float128) は未対応
      default:
        // 未知 datatype: numBitsPerVoxel から推測 (legacy fallback)
        if (hdr.numBitsPerVoxel === 32) { typed = new Float32Array(px); datatypeName = 'Float32?'; }
        else if (hdr.numBitsPerVoxel === 64) { typed = new Float64Array(px); datatypeName = 'Float64?'; }
        else if (hdr.numBitsPerVoxel === 16) { typed = new Int16Array(px); datatypeName = 'Int16?'; }
        else { typed = new Uint8Array(px); datatypeName = `unknown(dt=${dt})`; }
        console.warn(`[loadNii] unknown NIfTI datatype code ${dt}, falling back by bits=${hdr.numBitsPerVoxel}`);
        break;
    }
    // 内部 voxel は Float32 で統一 (rendering pipeline が Float32 想定)。
    // 既に Float32 ならそのまま、それ以外はコピー変換。
    const float32 = (typed instanceof Float32Array) ? typed : Float32Array.from(typed as ArrayLike<number>);
    bagOfFiles.push({ niftiHeader: hdr, pixelData: float32, filename, datatypeName });
    return;
  }
  // 不正 NIfTI / JSON 等: caller の catch に流して placeholder push させ poll を進める。
  // loadNii が「無 push で resolve」してしまうと bagOfFiles.length が永遠に
  // localFileList.length に届かず、初回ロードが完了しないバグになる。
  throw new Error(`not a valid NIfTI: ${filename ?? '?'}`);
}

// NIfTI のみのロード時、ファイル名から modality を推定する。
// 単語境界 ([\d_\-\. /]) で挟まれた "PT" / "PET" / "CT" / "MR" / "MRI" を拾う。
// 例: "003PT00.nii" → "PT", "scan_ct_001.nii.gz" → "CT", "Cartilage.nii" → null (隣接が文字)
// 不確実なら null を返し、UI 側の Set as PT/CT/MR ボタンで手動指定させる。
const detectModalityFromFilename = (basename: string | undefined): 'PT' | 'CT' | 'MR' | null => {
  if (!basename) return null;
  // 拡張子除去 (.nii / .nii.gz / .gz)
  const stem = basename.replace(/\.(nii\.gz|nii|gz)$/i, '');
  const re = /(?:^|[\d_\-\. /])(PT|PET|CT|MR|MRI)(?:$|[\d_\-\. /])/i;
  const m = stem.match(re);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  if (tag === 'PT' || tag === 'PET') return 'PT';
  if (tag === 'CT') return 'CT';
  if (tag === 'MR' || tag === 'MRI') return 'MR';
  return null;
};

// 各 box の state (centerInWorld / vecx,y,z など) は Vector3 を mutate-in-place するため、
// Vue の reactive proxy では深い変更を検知できない。show()/showImage() の末尾で bump して
// 「描画状態が更新された」signal とし、cross-ref line など派生計算の reactivity に使う。
const boxStateVersion = ref(0);

// Sphere ROI の画面 (page) 座標。ROI 近傍に stats を浮かせる (voxel inspector と同様) 用。
// drawAnnotationOverlays の球輪郭中心算出と同じ式で box i 上の canvas 座標を求め、page 座標へ。
const sphereScreenInBox = (i: number): { x: number; y: number } | null => {
  const s = segStore.sphere;
  if (!s || !isVolumeImageBoxInfo(i)) return null;
  const a = getVolumeImageBoxInfo(i);
  if (isProjectionInfo(a) || !a.vecz) return null;
  const c = s.centerWorld;
  const po = a.centerInWorld;
  const n = a.vecz.clone().normalize();
  const d = (c.x - po.x) * n.x + (c.y - po.y) * n.y + (c.z - po.z) * n.z;
  if (Math.abs(d) > s.radiusMm) return null;   // この box の断面と球が交差しない
  const dxw = c.x - po.x - d * n.x, dyw = c.y - po.y - d * n.y, dzw = c.z - po.z - d * n.z;
  const ax = a.vecx, ay = a.vecy;
  const a11 = ax.x*ax.x + ax.y*ax.y + ax.z*ax.z;
  const a22 = ay.x*ay.x + ay.y*ay.y + ay.z*ay.z;
  const a12 = ax.x*ay.x + ax.y*ay.y + ax.z*ay.z;
  const b1 = ax.x*dxw + ax.y*dyw + ax.z*dzw;
  const b2 = ay.x*dxw + ay.y*dyw + ay.z*dzw;
  const det = a11*a22 - a12*a12;
  if (Math.abs(det) < 1e-12) return null;
  const u = (a22*b1 - a12*b2) / det;
  const v = (a11*b2 - a12*b1) / det;
  const cx = u + (imageBoxW.value ?? 0)/2;
  const cy = v + boxRenderHeight(i)/2;     // rowSpan 対応
  const box = imb.value?.[i] as any;
  const cvRaw = box?.cv1;
  const cv: HTMLCanvasElement | null = cvRaw ? ((cvRaw.value ?? cvRaw) as HTMLCanvasElement) : null;
  if (!cv || !(cv instanceof HTMLCanvasElement)) return null;
  const rect = cv.getBoundingClientRect();
  const sxr = cv.width ? rect.width / cv.width : 1;
  const syr = cv.height ? rect.height / cv.height : 1;
  // ROI 円の少し右外にオフセットして ROI を隠さない
  const rPx = a11 > 0 ? (s.radiusMm / Math.sqrt(a11)) * sxr : 0;
  return { x: rect.left + cx * sxr + rPx + 10, y: rect.top + cy * syr - 12 };
};

const sphereFloatPos = computed<{ x: number; y: number } | null>(() => {
  void boxStateVersion.value;   // 描画のたび再評価 (pan/zoom/page 追従)
  if (!segStore.sphere) return null;
  const p = sphereScreenInBox(selectedImageBoxId.value);   // 選択 box を優先
  if (p) return p;
  for (let i = 0; i < imageBoxInfos.value.length; i++) {
    const q = sphereScreenInBox(i);
    if (q) return q;
  }
  return null;
});

// フローティングボックスのユーザドラッグ量 (ROI 追従位置に加算)。ヘッダを掴んで移動。
const sphereFloatOffset = ref({ x: 0, y: 0 });
const sphereFloatFinalPos = computed<{ x: number; y: number } | null>(() => {
  const p = sphereFloatPos.value;
  if (!p) return null;
  return { x: p.x + sphereFloatOffset.value.x, y: p.y + sphereFloatOffset.value.y };
});
let sphereDrag: { sx: number; sy: number; ox: number; oy: number } | null = null;
const onSphereFloatDragMove = (e: MouseEvent) => {
  if (!sphereDrag) return;
  sphereFloatOffset.value = {
    x: sphereDrag.ox + (e.clientX - sphereDrag.sx),
    y: sphereDrag.oy + (e.clientY - sphereDrag.sy),
  };
};
const onSphereFloatDragEnd = () => {
  sphereDrag = null;
  window.removeEventListener('mousemove', onSphereFloatDragMove);
  window.removeEventListener('mouseup', onSphereFloatDragEnd);
};
const onSphereFloatDragStart = (e: MouseEvent) => {
  e.preventDefault();
  sphereDrag = { sx: e.clientX, sy: e.clientY, ox: sphereFloatOffset.value.x, oy: sphereFloatOffset.value.y };
  window.addEventListener('mousemove', onSphereFloatDragMove);
  window.addEventListener('mouseup', onSphereFloatDragEnd);
};

const show = () => {
  if (imb.value == null) return;
  for (let i=0; i<imb.value.length; i++){
    showImage(i);
  }
  boxStateVersion.value++;
};

const showImage = (i:number) => {

  const info1 = imageBoxInfos.value[i];
  // tileN が infos より先に伸びる過渡状態 (レイアウト切替や HMR 直後) では
  // ここが undefined になりうる。判定関数は null 安全だが、この下で info を直接
  // 読む経路があるので入口でも弾く (CLAUDE.md 2.8 と同じ「throw させない」方針)。
  if (!info1) return;

  // 各 draw メソッドは async (GPU パスは offscreen 描画後に ctx.drawImage する)。
  // アノテーション (polygon / sphere / rect) を同期的に描くと、後から解決する GPU 描画に
  // 上書きされて消える (特に描画中 polygon の線が見えない)。draw の promise を捕まえて
  // 完了後に drawAnnotationOverlays を走らせる。
  let drawPromise: Promise<unknown> | void;

  if (isDicomSliceImageBoxInfo(i)){
    const info = info1 as DicomSliceImageBoxInfo;

    const j = info.currentSeriesNumber;
    
    if (seriesList[j] == null || seriesList[j].myDicom == null) return;

    const dataSet = seriesList[j].myDicom![info.currentSliceNumber];

    try {
      if (dataSet === undefined) {
        imb.value![i].clear();
      } else {
        // ★1: 未対応 transfer syntax の DICOM は明示エラーで empty state 表示
        const _ts = getSeriesTransferSyntaxInfo([dataSet]);
        if (!_ts.supported) {
          imb.value![i].clear(`Unsupported: ${_ts.name}`);
          return;
        }
        // DICOM Library https://www.dicomlibrary.com/dicom/dicom-tags/
        // const studyInstanceUid = dataSet.string('x0020000d');
        // const patientid = dataSet.string('x00100020');
        // const mod = dataSet.string('x00080060');
        const rows = dataSet.int16("x00280010") ?? 512;
        const cols = dataSet.int16("x00280011") ?? 512;
        // box リサイズ時に fit を正確に引き直すため、描画のたびに画像サイズを控える
        info.imgW = cols;
        info.imgH = rows;

        // WindowCenter/Width: box の override → DICOM タグ → pixel 値域からの auto-window。
        // DX や Secondary Capture は WC/WW タグを欠くことが多く、その場合に
        // ww=1 だと画像がほぼ真っ白になる。タグ欠落時は pixel min/max から窓を作る。
        const dcmWcStr = dataSet.string("x00281050", 0);
        const dcmWwStr = dataSet.string("x00281051", 0);
        let wc: number, ww: number;
        if (imageBoxInfos.value[i].myWC != null && imageBoxInfos.value[i].myWW != null) {
          wc = imageBoxInfos.value[i].myWC!;
          ww = imageBoxInfos.value[i].myWW!;
        } else if (dcmWcStr != null && dcmWwStr != null && Number(dcmWwStr) > 0) {
          wc = Number(dcmWcStr);
          ww = Number(dcmWwStr);
        } else {
          const aw = autoWindowFromPixels(dataSet);
          wc = imageBoxInfos.value[i].myWC ?? aw.wc;
          ww = imageBoxInfos.value[i].myWW ?? aw.ww;
        }

        const intercept = Number(dataSet.string("x00281052") ?? "0");
        const slope = Number(dataSet.string("x00281053") ?? "1");

        const centerX = info.centerX;
        const centerY = info.centerY;
        
        if (info.zoom == null){
          // 「box 内に画像が全部収まる最大 zoom」: 横と縦の制約のうち厳しい方を採用。
          // 注意: 縦は box 全体高 imageBoxH ではなく titlebar (22px) を引いた表示領域。
          //   canvas の buffer は box 全体高だが visible 部分は titlebar より下なので、
          //   titlebar 高を引かないと下端 22px が画面外にはみ出す。
          //   .mv-titlebar の CSS height = 22px と一致させる (定数は上部で 1 か所に定義)。
          const fitW = (imageBoxW.value ?? 1) / cols;
          const fitH = Math.max(1, ((imageBoxH.value ?? 1) - TITLEBAR_PX)) / rows;
          info.zoom = Math.min(fitW, fitH);
        }
        const zoom = info.zoom;

        info.imageNumberOfDicomTag = Number(dataSet.string("x00200013"));
        info.description = dataSet.string("x0008103e") ?? "SeriesName";

        const pixelDataElement = dataSet.elements.x7fe00010;
        // pixel data 要素を持たない DICOM (Structured Report / Presentation State 等) は
        // 表示できないので明示エラーで empty state にして抜ける。
        if (!pixelDataElement) {
          imb.value![i].clear('No pixel data in this DICOM');
          return;
        }

        // 2024/5/12 ここでjpeg解凍するのはあまりよろしくない。事前に非同期でしたい。今日のところは我慢する。
        if (DecompressJpegLossless.check(dataSet) && dataSet.decompressed == null){
          dataSet.decompressed = DecompressJpegLossless.decode(dataSet);
        }

        const buf = dataSet.decompressed == null ? dataSet.byteArray.buffer as ArrayBuffer : dataSet.decompressed;
        const offset = dataSet.decompressed == null ? pixelDataElement.dataOffset : 0;
        const length = dataSet.decompressed == null ? pixelDataElement.length : buf.byteLength;

        if (dataSet.string("x00280004") == "RGB") {
          const ui8a = new Uint8Array(buf, offset, length);
          drawPromise = imb.value![i].showRgb(ui8a, rows!, cols!, centerX, centerY, zoom);
        } else {
          // BitsAllocated に従って 8-bit / 16-bit を読み分ける (DX や Secondary
          // Capture は 8-bit grayscale で、Int16 固定読みだと画素が壊れる)。
          const i16a = readDicomPixelsAsInt16(dataSet);
          drawPromise = imb.value![i].show(
            i16a, rows, cols, wc, ww, intercept, slope, centerX, centerY, zoom,
            info.interpolation ?? 'bilinear'
          );
        }
      }
    } catch (ex) {
      console.log("Error parsing byte stream", ex);
    }
  }
  else if (isVolumeImageBoxInfo(i)){
    const info = info1 as VolumeImageBoxInfo;

    const j = info.currentSeriesNumber;
    const dv = seriesList[j].volume!;
    const pixelData0 = dv.voxel;
    const nx = dv.nx;
    const ny = dv.ny;
    const nz = dv.nz;
    const p00 = worldToVoxel_(screenToWorld(i,0,0),j);
    const v01 = worldToVoxel_(screenToWorld(i,0,1),j).sub(p00);
    const v10 = worldToVoxel_(screenToWorld(i,1,0),j).sub(p00);
    const [wc,ww] = getMyWCWW(i);
    const clut = cluts[info.clut];

    if (info.isVr){
      // Volume Rendering: 自由回転対応 ray-cast。vForward = box の vecz を world→voxel
      // 変換した through-plane 1 step ベクトル (mm 単位)。maxSteps は volume の対角長で十分。
      const aScale = info.mip?.alphaScale ?? 0.06;
      const screenOrigin = screenToWorld(i, 0, 0);
      const stepWorld = info.vecz.clone().normalize();   // 1 mm step
      const vForward = worldToVoxel_(screenOrigin.clone().add(stepWorld), j).sub(p00);
      const maxSteps = Math.ceil(Math.sqrt(nx*nx + ny*ny + nz*nz) * 1.2);
      // VR opacity TF: control points → 256-entry LUT。preset 既定は ramp。
      const tf = info.mip?.vrOpacityTF ?? DEFAULT_TF;
      const opacityLut = buildOpacityLut(tf);
      const shading = info.mip?.vrShading;
      drawPromise = imb.value![i].drawNiftiVR(pixelData0, nx, ny, nz, wc!, ww!,
        p00, v01, v10, vForward, maxSteps, clut, opacityLut, mipFastBoxes.has(i), aScale, shading);
    } else if (!info.isMip){
        // CT 寝台除去: この volume が CT で、segStore に body mask があれば適用
        // Pinia Proxy 回避のため seriesUID で照合 (voxel TypedArray 同一でも可)
        const ctRefUid = segStore.ctVolumeRef?.metadata?.seriesUID;
        const dvUid = dv.metadata?.seriesUID;
        const isThisCt = !!ctRefUid && ctRefUid === dvUid;
        const ctBodyMask = (segStore.ctBodyMaskEnabled
            && segStore.ctBodyMask
            && isThisCt)
          ? segStore.ctBodyMask
          : undefined;
        drawPromise = imb.value![i].drawNiftiSlice(pixelData0,nx,ny,nz, wc!, ww!, p00,v01,v10,clut,
          buildMaskOverlayForBox(i), ctBodyMask, info.interpolation ?? 'bilinear');
      }else{
      const angle = info.mip!.mipAngle;
      // MIP の対象 volume が PET と一致する場合のみマスク overlay を渡す
      // （マスクは PET 格子と同形なので、同じ pix と同じ index で参照可能）
      const petIdx = findPetSeriesIndex();
      const overlayForMip = (info.currentSeriesNumber === petIdx)
        ? buildMipMaskOverlay(i)
        : undefined;
      // 表面投影の閾値は **null なら volume の分布から自動決定**する。
      // 固定値は modality/被写体に依存して当たらない (kitty は体表が -900HU 付近)。
      const vol0 = seriesList[info.currentSeriesNumber].volume!;
      const surfThresh = info.mip!.thresholdSurfaceMip ?? surfaceThresholdFor(vol0).threshold;
      drawPromise = imb.value![i].drawNiftiMip(pixelData0,nx,ny,nz, wc!, ww!, p00,v01,v10,
        angle, surfThresh, info.mip!.depthSurfaceMip, clut,
        info.mip!.isSurface, overlayForMip, mipFastBoxes.has(i),
        { on: info.mip!.shadeSurface !== false,
          ambient: info.mip!.shadeAmbient ?? 0.25,
          specular: info.mip!.shadeSpecular ?? 0.35,
          depthCue: info.mip!.shadeDepthCue ?? 0.35,
          minRun: info.mip!.surfMinRun ?? 3 },
        { x: vol0.vectorX.length(), y: vol0.vectorY.length(), z: vol0.vectorZ.length() },
        // CT 寝台除去は MPR / fusion だけでなく MIP/sMIP にも適用する。
        // (「CT と認識されたのに remove bed が効かない」の実体はこれが渡っていなかったこと)
        ctBodyMaskForVolume(vol0));
      }
  }else{ // fusion
    const info = info1 as FusedVolumeImageBoxInfo;

    const j0 = info.currentSeriesNumber;
    const j1 = info.currentSeriesNumber1;

    const dv0 = seriesList[j0].volume!;
    const dv1 = seriesList[j1].volume!;

    const pixelData0 = dv0.voxel;
    const pixelData1 = dv1.voxel;

    const nx0 = dv0.nx;
    const ny0 = dv0.ny;
    const nz0 = dv0.nz;
    const nx1 = dv1.nx;
    const ny1 = dv1.ny;
    const nz1 = dv1.nz;

    const [wc0,ww0] = getMyWCWW(i);
    const [wc1,ww1] = getMyWCWW1(i);

    const p00_0 = worldToVoxel_(screenToWorld(i,0,0),j0);
    const v01_0 = worldToVoxel_(screenToWorld(i,0,1),j0).sub(p00_0);
    const v10_0 = worldToVoxel_(screenToWorld(i,1,0),j0).sub(p00_0);

    const p00_1 = worldToVoxel_(screenToWorld(i,0,0),j1);
    const v01_1 = worldToVoxel_(screenToWorld(i,0,1),j1).sub(p00_1);
    const v10_1 = worldToVoxel_(screenToWorld(i,1,0),j1).sub(p00_1);

    const clut0 = cluts[info.clut];
    const clut1 = cluts[info.clut1];

    // CT 寝台除去: pix0 (CT layer) が segStore.ctVolumeRef なら body mask を渡す
    // Pinia Proxy 回避のため seriesUID で照合
    const ctRefUid = segStore.ctVolumeRef?.metadata?.seriesUID;
    const dv0Uid = dv0.metadata?.seriesUID;
    const isFusionCtMatch = !!ctRefUid && ctRefUid === dv0Uid;
    const fusionCtBodyMask = (segStore.ctBodyMaskEnabled
        && segStore.ctBodyMask
        && isFusionCtMatch)
      ? segStore.ctBodyMask
      : undefined;
    // Fusion view ではマスク overlay を描かない（要望により）。
    if (info.isVr) {
      // Fusion VR: CT VR + PET VR を α blend
      const angle = info.mip?.mipAngle ?? 0;
      drawPromise = imb.value![i].drawFusionVR(
        pixelData0, nx0,ny0,nz0, wc0!, ww0!, p00_0,v01_0,v10_0,clut0,
        pixelData1, nx1,ny1,nz1, wc1!, ww1!, p00_1,v01_1,v10_1,clut1,
        angle, info.overlayAlpha ?? 0.5,
      );
    } else if (info.isMip) {
      // Fusion MIP: CT base MIP + PET overlay MIP を α blend
      const angle = info.mip?.mipAngle ?? 0;
      drawPromise = imb.value![i].drawFusionMip(
        pixelData0, nx0,ny0,nz0, wc0!, ww0!, p00_0,v01_0,v10_0,clut0,
        pixelData1, nx1,ny1,nz1, wc1!, ww1!, p00_1,v01_1,v10_1,clut1,
        angle, info.overlayAlpha ?? 0.5,
      );
    } else {
      drawPromise = imb.value![i].drawNiftiSliceFusion(
        pixelData0, nx0,ny0,nz0, wc0!, ww0!, p00_0,v01_0,v10_0,clut0,
        pixelData1, nx1,ny1,nz1, wc1!, ww1!, p00_1,v01_1,v10_1,clut1,
        undefined,
        fusionCtBodyMask,
        info.overlayAlpha ?? 0.5,
        info.interpolation ?? 'bilinear',
        info.interpolation1 ?? 'bilinear',
      );
    }
  }

  // アノテーションは base 描画 (async GPU 含む) の完了後に重ねる。
  // 同期的に描くと GPU の ctx.drawImage に上書きされ、描画中 polygon が見えなくなる。
  if (drawPromise && typeof (drawPromise as Promise<unknown>).then === 'function') {
    (drawPromise as Promise<unknown>).then(() => drawAnnotationOverlays(i)).catch(() => { /* 描画失敗時はアノテーションもスキップ */ });
  } else {
    drawAnnotationOverlays(i);
  }
  // box i の state が更新されたので reactive trigger を bump (cross-ref line 等)
  boxStateVersion.value++;
};

const drawAnnotationOverlays = (i: number) => {
  // 矩形 ROI は box 種別を問わず描く (DICOM slice / Volume / Fusion)。
  drawRectRoiOverlays(i);

  // 球 / polygon は Volume box のみ。
  if (!isVolumeImageBoxInfo(i)) return;
  const a = getVolumeImageBoxInfo(i);

  // 球: 現スライス面と球の交差円を描く。
  const s = segStore.sphere;
  if (s){
    const c = s.centerWorld;
    const planeOrigin = a.centerInWorld;
    const normal = a.vecz.clone().normalize();
    const d = (c.x - planeOrigin.x) * normal.x + (c.y - planeOrigin.y) * normal.y + (c.z - planeOrigin.z) * normal.z;
    if (Math.abs(d) <= s.radiusMm){
      const rIntersect = Math.sqrt(s.radiusMm * s.radiusMm - d * d);
      // 中心を screen 座標へ。screenToWorld の逆: vecx, vecy で展開しているので、(x,y)→ world のうち (x,y) を解く。
      const dxw = c.x - planeOrigin.x - d * normal.x;
      const dyw = c.y - planeOrigin.y - d * normal.y;
      const dzw = c.z - planeOrigin.z - d * normal.z;
      // dx*vecx + dy*vecy = (dxw,dyw,dzw) を最小二乗で。vecx,vecy は直交とは限らないが大体直交。
      const ax = a.vecx, ay = a.vecy;
      const a11 = ax.x*ax.x + ax.y*ax.y + ax.z*ax.z;
      const a22 = ay.x*ay.x + ay.y*ay.y + ay.z*ay.z;
      const a12 = ax.x*ay.x + ax.y*ay.y + ax.z*ay.z;
      const b1 = ax.x*dxw + ax.y*dyw + ax.z*dzw;
      const b2 = ay.x*dxw + ay.y*dyw + ay.z*dzw;
      const det = a11*a22 - a12*a12;
      if (Math.abs(det) > 1e-12){
        const u = (a22*b1 - a12*b2) / det;
        const v = (a11*b2 - a12*b1) / det;
        const cx = u + imageBoxW.value!/2;
        const cy = v + boxRenderHeight(i)/2;   // rowSpan 対応
        const pixPerMm = 1 / Math.sqrt(a11);
        const rPx = rIntersect * pixPerMm;
        imb.value![i].drawSphereOverlay(cx, cy, rPx);
      }
    }
  }

  // polygon: 描画中のものをオーバーレイ。inProgress ならカーソルまでのラバーバンドも描く。
  const p = segStore.polygon;
  if (p && p.imageBoxId === i && p.screenVertices.length > 0){
    const verts = (p.inProgress && polygonCursor.value)
      ? [...p.screenVertices, polygonCursor.value]
      : p.screenVertices;
    imb.value![i].drawPolygonOverlay(verts, p.mode, !p.inProgress);
  }

  // brush: ツール選択中はカーソル位置にブラシサイズの円 (物理 mm → screen 投影) を表示。
  // |vecx| / |vecy| = screen 1px あたりの world mm なので、その逆数が px/mm。
  if (leftButtonFunction.value === 'brushROI' && brushCursor.value && brushCursor.value.boxId === i && !a.isMip && !a.isVr){
    const rMm = segStore.brushRadiusMm;
    const pxPerMmX = 1 / Math.max(a.vecx.length(), 1e-6);
    const pxPerMmY = 1 / Math.max(a.vecy.length(), 1e-6);
    imb.value![i].drawBrushCursorOverlay(
      brushCursor.value.x, brushCursor.value.y, rMm * pxPerMmX, rMm * pxPerMmY, 'add',
    );
  }
};

// box i に、確定済み矩形 ROI とドラッグ中 draft を描く。
// 確定済み矩形は voxel 座標で保持されているので、box の現在の表示に合わせて
// canvas 座標へ逆投影する。series が一致する box にのみ描画する。
// DICOM slice box では slice index が一致する矩形のみ。
const drawRectRoiOverlays = (i: number) => {
  const isDicomSlice = isDicomSliceImageBoxInfo(i);
  if (!isDicomSlice && !isAnyVolumeBox(i)) return;
  const seriesIdx = seriesIndexOfBox(i);

  const rectsToDraw: Array<{ x0: number; y0: number; x1: number; y1: number; label?: string }> = [];
  // 番号は rectRois 全配列のインデックスを使う (= 一覧パネルの表示番号と一致させるため)。
  // box ごとの series/slice フィルタ後の部分インデックスにしてはいけない。
  for (let idx = 0; idx < segStore.rectRois.length; idx++) {
    const r = segStore.rectRois[idx];
    if (r.seriesIndex !== seriesIdx) continue;
    if (isDicomSlice) {
      // DICOM slice: 矩形が配置されたスライスと現在表示中スライスが一致する場合のみ。
      const info = imageBoxInfos.value[i] as DicomSliceImageBoxInfo;
      if (Math.round(r.topLeft[2]) !== info.currentSliceNumber) continue;
    }
    const a = voxelToScreenAny(i, r.topLeft[0], r.topLeft[1], r.topLeft[2]);
    const b = voxelToScreenAny(i, r.bottomRight[0], r.bottomRight[1], r.bottomRight[2]);
    if (!a || !b) continue;
    rectsToDraw.push({
      x0: a[0], y0: a[1], x1: b[0], y1: b[1],
      label: segStore.rectRoiDisplayName(idx),
    });
  }

  // ドラッグ中 draft はこの box のものだけ screen 座標そのままで描く。
  const d = rectRoiDraft.value;
  const draftForBox = (d && d.boxId === i)
    ? { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 }
    : null;

  if (rectsToDraw.length > 0 || draftForBox) {
    imb.value![i].drawRectRoiOverlay(rectsToDraw, draftForBox);
  }
};

const screenToWorld = (imageBoxNumber: number, x: number, y:number) => {

  // 今はVolumeのときしか対応していないが、理論的にはDicomにも対応できる。

  const world = new THREE.Vector3(0,0,0);
  const a = imageBoxInfos.value[imageBoxNumber] as VolumeImageBoxInfo;
  // **高さは boxRenderHeight (canvas の実寸)**。imageBoxH は「1 行ぶん」なので、
  // rowSpan=2 の背高 box (PET/CT + MIP の MIP 列) でそのまま使うと中心が半行ずれる。
  world.add(a.centerInWorld)
       .addScaledVector(a.vecx, x - imageBoxW.value!/2)
       .addScaledVector(a.vecy, y - boxRenderHeight(imageBoxNumber)/2);
  return world;
}

// DICOM slice box の canvas (x, y) → world (mm)。
// 表示中の slice K の DICOM タグ
//   (0020,0032) ImagePositionPatient   = ipp
//   (0020,0037) ImageOrientationPatient = orient (6 floats)
//   (0028,0030) PixelSpacing            = pixSpacing
//   (0028,0010/0011) Rows / Columns
// と info.zoom / info.centerX/Y を使い、ImageBox.drawImageCvZoom と同じ
// 「fx = (x - canvas/2)/zoom + nx/2 + shiftX」ピクセル変換を逆走り。
const screenToWorldDicomSlice = (boxId: number, cx: number, cy: number): THREE.Vector3 | null => {
  if (!isDicomSliceImageBoxInfo(boxId)) return null;
  const info = imageBoxInfos.value[boxId] as DicomSliceImageBoxInfo;
  const series = seriesList[info.currentSeriesNumber];
  const ds = series?.myDicom?.[info.currentSliceNumber];
  if (!ds) return null;
  const cols = ds.int16('x00280011') ?? 0;
  const rows = ds.int16('x00280010') ?? 0;
  if (!cols || !rows) return null;
  const ps0 = ds.floatString('x00280030', 0);
  const ps1 = ds.floatString('x00280030', 1);
  const o0 = ds.floatString('x00200037', 0);
  const o1 = ds.floatString('x00200037', 1);
  const o2 = ds.floatString('x00200037', 2);
  const o3 = ds.floatString('x00200037', 3);
  const o4 = ds.floatString('x00200037', 4);
  const o5 = ds.floatString('x00200037', 5);
  const i0 = ds.floatString('x00200032', 0);
  const i1 = ds.floatString('x00200032', 1);
  const i2 = ds.floatString('x00200032', 2);
  if (ps0 == null || o0 == null || i0 == null) return null;
  const vecRow = new THREE.Vector3(o0, o1!, o2!).multiplyScalar(ps0!);  // 1 col-step
  const vecCol = new THREE.Vector3(o3!, o4!, o5!).multiplyScalar(ps1!); // 1 row-step
  const ipp = new THREE.Vector3(i0, i1!, i2!);
  const canvasW = imageBoxW.value!;
  const canvasH = imageBoxH.value!;
  const zoom = info.zoom ?? 1;
  const fx = (cx - canvasW / 2) / zoom + cols / 2 + info.centerX;
  const fy = (cy - canvasH / 2) / zoom + rows / 2 + info.centerY;
  return ipp.clone().addScaledVector(vecRow, fx).addScaledVector(vecCol, fy);
};

// 統合: Volume / Fusion / DICOM slice いずれの box でも canvas → world を返す。
const screenToWorldAny = (boxId: number, cx: number, cy: number): THREE.Vector3 | null => {
  if (boxId < 0 || boxId >= imageBoxInfos.value.length) return null;
  if (isAnyVolumeBox(boxId)) return screenToWorld(boxId, cx, cy);
  if (isDicomSliceImageBoxInfo(boxId)) return screenToWorldDicomSlice(boxId, cx, cy);
  return null;
};

// box が参照している series の index (seriesList の添字) を返す。
const seriesIndexOfBox = (boxId: number): number => {
  const info = imageBoxInfos.value[boxId] as { currentSeriesNumber?: number } | undefined;
  return info?.currentSeriesNumber ?? -1;
};

// canvas (cx, cy) → 当該 box の series の voxel 座標。
// DICOM slice box: 表示中スライスの (col, row, sliceNumber)。
// Volume / Fusion box: 当該 volume の worldToVoxel 結果。
// 戻り値の第3要素は through-plane の voxel index。
const screenToVoxelAny = (boxId: number, cx: number, cy: number): [number, number, number] | null => {
  if (boxId < 0 || boxId >= imageBoxInfos.value.length) return null;
  if (isDicomSliceImageBoxInfo(boxId)) {
    const info = imageBoxInfos.value[boxId] as DicomSliceImageBoxInfo;
    const series = seriesList[info.currentSeriesNumber];
    const ds = series?.myDicom?.[info.currentSliceNumber];
    if (!ds) return null;
    const cols = ds.int16('x00280011') ?? 0;
    const rows = ds.int16('x00280010') ?? 0;
    if (!cols || !rows) return null;
    // screenToWorldDicomSlice / DebugInspector と同じ pixel 変換。
    const zoom = info.zoom ?? 1;
    const fx = (cx - imageBoxW.value! / 2) / zoom + cols / 2 + info.centerX;
    const fy = (cy - imageBoxH.value! / 2) / zoom + rows / 2 + info.centerY;
    return [fx, fy, info.currentSliceNumber];
  }
  if (isAnyVolumeBox(boxId)) {
    const j = seriesIndexOfBox(boxId);
    if (j < 0 || !seriesList[j]?.volume) return null;
    const w = screenToWorld(boxId, cx, cy);
    const v = worldToVoxel_(w, j);
    return [v.x, v.y, v.z];
  }
  return null;
};

// 上の逆変換: series voxel 座標 → 当該 box の canvas (cx, cy)。
// 矩形 ROI overlay を描くために使う。Volume box では through-plane voxel も渡す。
const voxelToScreenAny = (boxId: number, vx: number, vy: number, vz: number): [number, number] | null => {
  if (boxId < 0 || boxId >= imageBoxInfos.value.length) return null;
  if (isDicomSliceImageBoxInfo(boxId)) {
    const info = imageBoxInfos.value[boxId] as DicomSliceImageBoxInfo;
    const series = seriesList[info.currentSeriesNumber];
    const ds = series?.myDicom?.[info.currentSliceNumber];
    if (!ds) return null;
    const cols = ds.int16('x00280011') ?? 0;
    const rows = ds.int16('x00280010') ?? 0;
    if (!cols || !rows) return null;
    const zoom = info.zoom ?? 1;
    const cx = (vx - cols / 2 - info.centerX) * zoom + imageBoxW.value! / 2;
    const cy = (vy - rows / 2 - info.centerY) * zoom + imageBoxH.value! / 2;
    return [cx, cy];
  }
  if (isAnyVolumeBox(boxId)) {
    const j = seriesIndexOfBox(boxId);
    if (j < 0 || !seriesList[j]?.volume) return null;
    const w = voxelToWorld_(new THREE.Vector3(vx, vy, vz), j);
    const s = worldToScreen(boxId, w);
    if (!s) return null;
    return [s.sx, s.sy];
  }
  return null;
};

const voxelToWorld_ = (p: THREE.Vector3, vol_id:number) => {
  const v = seriesList[vol_id].volume!;
  return voxelToWorld(p, v);
}

// world 座標 → 画面 (sx, sy, sz) に逆射影。screenToWorld の inverse。
// sx, sy は canvas 内 px (0..imageBoxW/H)、sz は plane からの距離 (off-plane 判定用)。
// Volume / Fusion box でのみ意味を持つ。
const worldToScreen = (boxId: number, w: THREE.Vector3): { sx: number; sy: number; sz: number } | null => {
  if (boxId < 0 || boxId >= imageBoxInfos.value.length) return null;
  if (!isAnyVolumeBox(boxId)) return null;
  const a = imageBoxInfos.value[boxId] as VolumeImageBoxInfo;
  if (!a.vecx || !a.vecy || !a.vecz) return null;
  const cx = (imageBoxW.value ?? 0) / 2;
  const cy = boxRenderHeight(boxId) / 2;   // rowSpan 対応 (screenToWorld と対称)
  const dx = w.x - a.centerInWorld.x;
  const dy = w.y - a.centerInWorld.y;
  const dz = w.z - a.centerInWorld.z;
  // [vecx vecy vecz] * (sx_off, sy_off, sz_off)^T = (dx, dy, dz)^T
  const A = [
    [a.vecx.x, a.vecy.x, a.vecz.x],
    [a.vecx.y, a.vecy.y, a.vecz.y],
    [a.vecx.z, a.vecy.z, a.vecz.z],
  ];
  try {
    const ans = solve(A, [dx, dy, dz]);
    return { sx: ans[0] + cx, sy: ans[1] + cy, sz: ans[2] };
  } catch {
    return null;
  }
}

const worldToVoxel_ = (p: THREE.Vector3, vol_id:number) => {
  const v = seriesList[vol_id].volume!;
  return worldToVoxel(p,v);
}

const changeSuv = (a:number,b:number, doShow: boolean) => {
  for (let i=0; i<imageBoxInfos.value.length; i++){
    setMyWCWW(i, (a+b)/2, b-a);
  }
  if (doShow){
    show();
  }
}

const findPetSeriesIndex = (): number => {
  const ref = segStore.petVolumeRef;
  if (!ref) return -1;
  // Pinia は state を Proxy 化するので === では一致しない。voxel TypedArray の同一性で照合。
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    if (!v) continue;
    if (v.voxel === ref.voxel) return i;
    if (v === ref) return i;
    if (v.metadata?.seriesUID && ref.metadata?.seriesUID && v.metadata.seriesUID === ref.metadata.seriesUID) return i;
  }
  // フォールバック: modality === 'PT' のシリーズを返す
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    if (v?.metadata?.modality === 'PT') return i;
  }
  return -1;
};

// ===== デバッグ機能 (Voxel inspector) の生成 =====
// 実体は useDebugInspector composable に分離。deps (screenToWorldAny / worldToVoxel_ /
// findPetSeriesIndex 等) がすべて定義済みのこの位置で生成する。seriesList は reassign される
// let なので必ず getter 経由で最新を渡す。返却された ref/関数は template・イベントハンドラから
// 参照されるため、そのまま同名で分割代入する。
const {
  debugHoverRows,
  debugMaskInfo,
  debugScreenX,
  debugScreenY,
  debugShow,
  debugWorld,
  updateDebugHover,
  handleDebugEditClick,
} = useDebugInspector({
  debugMode,
  imageBoxInfos,
  imageBoxW,
  imageBoxH,
  getSeriesList: () => seriesList,
  isDicomSliceImageBoxInfo,
  isAnyVolumeBox,
  getCanvasXY,
  screenToWorldAny,
  worldToVoxel_,
  findPetSeriesIndex,
  show,
});

// ===== View state URL / Snapshot file (session save/load) の生成 =====
// 実体は useSnapshotIo composable に分離。rectRoiToJson / importRectRoisFromJson は rect ROI
// export とも共有するため DicomView 側に残し、getter として渡す。downloadSnapshotFile /
// loadSnapshotFile は defineExpose 経由で App.vue から呼ばれる。
const {
  downloadSnapshotFile,
  loadSnapshotFile,
} = useSnapshotIo({
  tileN,
  imageBoxInfos,
  syncImageBox,
  isDicomSliceImageBoxInfo,
  isFusedImageBoxInfo,
  isAnyVolumeBox,
  getBoxCurrentPlane,
  setPlaneOnBox,
  show,
  rectRoiToJson,
  importRectRoisFromJson,
  applyStoredRegistrations,
});

// 描画パイプラインが使う labelClut を store の各ラベル色から動的生成する。
// index = label id で参照される (CPU: labelClut[lid % len], GPU: lid % len)。
// 静的 labelClut (Clut.ts) は palette index であり label.color と一致しないため
// (例: Physiological id=2 は水色 [120,200,255] を意図しているが labelClut[2] は緑)、
// ここで label.color を単一の真実として color を引けるようにする。
// computed なので labels の色/数が変わらない限り同一配列参照を返し、
// GPU 側の clutBufCache (WeakMap keyed by array identity) が正しくヒットする。
// 各 entry は [r, g, b, visibility]。visibility (0/1) は overlay で eye アイコン非表示の
// ラベルを描かないための係数 (CPU: alpha *= c[3], GPU shader: alpha *= labelClut[cidx].a)。
const labelClutDynamic = computed<number[][]>(() => {
  const maxId = segStore.labels.reduce((m, l) => Math.max(m, l.id), 0);
  const arr: number[][] = [[0, 0, 0, 1]];  // index 0 = background
  for (let id = 1; id <= maxId; id++) {
    const lbl = segStore.labels.find(l => l.id === id);
    const vis = lbl ? (lbl.visible === false ? 0 : 1) : 1;
    // ラベルが存在すればその明示色。欠番 id は静的 palette にフォールバック。
    const base = lbl
      ? [lbl.color[0], lbl.color[1], lbl.color[2]]
      : labelClut[id % labelClut.length];
    arr[id] = [base[0], base[1], base[2], vis];
  }
  return arr;
});

// MIP 用のマスクオーバレイ。drawNiftiMip では mask の (nx,ny,nz) が
// pix と一致している前提で、内部で投影マップを生成する。
// p00/v01/v10 は drawNiftiMip 側では使われない（投影後の 2D 配列で参照）が、
// 型を満たすためにダミーで渡す。
const buildMipMaskOverlay = (boxId?: number) => {
  if (!segStore.overlayEnabled) return undefined;
  if (boxId !== undefined && !isBoxOverlayEnabled(boxId)) return undefined;
  const mask = segStore.finalMask;
  const pet = segStore.petVolumeRef;
  if (!mask || !pet) return undefined;
  return {
    mask,
    p00: new THREE.Vector3(0,0,0),
    v01: new THREE.Vector3(0,0,0),
    v10: new THREE.Vector3(0,0,0),
    nx: pet.nx, ny: pet.ny, nz: pet.nz,
    labelClut: labelClutDynamic.value,
    alpha: segStore.overlayAlpha,
    version: segStore.maskVersion,
  };
};

const buildMaskOverlayForBox = (i: number) => {
  if (!segStore.overlayEnabled) return undefined;
  if (!isBoxOverlayEnabled(i)) return undefined;
  const mask = segStore.finalMask;
  const pet = segStore.petVolumeRef;
  if (!mask || !pet) return undefined;
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) return undefined;

  const p00 = worldToVoxel_(screenToWorld(i, 0, 0), petIdx);
  const v01 = worldToVoxel_(screenToWorld(i, 0, 1), petIdx).sub(p00);
  const v10 = worldToVoxel_(screenToWorld(i, 1, 0), petIdx).sub(p00);

  return {
    mask,
    p00, v01, v10,
    nx: pet.nx, ny: pet.ny, nz: pet.nz,
    labelClut: labelClutDynamic.value,
    alpha: segStore.overlayAlpha,
    // GPU mask texture cache の invalidation key。これが無いと version=0 固定になり、
    // finalMask を in-place 編集 (assign label / polygon) しても再 upload されず、
    // paging 等で別 version 要求が走るまで変更が画面に反映されない。
    version: segStore.maskVersion,
  };
};

// 中央スライスから 96x96 のサムネイルを作る。
// volume があれば voxel から、なければ DICOM 中央スライスから生成。
const generateThumbnail = (s: SeriesList, modality: string, sliceIdx?: number): string | null => {
  const TH = 96;
  const cv = document.createElement('canvas');
  cv.width = TH; cv.height = TH;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, TH, TH);

  // WC/WW のデフォルト
  const isPet = modality === 'PT' || modality === 'PET';
  const defaultWC = isPet ? 3 : 40;
  const defaultWW = isPet ? 6 : 400;

  // DICOM タグから WC/WW を読み出す。サムネを「肺野条件 CT は肺野で表示」したい用途のため、
  // s.myDicom が利用可能なら voxel パスでも DICOM タグを優先する (s.volume 単独パスでも適用)。
  // PT は volume 上で SUV 化されているため WC/WW を suvFactor 倍する必要がある。
  const dicomWindow = (() => {
    if (!s.myDicom || s.myDicom.length === 0) return null;
    const ds = s.myDicom[Math.floor(s.myDicom.length / 2)];
    const wcStr = ds.string('x00281050', 0);
    const wwStr = ds.string('x00281051', 0);
    if (wcStr == null || wwStr == null) return null;
    const wc = Number(wcStr);
    const ww = Number(wwStr);
    if (!Number.isFinite(wc) || !Number.isFinite(ww) || ww <= 0) return null;
    return { wc, ww };
  })();

  if (s.volume){
    const v = s.volume;
    const k = sliceIdx != null
      ? Math.max(0, Math.min(v.nz - 1, sliceIdx))
      : Math.floor(v.nz / 2);
    // CT/MR: DICOM WC/WW (HU/MR 値) は volume voxel と同じスケール。そのまま使う。
    // PT: voxel は SUV (raw × suvFactor) なので DICOM WC/WW (Bq/mL 等) は × suvFactor して比較。
    //     suvFactor 不明なら default (3 / 6 SUV)。
    let wc = defaultWC, ww = defaultWW;
    if (dicomWindow) {
      if (isPet) {
        const suvF = v.metadata?.suvFactor;
        if (suvF != null && suvF > 0) {
          wc = dicomWindow.wc * suvF;
          ww = dicomWindow.ww * suvF;
        }
      } else {
        wc = dicomWindow.wc;
        ww = dicomWindow.ww;
      }
    }
    let ad = 0;
    for (let y = 0; y < TH; y++){
      for (let x = 0; x < TH; x++){
        const px = Math.floor(x / TH * v.nx);
        const py = Math.floor(y / TH * v.ny);
        const raw = v.voxel[k * v.nx * v.ny + py * v.nx + px];
        let p = Math.floor((raw - (wc - ww/2)) * (255/ww));
        if (p < 0) p = 0; if (p > 255) p = 255;
        img.data[ad] = p;
        img.data[ad+1] = p;
        img.data[ad+2] = p;
        img.data[ad+3] = 255;
        ad += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  if (s.myDicom && s.myDicom.length > 0){
    try {
      const k = sliceIdx != null
        ? Math.max(0, Math.min(s.myDicom.length - 1, sliceIdx))
        : Math.floor(s.myDicom.length / 2);
      const ds = s.myDicom[k];
      const rows = ds.int16("x00280010") ?? 512;
      const cols = ds.int16("x00280011") ?? 512;
      const intercept = Number(ds.string("x00281052") ?? "0");
      const slope = Number(ds.string("x00281053") ?? "1");
      const pde = ds.elements.x7fe00010;
      if (!pde) return null;
      const photo = (ds.string("x00280004") ?? '').toUpperCase();
      // WC/WW: DICOM タグ → modality default。タグ欠落 (DX 等) は pixel
      // 値域からの auto-window。defaultWC/WW は 0..255 の DX で暗くなりすぎる。
      const dcmWc = ds.string("x00281050", 0);
      const dcmWw = ds.string("x00281051", 0);
      let wc: number, ww: number;
      if (dcmWc != null && dcmWw != null && Number(dcmWw) > 0) {
        wc = Number(dcmWc);
        ww = Number(dcmWw);
      } else if (photo === 'RGB') {
        wc = defaultWC; ww = defaultWW; // RGB は windowing しないので未使用
      } else {
        const aw = autoWindowFromPixels(ds);
        wc = aw.wc; ww = aw.ww;
      }

      // RGB 8bit interleaved: そのまま色をサンプリング (windowing 不要)
      if (photo === 'RGB') {
        const u8 = new Uint8Array(ds.byteArray.buffer, pde.dataOffset, pde.length);
        let ad = 0;
        for (let y = 0; y < TH; y++) {
          for (let x = 0; x < TH; x++) {
            const px = Math.floor(x / TH * cols);
            const py = Math.floor(y / TH * rows);
            const adP = (py * cols + px) * 3;
            img.data[ad]   = u8[adP]   ?? 0;
            img.data[ad+1] = u8[adP+1] ?? 0;
            img.data[ad+2] = u8[adP+2] ?? 0;
            img.data[ad+3] = 255;
            ad += 4;
          }
        }
        ctx.putImageData(img, 0, 0);
        return cv.toDataURL('image/png');
      }

      // grayscale (MONOCHROME1/2、8/16-bit)
      // JPEG Lossless: decompressed キャッシュが無ければサムネ生成は諦める
      // (背景 decompress が完了すれば再 build される)
      if (DecompressJpegLossless.check(ds) && (ds as MyDicom).decompressed == null) {
        return null;
      }
      // BitsAllocated に従って 8/16-bit を読み分ける (Int16 固定だと DX で破損)
      const i16 = readDicomPixelsAsInt16(ds);
      let ad = 0;
      for (let y = 0; y < TH; y++){
        for (let x = 0; x < TH; x++){
          const px = Math.floor(x / TH * cols);
          const py = Math.floor(y / TH * rows);
          const raw = i16[py * cols + px] * slope + intercept;
          let p = Math.floor((raw - (wc - ww/2)) * (255/ww));
          if (p < 0) p = 0; if (p > 255) p = 255;
          img.data[ad] = p;
          img.data[ad+1] = p;
          img.data[ad+2] = p;
          img.data[ad+3] = 255;
          ad += 4;
        }
      }
      ctx.putImageData(img, 0, 0);
      return cv.toDataURL('image/png');
    } catch {
      return null;
    }
  }
  return null;
}

const rebuildSeriesSummaries = () => {
  const out: SeriesSummary[] = [];
  for (let i = 0; i < seriesList.length; i++){
    const s = seriesList[i];
    let description = '', modality = '-', matrixSize = '-', voxelSize = '-', fileCount = 0;
    if (s.myDicom && s.myDicom.length > 0){
      const ds = s.myDicom[0];
      description = ds.string("x0008103e") ?? '';
      modality = (ds.string("x00080060") ?? '').toUpperCase();
      const rows = ds.int16("x00280010") ?? 0;
      const cols = ds.int16("x00280011") ?? 0;
      matrixSize = `${rows}×${cols}×${s.myDicom.length}`;
      const px = ds.floatString("x00280030", 0);
      const py = ds.floatString("x00280030", 1);
      if (px != null && py != null){
        voxelSize = `${px.toFixed(2)}×${py.toFixed(2)} mm`;
      }
      fileCount = s.myDicom.length;
    }
    if (s.volume){
      const v = s.volume;
      modality = v.metadata?.modality ?? modality;
      description = v.metadata?.seriesDescription ?? description;
      matrixSize = `${v.nx}×${v.ny}×${v.nz}`;
      voxelSize = `${v.vectorX.length().toFixed(2)}×${v.vectorY.length().toFixed(2)}×${v.vectorZ.length().toFixed(2)} mm`;
    }
    if (!description) description = `Series ${i}`;
    let seriesUID = '';
    if (s.myDicom && s.myDicom.length > 0) {
      seriesUID = s.myDicom[0].string('x0020000e') ?? '';
    } else if (s.volume?.metadata?.seriesUID) {
      seriesUID = s.volume.metadata.seriesUID;
    }

    // ★1: transfer syntax 判定
    const tsInfo = s.myDicom && s.myDicom.length > 0
      ? getSeriesTransferSyntaxInfo(s.myDicom)
      : { name: 'NIfTI / Other', supported: true };

    // ★3: PT 識別用フィールド
    let acquisitionTime: string | undefined;
    let studyDate: string | undefined;
    let studyUID: string | undefined;
    let attenuationCorrected: boolean | undefined;
    if (s.myDicom && s.myDicom.length > 0) {
      const ds = s.myDicom[0];
      const at = ds.string('x00080032'); // AcquisitionTime "HHMMSS.FFFFFF"
      if (at && at.length >= 4) {
        acquisitionTime = `${at.substring(0,2)}:${at.substring(2,4)}`;
      }
      const sd = ds.string('x00080020'); // StudyDate "YYYYMMDD"
      if (sd && sd.length >= 8) {
        studyDate = `${sd.substring(0,4)}-${sd.substring(4,6)}-${sd.substring(6,8)}`;
      }
      studyUID = ds.string('x0020000d') ?? undefined;
      if (modality === 'PT' || modality === 'PET') {
        // (0028,0051) Corrected Image: backslash-separated values like "ATTN\\DECY"
        const corrected = ds.string('x00280051') ?? '';
        attenuationCorrected = corrected.toUpperCase().includes('ATTN');
      }
    }

    const ds0 = s.myDicom?.[0];
    const photometric = ds0?.string('x00280004');
    const imageType   = ds0?.string('x00080008');
    // フレーム数: DICOM は myDicom.length、NIfTI のみは volume.nz
    const nFramesEffective = s.myDicom?.length ?? s.volume?.nz ?? 0;
    const isPrimary = isPrimaryForFusion({
      nFrames: nFramesEffective,
      modality,
      photometric,
      imageType,
    });
    const isRgb = isRgbSeries(photometric);

    // doSort で NIfTI は myDicom: null + volume:{...} で push されるため
    // myDicom の有無で読み込み元ファイル種別を判定できる。
    const sourceType: 'DICOM' | 'NIFTI' =
      (s.myDicom && s.myDicom.length > 0) ? 'DICOM' : 'NIFTI';

    // Datatype label: 優先順位 (1) volume.metadata.datatypeName (NIfTI / MPR'd DICOM)
    // (2) DICOM tag (0028,0100 + 0028,0103) — まだ MPR 前でも表示するため
    let datatypeName: string | undefined = s.volume?.metadata?.datatypeName;
    if (!datatypeName && s.myDicom && s.myDicom.length > 0) {
      const ds = s.myDicom[0];
      const bits = ds.int16("x00280100");
      const isSigned = (ds.int16("x00280103") ?? 0) === 1;
      if (bits != null) datatypeName = `${isSigned ? 'Int' : 'Uint'}${bits}`;
    }

    out.push({
      index: i,
      description,
      modality: modality || '-',
      matrixSize,
      voxelSize,
      fileCount,
      hasVolume: !!s.volume,
      thumbnail: generateThumbnail(s, modality),
      seriesUID,
      transferSyntaxName: tsInfo.name,
      transferSyntaxSupported: tsInfo.supported,
      transferSyntaxReason: tsInfo.reason,
      acquisitionTime,
      studyDate,
      studyUID,
      attenuationCorrected,
      isPrimary,
      isRgb,
      sourceType,
      datatypeName,
    });
  }
  seriesSummaries.value = out;
}

const detectPetCtFromDicom = () => {
  // DICOM ファイル群から PET/CT/MR modality を検出して store に登録。
  // volume が未生成のシリーズは modality タグだけでも検出して候補として扱う。
  // NIfTI のみのシリーズは myDicom が null なので volume.metadata.modality を併用。
  let petIdx = -1, ctIdx = -1, mrIdx = -1;
  for (let i = 0; i < seriesList.length; i++) {
    let m = '';
    const dlist = seriesList[i].myDicom;
    if (dlist && dlist.length > 0) {
      m = (dlist[0].string("x00080060") ?? "").toUpperCase();
    } else {
      m = (seriesList[i].volume?.metadata?.modality ?? '').toUpperCase();
    }
    if ((m === "PT" || m === "PET") && petIdx < 0) petIdx = i;
    if (m === "CT" && ctIdx < 0) ctIdx = i;
    if (m === "MR" && mrIdx < 0) mrIdx = i;
  }
  segStore.setPetVolume(petIdx >= 0 ? (seriesList[petIdx].volume ?? null) : null);
  segStore.setCtVolume(ctIdx >= 0 ? (seriesList[ctIdx].volume ?? null) : null);
  segStore.setMrVolume(mrIdx >= 0 ? (seriesList[mrIdx].volume ?? null) : null);
};

// volume 新規生成時に segStore の active 参照を「未設定なら」設定する。
// 注意: 既に active がある場合は上書きしない (ユーザの ★ 選択や既存 mask を尊重するため)。
//
// 旧実装は seriesList を頭から走査して最後に見つかった PT/CT/MR で常に上書きしていたが、
// (a) ユーザの ★ 選択を毎回壊し、(b) setPetVolume で seriesUID が変わると mask を破棄していた。
// fusion drag-and-drop で別 PT の volume を生成した瞬間に active PT が切替わり、
// PT mask overlay の消失で「無関係な box が変化」する根本原因だった。
const refreshSegStoreVolumeRefs = () => {
  if (segStore.petVolumeRef == null) {
    for (let i = 0; i < seriesList.length; i++) {
      const v = seriesList[i].volume;
      if (!v) continue;
      const m = v.metadata?.modality;
      if (m === "PT" || m === "PET") { segStore.setPetVolume(v); break; }
    }
  }
  if (segStore.ctVolumeRef == null) {
    for (let i = 0; i < seriesList.length; i++) {
      const v = seriesList[i].volume;
      if (!v) continue;
      const m = v.metadata?.modality;
      if (m === "CT") { segStore.setCtVolume(v); break; }
    }
  }
  if (segStore.mrVolumeRef == null) {
    for (let i = 0; i < seriesList.length; i++) {
      const v = seriesList[i].volume;
      if (!v) continue;
      const m = v.metadata?.modality;
      if (m === "MR") { segStore.setMrVolume(v); break; }
    }
  }
};

// seriesList[i].volume を生成 (未生成なら)。imageBoxInfos には触らない。
// fusion drag-and-drop など、box の表示を書き換えたくない場面で使う。
// 戻り値: 成功なら true (volume が利用可能な状態を保証)。transfer syntax 非対応なら false + alert。
const ensureVolume_ = (i: number): boolean => {
  if (seriesList[i].volume) return true;
  if (!seriesList[i].myDicom || seriesList[i].myDicom!.length === 0) return false;
  const ts = getSeriesTransferSyntaxInfo(seriesList[i].myDicom);
  if (!ts.supported) {
    alert(`Cannot create MPR: ${ts.reason ?? `unsupported transfer syntax (${ts.uid})`}.\n\nSeries: ${ts.name}`);
    return false;
  }
  seriesList[i].volume = generateVolumeFromDicom(seriesList[i].myDicom!);
  refreshSegStoreVolumeRefs();
  rebuildSeriesSummaries();
  return true;
};

// ensureVolume_ + box[boxId] を Volume box に書き換える。
// 「Make MPR (this box)」ボタンや、layout setup で box[boxId] を Volume として表示したい場合に使う。
// box[boxId] を巻き込まれたくない場面 (fusion D&D の src/tgt MPR) では ensureVolume_ を直接使う。
//
// 引数:
//   seriesIdx: Volume を生成する seriesList index
//   boxId:     書き込む先 imageBoxInfos index (省略時は seriesIdx へ — レガシ動作)
//
// window / CLUT は **元の box の値を保持** (CT で MPR したのに PT 既定 (3/6) になる事故を防ぐ)。
// 元 box が myWC/myWW null なら DICOM tag → modality 既定の順で fallback。
const mpr_ = (seriesIdx: number, boxId?: number): boolean => {
  if (!ensureVolume_(seriesIdx)) return false;
  const targetBoxId = boxId ?? seriesIdx;
  const oldInfo = imageBoxInfos.value[targetBoxId];
  const oldIsDicomSlice = oldInfo != null && 'currentSliceNumber' in oldInfo;
  const d = seriesList[seriesIdx].volume!;
  const p0 = voxelToWorld_(new THREE.Vector3(0,0,0), seriesIdx);
  const p1 = voxelToWorld_(new THREE.Vector3(d.nx,d.ny, d.nz), seriesIdx);
  p0.add(p1).divideScalar(2); // 中点

  // window / CLUT を継承: 旧 box が値を持っていればそれを採用
  const mod = (d.metadata?.modality ?? '').toUpperCase();
  const isPt = (mod === 'PT' || mod === 'PET');
  const isCt = (mod === 'CT');
  const ds = seriesList[seriesIdx]?.myDicom?.[0];
  const dWC = ds ? Number(ds.string('x00281050', 0) ?? 'NaN') : NaN;
  const dWW = ds ? Number(ds.string('x00281051', 0) ?? 'NaN') : NaN;
  const dHasWindow = isFinite(dWC) && isFinite(dWW) && dWW > 0;
  // PT は SUV 化された voxel と DICOM WC/WW (Bq/ml) が単位ズレするため、
  // suvFactor 適用済 + suvOk なら DICOM WC*suvFactor、それ以外は SUV 既定 3/6
  let fallbackWC: number, fallbackWW: number;
  if (isCt) {
    fallbackWC = dHasWindow ? dWC : 40;
    fallbackWW = dHasWindow ? dWW : 400;
  } else if (isPt) {
    if (dHasWindow && d.metadata?.suvOk && d.metadata.suvFactor) {
      fallbackWC = dWC * d.metadata.suvFactor;
      fallbackWW = dWW * d.metadata.suvFactor;
    } else {
      fallbackWC = 3; fallbackWW = 6;
    }
  } else {
    fallbackWC = dHasWindow ? dWC : 0;
    fallbackWW = dHasWindow ? dWW : 1000;
  }
  // 旧 box の WC/WW は単位が voxel スケールと一致しているか?
  //   - 旧 box が DICOM slice の場合: voxel は raw DICOM (intercept/slope 適用済) スケール、
  //     WC/WW も同じスケール。volume 化により PT は SUV 倍されるため WC/WW を suvFactor 倍する。
  //     CT/MR/その他は volume と DICOM slice で同一スケール (HU/MR 値) なのでそのまま継承。
  //   - 旧 box が Volume の場合: WC/WW はすでに volume と同スケール → そのまま継承。
  let wc = fallbackWC, ww = fallbackWW;
  if (oldInfo?.myWC != null && oldInfo?.myWW != null) {
    if (oldIsDicomSlice && isPt && d.metadata?.suvOk && d.metadata.suvFactor) {
      wc = oldInfo.myWC * d.metadata.suvFactor;
      ww = oldInfo.myWW * d.metadata.suvFactor;
    } else {
      wc = oldInfo.myWC;
      ww = oldInfo.myWW;
    }
  }
  // CLUT 継承: 旧 box が CLUT を持つなら維持。それ以外は modality 既定 (PT は white2black)
  const oldClut = (oldInfo as VolumeImageBoxInfo)?.clut;
  const clut = (typeof oldClut === 'number') ? oldClut : (isPt ? 1 : 0);

  imageBoxInfos.value[targetBoxId] = {
    clut,
    myWC: wc,
    myWW: ww,
    description: oldInfo?.description || (d.metadata?.seriesDescription ?? "metavol generated"),
    currentSeriesNumber: seriesIdx,
    centerInWorld: p0,
    vecx: d.vectorX.clone(),
    vecy: d.vectorY.clone(),
    vecz: d.vectorZ.clone(),
    isMip: false,
    mip: null,
  } as VolumeImageBoxInfo;

  return true;
}


const mpr = (doShow: boolean) => {
  const boxId = selectedImageBoxId.value;
  const i = imageBoxInfos.value[boxId].currentSeriesNumber;
  mpr_(i, boxId);
  if (doShow){
    show();
  }
}

// Fusion 単発レイアウト: 選択中 box (or box 0) を CT/MR base + PT overlay の Fusion にする。
// 旧実装は series 0/1 をハードコードしていたため、PT/CT の順序や tileN=0 状態で破綻していた。
// 現在は findPetSeriesIndex / findBaseSeriesIndexForFusion で自動判別する。
const fusion = () => {
  const petIdx = findPetSeriesIndex();
  const base = findBaseSeriesIndexForFusion();
  if (petIdx < 0 || !base) {
    alert('Fusion requires both a PT series and a CT or MR series.');
    return;
  }
  const baseIdx = base.idx;
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  if (!seriesList[baseIdx].volume) { if (!mpr_(baseIdx)) return; }
  const baseVol = seriesList[baseIdx].volume!;
  const baseP0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), baseIdx);
  const baseP1 = voxelToWorld_(new THREE.Vector3(baseVol.nx, baseVol.ny, baseVol.nz), baseIdx);
  const baseCenter = baseP0.add(baseP1).divideScalar(2);

  // tileN=0 (起動直後 / Close all 後) なら 1 box 出して target を確保
  if ((tileN.value ?? 0) <= 0) tileN.value = 1;

  // 書き込み先: 選択中 box が有効ならそこ、無ければ 0
  const sel = selectedImageBoxId.value;
  const tgt = (sel >= 0 && sel < imageBoxInfos.value.length) ? sel : 0;

  imageBoxInfos.value[tgt] = {
    centerInWorld: baseCenter,
    vecx: baseVol.vectorX.clone(),
    vecy: baseVol.vectorY.clone(),
    vecz: baseVol.vectorZ.clone(),
    clut: 0,                                  // base (CT/MR): gray
    clut1: 2,                                 // overlay (PT): rainbow
    currentSeriesNumber: baseIdx,
    currentSeriesNumber1: petIdx,
    description: base.modality === 'CT' ? 'Fused CT+PT' : 'Fused MR+PT',
    myWC: base.modality === 'CT' ? 40 : 0,
    myWW: base.modality === 'CT' ? 400 : 1000,
    myWC1: 3, myWW1: 6,                        // PT SUV preset
    isMip: false, mip: null,
  } as FusedVolumeImageBoxInfo;

  refreshSegStoreVolumeRefs();
  showImage(tgt);
}


const findMaximumAxis = (v: THREE.Vector3) => {
  if (v.x>v.y && v.x>v.z){
    return 0;
  }
  else if (v.y>v.x && v.y>v.z){
    return 1;
  }
  else{
    return 2
  }
}

const determinePlaneDirection = (d: VolumeImageBoxInfo) => {
  if (findMaximumAxis(d.vecx)===0 && findMaximumAxis(d.vecy)===1){
    return "axial";
  }
  else if (findMaximumAxis(d.vecx)===0 && findMaximumAxis(d.vecy)===2){
    return "coronal";
  }
  else if (findMaximumAxis(d.vecx)===1 && findMaximumAxis(d.vecy)===2){
    return "sagittal";
  }
  else return "unknown";
}


const switchToAxial = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (determinePlaneDirection(d)=="coronal"){
    const temp = d.vecy;
    d.vecy = d.vecz;
    d.vecy.normalize().multiplyScalar(d.vecx.length());
    d.vecz = temp;
    if (doShow){
      show();
    }
  }
}

const switchToCoronal = (doShow: boolean) => {
  debugger;
  const d = getSelectedInfo();
  if (determinePlaneDirection(d)=="axial"){
    const temp = d.vecy;
    d.vecy = d.vecz;
    d.vecy.normalize().multiplyScalar(d.vecx.length());
    d.vecz = temp;
    if (doShow){
      show();
    }
  }
}


const reverse = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (d.clut == 0) d.clut = 1;
  else if (d.clut == 1) d.clut = 0;
  else if (d.clut == 2) d.clut = 3;
  else if (d.clut == 3) d.clut = 2;
  else if (d.clut == 4) d.clut = 5;
  else if (d.clut == 5) d.clut = 4;
  if (doShow){
    show();
  }
}

const switchToMonochrome = (doShow: boolean) => { 
  getSelectedInfo().clut=0;
  if (doShow){
    show();
  }
}
const switchToRainbow = (doShow: boolean) => {
   getSelectedInfo().clut=2;
   if (doShow){
    show();
  }
}
const switchToHot = (doShow: boolean) => { 
  getSelectedInfo().clut=4;
  if (doShow){
    show();
  }
}

const switchToMip = (doShow: boolean) => {
  const d = getSelectedInfo();
  d.isMip = true;
  if (d.mip == null){
    d.mip = {
      mipAngle: 0,
      isSurface: false,
      thresholdSurfaceMip: 0.3,
      depthSurfaceMip: 3,
    }
  }else{
    d.mip.isSurface = false;
  }
  if (doShow){
    show();
  }
}

const switchToSMip = (doShow: boolean) => {
  const d = getSelectedInfo();
  if (!d.isMip) switchToMip(false);
  d.mip!.isSurface = true;
  if (doShow){
    show();
  }
}

// 生成した単一 Volume phantom を「メインビューアーで開く」共通処理。
// 起動直後は tileN=0 (box 0 個) なので、そのまま imageBoxInfos に書いても何も描画
// されなかった (phantom が開かない不具合の原因)。fusion() と同じく tileN と書き込み先
// box を確保してから showImage する。
const openVolumePhantomInMainView = (
  c: VolumeImageBoxInfo,
  opts: { wc: number; ww: number; clut: number; description: string },
) => {
  c.myWC = opts.wc;
  c.myWW = opts.ww;
  c.clut = opts.clut;
  c.description = opts.description;

  // tileN=0 (起動直後 / Close all 後) なら 1 box 出して target を確保
  if ((tileN.value ?? 0) <= 0) tileN.value = 1;
  const sel = selectedImageBoxId.value;
  const tgt = (sel >= 0 && sel < imageBoxInfos.value.length) ? sel : 0;
  selectedImageBoxId.value = tgt;

  imageBoxInfos.value[tgt] = c;
  refreshSegStoreVolumeRefs();
  rebuildSeriesSummaries();
  showImage(tgt);
}

const phantomNema = () => {
  const P = Phantom.generatePhantomNema();
  const c = pushVolume(seriesList, P);
  // PT phantom: SUV-aware default window (0..16 → wc=8, ww=16 covers warm + hot spheres),
  // hot CLUT for visibility, sensible description.
  openVolumePhantomInMainView(c, { wc: 8, ww: 16, clut: 1, description: 'NEMA IEC Body Phantom' });
}

const phantomWholeBody = () => {
  const P = Phantom.generatePhantomWholeBody();
  const c = pushVolume(seriesList, P);
  // Whole-body PET: bladder is hottest (~18). Default window 0..15 catches mets +
  // most organs but leaves bladder saturated (which is realistic).
  openVolumePhantomInMainView(c, { wc: 7.5, ww: 15, clut: 1, description: 'Whole-body PET (synthetic)' });
}

// Whole-body PET/CT digital phantom: sample-data の cervicalca に幾何を似せた
// 合成 CT + PET のペア (同一 world 座標なので fusion が揃う)。生成後は PET Standard
// (CT axi / PET axi / Fusion / MIP) をそのままメインビューアーに開く。
const phantomWholeBodyPetCt = async () => {
  const { ct, pet } = Phantom.generatePhantomWholeBodyPetCt();
  pushVolume(seriesList, ct);
  pushVolume(seriesList, pet);
  refreshSegStoreVolumeRefs();
  rebuildSeriesSummaries();

  // PET Standard は 2x2。tileN を確保してから setupPetStandardView に任せる
  // (PT/CT は metadata.modality から自動判別される)。
  tileN.value = 4;
  await nextTick();
  await setupPetStandardView();
}

// ===== 実験: z スライスのスクランブル & 類似度による復元 =====
// スクランブルの ground truth (どの series をどう並べ替えたか) を保持し、recover 後に
// 復元精度をレポートする。scramble は coronal / MIP で見るとぐちゃぐちゃが分かる。
const scrambleTruth = ref<{ seriesIdx: number; perm: number[] } | null>(null);

// 現在選択中の box が指す series の volume を返す (無ければ PET → series 0)。
const volumeForExperiment = (): { idx: number; vol: Volume } | null => {
  const cand: number[] = [];
  const sel = imageBoxInfos.value[selectedImageBoxId.value] as VolumeImageBoxInfo | undefined;
  if (sel && typeof sel.currentSeriesNumber === 'number') cand.push(sel.currentSeriesNumber);
  const pet = findPetSeriesIndex();
  if (pet >= 0) cand.push(pet);
  cand.push(0);
  for (const i of cand) {
    if (i >= 0 && i < seriesList.length && seriesList[i]?.volume) {
      return { idx: i, vol: seriesList[i].volume! };
    }
  }
  return null;
};

const scrambleSlices = () => {
  const target = volumeForExperiment();
  if (!target) { alert('Load or reconstruct a volume first (e.g. a phantom or PET Standard).'); return; }
  const { idx, vol } = target;
  const t0 = performance.now();
  const { voxel, perm } = scrambleZSlices(vol);
  const old = vol.voxel;
  vol.voxel = voxel;
  evictVolumeTexture(old);           // 旧 texture を解放 (GPU cache は voxel 参照 key)
  scrambleTruth.value = { seriesIdx: idx, perm };
  const desc = seriesSummaries.value[idx]?.description ?? `series ${idx}`;
  console.log(`[scramble] shuffled ${vol.nz} z-slices of "${desc}" in ${(performance.now() - t0).toFixed(0)}ms`);
  show();
};

const recoverSlices = () => {
  const target = volumeForExperiment();
  if (!target) { alert('Nothing to recover.'); return; }
  const { idx, vol } = target;
  const t0 = performance.now();
  const { voxel, order } = recoverZOrder(vol);
  const old = vol.voxel;
  vol.voxel = voxel;
  evictVolumeTexture(old);
  const ms = performance.now() - t0;

  let msg = `Recovered ${vol.nz} slices in ${ms.toFixed(0)}ms`;
  // ground truth があれば精度をレポート (同じ series をスクランブルしていた場合のみ)
  const truth = scrambleTruth.value;
  if (truth && truth.seriesIdx === idx && truth.perm.length === vol.nz) {
    const acc = scrambleAccuracy(truth.perm, order);
    const pct = (acc.adjacency * 100).toFixed(1);
    const rho = acc.spearmanAbs.toFixed(3);
    msg = `Recovery: adjacency ${pct}%, |Spearman| ${rho}${acc.reversed ? ' (reversed)' : ''} — ${ms.toFixed(0)}ms`;
    console.log(`[recover] adjacency=${pct}% spearmanAbs=${rho} reversed=${acc.reversed} n=${acc.n} (${ms.toFixed(0)}ms)`);
    // recover は現在のスクランブル状態を「元に戻した」ので truth は無効化
    // (recovered 順に voxel を並べ直したため perm はもう対応しない)。
    scrambleTruth.value = null;
  } else {
    console.log(`[recover] reordered ${vol.nz} slices (no ground truth to score) in ${ms.toFixed(0)}ms`);
  }
  alert(msg);
  show();
};

const runDebugger = () => {
  console.log(innerWidth);
};

const maximize = () => {
  const hello = document.getElementById("hello");
  debugger;
  imageBoxW.value=hello!.scrollWidth! / 2 - 10;
}

const gridCols = (n: number) => {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 9) return 3;
  return 4;
};
const gridStyle = computed(() => {
  const cols = gridCols(tileN.value ?? 1);
  return { gridTemplateColumns: `repeat(${cols}, max-content)` };
});

// box が縦に占有する行数 (rowSpan)。default 1。
const boxRowSpan = (i: number): number => {
  const span = (imageBoxInfos.value[i] as VolumeImageBoxInfo | undefined)?.rowSpan ?? 1;
  return span >= 2 ? Math.floor(span) : 1;
};

// rowSpan=2 の box は canvas を 2 行ぶんの高さにする。1 行の box 全体 = titlebar + canvas
// なので、span 行ぶんの canvas 高さ = h*span + (titlebar + gap)*(span-1) で 2 行にピタリ収まる。
const boxRenderHeight = (i: number): number => {
  const h = imageBoxH.value ?? 0;
  const span = boxRowSpan(i);
  if (span <= 1) return h;
  const gap = noGapMode.value ? 0 : GAP_PX;
  return h * span + (TITLEBAR_H + gap) * (span - 1);
};

// grid セルに row span を効かせる style。
const boxCellStyle = (i: number): Record<string, string> => {
  const span = boxRowSpan(i);
  return span >= 2 ? { gridRow: `span ${span}` } : {};
};

// 画像エリアのサイズから cols x rows がちょうど収まる box サイズを算出。
// 正方形に固執せず、横と縦を独立に最大化して隙間を埋める。
//
// Vuetify の box-sizing: border-box / scrollbar の有無 / drawer の transition 中の
// 中間サイズなど計算で詰めると環境依存で必ずズレる。.mv-imagearea 要素を直接測って
// そこから padding / gap / title bar / safety を引くのが最も堅い。
const TITLEBAR_H = 22;
const GAP_PX = 6;             // .mv-tile-grid の gap
const SAFETY_PX = 4;          // 各方向のクリッピング保険 (border 1px + 余裕)
const BOX_BORDER_PX = 1;      // .mv-box の border 合計 (canvas 幅 + これが box の実寸)

const computeFitBoxSize = (cols: number, rows: number): { w: number; h: number } => {
  const ia = document.querySelector('.mv-imagearea') as HTMLElement | null;
  let availW: number, availH: number;
  if (ia) {
    // imagearea は padding: 8px 入っているので clientWidth/Height で padding 内側を取る
    availW = ia.clientWidth - 16;   // padding 8px each side
    availH = ia.clientHeight - 16;
  } else {
    // mount 前のフォールバック
    const sidebarW = drawer.value ? 280 : 0;
    const inspectorW = inspector.value ? 320 : 0;
    availW = Math.max(200, window.innerWidth - sidebarW - inspectorW - 16);
    // app-bar 高さは CSS 変数 --mv-appbar-h が唯一の情報源。取れなければ 36 を仮定。
    const barH = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--mv-appbar-h')) || 36;
    availH = Math.max(200, window.innerHeight - barH - 16);
  }

  // noGapMode 時は gap も safety も 0 にして画像エリアいっぱいに敷き詰める。
  const gap = noGapMode.value ? 0 : GAP_PX;
  const safe = noGapMode.value ? 0 : SAFETY_PX;
  const gapH = gap * Math.max(0, cols - 1);
  const gapV = gap * Math.max(0, rows - 1);

  // 各 cell に title bar (1 行 26px) と border (約 2px) と保険 SAFETY_PX を引く。
  // noGapMode では safe=0 になるので、box の border 分 (BOX_BORDER_PX) は別途必ず引く。
  // これを引かないと cols * (canvas + border) が availW を数 px 超えて横スクロールが出る。
  const w = Math.max(120, Math.floor((availW - gapH - cols * (safe + BOX_BORDER_PX)) / cols));
  const h = Math.max(120, Math.floor((availH - gapV - rows * (TITLEBAR_H + safe + BOX_BORDER_PX)) / rows));
  return { w, h };
}

// 現在の tileN と drawer 状態から最適な box サイズを返す
const fitBoxSizeForCurrentTile = (): { w: number; h: number } => {
  const n = tileN.value ?? 1;
  const cols = gridCols(n);
  const rows = Math.ceil(n / cols);
  return computeFitBoxSize(cols, rows);
}

// 候補列挙: PT / CT 各 modality に該当する seriesList index を返す。
// App.vue 側のピッカー UI が「2 PT × 2 CT 等で曖昧か」を判定するために使う。
// 配列はスコア降順ソート (高いほど優先) — ATTN > NAC、WB > Lung 等を反映。
type SeriesCand = { idx: number; label: string; isActive: boolean; score: number };
const getPetCtSeriesCandidates = (): { pt: SeriesCand[]; ct: SeriesCand[] } => {
  const pt: SeriesCand[] = [];
  const ct: SeriesCand[] = [];
  const activePtUid = segStore.petVolumeRef?.metadata?.seriesUID ?? '';
  const activeCtUid = segStore.ctVolumeRef?.metadata?.seriesUID ?? '';
  const rules = loadPriorityRules();

  for (let i = 0; i < seriesList.length; i++) {
    let m = '';
    const dlist = seriesList[i].myDicom;
    if (dlist && dlist.length > 0) {
      m = (dlist[0].string("x00080060") ?? '').toUpperCase();
    } else {
      m = (seriesList[i].volume?.metadata?.modality ?? '').toUpperCase();
    }
    const summary = seriesSummaries.value[i];
    const label = summary?.description || `Series ${i}`;
    const sUid = seriesList[i].volume?.metadata?.seriesUID
      ?? (dlist && dlist.length > 0 ? (dlist[0].string('x0020000e') ?? '') : '');
    const score = scoreSeries({
      description: label,
      modality: m,
      attenuationCorrected: summary?.attenuationCorrected,
      hasSuvFactor: !!seriesList[i].volume?.metadata?.suvFactor,
    }, rules);

    if (m === 'PT' || m === 'PET') {
      pt.push({ idx: i, label, isActive: !!sUid && sUid === activePtUid, score });
    } else if (m === 'CT') {
      ct.push({ idx: i, label, isActive: !!sUid && sUid === activeCtUid, score });
    }
  }

  // スコア降順。ただし **同点だけでなく「撮影そのものか」「枚数」も見る**。
  // priority rules は description 文字列ベースなので、実運用の混在症例では
  // 再構成 (PET CORONAL) や MIP が本来の PET TRANSAXIAL より上に来てしまい、
  // MTV measurement が誤ったシリーズで組まれていた (実測: PET CORONAL が自動選択された)。
  const nFramesOf = (i: number) => seriesList[i]?.myDicom?.length ?? seriesList[i]?.volume?.nz ?? 0;
  const rank = (a: SeriesCand, b: SeriesCand) =>
    b.score - a.score ||
    Number(isOriginalPrimary(b.idx)) - Number(isOriginalPrimary(a.idx)) ||
    nFramesOf(b.idx) - nFramesOf(a.idx);
  pt.sort(rank);
  ct.sort(rank);

  // CT は「先頭 PT と同じ FrameOfReference」を最優先にする。
  // 混在症例では診断 CT (別 FoR) と PET/CT の CT が並ぶので、機械的に合っている方を選ぶ。
  const topPt = pt[0];
  if (topPt) {
    const ptFor = frameOfRefOf(topPt.idx);
    if (ptFor) {
      ct.sort((a, b) =>
        Number(frameOfRefOf(b.idx) === ptFor) - Number(frameOfRefOf(a.idx) === ptFor) || rank(a, b));
    }
  }
  return { pt, ct };
};

// 解決済 PT/CT index を返す。優先順位:
//   1. override (引数で明示) — App.vue ピッカー確定時に使う
//   2. segStore active (★ で指定された PT/CT)
//   3. priority score 最大 (ATTN > NAC、WB > Lung 等のルールベース)
const resolvePetCtIndices = (overridePetIdx?: number, overrideCtIdx?: number): { petIdx: number; ctIdx: number } => {
  const cands = getPetCtSeriesCandidates();
  let petIdx = overridePetIdx ?? -1;
  let ctIdx = overrideCtIdx ?? -1;
  if (petIdx < 0) {
    const active = cands.pt.find(c => c.isActive);
    if (active) petIdx = active.idx;
    else if (cands.pt.length > 0) petIdx = cands.pt[0].idx;  // sort 済 = top-scored
  }
  if (ctIdx < 0) {
    const active = cands.ct.find(c => c.isActive);
    if (active) ctIdx = active.idx;
    else if (cands.ct.length > 0) ctIdx = cands.ct[0].idx;
  }
  return { petIdx, ctIdx };
};

// MIP の screen-down (vecy) が患者頭側 (+Z) を向くと頭が画面下に表示されてしまう。
// DICOM 患者座標系では +Z = Superior (頭側) なので、vecy.z > 0 のとき反転して
// screen-down が患者足側 (head-up) になるよう揃える。
// 入力ベクトルは clone されたものを想定 — in-place で反転して返す。
const headUpVecy = (vecy: THREE.Vector3): THREE.Vector3 => {
  if (vecy.z > 0) vecy.negate();
  return vecy;
};

// PET 標準ビュー: 2x2 で
//   Box 0 = CT axial
//   Box 1 = PET axial
//   Box 2 = Fusion axial
//   Box 3 = PET MIP
// 引数: 明示的に PT/CT seriesList index を指定 (省略時は active → first-found 順)
const setupPetStandardView = async (overridePetIdx?: number, overrideCtIdx?: number) => {
  const { petIdx, ctIdx } = resolvePetCtIndices(overridePetIdx, overrideCtIdx);
  if (petIdx < 0 || ctIdx < 0){
    console.warn("Both PET and CT are required. petIdx=", petIdx, " ctIdx=", ctIdx);
    return;
  }

  // PET と CT を Volume 化（未生成かつ DICOM ソースのみ）。
  // NIfTI はロード時に volume が既に生成されているため mpr_ 不要。
  if (!seriesList[petIdx].volume && seriesList[petIdx].myDicom) mpr_(petIdx);
  if (!seriesList[ctIdx].volume && seriesList[ctIdx].myDicom) mpr_(ctIdx);
  const pet = seriesList[petIdx].volume!;
  const ct  = seriesList[ctIdx].volume!;

  // 各 Box の中心は CT の中心を基準に揃える（同じ世界座標を表示）
  const ctCenter = volumeCenterWorld(ct);
  const petCenter = volumeCenterWorld(pet);

  // CT axial: black2white
  imageBoxInfos.value[0] = {
    clut: 0, myWC: 40, myWW: 400, description: "CT axial",
    currentSeriesNumber: ctIdx,
    centerInWorld: ctCenter.clone(),
    vecx: ct.vectorX.clone(),
    vecy: ct.vectorY.clone(),
    vecz: ct.vectorZ.clone(),
    isMip: false, mip: null,
  } as VolumeImageBoxInfo;

  // PET axial: white2black (0=white, high count=black)
  // CT と同じ mm/pixel になるよう PET vec をスケール (PET 4mm voxel と CT 1mm voxel が
  // 同じ canvas サイズなら patient が異なるサイズに見えてしまう問題の解消)。
  // 結果: PET 表示は CT と同じ視野範囲 + 同じ patient 大きさ。voxel は粗いまま。
  const petMagX = ct.vectorX.length() / pet.vectorX.length();
  const petMagY = ct.vectorY.length() / pet.vectorY.length();
  imageBoxInfos.value[1] = {
    clut: 1, myWC: 3, myWW: 6, description: "PET axial",
    currentSeriesNumber: petIdx,
    centerInWorld: ctCenter.clone(),  // CT と中心も揃えると anatomical sync が完成
    vecx: pet.vectorX.clone().multiplyScalar(petMagX),
    vecy: pet.vectorY.clone().multiplyScalar(petMagY),
    vecz: pet.vectorZ.clone(),
    isMip: false, mip: null,
  } as VolumeImageBoxInfo;

  // Fusion axial: CT (black2white) + PET (rainbow)
  imageBoxInfos.value[2] = {
    centerInWorld: ctCenter.clone(),
    vecx: ct.vectorX.clone(),
    vecy: ct.vectorY.clone(),
    vecz: ct.vectorZ.clone(),
    clut: 0,    // black2white (CT そのまま)
    clut1: 2,   // rainbow (PET)
    currentSeriesNumber: ctIdx,
    currentSeriesNumber1: petIdx,
    description: "Fusion axial",
    myWC: 40,  myWW: 400,
    myWC1: 3,  myWW1: 6,
  } as FusedVolumeImageBoxInfo;

  // PET MIP: white2black。MIP も CT と同じ mm/pixel に揃える (axial 3 box と MIP の patient
  // サイズが同じになるよう、CT vectorX.length() を 1mm 基準として使う)
  const ctStepX = ct.vectorX.length();
  imageBoxInfos.value[3] = {
    clut: 1,
    myWC: 3, myWW: 6,
    description: "PET MIP",
    currentSeriesNumber: petIdx,
    centerInWorld: petCenter.clone(),
    vecx: pet.vectorX.clone().normalize().multiplyScalar(ctStepX),
    vecy: headUpVecy(pet.vectorZ.clone().normalize().multiplyScalar(ctStepX)),
    vecz: pet.vectorY.clone(),
    isMip: true,
    mip: makeMipState(),
  } as VolumeImageBoxInfo;

  // store の参照を更新
  refreshSegStoreVolumeRefs();

  // 1画面に2x2が収まるサイズに自動調整
  autoFitMode.value = true;
  applyAutoFit();

  // 全 box を paging 同期 (PET Standard 等のマルチ box レイアウトでは ON が自然)
  syncImageBox.value = true;

  // ImageBox 再 init してから描画
  await nextTick();
  if (imb.value){
    for (const a of imb.value){ a.init(); }
  }
  show();

  // **ここが MTV 測定の入口。** 前回の続きがあるならこのタイミングでだけ尋ねる
  // (d&d で PET を重ねただけのユーザには訊かない)。
  void checkRecoveryForCurrentPet();
}

// ===== レイアウトプリセット =====
// PET Standard と同じスタイルで複数のレイアウトを切り替え可能にする。

// 与えた volume と plane で VolumeImageBoxInfo を生成する小ヘルパ。
// 断面 (axi/cor/sag) の表示ベクトルを **world (患者) 軸** で作る。
//
// **volume の index 軸 (vectorX/Y/Z) を割り当ててはいけない。**
// 以前はそうしていたため axial 撮像でしか正しくならず、coronal 撮像 (例: MR t1_mpr_ns_cor)
// では "axial" と称して冠状断が出るなど軸が入れ替わっていた。
// world は DICOM LPS: +X = 患者左, +Y = 背側, +Z = 頭側。
//   axial   : 画面x = +X, 画面y = +Y,       through = Z
//   coronal : 画面x = +X, 画面y = 頭が上,   through = Y
//   sagittal: 画面x = +Y, 画面y = 頭が上,   through = X
const planeVectorsWorld = (
  v: Volume.Volume,
  plane: 'axi' | 'cor' | 'sag',
): { vecx: THREE.Vector3; vecy: THREE.Vector3; vecz: THREE.Vector3 } => {
  const AX = new THREE.Vector3(1, 0, 0);
  const AY = new THREE.Vector3(0, 1, 0);
  const AZ = new THREE.Vector3(0, 0, 1);
  // world 軸 e に最も沿う voxel 軸の pitch (mm) = その方向の実効スライス厚 / 画素間隔
  const pitchAlong = (e: THREE.Vector3): number => {
    let best = v.vectorX, bestDot = -1;
    for (const c of [v.vectorX, v.vectorY, v.vectorZ]) {
      const L = c.length();
      if (L <= 0) continue;
      const d = Math.abs((c.x * e.x + c.y * e.y + c.z * e.z) / L);
      if (d > bestDot) { bestDot = d; best = c; }
    }
    return best.length() || 1;
  };
  let ex: THREE.Vector3, ey: THREE.Vector3, ez: THREE.Vector3;
  if (plane === 'cor')      { ex = AX.clone(); ey = AZ.clone().negate(); ez = AY.clone(); }
  else if (plane === 'sag') { ex = AY.clone(); ey = AZ.clone().negate(); ez = AX.clone(); }
  else                      { ex = AX.clone(); ey = AY.clone();          ez = AZ.clone(); }
  // 面内は等方にする (縦横で mm/px が違うと画像が歪む) — 2 軸の細かい方に合わせる
  const inPlane = Math.min(pitchAlong(ex), pitchAlong(ey));
  return {
    vecx: ex.multiplyScalar(inPlane),
    vecy: headUpVecy(ey.multiplyScalar(inPlane)),
    vecz: ez.multiplyScalar(pitchAlong(ez)),
  };
};

const makeVolumeBoxForPlane = (
  volIdx: number,
  plane: 'axi' | 'cor' | 'sag' | 'mip',
  description: string,
  clut: number,
  wcWw: { wc: number; ww: number },
  isMip = false,
): VolumeImageBoxInfo => {
  const v = seriesList[volIdx].volume!;
  const p0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), volIdx);
  const p1 = voxelToWorld_(new THREE.Vector3(v.nx, v.ny, v.nz), volIdx);
  const center = p0.add(p1).divideScalar(2);
  const { vecx, vecy, vecz } = planeVectorsWorld(v, plane === 'mip' ? 'axi' : plane);
  return {
    clut, myWC: wcWw.wc, myWW: wcWw.ww, description,
    currentSeriesNumber: volIdx, centerInWorld: center,
    vecx, vecy, vecz, isMip,
    mip: isMip ? makeMipState() : null,
  } as VolumeImageBoxInfo;
};

// L1 Triplanar PT (1×3) は廃止 (2026-07)。
// 「PET Triplanar + MIP (2×2)」= setupPtOnly4up が axial/coronal/sagittal を含み内容が重複していたため。

// L2 Triplanar Fused: 1×3 (Fused axial / coronal / sagittal)
// Fusion 用 base layer (CT or MR) を探す。CT 優先、なければ MR。
const findBaseSeriesIndexForFusion = (): { idx: number; modality: 'CT' | 'MR' } | null => {
  let ctIdx = -1, mrIdx = -1;
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    const tag = (seriesList[i].myDicom?.[0]?.string('x00080060') ?? '').toUpperCase();
    const m = v?.metadata?.modality ?? tag;
    if (m === 'CT' && ctIdx < 0) ctIdx = i;
    if (m === 'MR' && mrIdx < 0) mrIdx = i;
  }
  if (ctIdx >= 0) return { idx: ctIdx, modality: 'CT' };
  if (mrIdx >= 0) return { idx: mrIdx, modality: 'MR' };
  return null;
};

const setupTriplanarFused = async () => {
  const petIdx = findPetSeriesIndex();
  const base = findBaseSeriesIndexForFusion();
  if (petIdx < 0 || !base) {
    alert('PT plus a CT or MR series are required for Fusion.');
    return;
  }
  const baseIdx = base.idx;
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  if (!seriesList[baseIdx].volume) { if (!mpr_(baseIdx)) return; }
  const baseVol = seriesList[baseIdx].volume!;
  const baseP0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), baseIdx);
  const baseP1 = voxelToWorld_(new THREE.Vector3(baseVol.nx, baseVol.ny, baseVol.nz), baseIdx);
  const baseCenter = baseP0.add(baseP1).divideScalar(2);
  // base modality に応じた windowing デフォルト
  const baseWC = base.modality === 'CT' ? 40 : 0;
  const baseWW = base.modality === 'CT' ? 400 : 1000;
  const labelPrefix = base.modality === 'CT' ? 'Fused' : 'Fused (MR+PT)';
  const makeFused = (plane: 'axi' | 'cor' | 'sag', desc: string): FusedVolumeImageBoxInfo => {
    // world 軸ベースで断面を作る (index 軸だと coronal/sagittal 撮像で軸が入れ替わる)
    const { vecx, vecy, vecz } = planeVectorsWorld(baseVol, plane);
    return {
      centerInWorld: baseCenter.clone(), vecx, vecy, vecz,
      clut: 0, clut1: 2,
      currentSeriesNumber: baseIdx, currentSeriesNumber1: petIdx,
      description: desc, myWC: baseWC, myWW: baseWW, myWC1: 3, myWW1: 6,
    } as FusedVolumeImageBoxInfo;
  };
  imageBoxInfos.value[0] = makeFused('axi', `${labelPrefix} axial`);
  imageBoxInfos.value[1] = makeFused('cor', `${labelPrefix} coronal`);
  imageBoxInfos.value[2] = makeFused('sag', `${labelPrefix} sagittal`);
  tileN.value = 3;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  syncImageBox.value = true;
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L3 PT-only 4-up: 2×2 (PT axi / cor / sag / MIP)
const setupPtOnly4up = async () => {
  const petIdx = findPetSeriesIndex();
  if (petIdx < 0) { alert('No PT series found.'); return; }
  if (!seriesList[petIdx].volume) { if (!mpr_(petIdx)) return; }
  const wcww = { wc: 3, ww: 6 };
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(petIdx, 'axi', 'PT axial',    1, wcww);
  imageBoxInfos.value[1] = makeVolumeBoxForPlane(petIdx, 'cor', 'PT coronal',  1, wcww);
  imageBoxInfos.value[2] = makeVolumeBoxForPlane(petIdx, 'sag', 'PT sagittal', 1, wcww);
  // MIP は PET の coronal-like 視軸を使う (既存 PET Standard と同じ式)
  const pet = seriesList[petIdx].volume!;
  const pP0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), petIdx);
  const pP1 = voxelToWorld_(new THREE.Vector3(pet.nx, pet.ny, pet.nz), petIdx);
  imageBoxInfos.value[3] = {
    clut: 1, myWC: 3, myWW: 6, description: 'PT MIP',
    currentSeriesNumber: petIdx,
    centerInWorld: pP0.add(pP1).divideScalar(2),
    vecx: pet.vectorX.clone(),
    vecy: headUpVecy(pet.vectorZ.clone().normalize().multiplyScalar(pet.vectorX.length())),
    vecz: pet.vectorY.clone(),
    isMip: true,
    mip: makeMipState(),
  } as VolumeImageBoxInfo;
  tileN.value = 4;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  syncImageBox.value = true;
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L4 Compare 2-up: 1×2 (同 plane で 2 series 横並び)
// PT が 2 つ以上あれば PT axial × 2、無ければ CT/PT 並びにフォールバック。
const setupCompare2up = async () => {
  // PT 2 つ
  const ptIdxs: number[] = [];
  for (let i = 0; i < seriesList.length; i++) {
    const v = seriesList[i].volume;
    const m = (v?.metadata?.modality)
      ?? ((seriesList[i].myDicom?.[0]?.string('x00080060') ?? '').toUpperCase() === 'PT' ? 'PT' : '');
    if (m === 'PT' || m === 'PET') ptIdxs.push(i);
  }
  let leftIdx: number, rightIdx: number, leftDesc: string, rightDesc: string;
  let leftClut = 1, rightClut = 1;
  let wcL = { wc: 3, ww: 6 }, wcR = { wc: 3, ww: 6 };
  if (ptIdxs.length >= 2) {
    leftIdx = ptIdxs[0]; rightIdx = ptIdxs[1];
    leftDesc = seriesSummaries.value[leftIdx]?.description ?? 'PT 1';
    rightDesc = seriesSummaries.value[rightIdx]?.description ?? 'PT 2';
  } else {
    // Fallback: CT vs PT
    let ctIdx = -1, petIdx = -1;
    for (let i = 0; i < seriesList.length; i++) {
      const dl = seriesList[i].myDicom;
      const m = (dl?.[0]?.string('x00080060') ?? '').toUpperCase();
      if (m === 'CT' && ctIdx < 0) ctIdx = i;
      if ((m === 'PT' || m === 'PET') && petIdx < 0) petIdx = i;
    }
    if (ctIdx < 0 && petIdx < 0) { alert('At least one PT or CT series is required.'); return; }
    if (ctIdx < 0) { leftIdx = petIdx; rightIdx = petIdx; }
    else if (petIdx < 0) { leftIdx = ctIdx; rightIdx = ctIdx; leftClut = 0; rightClut = 0; wcL = { wc: 40, ww: 400 }; wcR = wcL; }
    else { leftIdx = ctIdx; rightIdx = petIdx; leftClut = 0; wcL = { wc: 40, ww: 400 }; }
    leftDesc = seriesSummaries.value[leftIdx]?.description ?? '';
    rightDesc = seriesSummaries.value[rightIdx]?.description ?? '';
  }
  if (!seriesList[leftIdx].volume)  { if (!mpr_(leftIdx))  return; }
  if (!seriesList[rightIdx].volume) { if (!mpr_(rightIdx)) return; }
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(leftIdx,  'axi', leftDesc,  leftClut,  wcL);
  imageBoxInfos.value[1] = makeVolumeBoxForPlane(rightIdx, 'axi', rightDesc, rightClut, wcR);
  tileN.value = 2;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  syncImageBox.value = true;
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// L5 PET/CT + tall MIP: 3×2 でいちばん右の列を全高 PET MIP にする。
//   [ CT axial ][ PET axial      ][ PET MIP ]
//   [ Fusion   ][ Fusion coronal ][  (span) ]
// 右列の MIP は rowSpan=2 で 2 行ぶんの背高 box (setupPetCtMipRight → box2)。
const setupPetCtMipRight = async () => {
  const { petIdx, ctIdx } = resolvePetCtIndices();
  if (petIdx < 0 || ctIdx < 0) { alert('Both a PT and a CT series are required.'); return; }
  if (!seriesList[petIdx].volume && seriesList[petIdx].myDicom) mpr_(petIdx);
  if (!seriesList[ctIdx].volume && seriesList[ctIdx].myDicom) mpr_(ctIdx);
  if (!seriesList[petIdx].volume || !seriesList[ctIdx].volume) return;
  const pet = seriesList[petIdx].volume!;
  const ct  = seriesList[ctIdx].volume!;

  const ctCenter = (() => {
    const p0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), ctIdx);
    const p1 = voxelToWorld_(new THREE.Vector3(ct.nx, ct.ny, ct.nz), ctIdx);
    return p0.add(p1).divideScalar(2);
  })();

  // box0: CT axial
  imageBoxInfos.value[0] = makeVolumeBoxForPlane(ctIdx, 'axi', 'CT axial', 0, { wc: 40, ww: 400 });

  // box1: PET axial (CT と同じ mm/px・中心に揃える)
  const petMagX = ct.vectorX.length() / pet.vectorX.length();
  const petMagY = ct.vectorY.length() / pet.vectorY.length();
  imageBoxInfos.value[1] = {
    clut: 1, myWC: 3, myWW: 6, description: 'PET axial',
    currentSeriesNumber: petIdx,
    centerInWorld: ctCenter.clone(),
    vecx: pet.vectorX.clone().multiplyScalar(petMagX),
    vecy: pet.vectorY.clone().multiplyScalar(petMagY),
    vecz: pet.vectorZ.clone(),
    isMip: false, mip: null,
  } as VolumeImageBoxInfo;

  // box2: PET MIP (右列・全高)。coronal 視軸で MIP、CT の mm/px に揃える。
  const petCenter = (() => {
    const p0 = voxelToWorld_(new THREE.Vector3(0, 0, 0), petIdx);
    const p1 = voxelToWorld_(new THREE.Vector3(pet.nx, pet.ny, pet.nz), petIdx);
    return p0.add(p1).divideScalar(2);
  })();
  const ctStepX = ct.vectorX.length();
  imageBoxInfos.value[2] = {
    clut: 1, myWC: 3, myWW: 6, description: 'PET MIP',
    currentSeriesNumber: petIdx,
    centerInWorld: petCenter.clone(),
    vecx: pet.vectorX.clone().normalize().multiplyScalar(ctStepX),
    vecy: headUpVecy(pet.vectorZ.clone().normalize().multiplyScalar(ctStepX)),
    vecz: pet.vectorY.clone(),
    isMip: true,
    mip: makeMipState(),
    rowSpan: 2,
  } as VolumeImageBoxInfo;

  // box3/box4: Fusion axial + coronal (CT base + PET rainbow overlay)
  const makeFused = (plane: 'axi' | 'cor', desc: string): FusedVolumeImageBoxInfo => {
    let vecx: THREE.Vector3, vecy: THREE.Vector3, vecz: THREE.Vector3;
    if (plane === 'cor') {
      vecx = ct.vectorX.clone();
      vecy = headUpVecy(ct.vectorZ.clone().normalize().multiplyScalar(ct.vectorX.length()));
      vecz = ct.vectorY.clone();
    } else {
      vecx = ct.vectorX.clone(); vecy = ct.vectorY.clone(); vecz = ct.vectorZ.clone();
    }
    return {
      centerInWorld: ctCenter.clone(), vecx, vecy, vecz,
      clut: 0, clut1: 2,
      currentSeriesNumber: ctIdx, currentSeriesNumber1: petIdx,
      description: desc, myWC: 40, myWW: 400, myWC1: 3, myWW1: 6,
    } as FusedVolumeImageBoxInfo;
  };
  imageBoxInfos.value[3] = makeFused('axi', 'Fusion axial');
  imageBoxInfos.value[4] = makeFused('cor', 'Fusion coronal');

  tileN.value = 5;
  selectedImageBoxId.value = 0;
  refreshSegStoreVolumeRefs();
  autoFitMode.value = true;
  applyAutoFit();
  syncImageBox.value = true;
  await nextTick();
  if (imb.value) for (const a of imb.value) a.init();
  show();
};

// ===== テスト DICOM 自動オープン =====
// Chromium 系: showDirectoryPicker() を使い、選んだフォルダのハンドルをセッション中キャッシュ。
// 一度選べば「Load test DICOM」ボタンで即時再ロード可能。
let cachedTestDirHandle: any = null;

const collectFilesFromDirHandle = async (dirHandle: any): Promise<File[]> => {
  const out: File[] = [];
  const walk = async (h: any) => {
    for await (const entry of h.values()){
      if (entry.kind === 'file'){
        try { out.push(await entry.getFile()); } catch {}
      } else if (entry.kind === 'directory'){
        await walk(entry);
      }
    }
  };
  await walk(dirHandle);
  return out;
};

const loadTestDicom = async () => {
  const w = window as any;
  if (typeof w.showDirectoryPicker !== 'function'){
    alert('This browser does not support the File System Access API. Please use Chrome or Edge.');
    return;
  }
  try {
    if (!cachedTestDirHandle){
      cachedTestDirHandle = await w.showDirectoryPicker();
    }
    isLoading.value = true;
    const files = await collectFilesFromDirHandle(cachedTestDirHandle);
    if (files.length === 0){
      alert('No files found in the selected folder.');
      isLoading.value = false;
      return;
    }
    // ロード後は drag&drop と同じく **plain viewer のまま** にする (auto PET Standard はしない)。
    // 「DICOM を読み込んだ直後は plain viewer」がユーザ指定の原則で、autoLayoutAfterLoad
    // (loadFiles 内) の方針とも揃える。Volume 表示は Layouts / PET Standard から明示的に。
    loadFiles(files);
  } catch (err){
    console.warn('loadTestDicom canceled or failed', err);
    isLoading.value = false;
  }
};

const disableAutoFit = () => { autoFitMode.value = false; };
const fitToWindow = () => {
  autoFitMode.value = true;
  applyAutoFit();
};

// SeriesList でサムネ paging するときに任意 slice のサムネを生成するための provide。
// SeriesList は seriesList[] や myDicom 配列を直接見られないので、ここからクロージャで提供。
provide('getThumbnailForSlice', (seriesIdx: number, sliceIdx: number): string | null => {
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return null;
  const s = seriesList[seriesIdx];
  if (!s) return null;
  const modality = seriesSummaries.value[seriesIdx]?.modality ?? '-';
  return generateThumbnail(s, modality, sliceIdx);
});
provide('getSliceCount', (seriesIdx: number): number => {
  if (seriesIdx < 0 || seriesIdx >= seriesList.length) return 0;
  const s = seriesList[seriesIdx];
  if (!s) return 0;
  if (s.volume) return s.volume.nz;
  if (s.myDicom) return s.myDicom.length;
  return 0;
});

// SegmentationPanel への ref。App-bar ハンバーガーから panel の save/load を呼ぶための
// パススルーに使う (Load mask / Export PDF は file I/O・病変集計が panel 側にあるため)。
const segPanelRef = ref<any>(null);

// 右 Inspector (Segmentation) の開閉は **明示的なイベントだけ** で決める。watch で自動追従させない。
//   閉じる: 起動時 (App の drawerRight=false) / ロード直後 (autoLayoutAfterLoad) / Close all
//   開く  : MTV measurement (openInspectorForMtv) / ユーザのトグルボタン
// 以前は「volume box が無くなったら閉じる」watch を置いていたが、レイアウト再構築の途中で
// volume box が一瞬 0 になるため、開いた直後に勝手に閉じてしまっていた (パネルが出ない不具合)。
// 遅延判定でごまかすより、自動クローズ自体を持たない方が確実で、要件もすべて満たせる。

defineExpose({
  setupPetStandardView,
  openInspectorForMtv,
  // app-bar の Window preset ボタン / ハンバーガーの Advanced ダイアログ用。
  // どちらも UI は App.vue 側に移したが、実処理は従来どおりここに残っている。
  presetSelected,
  selectedBoxModality,
  phantomNema,
  phantomWholeBody,
  // LLM assistant (読み取り専用ツール) の実体
  llmListSeries,
  llmDescribeView,
  // App-bar ハンバーガー用: Segmentation panel の save/load パススルー
  segLoadMask: () => segPanelRef.value?.loadMask?.(),
  segExportPdf: () => segPanelRef.value?.exportPdf?.(),
  // NIfTI raw byte view (Persona 2 デバッグ用)
  inspectNiftiRaw,
  getNiftiSeriesList,
  // PET Standard ピッカー UI 用 (App.vue):
  //   getPetCtSeriesCandidates() — PT/CT 各候補一覧 (idx, label, isActive)
  //   resolvePetCtIndices()      — active → first-found 解決済み index
  getPetCtSeriesCandidates,
  resolvePetCtIndices,
  // App-bar の Preprocessing メニューから redraw を呼ぶ用
  redraw: show,
  // ROI (矩形 / sphere) を JSON 書き出し / 読み込み
  exportRoisAsJson,
  importRoisFromJsonFile,
  // 統合 Undo / Redo (App-bar の Undo/Redo ボタン用)
  undoLastAction,
  redoLastAction,
  setupTriplanarFused,
  setupPtOnly4up,
  setupCompare2up,
  setupPetCtMipRight,
  scrambleSlices,
  recoverSlices,
  loadTestDicom,
  // ガイドツアー (デモ) 用: 合成 PET/CT ファントムを読み込む
  phantomWholeBodyPetCt,
  // ハンバーガーメニューの "Load files…" から呼ぶための公開エントリ
  loadFiles,
  disableAutoFit,
  fitToWindow,
  seriesSummariesPublic: seriesSummaries,
  fusion,
  // ★2: JPEG Lossless decompress 進捗を App-bar から参照可能に
  jpegDecompressInProgress,
  jpegDecompressDone,
  jpegDecompressTotal,
  // nii.gz gunzip 進捗 (DecompressionStream chunk 単位)
  niftiGunzipInProgress,
  niftiGunzipName,
  niftiGunzipBytes,
  // Snapshot file (replaces former share-URL): full session save/load
  downloadSnapshotFile,
  loadSnapshotFile,
  // NIfTI header viewer 用
  getNiftiHeaderForSeries: (idx: number) => {
    if (idx < 0 || idx >= seriesList.length) return null;
    const v = seriesList[idx]?.volume;
    if (!v?.metadata) return null;
    return {
      header: v.metadata.niftiHeader ?? null,
      filename: v.metadata.sourceFilename ?? null,
      modality: v.metadata.modality,
      seriesUID: v.metadata.seriesUID,
      datatypeName: v.metadata.datatypeName,
      dims: { nx: v.nx, ny: v.ny, nz: v.nz },
    };
  },
  // Tracer preset
  applyTracerPreset,
  applyTracerById,
  // DICOM tag viewer
  getActiveTagContext,
  getTagContextForSeries,
  activeTagContext,
});

</script>

<template>
  <!-- Left sidebar: navigation / IO / view / series -->
  <v-navigation-drawer
    v-model="drawer"
    width="280"
    class="mv-pane"
    :border="0"
  >
    <sidebar
      :series-summaries="seriesSummaries"
      @setModality="onSetSeriesModality"
      @setActiveForSeg="onSetActiveForSeg"
      @inspectRaw="(p: { index: number }) => inspectNiftiRaw(p.index)"
      @viewHeader="(p: { index: number }) => onViewNiftiHeader(p.index)"
    />
  </v-navigation-drawer>

  <!-- Right inspector: segmentation -->
  <v-navigation-drawer
    v-model="inspector"
    width="320"
    location="right"
    class="mv-pane"
    :border="0"
  >
    <div class="mv-inspector-header">
      <span class="mv-section-title">Segmentation</span>
      <v-spacer />
      <v-btn
        icon
        size="x-small"
        variant="text"
        @click="inspector = false"
      >
        <v-icon icon="mdi-close" />
        <v-tooltip activator="parent" location="bottom">Hide right sidebar (Segmentation panel)</v-tooltip>
      </v-btn>
    </div>
    <SegmentationPanel
      ref="segPanelRef"
      @redraw="show"
      @jump="jumpToWorld"
      @set-tool="onPanelSetTool"
      @save-snapshot="downloadSnapshotFile"
      :active-tool="leftButtonFunction"
    />
  </v-navigation-drawer>

  <!-- Image area -->
  <div class="mv-imagearea" id="hello"
       @dragover.prevent
       @drop.prevent="(e: DragEvent) => dropFile(e)">
    <!-- 起動直後 / Close all 後の empty state。box ゼロ時のみ表示 -->
    <div v-if="(tileN ?? 0) === 0" class="mv-imagearea-empty">
      <v-icon icon="mdi-tray-arrow-down" size="56" />
      <span class="mv-imagearea-empty-title">Drop files here to start</span>
      <span class="mv-imagearea-empty-hint">DICOM folders or NIfTI files (.nii / .nii.gz)</span>
      <div class="mt-3">
        <v-btn
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="mdi-folder-open-outline"
          @click="onClickLoad"
        >
          Load files…
          <v-tooltip activator="parent" location="bottom">Choose DICOM or NIfTI files to open (or drop them anywhere here)</v-tooltip>
        </v-btn>
        <input
          ref="hiddenLoadInput"
          type="file"
          multiple
          accept=".dcm,.nii,.nii.gz,.gz,application/dicom,application/octet-stream"
          style="display: none"
          @change="onHiddenLoadInputChange"
        />
      </div>
      <span class="mv-imagearea-empty-hint mv-empty-link-hint mt-3">
        To add more later, use the <v-icon icon="mdi-menu" size="small" /> menu in the top-left.
      </span>
      <span class="mv-imagearea-empty-hint mv-empty-link-hint">
        Restoring a previous session? Drop your image files first, then use the
        <v-icon icon="mdi-camera-outline" size="small" /> Snapshot menu (top bar) → Load snapshot.
      </span>
      <span class="mv-imagearea-empty-hint mv-empty-link-hint">
        Remote: pass DICOM/NIfTI as <code>?url=https://your-host/scan.nii.gz</code>
        (multiple <code>?url=</code> params allowed; CORS-permitted hosts only)
      </span>
    </div>
    <div class="mv-tile-grid" :class="{ 'is-no-gap': noGapMode }" :style="gridStyle">
      <imagebox
        v-for="i in tileN"
        :key="i"
        :class="['mv-imagebox-cell', { 'is-selected': i-1 === selectedImageBoxId, 'cursor-grab': leftButtonFunction==='pan', 'mv-cursor-cross': leftButtonFunction==='brushROI' || leftButtonFunction==='polygonROI' }]"
        :style="boxCellStyle(i-1)"
        ref="imb"
        :imageBoxId="i-1"
        :width="imageBoxW"
        :height="boxRenderHeight(i-1)"
        @wheel.prevent="wheel"
        @click="imageBoxClicked"
        @mousemove="mouseMove"
        @mouseleave="onBoxMouseLeave(i-1)"
        @mousedown.left="onBoxMouseDown"
        @mouseup.left="onBoxMouseUp"
        @mousedown.middle.prevent
        @auxclick.prevent
        @contextmenu="onContextMenu"
        @dblclick="onDblClick"
        @dragenter="dragEnter"
        @dragleave="dragLeave"
        @dragover.prevent
        @drop.prevent.stop="(e: DragEvent) => dropFile(e, i-1)"
        :isEnter="isEnter"
        :selected="i-1 === selectedImageBoxId"
        :modality-label="getBoxModalityLabel(i-1)"
        :description="getBoxDescription(i-1)"
        :rendering="getBoxRendering(i-1)"
        :fused="isBoxFused(i-1)"
        :current-plane="getBoxCurrentPlane(i-1)"
        :current-clut="getBoxCurrentClut(i-1)"
        :legend="getBoxLegend(i-1)"
        :legend2="getBoxLegend2(i-1)"
        :corner-info="cornerInfoFor(i-1)"
        :cross-ref-lines="crossRefLinesFor(i-1)"
        :crosshair-x="getBoxCrosshairX(i-1)"
        :crosshair-y="getBoxCrosshairY(i-1)"
        :sync-enabled="isBoxSyncEnabled(i-1)"
        :global-sync-on="!!syncImageBox"
        :interpolation="getBoxInterpolation(i-1)"
        :interpolation1="getBoxInterpolation1(i-1)"
        :mip-threshold="getBoxMipThreshold(i-1)"
        :mip-depth="getBoxMipDepth(i-1)"
        :mip-shade="getBoxMipShade(i-1)"
        :mip-auto-info="getBoxMipAutoInfo(i-1)"
        :mip-alpha-scale="getBoxMipAlphaScale(i-1)"
        :vr-tf-preset-id="getBoxVrTfPresetId(i-1)"
        :vr-tf-presets="vrTfPresetsView"
        :vr-tf-points="getBoxVrTfPoints(i-1)"
        :vr-shading-enabled="!!getVrShadingField(i-1, 'enabled')"
        :vr-shading-ambient="getVrShadingField(i-1, 'ambient')"
        :vr-shading-diffuse="getVrShadingField(i-1, 'diffuse')"
        :vr-shading-spec-int="getVrShadingField(i-1, 'specularInt')"
        :vr-shading-spec-power="getVrShadingField(i-1, 'specularPower')"
        :vr-demo-running="isVrDemoRunningOnBox(i-1)"
        @close-box="onTitlebarClose(i-1)"
        @reset-view="onTitlebarResetView(i-1)"
        @set-plane="(p: 'axi'|'cor'|'sag'|'mip'|'smip'|'vr') => onTitlebarSetPlane(i-1, p)"
        @set-clut="(c: number) => onTitlebarSetClut(i-1, c)"
        @toggle-sync="onTitlebarToggleSync(i-1)"
        @maximize="onTitlebarMaximize(i-1)"
        @toggle-overlay="onTitlebarToggleOverlay(i-1)"
        @make-mpr="(plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr') => onTitlebarMakeMpr(i-1, plane)"
        @save-volume-nifti="onTitlebarSaveVolumeNifti(i-1)"
        @modality-drag-start="(e: DragEvent) => onModalityDragStart(e, i-1)"
        :overlay-alpha="getBoxOverlayAlpha(i-1)"
        @set-overlay-alpha="(v: number) => onSetOverlayAlpha(i-1, v)"
        :base-modality="getBoxBaseModality(i-1)"
        :overlay-modality="getBoxOverlayModality(i-1)"
        :overlay-clut="getBoxOverlayClut(i-1)"
        @set-overlay-clut="(c: number) => onTitlebarSetClut1(i-1, c)"
        @duplicate-box="onTitlebarDuplicate(i-1)"
        :active-window-layer="getBoxActiveWindowLayer(i-1)"
        @set-active-window-layer="(l: 'base' | 'overlay') => onSetActiveWindowLayer(i-1, l)"
        @set-interpolation="(p: { layer: 'base'|'overlay'; mode: 'nearest'|'bilinear' }) => onSetInterpolation(i-1, p)"
        @set-mip-param="(p: any) => onSetMipParam(i-1, p)"
        @set-vr-tf-preset="(id: string) => onSetVrTfPreset(i-1, id)"
        @set-vr-tf-points="(pts: { v: number; a: number }[]) => onSetVrTfPoints(i-1, pts)"
        @set-vr-shading="(p: { key: 'enabled'|'ambient'|'diffuse'|'specularInt'|'specularPower'; value: number | boolean }) => onSetVrShading(i-1, p)"
        @toggle-vr-demo="onToggleVrDemo(i-1)"
        :can-revert-to-dicom="getCanRevertToDicom(i-1)"
        @back-to-dicom="onBackToDicom(i-1)"
        :paging="getBoxPaging(i-1)"
        @set-paging-index="(idx: number) => onSetPagingIndex(i-1, idx)"
        :register-busy="boxRegisterBusy === i-1"
        :manual-align="getBoxManualAlign(i-1)"
        @auto-register="onBoxAutoRegister(i-1)"
        @reset-register="onBoxResetRegister(i-1)"
        @toggle-manual-align="onBoxToggleManualAlign(i-1)"
        @manual-nudge="(d: any) => onBoxManualNudge(i-1, d)"
        @set-manual-step="(d: any) => { if (d.mm != null) manualStepMm = d.mm; if (d.deg != null) manualStepDeg = d.deg; }"
        @refine-register="onBoxAutoRegister(i-1, { fromCurrent: true })"
        @undo-register="undoRegistration()"
        @unfuse="unfuseBox(i-1)"
        @pick-fusion="onOpenFusionPicker(i-1)"
      />
    </div>

    <!-- Debug: voxel hover inspector -->
    <DebugInspector
      :enabled="debugMode"
      :rows="debugHoverRows"
      :mask="debugMaskInfo"
      :world="debugWorld"
      :screen-x="debugScreenX"
      :screen-y="debugScreenY"
      :show="debugShow"
    />

    <!-- Sphere VOI stats: 画像中の ROI 近傍に浮かせる (voxel inspector と同様)。ヘッダでドラッグ移動可。 -->
    <div
      v-if="sphereFloatFinalPos && segStore.sphere"
      class="mv-sphere-float"
      :style="{ left: sphereFloatFinalPos.x + 'px', top: sphereFloatFinalPos.y + 'px' }"
    >
      <div class="mv-sphere-float-hdr" @mousedown="onSphereFloatDragStart" title="Drag to move">
        <v-icon icon="mdi-drag" size="x-small" class="mr-1" />
        Sphere VOI
        <v-btn
          icon="mdi-close" size="x-small" variant="text" density="compact" class="ml-auto"
          title="Clear sphere VOI"
          @mousedown.stop
          @click="segStore.clearSphere(); sphereFloatOffset = { x: 0, y: 0 }; show()"
        />
      </div>
      <div class="mv-sphere-float-max">
        <span class="lbl">SUVmax</span>
        <span class="val">{{ segStore.sphere.suvMax.toFixed(3) }}</span>
      </div>
      <div class="mv-sphere-float-row"><span>SUVmean</span><span class="mono">{{ segStore.sphere.suvMean.toFixed(3) }}</span></div>
      <div class="mv-sphere-float-row"><span>radius</span><span class="mono">{{ segStore.sphere.radiusMm.toFixed(1) }} mm</span></div>
      <div class="mv-sphere-float-row"><span>voxels</span><span class="mono">{{ segStore.sphere.voxelCount }}</span></div>
    </div>

    <!-- Debug: indicator badge (画面右下) -->
    <div v-if="debugMode" class="mv-debug-badge">
      <v-icon icon="mdi-bug" size="x-small" />
      DEBUG
      <span class="hint">Shift+Click=edit voxel / Ctrl+Shift+D=toggle</span>
    </div>
  </div>

  <!-- Auto-save recovery dialog -->
  <v-dialog v-model="showRecoveryDialog" max-width="480" persistent>
    <v-card v-if="recoveryCandidate" class="mv-recovery-card">
      <v-card-title class="mv-recovery-title">
        <v-icon icon="mdi-history" class="mr-2" color="primary" />
        Recover previous session?
      </v-card-title>
      <v-card-text>
        <div class="mv-recovery-line">
          <strong>{{ recoveryCandidate.seriesDescription || 'Unknown series' }}</strong>
        </div>
        <div class="mv-recovery-line mv-recovery-meta">
          Last edited <strong>{{ formatRelativeTime(recoveryCandidate.savedAt) }}</strong>
          ({{ new Date(recoveryCandidate.savedAt).toLocaleString() }})
        </div>
        <div class="mv-recovery-line mv-recovery-meta">
          {{ recoveryCandidate.dims[0] }}×{{ recoveryCandidate.dims[1] }}×{{ recoveryCandidate.dims[2] }}
          · {{ recoveryCandidate.labels?.length ?? 0 }} labels
        </div>
        <div class="mv-recovery-hint">
          Loading the saved mask will replace any current segmentation on this PT.
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" @click="onRecoverDiscard">
          Discard saved
          <v-tooltip activator="parent" location="top">Delete the auto-saved mask so this prompt stops appearing</v-tooltip>
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="onRecoverSkip">
          Skip
          <v-tooltip activator="parent" location="top">Keep the saved mask on disk but do not load it now</v-tooltip>
        </v-btn>
        <v-btn variant="flat" color="primary" @click="onRecoverYes">
          Recover
          <v-tooltip activator="parent" location="top">Load the auto-saved mask, replacing the current segmentation</v-tooltip>
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Fuse with… : 重ねる相手を提案付きで選ぶ。
       候補は絞り込まず、推奨 (同 FrameOfReference の PT×CT) を上に出して理由を添えるだけ。
       イレギュラーな組み合わせ (別 study の診断 CT に PET 等) も下に並ぶので選べる。 -->
  <v-dialog v-model="fusionDialog.open" max-width="640">
    <v-card>
      <v-card-title class="text-body-1">
        Fuse onto <span class="text-primary">{{ fusionDialog.baseLabel }}</span>
      </v-card-title>
      <v-card-text class="pt-0">
        <div class="text-caption text-disabled mb-2">
          Pick the series to overlay. Items marked <b>recommended</b> share this box's frame of
          reference, so they are already spatially aligned.
        </div>
        <v-list density="compact" class="mv-fusion-list">
          <v-list-item
            v-for="c in fusionDialog.candidates"
            :key="c.idx"
            @click="onPickFusionCandidate(c.idx)"
          >
            <template #prepend>
              <span class="modality-chip" :class="{ 'is-pt': c.modality === 'PT' || c.modality === 'PET', 'is-ct': c.modality === 'CT' }">
                {{ c.modality || '?' }}
              </span>
            </template>
            <v-list-item-title>
              {{ c.label }}
              <v-chip v-if="c.recommended" size="x-small" color="primary" variant="flat" class="ml-2">recommended</v-chip>
            </v-list-item-title>
            <v-list-item-subtitle>{{ c.nFrames }} frames · {{ c.reason }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="fusionDialog.open = false">
          Cancel
          <v-tooltip activator="parent" location="top">Close without fusing</v-tooltip>
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- NIfTI header viewer dialog (volume card "..." メニュー → "View NIfTI header") -->
  <v-dialog v-model="niftiHeaderDialog.open" max-width="720">
    <v-card>
      <v-card-title class="d-flex align-center" style="gap: 8px;">
        <v-icon icon="mdi-format-list-bulleted-type" size="small" />
        <span>NIfTI header</span>
        <span class="text-caption text-disabled" style="font-family: 'JetBrains Mono', monospace; margin-left: 4px;">
          {{ niftiHeaderDialog.filename }}
        </span>
        <v-spacer />
        <v-btn icon variant="text" size="small" @click="niftiHeaderDialog.open = false">
          <v-icon icon="mdi-close" />
          <v-tooltip activator="parent" location="bottom">Close the NIfTI header viewer</v-tooltip>
        </v-btn>
      </v-card-title>
      <v-card-text style="max-height: 70vh; overflow: auto;">
        <div class="text-caption text-disabled mb-2">
          modality: <b>{{ niftiHeaderDialog.modality }}</b>
          · datatype: <b>{{ niftiHeaderDialog.datatypeName }}</b>
          · series UID: <span style="font-family: 'JetBrains Mono', monospace;">{{ niftiHeaderDialog.seriesUID }}</span>
        </div>
        <table class="mv-nifti-hdr-table">
          <tbody>
            <tr v-for="r in niftiHeaderDialog.rows" :key="r.key">
              <td class="key">{{ r.key }}</td>
              <td class="val">{{ r.value }}</td>
            </tr>
          </tbody>
        </table>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mv-nifti-hdr-table {
  width: 100%;
  font-size: 12px;
  border-collapse: collapse;
}
.mv-nifti-hdr-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--mv-border);
  vertical-align: top;
}
.mv-nifti-hdr-table td.key {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: var(--mv-text-muted);
  width: 28%;
  white-space: nowrap;
}
.mv-nifti-hdr-table td.val {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  word-break: break-all;
}
</style>

<style scoped>
.mv-tile-grid {
  display: grid;
  gap: 6px;
  justify-content: center;
  align-content: start;
  margin: auto;
}
/* 「全体化」モード: タイル間 gap を排除して画像エリアを最大限活用 */
.mv-tile-grid.is-no-gap {
  gap: 0;
}

/* 起動直後 / Close all 後: box ゼロのときの empty state。
   drag&drop イベントは @drop.prevent が親 .mv-imagearea にあるため、empty state 自身が
   pointer-events を catch しても normal な bubbling で親まで届く → Load button を
   普通に click できる。 */
.mv-imagearea-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  color: var(--mv-text-muted, #5A6877);
  user-select: none;
}
.mv-imagearea-empty-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.mv-imagearea-empty-hint {
  font-size: 11px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: var(--mv-text-dim, #8FA0B0);
}
.mv-empty-link-hint {
  margin-top: 4px;
  text-align: center;
  max-width: 600px;
  line-height: 1.5;
  color: var(--mv-text-muted);
}
.mv-empty-link-hint code {
  background: rgba(0, 212, 170, 0.08);
  border: 1px solid var(--mv-border, #2a3441);
  padding: 1px 4px;
  border-radius: 2px;
  color: var(--mv-accent, #00D4AA);
}

.mv-inspector-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mv-border);
  position: sticky;
  top: 0;
  background: var(--mv-surface);
  z-index: 1;
}

/* drawer 内のテキストが上端で見切れないよう */
:deep(.v-navigation-drawer__content) {
  padding-top: 0;
}

.mv-sphere-float {
  position: fixed;
  z-index: 9997;
  min-width: 130px;
  padding: 5px 8px 6px;
  background: rgba(15, 20, 25, 0.94);
  border: 1px solid var(--mv-accent-dim, #1f6f5f);
  border-radius: 5px;
  color: var(--mv-text);
  font-size: 11px;
  box-shadow: var(--mv-shadow, 0 4px 16px rgba(0,0,0,0.4));
  backdrop-filter: blur(3px);
  pointer-events: auto;
}
.mv-sphere-float-hdr {
  display: flex;
  align-items: center;
  color: var(--mv-accent);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 3px;
  cursor: move;
  user-select: none;
}
.mv-sphere-float-max {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--mv-border);
  padding-bottom: 3px;
  margin-bottom: 3px;
}
.mv-sphere-float-max .lbl {
  font-size: 11px;
  color: var(--mv-text-muted);
  letter-spacing: 0.02em;
}
.mv-sphere-float-max .val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 20px;
  font-weight: 700;
  color: var(--mv-accent);
  line-height: 1;
}
.mv-sphere-float-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--mv-text-muted);
  line-height: 1.5;
}
.mv-sphere-float-row .mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--mv-text);
}

.mv-debug-badge {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 9998;
  background: rgba(255, 92, 122, 0.18);
  border: 1px solid var(--mv-error);
  color: var(--mv-error);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.mv-debug-badge .hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--mv-text-muted);
  margin-left: 6px;
}

/* Auto-save recovery dialog */
.mv-recovery-card {
  background: var(--mv-surface) !important;
  color: var(--mv-text);
}
.mv-recovery-title {
  display: flex;
  align-items: center;
  font-size: 16px !important;
  font-weight: 600;
  padding-top: 16px !important;
}
.mv-recovery-line {
  font-size: 13px;
  margin-bottom: 4px;
}
.mv-recovery-meta {
  color: var(--mv-text-dim);
  font-size: 12px;
  font-feature-settings: 'tnum';
}
.mv-recovery-hint {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255, 180, 84, 0.08);
  border: 1px solid rgba(255, 180, 84, 0.3);
  border-radius: 4px;
  color: var(--mv-warning);
  font-size: 11px;
}
</style>


