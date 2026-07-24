<script setup lang="ts">

// 2024/6/9 
// Kenji Hirata
// important class, responsible for drawing image box.
//


import { ref, onMounted} from 'vue';
import * as THREE from '@/lib/threeMath';
import { isWebGpuAvailable } from './webgpu/gpuContext';
import { gpuRenderMip } from './webgpu/mipPipeline';
import { gpuRenderVr } from './webgpu/vrPipeline';
import { gpuRenderSlice } from './webgpu/slicePipeline';
import { gpuRenderFusion } from './webgpu/fusionPipeline';
import VrTfEditor from './VrTfEditor.vue';
import { gpuRenderFusionMip } from './webgpu/fusionMipPipeline';
import { gpuRenderFusionVr } from './webgpu/fusionVrPipeline';
import { usePerfStore } from '../stores/perf';
const perfStore = usePerfStore();


interface ClutLegendProp {
  gradient: string;
  minLabel: string;
  maxLabel: string;
}

// 4 隅オーバーレイ。各隅は複数行を string[] で受け取り、改行表示。
// undefined または全コーナー空配列なら何も描かない。
export interface CornerInfoProp {
  tl?: string[];
  tr?: string[];
  bl?: string[];
  br?: string[];
}

const prop = defineProps<{
  width: number;
  height: number;
  selected: boolean;
  isEnter: boolean;
  modalityLabel?: string;
  description?: string;
  boxKind?: 'dicom' | 'volume' | 'fusion' | 'mip';
  currentPlane?: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr' | null;
  currentClut?: number;
  syncEnabled?: boolean;
  globalSyncOn?: boolean;
  // Color scale legend (canvas 右下に半透明 overlay)。
  // legend = 主レイヤ (Volume なら唯一、Fusion なら CT)、legend2 = Fusion の PET レイヤ。
  legend?: ClutLegendProp;
  legend2?: ClutLegendProp;
  // Crosshair (canvas 上の screen 座標 px)。null/undefined なら描画しない。
  crosshairX?: number | null;
  crosshairY?: number | null;
  // 4 隅 patient/exam info overlay。undefined ならグローバルトグル OFF。
  cornerInfo?: CornerInfoProp;
  // 断面支持線 (cross-reference lines)。他 box の slice plane を投影した線分。
  // canvas pixel 座標。undefined / 空配列なら描画しない。
  crossRefLines?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  // Fusion overlay ブレンド比 (0..1)。Fusion box の titlebar slider 用。Fusion 以外では未使用。
  overlayAlpha?: number;
  // Fusion box の base / overlay 識別 (titlebar CLUT ボタン badge 用)
  baseModality?: string;        // 例: 'CT', 'MR'
  overlayModality?: string;     // 例: 'PT'
  overlayClut?: number;         // overlay レイヤの現在 CLUT id (clut1)
  // Fusion box: Window/Level drag が作用するレイヤ ('base' | 'overlay')。'base' なら base 側、それ以外は overlay 側
  activeWindowLayer?: 'base' | 'overlay';
  // 補間モード (slice/MPR 用)。VolumeBox は interpolation のみ、FusionBox は両方使う。
  interpolation?: 'nearest' | 'bilinear';
  interpolation1?: 'nearest' | 'bilinear';
  // sMIP / VR の現在値 (titlebar 歯車 popover の表示用)。MIP / 通常スライスでは null/undefined。
  mipThreshold?: number;
  mipDepth?: number;
  mipAlphaScale?: number;
  // VR Phase A: opacity transfer function preset id (vrTf.TF_PRESETS から)
  vrTfPresetId?: string;
  // 全 preset 選択肢 (UI 表示用、parent から渡す)
  vrTfPresets?: { id: string; label: string; description: string }[];
  // VR D15: 実 control points (vrOpacityTF)。editor がこれを直接編集する。
  vrTfPoints?: { v: number; a: number }[];
  // VR Phase B: Phong shading
  vrShadingEnabled?: boolean;
  vrShadingAmbient?: number;
  vrShadingDiffuse?: number;
  vrShadingSpecInt?: number;
  vrShadingSpecPower?: number;
  // VR demo: 再生中?
  vrDemoRunning?: boolean;
  // この Volume box は元 DICOM に戻せるか? (DICOM-origin 系列のみ true)。
  canRevertToDicom?: boolean;
}>();

const emit = defineEmits<{
  (e: 'closeBox'): void;
  (e: 'resetView'): void;
  (e: 'setPlane', plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr'): void;
  (e: 'setClut', clutIdx: number): void;
  (e: 'toggleSync'): void;
  (e: 'maximize'): void;
  (e: 'toggleOverlay'): void;
  (e: 'makeMpr', plane: 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr'): void;
  (e: 'saveVolumeNifti'): void;
  // Modality chip drag start: 親 (DicomView) が dataTransfer を埋めて fusion 起点にする
  (e: 'modalityDragStart', ev: DragEvent): void;
  // Fusion overlay blend ratio 変更 (0..1)
  (e: 'setOverlayAlpha', v: number): void;
  // Fusion overlay レイヤの CLUT 変更
  (e: 'setOverlayClut', clutIdx: number): void;
  // Box 複製: 同じ表示内容で別インスタンスを新規 box として追加
  (e: 'duplicateBox'): void;
  // Fusion box: Window/Level drag の対象レイヤを切替 ('base' | 'overlay')
  (e: 'setActiveWindowLayer', layer: 'base' | 'overlay'): void;
  // Sampling 補間切替。layer='base' なら interpolation (vol0)、layer='overlay' なら interpolation1 (vol1)
  // VolumeBox は layer='base' のみ送る。FusionBox は base / overlay 両方を別々に切替可能。
  (e: 'setInterpolation', payload: { layer: 'base' | 'overlay'; mode: 'nearest' | 'bilinear' }): void;
  // sMIP / VR のレンダリングパラメータ更新 (titlebar 歯車 popover)
  (e: 'setMipParam', payload: { key: 'thresholdSurfaceMip' | 'depthSurfaceMip' | 'alphaScale'; value: number }): void;
  // VR Phase A: TF preset 切替
  (e: 'setVrTfPreset', presetId: string): void;
  // VR D15: 直接 control points を更新 (editor 経由)。preset id は親側で 'custom' に。
  (e: 'setVrTfPoints', pts: { v: number; a: number }[]): void;
  // VR Phase B: shading 設定
  (e: 'setVrShading', payload: { key: 'enabled' | 'ambient' | 'diffuse' | 'specularInt' | 'specularPower'; value: number | boolean }): void;
  // VR demo: play / stop の toggle
  (e: 'toggleVrDemo'): void;
  // Volume box → DICOM slice (2D) に戻す
  (e: 'backToDicom'): void;
}>();

// Fusion box の overlay clut が active か判定 (clut1 用)
const isOverlayClutActive = (itemId: number): boolean => {
  if (prop.overlayClut == null) return false;
  if (itemId === -1) return false;
  return (prop.overlayClut & ~1) === itemId;
};

// Modality chip drag: Volume / Fusion / DicomSlice いずれからも fusion を起動できる。
// MIP / VR は除外 (drag start handler 側で別途チェック)。
const isModalityChipDraggable = (): boolean => {
  return prop.boxKind === 'volume' || prop.boxKind === 'fusion' || prop.boxKind === 'dicom';
};

const isEnter = ref(false);

const planeItems = [
  { id: 'axi',  label: 'Axial' },
  { id: 'cor',  label: 'Coronal' },
  { id: 'sag',  label: 'Sagittal' },
  { id: 'mip',  label: 'MIP' },
  { id: 'smip', label: 'sMIP' },
  { id: 'vr',   label: 'Volume Rendering' },
] as const;

// CLUT id は DicomView 側の switchTo* と一致 (Mono=0, Rainbow=2, Hot=4)。
// 'Reverse' は同色の反転 LUT へトグル (DicomView 側で id=-1 を sentinel として処理)。
const clutItems = [
  { id: 0,  label: 'Mono' },
  { id: 4,  label: 'Hot' },
  { id: 2,  label: 'Rainbow' },
  { id: -1, label: 'Reverse' },
] as const;

// 現在 CLUT のハイライト判定: 反転 LUT (奇数値) は対応する偶数 LUT を active 表示。
const isClutActive = (itemId: number): boolean => {
  if (prop.currentClut == null) return false;
  if (itemId === -1) return false;
  return (prop.currentClut & ~1) === itemId;
};

const modalityChipColor = (m?: string): string => {
  const u = (m ?? '').toUpperCase();
  if (u === 'PT' || u === 'PET') return '#ff9b3a';
  if (u === 'CT') return '#7ad0ff';
  if (u === 'MR') return '#a78bfa';
  if (u === 'FUSED') return '#ffd24a';
  if (u === 'MIP')   return '#c9a0ff';
  if (u === '2D')    return '#666';
  return '#888';
};

const isVolumeKind = (): boolean => prop.boxKind === 'volume' || prop.boxKind === 'fusion' || prop.boxKind === 'mip';

const onSavePngLocal = () => {
  if (!cv1.value) return;
  const url = cv1.value.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  a.download = `metavol-${ts}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

const cv1 = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;

// 3D volume を fractional voxel 座標で nearest-to-center sampling する。
// 範囲外なら null。voxel 中心は整数座標前提なので floor(v + 0.5) で最近傍 center。
const sampleNearest = (
    pix: Float32Array | Int16Array,
    nx: number, ny: number, nz: number,
    vx: number, vy: number, vz: number,
): number | null => {
    const x = Math.floor(vx + 0.5), y = Math.floor(vy + 0.5), z = Math.floor(vz + 0.5);
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return null;
    return pix[z * nx * ny + y * nx + x];
};

// 3D volume を fractional voxel 座標で trilinear sampling する。
// 範囲外なら null を返す (caller が背景値で埋める想定)。
// 主に Fusion box の PET layer 用 (低解像 PET → 高解像 CT 上に重ねるとき
// nearest だとブロック状になるのを滑らかにする)。
const sampleTrilinear = (
    pix: Float32Array | Int16Array,
    nx: number, ny: number, nz: number,
    vx: number, vy: number, vz: number,
): number | null => {
    if (vx < 0 || vy < 0 || vz < 0 || vx >= nx || vy >= ny || vz >= nz) return null;
    const x0 = Math.floor(vx); const x1 = x0 + 1 < nx ? x0 + 1 : x0; const fx = vx - x0;
    const y0 = Math.floor(vy); const y1 = y0 + 1 < ny ? y0 + 1 : y0; const fy = vy - y0;
    const z0 = Math.floor(vz); const z1 = z0 + 1 < nz ? z0 + 1 : z0; const fz = vz - z0;
    const nxny = nx * ny;
    const c000 = pix[z0 * nxny + y0 * nx + x0];
    const c100 = pix[z0 * nxny + y0 * nx + x1];
    const c010 = pix[z0 * nxny + y1 * nx + x0];
    const c110 = pix[z0 * nxny + y1 * nx + x1];
    const c001 = pix[z1 * nxny + y0 * nx + x0];
    const c101 = pix[z1 * nxny + y0 * nx + x1];
    const c011 = pix[z1 * nxny + y1 * nx + x0];
    const c111 = pix[z1 * nxny + y1 * nx + x1];
    const c00 = c000 + (c100 - c000) * fx;
    const c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx;
    const c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
};

// Canvas が「空」(まだ画像未描画 / clear() 直後) かどうか。
// HTML overlay の empty state を表示制御する ref。
const isEmpty = ref(true);
const emptyText = ref('No image');

const init = () => {
  if (cv1.value === null) {
    return;
  }
  ctx = cv1.value.getContext("2d", {willReadFrequently: true});
  clear();
}

onMounted(() => {
  init();
});

const show = (ppp: Float32Array | Int16Array, cols: number, rows: number, wc: number, ww: number, intercept: number, slope: number, centerX:number, centerY:number, zoom: number, interpolation: 'nearest' | 'bilinear' = 'bilinear') => {
    isEmpty.value = false;
    drawImageCvZoom(ppp, cols, rows, wc, ww, intercept, slope, centerX, centerY, zoom, interpolation);
}

const showDirect = (ppp: Float32Array | Int16Array, wc: number, ww: number) => {
    isEmpty.value = false;
    drawImageCvDirect(ppp, wc, ww);
}

const show2 = (ppp: Float32Array, qqq: Float32Array, cols: number, rows: number, wc: number, ww: number, wc2: number, ww2: number, intercept: number, slope: number, centerX:number, centerY:number, zoom: number) => {
    isEmpty.value = false;
    drawImageCv2(ppp, qqq, cols, rows, wc, ww, wc2, ww2, intercept, slope, centerX, centerY, zoom);
}

const showRgb = (ppp: Uint8Array, cols: number, rows: number, centerX:number, centerY:number, zoom: number) => {
    isEmpty.value = false;
    drawImageCvRgb(ppp, cols, rows, centerX, centerY, zoom);
}

// Bilinear / Nearest 補間版。
//   bilinear: zoom in 時のジャギーを解消するため fractional pixel 座標で 4 近傍を線形補間。
//   nearest:  voxel 境界をくっきり見たいケース用。voxel 中心 = 整数規約に合わせ
//             floor(v + 0.5) で最近傍 cell を選ぶ (sampleNearest と同じ規約)。
// 範囲外は黒背景。端 (fx >= nx-1 等) は x1 = clamp(x0+1, ≤nx-1) で stretched 1px に丸める。
const drawImageCvZoom = async function(pix: Float32Array | Int16Array, ny:number, nx:number, wc:number, ww:number, intercept:number, slope:number, shiftX:number, shiftY:number, zoom:number, interpolation: 'nearest' | 'bilinear' = 'bilinear') {
  if (cv1.value === null || ctx === null) return;
  const canvasx = cv1.value.width;
  const canvasy = cv1.value.height;
  const myImageData = ctx.getImageData(0,0,canvasx,canvasy);
  let ad = 0;

  const lo = wc - ww/2;
  const scale = 255 / ww;

  for (let y = 0; y<canvasy; y++){
    const fy = (y-canvasy/2)/zoom + ny/2 + shiftY;
    for (let x = 0; x<canvasx; x++){
      const fx = (x-canvasx/2)/zoom + nx/2 + shiftX;
      if (fx<0 || fx>=nx || fy<0 || fy>=ny){
        myImageData.data[ad] = 0;
        myImageData.data[ad+1] = 0;
        myImageData.data[ad+2] = 0;
        ad += 4;
        continue;
      }
      let v: number;
      if (interpolation === 'nearest') {
        const xi = Math.floor(fx + 0.5);
        const yi = Math.floor(fy + 0.5);
        const xc = xi >= nx ? nx - 1 : xi;
        const yc = yi >= ny ? ny - 1 : yi;
        v = pix[xc + yc * nx];
      } else {
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = x0 + 1 < nx ? x0 + 1 : x0;
        const y1 = y0 + 1 < ny ? y0 + 1 : y0;
        const dx = fx - x0;
        const dy = fy - y0;
        const v00 = pix[x0 + y0*nx];
        const v10 = pix[x1 + y0*nx];
        const v01 = pix[x0 + y1*nx];
        const v11 = pix[x1 + y1*nx];
        v = (v00*(1-dx) + v10*dx) * (1-dy) + (v01*(1-dx) + v11*dx) * dy;
      }
      const raw = v * slope + intercept;
      let p = (raw - lo) * scale;
      if (p<0) p=0;
      if (p>255) p=255;
      myImageData.data[ad] = p;
      myImageData.data[ad+1] = p;
      myImageData.data[ad+2] = p;
      ad += 4;
    }
  }
  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
}

const drawImageCvDirect = async function(pix: Float32Array | Int16Array, wc:number, ww:number) {
  if (cv1.value === null || ctx === null) return;
  const canvasx = cv1.value.width;
  const canvasy = cv1.value.height;
  const myImageData = ctx.getImageData(0,0,canvasx,canvasy); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
  let ad = 0;

  for (let y1 = 0; y1<canvasy; y1++){
    for (let x1 = 0; x1<canvasx; x1++){
      const raw = pix[x1+y1*canvasx];
      let p = (raw-(wc-ww/2)) * (255/ww);
      if (p<0) p=0;
      if (p>255) p=255;
      myImageData.data[ad] = p; //red
      myImageData.data[ad+1] = p; //green
      myImageData.data[ad+2] = p; //blue
      ad += 4;
    }
  }
  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
}


export interface MaskOverlay {
  mask: Uint16Array;
  // mask は別 Volume 系（PET など）に紐づく。PET 座標での p00/v01/v10 を別途渡す。
  p00: THREE.Vector3;
  v01: THREE.Vector3;
  v10: THREE.Vector3;
  nx: number; ny: number; nz: number;
  labelClut: number[][];
  alpha: number;
  // segStore.maskVersion — GPU mask texture cache の invalidation key。
  // mask Uint16Array は recompute で in-place 書換されるため、参照同一性だけでは差分検出できない。
  version?: number;
}

const drawNiftiSlice = async function(pix: Float32Array | Int16Array,
    nx:number, ny:number, nz:number, wc:number, ww:number,
    p00:THREE.Vector3, v01:THREE.Vector3,v10:THREE.Vector3, clut: number[][],
    overlay?: MaskOverlay,
    bodyMask?: Uint8Array,         // CT 寝台除去用 body mask (0=体外, 1=体内)
    interpolation: 'nearest' | 'bilinear' = 'bilinear') {

      if (cv1.value === null || ctx === null) return;
      const canvasx = cv1.value.width;
      const canvasy = cv1.value.height;

      // ====== WebGPU fast path (Step 4) ======
      const t0 = performance.now();
      if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
          const gpuOff = await gpuRenderSlice({
            voxel: pix, nx, ny, nz,
            outW: canvasx, outH: canvasy,
            p00: { x: p00.x, y: p00.y, z: p00.z },
            v01: { x: v01.x, y: v01.y, z: v01.z },
            v10: { x: v10.x, y: v10.y, z: v10.z },
            wc, ww, clut,
            overlay: overlay ? {
              mask: overlay.mask,
              version: overlay.version ?? 0,
              nx: overlay.nx, ny: overlay.ny, nz: overlay.nz,
              p00: { x: overlay.p00.x, y: overlay.p00.y, z: overlay.p00.z },
              v01: { x: overlay.v01.x, y: overlay.v01.y, z: overlay.v01.z },
              v10: { x: overlay.v10.x, y: overlay.v10.y, z: overlay.v10.z },
              labelClut: overlay.labelClut,
              alpha: overlay.alpha,
            } : undefined,
            bodyMask,
            targetCanvas: cv1.value,
            interpolation,
          });
          if (gpuOff) {
            isEmpty.value = false;
            ctx.drawImage(gpuOff as any, 0, 0);
            perfStore.record('mpr', 'gpu', performance.now() - t0);
            return;
          }
        } catch (err) {
          console.warn('[gpu] slice failed:', err);
          if (!perfStore.cpuFallbackAllowed) {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, canvasx, canvasy);
            isEmpty.value = false;
            return;
          }
        }
      }
      if (!perfStore.cpuFallbackAllowed) {
        console.warn('[slice] CPU fallback blocked by rendererMode=gpu — filling sentinel');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false;
        return;
      }

      isEmpty.value = false;
      const myImageData = ctx.getImageData(0,0,canvasx,canvasy); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
      let ad = 0;

      for (let i = 0; i<canvasy; i++){
        let v = p00.clone().addScaledVector(v01,i);
        const vm = overlay ? overlay.p00.clone().addScaledVector(overlay.v01, i) : null;
        for (let j = 0; j<canvasx; j++){

          // 補間: 'bilinear' (実体は trilinear) で滑らか、'nearest' で voxel 境界くっきり。
          let raw = interpolation === 'nearest'
              ? sampleNearest(pix, nx, ny, nz, v.x, v.y, v.z)
              : sampleTrilinear(pix, nx, ny, nz, v.x, v.y, v.z);
          // CT 寝台除去: bodyMask が定義されていて当該 voxel が体外なら -1024 で塗り潰す
          if (raw != null && bodyMask){
            const bx = Math.floor(v.x), by = Math.floor(v.y), bz = Math.floor(v.z);
            if (bx >= 0 && bx < nx && by >= 0 && by < ny && bz >= 0 && bz < nz){
              if (bodyMask[bz*nx*ny + by*nx + bx] === 0) raw = -1024;
            }
          }
          if (raw != null){
            let p = Math.floor((raw-(wc-ww/2)) * (255/ww));
            if (p<0) p=0;
            if (p>255) p=255;
            myImageData.data[ad] = clut[p][0]; //red
            myImageData.data[ad+1] = clut[p][1]; //green
            myImageData.data[ad+2] = clut[p][2]; //blue
          }else{
            myImageData.data[ad] = clut[0][0];
            myImageData.data[ad+1] = clut[0][1];
            myImageData.data[ad+2] = clut[0][2];
          }

          if (overlay && vm){
            // Voxel center 規約 = 整数座標。floor + 0.5 で round-to-nearest-center。
            // (PET 側の trilinear は半 voxel 中心基準で動作するため、floor() のままでは
            // PET エッジとマスクエッジが ½ voxel ずれて見える)
            const mx = Math.floor(vm.x + 0.5), my = Math.floor(vm.y + 0.5), mz = Math.floor(vm.z + 0.5);
            if (mx>=0 && mx<overlay.nx && my>=0 && my<overlay.ny && mz>=0 && mz<overlay.nz){
              const lid = overlay.mask[overlay.ny*overlay.nx*mz + overlay.nx*my + mx];
              if (lid > 0){
                const c = overlay.labelClut[lid % overlay.labelClut.length];
                const a = overlay.alpha;
                myImageData.data[ad]   = myImageData.data[ad]   * (1-a) + c[0]*a;
                myImageData.data[ad+1] = myImageData.data[ad+1] * (1-a) + c[1]*a;
                myImageData.data[ad+2] = myImageData.data[ad+2] * (1-a) + c[2]*a;
              }
            }
            vm.add(overlay.v10);
          }

          ad += 4;
          v.add(v10);
        }
      }

  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
  perfStore.record('mpr', 'cpu', performance.now() - t0);
}

const drawNiftiSliceFusion = async function(pix0: Float32Array | Int16Array,
    nx0:number, ny0:number, nz0:number, wc0:number, ww0:number,
    p00_0:THREE.Vector3, v01_0:THREE.Vector3,v10_0:THREE.Vector3, clut0: number[][],
    pix1: Float32Array | Int16Array,
    nx1:number, ny1:number, nz1:number, wc1:number, ww1:number,
    p00_1:THREE.Vector3, v01_1:THREE.Vector3,v10_1:THREE.Vector3, clut1: number[][],
    overlay?: MaskOverlay,
    bodyMask?: Uint8Array,    // CT 寝台除去用 (pix0=CT 想定)
    alpha: number = 0.5,      // overlay (pix1) ブレンド比 0..1。base は (1-alpha)。
    interpolation0: 'nearest' | 'bilinear' = 'bilinear',  // base layer
    interpolation1: 'nearest' | 'bilinear' = 'bilinear',  // overlay layer
  ) {

      if (cv1.value === null || ctx === null) return;
      const canvasx = cv1.value.width;
      const canvasy = cv1.value.height;

      // ====== WebGPU fast path (Step 5) ======
      const t0 = performance.now();
      if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
          const gpuOff = await gpuRenderFusion({
            voxel0: pix0, nx0, ny0, nz0,
            p00_0: { x: p00_0.x, y: p00_0.y, z: p00_0.z },
            v01_0: { x: v01_0.x, y: v01_0.y, z: v01_0.z },
            v10_0: { x: v10_0.x, y: v10_0.y, z: v10_0.z },
            wc0, ww0, clut0,
            voxel1: pix1, nx1, ny1, nz1,
            p00_1: { x: p00_1.x, y: p00_1.y, z: p00_1.z },
            v01_1: { x: v01_1.x, y: v01_1.y, z: v01_1.z },
            v10_1: { x: v10_1.x, y: v10_1.y, z: v10_1.z },
            wc1, ww1, clut1,
            outW: canvasx, outH: canvasy,
            overlayBlend: alpha,
            interpolation0,
            interpolation1,
            overlay: overlay ? {
              mask: overlay.mask,
              version: overlay.version ?? 0,
              nx: overlay.nx, ny: overlay.ny, nz: overlay.nz,
              p00: { x: overlay.p00.x, y: overlay.p00.y, z: overlay.p00.z },
              v01: { x: overlay.v01.x, y: overlay.v01.y, z: overlay.v01.z },
              v10: { x: overlay.v10.x, y: overlay.v10.y, z: overlay.v10.z },
              labelClut: overlay.labelClut,
              alpha: overlay.alpha,
            } : undefined,
            bodyMask,
            targetCanvas: cv1.value,
          });
          if (gpuOff) {
            isEmpty.value = false;
            ctx.drawImage(gpuOff as any, 0, 0);
            perfStore.record('fusion-mpr', 'gpu', performance.now() - t0);
            return;
          }
        } catch (err) {
          console.warn('[gpu] fusion-slice failed:', err);
          if (!perfStore.cpuFallbackAllowed) {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(0, 0, canvasx, canvasy);
            isEmpty.value = false;
            return;
          }
        }
      }
      if (!perfStore.cpuFallbackAllowed) {
        console.warn('[fusion-slice] CPU fallback blocked by rendererMode=gpu — filling sentinel');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false;
        return;
      }

      isEmpty.value = false;
      const myImageData = ctx.getImageData(0,0,canvasx,canvasy); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
      let ad = 0;
      const baseW = 1 - alpha;
      const ovlW = alpha;

      for (let i = 0; i<canvasy; i++){
        let v_0 = p00_0.clone().addScaledVector(v01_0,i);
        let v_1 = p00_1.clone().addScaledVector(v01_1,i);
        const vm = overlay ? overlay.p00.clone().addScaledVector(overlay.v01, i) : null;
        for (let j = 0; j<canvasx; j++){

          // base (pix0): interpolation0 で nearest / bilinear 切替
          const rawBase = interpolation0 === 'nearest'
              ? sampleNearest(pix0, nx0, ny0, nz0, v_0.x, v_0.y, v_0.z)
              : sampleTrilinear(pix0, nx0, ny0, nz0, v_0.x, v_0.y, v_0.z);
          if (rawBase != null){
            let raw = rawBase;
            // CT 寝台除去: bodyMask は voxel-grid なので nearest 固定で参照 (round-to-center)
            if (bodyMask){
              const bx = Math.floor(v_0.x + 0.5), by = Math.floor(v_0.y + 0.5), bz = Math.floor(v_0.z + 0.5);
              if (bx >= 0 && bx < nx0 && by >= 0 && by < ny0 && bz >= 0 && bz < nz0
                  && bodyMask[ny0*nx0*bz+nx0*by+bx] === 0){
                raw = -1024;
              }
            }
            let p = Math.floor((raw-(wc0-ww0/2)) * (255/ww0));
            if (p<0) p=0;
            if (p>255) p=255;
            myImageData.data[ad] = clut0[p][0] * baseW; //red
            myImageData.data[ad+1] = clut0[p][1] * baseW; //green
            myImageData.data[ad+2] = clut0[p][2] * baseW; //blue
          }else{
            myImageData.data[ad] = clut0[0][0] * baseW;
            myImageData.data[ad+1] = clut0[0][1] * baseW;
            myImageData.data[ad+2] = clut0[0][2] * baseW;
          }

          // overlay (pix1): interpolation1 で nearest / bilinear 切替
          const rawPet = interpolation1 === 'nearest'
              ? sampleNearest(pix1, nx1, ny1, nz1, v_1.x, v_1.y, v_1.z)
              : sampleTrilinear(pix1, nx1, ny1, nz1, v_1.x, v_1.y, v_1.z);
          if (rawPet != null){
            let p = Math.floor((rawPet-(wc1-ww1/2)) * (255/ww1));
            if (p<0) p=0;
            if (p>255) p=255;
            myImageData.data[ad] += clut1[p][0] * ovlW; //red
            myImageData.data[ad+1] += clut1[p][1] * ovlW; //green
            myImageData.data[ad+2] += clut1[p][2] * ovlW; //blue
          }else{
            myImageData.data[ad] += clut1[0][0] * ovlW;
            myImageData.data[ad+1] += clut1[0][1] * ovlW;
            myImageData.data[ad+2] += clut1[0][2] * ovlW;
          }

          if (overlay && vm){
            // Voxel center 規約 = 整数座標 (floor + 0.5 で nearest center 選択)
            const mx = Math.floor(vm.x + 0.5), my = Math.floor(vm.y + 0.5), mz = Math.floor(vm.z + 0.5);
            if (mx>=0 && mx<overlay.nx && my>=0 && my<overlay.ny && mz>=0 && mz<overlay.nz){
              const lid = overlay.mask[overlay.ny*overlay.nx*mz + overlay.nx*my + mx];
              if (lid > 0){
                const c = overlay.labelClut[lid % overlay.labelClut.length];
                const a = overlay.alpha;
                myImageData.data[ad]   = myImageData.data[ad]   * (1-a) + c[0]*a;
                myImageData.data[ad+1] = myImageData.data[ad+1] * (1-a) + c[1]*a;
                myImageData.data[ad+2] = myImageData.data[ad+2] * (1-a) + c[2]*a;
              }
            }
            vm.add(overlay.v10);
          }

          ad += 4;
          v_0.add(v10_0);
          v_1.add(v10_1);
        }
      }

  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
  perfStore.record('fusion-mpr', 'cpu', performance.now() - t0);
}

// let mipDataSet: Float32Array[] = new Float32Array[];

const drawNiftiMip = async function(pix: Float32Array | Int16Array,
    nx:number, ny:number, nz:number, wc:number, ww:number,
    p00:THREE.Vector3, v01:THREE.Vector3,v10:THREE.Vector3,
    angle:number, thresh:number, depth:number, clut: number[][], isSurface: boolean,
    overlay?: MaskOverlay,
    fast: boolean = false) {

      const time0 = performance.now();

      if (cv1.value === null || ctx === null) return;
      const canvasx = cv1.value.width;
      const canvasy = cv1.value.height;

      // ====== WebGPU fast path ======
      // overlay 有無いずれも GPU で対応 (Phase 1.5)。失敗時は CPU 経路へフォールスルー。
      // ただし rendererMode='gpu' (force GPU) なら CPU には落とさず空描画で return (parity テスト用)。
      const kind = isSurface ? 'smip' : 'mip';
      if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
          const gpuOff = await gpuRenderMip({
            voxel: pix, nx, ny, nz,
            outW: canvasx, outH: canvasy,
            p00: { x: p00.x, y: p00.y, z: p00.z },
            v01: { x: v01.x, y: v01.y, z: v01.z },
            v10: { x: v10.x, y: v10.y, z: v10.z },
            angle, wc, ww,
            isSurface,
            surfThresh: thresh, surfDepth: depth,
            clut,
            overlay: overlay ? {
              mask: overlay.mask,
              version: overlay.version ?? 0,
              labelClut: overlay.labelClut,
              alpha: overlay.alpha,
            } : undefined,
            targetCanvas: cv1.value,
          });
          if (gpuOff) {
            isEmpty.value = false;
            ctx.drawImage(gpuOff as any, 0, 0);
            const ms = performance.now() - time0;
            perfStore.record(kind, 'gpu', ms);
            return;
          }
        } catch (err) {
          console.warn('[gpu] MIP failed:', err);
          if (!perfStore.cpuFallbackAllowed) return;  // mode='gpu': do not fallback
        }
      }
      // mode='gpu' で WebGPU 不可 → 何も描かず return (parity test 用)
      if (!perfStore.cpuFallbackAllowed) {
        // mode='gpu' で GPU 不可: parity test が「無描画 → 前 CPU 描画と一致 → 偽 PASS」を起こすので
        // canvas を sentinel 色 (赤) で塗って明示的に fail を発生させる
        console.warn('[mip] CPU fallback blocked by rendererMode=gpu — filling sentinel');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false;
        return;
      }

      isEmpty.value = false;
      const myImageData = ctx.getImageData(0,0,canvasx,canvasy);
      let ad = 0;

      let mipData = new Float32Array(ny*nz);
      let mipMaskData: Uint16Array | null = null;
      if (overlay && overlay.mask){
        // overlay は PET 格子と同じ次元・affine の前提（MIP 元 PET と一致）
        mipMaskData = new Uint16Array(ny*nz);
      }

      const s = Math.sin((angle-90) *3.1415926535 / 180);
      const c = Math.cos((angle-90) *3.1415926535 / 180);

      // fast mode: precompute を (j,k) stride=2 で走らせ、未計算位置はあとで近傍コピー。
      // 144³ PET でだいたい 4x speedup。停止後 idle で full-res 再描画される運用前提。
      const stride = fast ? 2 : 1;

      const time1 = performance.now();


      if (!isSurface){
        for (let k = 0; k<nz; k += stride){
          for (let j = 0; j<ny; j += stride){
            let m = -Infinity;
            let lid = 0;
            const j0 = j - ny/2;
            for (let i=nx-1; i>=0; i--){
              const i0 = i - nx/2;
              const x = Math.floor(i0*c-j0*s)+nx/2;
              const y = Math.floor(i0*s+j0*c)+ny/2;
              if (x >= 0 && x < nx && y >= 0 && y < ny) {
                const idx = k*nx*ny + y*nx + x;
                const a = pix[idx];
                if (m < a){
                  m = a;
                }
                if (mipMaskData){
                  const v = overlay!.mask[idx];
                  if (v > lid) lid = v;
                }
              }
            }
            mipData[k*ny+j] = m;
            if (mipMaskData) mipMaskData[k*ny+j] = lid;
          }
        }
      }else{
        for (let k = 0; k<nz; k += stride){
          for (let j = 0; j<ny; j += stride){
            let m = -Infinity;
            let lid = 0;
            const j0 = j - ny/2;
            for (let i=nx-1; i>=0; i--){
              const i0 = i - nx/2;
              const x = Math.floor(i0*c-j0*s)+nx/2;
              const y = Math.floor(i0*s+j0*c)+ny/2;
              if (x >= 0 && x < nx && y >= 0 && y < ny) {
                const a = pix[k*nx*ny + y*nx + x];
                if (a<thresh) continue;

                for (let d = 0; d<depth; d++){
                  const id0 = (i-d) - nx/2;
                  const x1 = Math.floor(id0*c-j0*s)+nx/2;
                  const y1 = Math.floor(id0*s+j0*c)+ny/2;
                  const idx1 = k*nx*ny + y1*nx + x1;
                  const a = pix[idx1];
                  if (m < a){
                    m = a;
                  }
                  if (mipMaskData){
                    const v = overlay!.mask[idx1];
                    if (v > lid) lid = v;
                  }
                }
                i=0;
              }
            }
            mipData[k*ny+j] = m;
            if (mipMaskData) mipMaskData[k*ny+j] = lid;
          }
        }
      }

      // fast mode: スキップした (j,k) を最寄りの計算済みセル値でフィル
      if (stride > 1){
        for (let k = 0; k < nz; k++){
          const k0 = k - (k % stride);
          for (let j = 0; j < ny; j++){
            if ((k % stride) === 0 && (j % stride) === 0) continue;
            const j0 = j - (j % stride);
            mipData[k*ny+j] = mipData[k0*ny+j0];
            if (mipMaskData) mipMaskData[k*ny+j] = mipMaskData[k0*ny+j0];
          }
        }
      }

    // }

      const time2 = performance.now();

      for (let i = 0; i<canvasy; i++){
        let v = p00.clone().addScaledVector(v01,i);
        for (let j = 0; j<canvasx; j++){

          const v0 = v.clone().floor();
          if (v0.x>=0 && v0.x<nx && v0.y>=0 && v0.y<ny && v0.z>=0 && v0.z<nz){
            const raw = mipData[nx*v0.z+v0.x];
            let p = Math.floor((raw-(wc-ww/2)) * (255/ww));
            if (p<0) p=0;
            if (p>255) p=255;
            myImageData.data[ad] = clut[p][0];
            myImageData.data[ad+1] = clut[p][1];
            myImageData.data[ad+2] = clut[p][2];

            if (mipMaskData && overlay){
              // ny/nz と vy/vz は drawNiftiMip 呼び側で「画面の y= mip の z 軸」「画面 x= mip の x 軸」のとき有効
              // mipData は [k*ny + j] = [z*ny + y] 形式で格納されているため、
              // ここでは v0.z をスライス（mip 出力の z 軸）、v0.x を画面 x にマッピングして使う。
              // 画面の y が ny 軸対応のため index は mipData と同じ [v0.z, v0.x] 順。
              const lid = mipMaskData[nx*v0.z+v0.x];
              if (lid > 0){
                const cc = overlay.labelClut[lid % overlay.labelClut.length];
                const a = overlay.alpha;
                myImageData.data[ad]   = myImageData.data[ad]   * (1-a) + cc[0]*a;
                myImageData.data[ad+1] = myImageData.data[ad+1] * (1-a) + cc[1]*a;
                myImageData.data[ad+2] = myImageData.data[ad+2] * (1-a) + cc[2]*a;
              }
            }
          }else{
            myImageData.data[ad] = clut[0][0];
            myImageData.data[ad+1] = clut[0][1];
            myImageData.data[ad+2] = clut[0][2];
          }
          ad += 4;
          v.add(v10);
        }
      }

      const time3 = performance.now();

  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
  const time4 = performance.now();
  perfStore.record(kind, 'cpu', time4 - time0);
  // console.log(time1-time0, time2-time1, time3-time2, time4-time3);

  void isSurface;
}

// Fusion MIP: drawNiftiMip の 2-volume 版。 PET + CT の MIP を別々に取って α blend。
// CPU 実装: per canvas pixel で各 volume の slab を独立に決定し、独立に ray-cast (max)。
// 出力色 = baseW * gray(maxBase) + ovlW * color(maxOvl)。
// mask overlay は現状の Fusion 仕様 (drawNiftiSliceFusion でも overlay 渡してない) に倣い未対応。
const drawFusionMip = async function(
    pix0: Float32Array | Int16Array,
    nx0:number, ny0:number, nz0:number, wc0:number, ww0:number,
    p00_0:THREE.Vector3, v01_0:THREE.Vector3, v10_0:THREE.Vector3, clut0: number[][],
    pix1: Float32Array | Int16Array,
    nx1:number, ny1:number, nz1:number, wc1:number, ww1:number,
    p00_1:THREE.Vector3, v01_1:THREE.Vector3, v10_1:THREE.Vector3, clut1: number[][],
    angle: number, alpha: number = 0.5,
) {
    if (cv1.value === null || ctx === null) return;
    const canvasx = cv1.value.width;
    const canvasy = cv1.value.height;
    const t0 = performance.now();

    // ====== WebGPU fast path ======
    if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
            const gpuOff = await gpuRenderFusionMip({
                voxel0: pix0, nx0, ny0, nz0,
                p00_0: { x: p00_0.x, y: p00_0.y, z: p00_0.z },
                v01_0: { x: v01_0.x, y: v01_0.y, z: v01_0.z },
                v10_0: { x: v10_0.x, y: v10_0.y, z: v10_0.z },
                wc0, ww0, clut0,
                voxel1: pix1, nx1, ny1, nz1,
                p00_1: { x: p00_1.x, y: p00_1.y, z: p00_1.z },
                v01_1: { x: v01_1.x, y: v01_1.y, z: v01_1.z },
                v10_1: { x: v10_1.x, y: v10_1.y, z: v10_1.z },
                wc1, ww1, clut1,
                outW: canvasx, outH: canvasy,
                angle, overlayBlend: alpha,
                targetCanvas: cv1.value,
            });
            if (gpuOff) {
                isEmpty.value = false;
                ctx.drawImage(gpuOff as any, 0, 0);
                perfStore.record('mip-multi', 'gpu', performance.now() - t0);
                return;
            }
        } catch (err) {
            console.warn('[gpu] fusion-mip failed:', err);
            if (!perfStore.cpuFallbackAllowed) {
                ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, canvasx, canvasy);
                isEmpty.value = false; return;
            }
        }
    }
    if (!perfStore.cpuFallbackAllowed) {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false; return;
    }

    // CPU fallback
    isEmpty.value = false;
    const myImageData = ctx.getImageData(0, 0, canvasx, canvasy);
    const baseW = 1 - alpha;
    const ovlW = alpha;
    const s = Math.sin((angle - 90) * Math.PI / 180);
    const c = Math.cos((angle - 90) * Math.PI / 180);

    const lo0 = wc0 - ww0 / 2;
    const lo1 = wc1 - ww1 / 2;
    const sc0 = 255 / ww0;
    const sc1 = 255 / ww1;

    let ad = 0;
    for (let cy = 0; cy < canvasy; cy++) {
        const v0row = p00_0.clone().addScaledVector(v01_0, cy);
        const v1row = p00_1.clone().addScaledVector(v01_1, cy);
        for (let cx = 0; cx < canvasx; cx++) {
            const v0 = v0row.clone().floor();
            const v1 = v1row.clone().floor();

            // base (pix0)
            let baseR = clut0[0][0], baseG = clut0[0][1], baseB = clut0[0][2];
            if (v0.x >= 0 && v0.x < nx0 && v0.y >= 0 && v0.y < ny0 && v0.z >= 0 && v0.z < nz0) {
                let m = -Infinity;
                const j0 = v0.x - ny0 / 2;
                const k0 = v0.z;
                for (let ii = nx0 - 1; ii >= 0; ii--) {
                    const i0 = ii - nx0 / 2;
                    const x = Math.floor(i0 * c - j0 * s) + nx0 / 2;
                    const y = Math.floor(i0 * s + j0 * c) + ny0 / 2;
                    if (x >= 0 && x < nx0 && y >= 0 && y < ny0) {
                        const a = pix0[k0 * nx0 * ny0 + y * nx0 + x];
                        if (m < a) m = a;
                    }
                }
                if (m > -Infinity) {
                    let p = Math.floor((m - lo0) * sc0);
                    if (p < 0) p = 0; if (p > 255) p = 255;
                    baseR = clut0[p][0]; baseG = clut0[p][1]; baseB = clut0[p][2];
                }
            }
            // overlay (pix1)
            let ovlR = clut1[0][0], ovlG = clut1[0][1], ovlB = clut1[0][2];
            if (v1.x >= 0 && v1.x < nx1 && v1.y >= 0 && v1.y < ny1 && v1.z >= 0 && v1.z < nz1) {
                let m = -Infinity;
                const j1 = v1.x - ny1 / 2;
                const k1 = v1.z;
                for (let ii = nx1 - 1; ii >= 0; ii--) {
                    const i0 = ii - nx1 / 2;
                    const x = Math.floor(i0 * c - j1 * s) + nx1 / 2;
                    const y = Math.floor(i0 * s + j1 * c) + ny1 / 2;
                    if (x >= 0 && x < nx1 && y >= 0 && y < ny1) {
                        const a = pix1[k1 * nx1 * ny1 + y * nx1 + x];
                        if (m < a) m = a;
                    }
                }
                if (m > -Infinity) {
                    let p = Math.floor((m - lo1) * sc1);
                    if (p < 0) p = 0; if (p > 255) p = 255;
                    ovlR = clut1[p][0]; ovlG = clut1[p][1]; ovlB = clut1[p][2];
                }
            }
            myImageData.data[ad]     = baseR * baseW + ovlR * ovlW;
            myImageData.data[ad + 1] = baseG * baseW + ovlG * ovlW;
            myImageData.data[ad + 2] = baseB * baseW + ovlB * ovlW;
            myImageData.data[ad + 3] = 255;
            ad += 4;
            v0row.add(v10_0);
            v1row.add(v10_1);
        }
    }
    ctx.putImageData(myImageData, 0, 0);
    perfStore.record('mip-multi', 'cpu', performance.now() - t0);
};


// Volume Rendering (Phase 1): front-to-back ray casting + ramp opacity transfer function。
// drawNiftiMip と同じ pattern (precompute → canvas read) で、max ではなく compositing。
// fast=true で stride=2 (4x speedup)、idle で full-res 再描画する想定 (DicomView 側で制御)。
const drawNiftiVR = async function(pix: Float32Array | Int16Array,
    nx: number, ny: number, nz: number, wc: number, ww: number,
    p00: THREE.Vector3, v01: THREE.Vector3, v10: THREE.Vector3,
    vForward: THREE.Vector3,                                  // through-plane voxel-step
    maxSteps: number,                                         // ray sample 回数
    clut: number[][],
    opacityLut: Float32Array,                                 // 256-entry TF LUT (vrTf)
    fast: boolean = false,
    alphaScale: number = 0.06,
    shading?: { enabled: boolean; ambient: number; diffuse: number; specularInt: number; specularPower: number }) {

      if (cv1.value === null || ctx === null) return;
      const canvasx = cv1.value.width;
      const canvasy = cv1.value.height;

      // ====== WebGPU fast path ======
      // VR は overlay path がそもそも無い (CPU 版でも overlay 受けない) ので無条件 GPU 試行。
      const t0 = performance.now();
      if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
          const gpuOff = await gpuRenderVr({
            voxel: pix, nx, ny, nz,
            outW: canvasx, outH: canvasy,
            p00: { x: p00.x, y: p00.y, z: p00.z },
            v01: { x: v01.x, y: v01.y, z: v01.z },
            v10: { x: v10.x, y: v10.y, z: v10.z },
            vForward: { x: vForward.x, y: vForward.y, z: vForward.z },
            maxSteps,
            wc, ww, clut,
            opacityLut,
            targetCanvas: cv1.value,
            alphaScale,
            shading,
          });
          if (gpuOff) {
            isEmpty.value = false;
            ctx.drawImage(gpuOff as any, 0, 0);
            perfStore.record('vr', 'gpu', performance.now() - t0);
            return;
          }
        } catch (err) {
          console.warn('[gpu] VR failed:', err);
          if (!perfStore.cpuFallbackAllowed) return;
        }
      }
      if (!perfStore.cpuFallbackAllowed) {
        console.warn('[vr] CPU fallback blocked by rendererMode=gpu — filling sentinel');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false;
        return;
      }

      isEmpty.value = false;
      const myImageData = ctx.getImageData(0, 0, canvasx, canvasy);
      void fast;        // CPU 旧 stride/precompute は廃止 (vForward 方式に変更)

      const lo = wc - ww / 2;
      const range = ww;
      const ALPHA_SCALE = alphaScale;
      const nxny = nx * ny;
      const olut = opacityLut;          // hot loop で省略

      // 自由回転対応: 各 canvas pixel に対し、直接 vForward 方向に ray を歩く。
      // 旧 (k, j) precompute + 2D resample は z 軸固定が前提だったので廃止。
      let ad = 0;
      for (let cy = 0; cy < canvasy; cy++) {
        let px0 = p00.x + cy * v01.x;
        let py0 = p00.y + cy * v01.y;
        let pz0 = p00.z + cy * v01.z;
        for (let cx = 0; cx < canvasx; cx++) {
          let dr = 0, dg = 0, db = 0, da = 0;
          for (let s = 0; s < maxSteps; s++) {
            if (da > 0.99) break;
            const px = px0 + s * vForward.x;
            const py = py0 + s * vForward.y;
            const pz = pz0 + s * vForward.z;
            const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
            if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) continue;
            const v = pix[iz * nxny + iy * nx + ix];
            let p = (v - lo) / range;
            if (p < 0) continue;
            if (p > 1) p = 1;
            const cidx = Math.min(255, Math.floor(p * 255));
            // Opacity TF lookup × global alphaScale
            const alpha = olut[cidx] * ALPHA_SCALE;
            if (alpha < 0.002) continue;
            const c = clut[cidx];
            const transmit = 1 - da;
            dr += transmit * alpha * c[0];
            dg += transmit * alpha * c[1];
            db += transmit * alpha * c[2];
            da += transmit * alpha;
          }
          myImageData.data[ad]     = dr;
          myImageData.data[ad + 1] = dg;
          myImageData.data[ad + 2] = db;
          myImageData.data[ad + 3] = 255;
          ad += 4;
          px0 += v10.x; py0 += v10.y; pz0 += v10.z;
        }
      }

      ctx.putImageData(myImageData, 0, 0, 0, 0, canvasx, canvasy);
      perfStore.record('vr', 'cpu', performance.now() - t0);
}

// Fusion VR: drawFusionMip と同じ pattern で 2 volume を front-to-back composite。
// 各 volume を独立に composite してから baseW/ovlW で α blend。
const drawFusionVR = async function(
    pix0: Float32Array | Int16Array,
    nx0:number, ny0:number, nz0:number, wc0:number, ww0:number,
    p00_0:THREE.Vector3, v01_0:THREE.Vector3, v10_0:THREE.Vector3, clut0: number[][],
    pix1: Float32Array | Int16Array,
    nx1:number, ny1:number, nz1:number, wc1:number, ww1:number,
    p00_1:THREE.Vector3, v01_1:THREE.Vector3, v10_1:THREE.Vector3, clut1: number[][],
    angle: number, alpha: number = 0.5,
) {
    if (cv1.value === null || ctx === null) return;
    const canvasx = cv1.value.width;
    const canvasy = cv1.value.height;
    const t0 = performance.now();

    if (perfStore.gpuAllowed && isWebGpuAvailable()) {
        try {
            const gpuOff = await gpuRenderFusionVr({
                voxel0: pix0, nx0, ny0, nz0,
                p00_0: { x: p00_0.x, y: p00_0.y, z: p00_0.z },
                v01_0: { x: v01_0.x, y: v01_0.y, z: v01_0.z },
                v10_0: { x: v10_0.x, y: v10_0.y, z: v10_0.z },
                wc0, ww0, clut0,
                voxel1: pix1, nx1, ny1, nz1,
                p00_1: { x: p00_1.x, y: p00_1.y, z: p00_1.z },
                v01_1: { x: v01_1.x, y: v01_1.y, z: v01_1.z },
                v10_1: { x: v10_1.x, y: v10_1.y, z: v10_1.z },
                wc1, ww1, clut1,
                outW: canvasx, outH: canvasy,
                angle, overlayBlend: alpha,
                targetCanvas: cv1.value,
            });
            if (gpuOff) {
                isEmpty.value = false;
                ctx.drawImage(gpuOff as any, 0, 0);
                perfStore.record('vr-multi', 'gpu', performance.now() - t0);
                return;
            }
        } catch (err) {
            console.warn('[gpu] fusion-vr failed:', err);
            if (!perfStore.cpuFallbackAllowed) {
                ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, canvasx, canvasy);
                isEmpty.value = false; return;
            }
        }
    }
    if (!perfStore.cpuFallbackAllowed) {
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, canvasx, canvasy);
        isEmpty.value = false; return;
    }

    // CPU fallback
    isEmpty.value = false;
    const myImageData = ctx.getImageData(0, 0, canvasx, canvasy);
    const baseW = 1 - alpha;
    const ovlW = alpha;
    const s = Math.sin((angle - 90) * Math.PI / 180);
    const c = Math.cos((angle - 90) * Math.PI / 180);
    const lo0 = wc0 - ww0 / 2;
    const lo1 = wc1 - ww1 / 2;
    const ALPHA_SCALE = 0.06;

    let ad = 0;
    for (let cy = 0; cy < canvasy; cy++) {
        const v0row = p00_0.clone().addScaledVector(v01_0, cy);
        const v1row = p00_1.clone().addScaledVector(v01_1, cy);
        for (let cx = 0; cx < canvasx; cx++) {
            const v0 = v0row.clone().floor();
            const v1 = v1row.clone().floor();

            // ---- CT VR ----
            let ctR = 0, ctG = 0, ctB = 0, ctA = 0;
            if (v0.x >= 0 && v0.x < nx0 && v0.z >= 0 && v0.z < nz0) {
                const j0 = v0.x - ny0 / 2;
                const k0 = v0.z;
                for (let i = 0; i < nx0; i++) {
                    if (ctA > 0.99) break;
                    const i0 = i - nx0 / 2;
                    const x = Math.floor(i0 * c - j0 * s) + nx0 / 2;
                    const y = Math.floor(i0 * s + j0 * c) + ny0 / 2;
                    if (x < 0 || x >= nx0 || y < 0 || y >= ny0) continue;
                    const v = pix0[k0 * nx0 * ny0 + y * nx0 + x];
                    let p = (v - lo0) / ww0;
                    if (p < 0) continue;
                    if (p > 1) p = 1;
                    const aa = p * ALPHA_SCALE;
                    if (aa < 0.002) continue;
                    const cidx = Math.min(255, Math.floor(p * 255));
                    const cc = clut0[cidx];
                    const transmit = 1 - ctA;
                    ctR += transmit * aa * cc[0];
                    ctG += transmit * aa * cc[1];
                    ctB += transmit * aa * cc[2];
                    ctA += transmit * aa;
                }
            }
            // ---- PET VR ----
            let ptR = 0, ptG = 0, ptB = 0, ptA = 0;
            if (v1.x >= 0 && v1.x < nx1 && v1.z >= 0 && v1.z < nz1) {
                const j1 = v1.x - ny1 / 2;
                const k1 = v1.z;
                for (let i = 0; i < nx1; i++) {
                    if (ptA > 0.99) break;
                    const i0 = i - nx1 / 2;
                    const x = Math.floor(i0 * c - j1 * s) + nx1 / 2;
                    const y = Math.floor(i0 * s + j1 * c) + ny1 / 2;
                    if (x < 0 || x >= nx1 || y < 0 || y >= ny1) continue;
                    const v = pix1[k1 * nx1 * ny1 + y * nx1 + x];
                    let p = (v - lo1) / ww1;
                    if (p < 0) continue;
                    if (p > 1) p = 1;
                    const aa = p * ALPHA_SCALE;
                    if (aa < 0.002) continue;
                    const cidx = Math.min(255, Math.floor(p * 255));
                    const cc = clut1[cidx];
                    const transmit = 1 - ptA;
                    ptR += transmit * aa * cc[0];
                    ptG += transmit * aa * cc[1];
                    ptB += transmit * aa * cc[2];
                    ptA += transmit * aa;
                }
            }
            myImageData.data[ad]     = ctR * baseW + ptR * ovlW;
            myImageData.data[ad + 1] = ctG * baseW + ptG * ovlW;
            myImageData.data[ad + 2] = ctB * baseW + ptB * ovlW;
            myImageData.data[ad + 3] = 255;
            ad += 4;
            v0row.add(v10_0);
            v1row.add(v10_1);
        }
    }
    ctx.putImageData(myImageData, 0, 0);
    perfStore.record('vr-multi', 'cpu', performance.now() - t0);
};





// const drawImageCv1 = async function(pix: Float32Array | Int16Array, ny:number, nx:number, wc:number, ww:number, intercept:number, slope:number) {
//   if (cv1.value === null || ctx === null) return;
  
//   const myImageData = ctx.getImageData(0,0,nx,ny); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
//   let ad = 0;

//   for (let y = 0; y<ny; y++){
//     for (let x = 0; x<nx; x++){
//       const raw = pix[x+y*nx] * slope + intercept;
//       let p = (raw-(wc-ww/2)) * (255/ww);

//       if (p<0) p=0;
//       if (p>255) p=255;

//       myImageData.data[ad] = p; //red
//       myImageData.data[ad+1] = p; //green
//       myImageData.data[ad+2] = p; //blue
//       ad += 4;
//     }
//   }

//   const ibm = await window.createImageBitmap(myImageData, 0,0, nx, ny); // awaitにするのがポイントだった
 
//   if (nx==512 && ny==512){
//     ctx.putImageData(myImageData, 0,0,0,0,cv1.value.width, cv1.value.height);
//   }else{
//     const zoom = 512/nx;
//     ctx.scale(zoom, zoom);
//     ctx.drawImage(ibm, 0,0);
//     ctx.scale(1/zoom, 1/zoom); //これをしないと毎回どんどん拡大されていく。
//   }
// }

const drawImageCv2 = async function(pix: Float32Array, pix2:Float32Array,
 ny:number, nx:number, wc:number, ww:number, wc2:number, ww2:number,
  intercept:number, slope:number, shiftX:number, shiftY:number, zoom:number) {

    if (cv1.value === null || ctx === null) return;
    const canvasx = cv1.value.width;
    const canvasy = cv1.value.height;

    const myImageData = ctx.getImageData(0,0,canvasx,canvasy); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
    let ad = 0;

  for (let y = 0; y<canvasy; y++){
    for (let x = 0; x<canvasx; x++){
      const x1 = Math.floor((x-canvasx/2)/zoom +nx/2 + shiftX);
      const y1 = Math.floor((y-canvasy/2)/zoom +ny/2 + shiftY);

      if (x1<0 || x1>nx || y1<0 || y1>ny){
        myImageData.data[ad] = 0; //red
        myImageData.data[ad+1] = 0; //green
        myImageData.data[ad+2] = 0; //blue
        ad += 4;
        continue;
      }

      const ad_p = x1+y1*nx;
      const raw = pix[ad_p] * slope + intercept;
      let p = (raw-(wc-ww/2)) * (255/ww);
      const raw2 = pix2[ad_p] * slope + intercept;
      let q = (raw2-(wc2-ww2/2)) * (255/ww2);
      
      if (p<0) p=0;
      if (p>255) p=255;

      if (q>0){
        myImageData.data[ad] = 255; //red
        myImageData.data[ad+1] = p; //green
        myImageData.data[ad+2] = p; //blue

      }else{
        myImageData.data[ad] = p; //red
        myImageData.data[ad+1] = p; //green
        myImageData.data[ad+2] = p; //blue
      }
      ad += 4;
    }
  }

  const ibm = await window.createImageBitmap(myImageData, 0,0, nx, ny); // awaitにするのがポイントだった
 


  if (nx==512 && ny==512){
    ctx.putImageData(myImageData, 0,0,0,0,cv1.value.width, cv1.value.height);
  }else{
    const zoom = 512/nx;
    ctx.scale(zoom, zoom);
    ctx.drawImage(ibm, 0,0);
    ctx.scale(1/zoom, 1/zoom); //これをしないと毎回どんどん拡大されていく。
  }
}

const drawImageCvRgb = async function(pix:Uint8Array, ny:number, nx:number, shiftX:number, shiftY:number, zoom:number) {

  if (cv1.value === null || ctx === null) return;
  const canvasx = cv1.value.width;
  const canvasy = cv1.value.height;
  const myImageData = ctx.getImageData(0,0,canvasx,canvasy); // メモリーを新たに確保しないので、createImageDataよりも有利だと思う（想像）
  let ad = 0;

  for (let y = 0; y<canvasy; y++){
    for (let x = 0; x<canvasx; x++){
      const x1 = Math.floor((x-canvasx/2)/zoom +nx/2 + shiftX);
      const y1 = Math.floor((y-canvasy/2)/zoom +ny/2 + shiftY);
      if (x1<0 || x1>nx || y1<0 || y1>ny){
        myImageData.data[ad] = 0; //red
        myImageData.data[ad+1] = 0; //green
        myImageData.data[ad+2] = 0; //blue
        ad += 4;
        continue;
      }

      const ad_p = (x1+y1*nx)*3;
      myImageData.data[ad] = pix[ad_p]; //red
      myImageData.data[ad+1] = pix[ad_p+1]; //green
      myImageData.data[ad+2] = pix[ad_p+2]; //blue
      ad += 4;
    }
  }
  ctx.putImageData(myImageData, 0,0,0,0,canvasx, canvasy);
}


const clear = (text = "No image") => {

  if (cv1.value === null || ctx === null) return;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0,0,cv1.value.width, cv1.value.height);

  // テキストは canvas に焼き込まず、HTML overlay (mv-empty-state) で表示する
  isEmpty.value = true;
  emptyText.value = text;
}

const drawSphereOverlay = (cx: number, cy: number, radiusPx: number) => {
  if (cv1.value === null || ctx === null) return;
  if (radiusPx <= 0 || !isFinite(radiusPx)) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffd24a";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd24a";
  ctx.fill();
  ctx.restore();
};

// Voxel brush のカーソル円。物理的に円形なブラシ (mm) を画面へ投影するため rx/ry は
// px 単位で別々に受け取り (anisotropic 表示に対応) 楕円で描く。mode で色を変える。
const drawBrushCursorOverlay = (cx: number, cy: number, rx: number, ry: number, mode: 'add' | 'erase') => {
  if (cv1.value === null || ctx === null) return;
  if (!isFinite(rx) || !isFinite(ry) || rx <= 0 || ry <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = mode === 'add' ? "#7fff7f" : "#ff7f7f";
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.restore();
};

const drawPolygonOverlay = (vertices: Array<[number, number]>, mode: 'add' | 'erase', closed: boolean) => {
  if (cv1.value === null || ctx === null) return;
  if (vertices.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(vertices[0][0], vertices[0][1]);
  for (let i = 1; i < vertices.length; i++){
    ctx.lineTo(vertices[i][0], vertices[i][1]);
  }
  if (closed) ctx.closePath();
  ctx.strokeStyle = mode === 'add' ? "#7fff7f" : "#ff7f7f";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = mode === 'add' ? "rgba(127,255,127,0.9)" : "rgba(255,127,127,0.9)";
  for (const [x, y] of vertices){
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

// 矩形 ROI overlay。rects は各矩形の canvas 座標 [x0,y0,x1,y1]、
// draft は確定前のドラッグ中矩形 (破線で描く)。
const drawRectRoiOverlay = (
  rects: Array<{ x0: number; y0: number; x1: number; y1: number; label?: string }>,
  draft: { x0: number; y0: number; x1: number; y1: number } | null,
) => {
  if (cv1.value === null || ctx === null) return;
  ctx.save();
  // 確定済み矩形: 実線シアン
  ctx.strokeStyle = "#00d4aa";
  ctx.lineWidth = 1.5;
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.fillStyle = "#00d4aa";
  for (const r of rects) {
    const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
    const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
    if (r.label) ctx.fillText(r.label, x + 2, y - 3 < 10 ? y + 12 : y - 3);
  }
  // ドラッグ中矩形: 破線イエロー
  if (draft) {
    const x = Math.min(draft.x0, draft.x1), y = Math.min(draft.y0, draft.y1);
    const w = Math.abs(draft.x1 - draft.x0), h = Math.abs(draft.y1 - draft.y0);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#ffd54f";
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
};

defineExpose({init, show, show2, showRgb, showDirect,
   drawNiftiSlice, drawNiftiSliceFusion, drawNiftiMip, drawNiftiVR,
   drawFusionMip, drawFusionVR, clear,
   drawSphereOverlay, drawPolygonOverlay, drawRectRoiOverlay, drawBrushCursorOverlay,
   // canvas pixel を外部から読む用 (parity test 等)
   cv1});

</script>


<template>
    <div class="drop_area mv-box"
        @dragover.prevent
        :class="{enter: isEnter, 'is-selected': prop.selected, 'is-enter-style': prop.isEnter}">
        <!-- Titlebar 全体クリックで box を選択させたい (DicomView 側 @click="imageBoxClicked")。
             以前は @click.stop だったため titlebar クリックでは選択されなかった。
             modality-chip / actions / mod-chip のドラッグなどは個別に @click.stop を持つ。 -->
        <div class="mv-titlebar"
             @dblclick="emit('maximize')">
            <span class="mv-mod-chip"
                  :class="{ 'mv-mod-chip--draggable': isModalityChipDraggable() }"
                  :draggable="isModalityChipDraggable()"
                  :title="isModalityChipDraggable() ? 'Drag onto another box to fuse' : ''"
                  :style="{ background: modalityChipColor(prop.modalityLabel) }"
                  @dragstart="(e: DragEvent) => emit('modalityDragStart', e)"
                  @click.stop>
                {{ (prop.modalityLabel || '??').toUpperCase() }}
            </span>
            <span class="mv-desc" :title="prop.description ?? ''">
                {{ prop.description ?? '' }}
            </span>

            <span class="mv-titlebar-actions" @dblclick.stop>
                <!-- Volume / Fusion / MIP: 6 plane (axi/cor/sag/mip/smip/vr) + DICOM 2D 戻り -->
                <v-menu v-if="isVolumeKind()" location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-axis-arrow" size="small" />
                            <v-tooltip activator="parent" location="bottom">Plane / View</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-item v-for="p in planeItems" :key="p.id"
                                     :active="prop.currentPlane === p.id"
                                     @click="emit('setPlane', p.id)">
                            <v-list-item-title>{{ p.label }}</v-list-item-title>
                        </v-list-item>
                        <!-- DICOM-origin 系列のみ「2D に戻す」を許可。NIfTI のみは元 DICOM が無いので不可。
                             prop.canRevertToDicom が true のときだけ表示 -->
                        <template v-if="prop.canRevertToDicom">
                            <v-divider class="my-1" />
                            <v-list-item @click="emit('backToDicom')">
                                <template v-slot:prepend>
                                    <v-icon icon="mdi-image-outline" size="small" />
                                </template>
                                <v-list-item-title>DICOM slice (2D)</v-list-item-title>
                                <v-list-item-subtitle>Back to single-slice view</v-list-item-subtitle>
                            </v-list-item>
                        </template>
                    </v-list>
                </v-menu>

                <!-- DicomBox: Make MPR を VolumeBox と完全同一 (6 plane: axi/cor/sag/mip/smip/vr)。
                     クリックで mpr_(seriesIdx, boxId) → setPlaneOnBox(boxId, plane) を親が実行。 -->
                <v-menu v-else-if="prop.boxKind === 'dicom'" location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-axis-arrow" size="small" />
                            <v-tooltip activator="parent" location="bottom">Make MPR (this box)</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-item v-for="p in planeItems" :key="p.id"
                                     @click="emit('makeMpr', p.id)">
                            <v-list-item-title>{{ p.label }}</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>

                <!-- CLUT (single layer: Volume / MIP / VR) -->
                <v-menu v-if="isVolumeKind() && prop.boxKind !== 'fusion'" location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-palette" size="small" />
                            <v-tooltip activator="parent" location="bottom">Color (CLUT)</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-item v-for="c in clutItems" :key="c.id"
                                     :active="isClutActive(c.id)"
                                     @click="emit('setClut', c.id)">
                            <v-list-item-title>{{ c.label }}</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>

                <!-- CLUT for Fusion: base + overlay の 2 ボタン (どちらか不明問題の対応) -->
                <v-menu v-if="prop.boxKind === 'fusion'" location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn mv-tb-clut-base">
                            <v-icon icon="mdi-palette" size="small" />
                            <span class="mv-tb-clut-mod" :style="{ background: modalityChipColor(prop.baseModality) }">{{ prop.baseModality || '' }}</span>
                            <v-tooltip activator="parent" location="bottom">Color (CLUT) — base layer ({{ prop.baseModality || '' }})</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-subheader>Base ({{ prop.baseModality || '' }}) CLUT</v-list-subheader>
                        <v-list-item v-for="c in clutItems" :key="c.id"
                                     :active="isClutActive(c.id)"
                                     @click="emit('setClut', c.id)">
                            <v-list-item-title>{{ c.label }}</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>
                <v-menu v-if="prop.boxKind === 'fusion'" location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn mv-tb-clut-ovl">
                            <v-icon icon="mdi-palette" size="small" />
                            <span class="mv-tb-clut-mod" :style="{ background: modalityChipColor(prop.overlayModality) }">{{ prop.overlayModality || '' }}</span>
                            <v-tooltip activator="parent" location="bottom">Color (CLUT) — overlay ({{ prop.overlayModality || '' }})</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-subheader>Overlay ({{ prop.overlayModality || '' }}) CLUT</v-list-subheader>
                        <v-list-item v-for="c in clutItems" :key="c.id"
                                     :active="isOverlayClutActive(c.id)"
                                     @click="emit('setOverlayClut', c.id)">
                            <v-list-item-title>{{ c.label }}</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>

                <!-- 補間モード切替: slice/MPR の base / overlay を nearest / bilinear に。
                     MIP / VR 表示中は補間概念がないため非表示。
                     DicomSliceBox: 単一メニュー (Nearest / Bilinear)
                     VolumeBox:    単一メニュー
                     FusionBox:    2 階層 (Base → / Overlay → → Nearest / Bilinear) -->
                <v-menu
                    v-if="prop.boxKind === 'dicom'
                          || ((prop.boxKind === 'volume' || prop.boxKind === 'fusion')
                              && (prop.currentPlane === 'axi' || prop.currentPlane === 'cor' || prop.currentPlane === 'sag'))"
                    location="bottom end"
                >
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-blur" size="small" />
                            <v-tooltip activator="parent" location="bottom">Sampling (interpolation)</v-tooltip>
                        </v-btn>
                    </template>
                    <!-- DicomSliceBox / VolumeBox: 直接 nearest/bilinear -->
                    <v-list v-if="prop.boxKind === 'volume' || prop.boxKind === 'dicom'" density="compact">
                        <v-list-item :active="(prop.interpolation ?? 'bilinear') === 'bilinear'"
                                     @click="emit('setInterpolation', { layer: 'base', mode: 'bilinear' })">
                            <v-list-item-title>Bilinear (smooth)</v-list-item-title>
                        </v-list-item>
                        <v-list-item :active="prop.interpolation === 'nearest'"
                                     @click="emit('setInterpolation', { layer: 'base', mode: 'nearest' })">
                            <v-list-item-title>Nearest (crisp voxels)</v-list-item-title>
                        </v-list-item>
                    </v-list>
                    <!-- FusionBox: layer → mode の 2 段ネスト -->
                    <v-list v-else density="compact">
                        <v-menu open-on-hover location="end">
                            <template v-slot:activator="{ props: a }">
                                <v-list-item v-bind="a">
                                    <template v-slot:prepend>
                                        <span class="mv-tb-clut-mod" :style="{ background: modalityChipColor(prop.baseModality) }">{{ prop.baseModality || 'Base' }}</span>
                                    </template>
                                    <v-list-item-title>Base ({{ (prop.interpolation ?? 'bilinear') }})</v-list-item-title>
                                    <template v-slot:append>
                                        <v-icon icon="mdi-chevron-right" size="small" />
                                    </template>
                                </v-list-item>
                            </template>
                            <v-list density="compact">
                                <v-list-item :active="(prop.interpolation ?? 'bilinear') === 'bilinear'"
                                             @click="emit('setInterpolation', { layer: 'base', mode: 'bilinear' })">
                                    <v-list-item-title>Bilinear</v-list-item-title>
                                </v-list-item>
                                <v-list-item :active="prop.interpolation === 'nearest'"
                                             @click="emit('setInterpolation', { layer: 'base', mode: 'nearest' })">
                                    <v-list-item-title>Nearest</v-list-item-title>
                                </v-list-item>
                            </v-list>
                        </v-menu>
                        <v-menu open-on-hover location="end">
                            <template v-slot:activator="{ props: a }">
                                <v-list-item v-bind="a">
                                    <template v-slot:prepend>
                                        <span class="mv-tb-clut-mod" :style="{ background: modalityChipColor(prop.overlayModality) }">{{ prop.overlayModality || 'Ovl' }}</span>
                                    </template>
                                    <v-list-item-title>Overlay ({{ (prop.interpolation1 ?? 'bilinear') }})</v-list-item-title>
                                    <template v-slot:append>
                                        <v-icon icon="mdi-chevron-right" size="small" />
                                    </template>
                                </v-list-item>
                            </template>
                            <v-list density="compact">
                                <v-list-item :active="(prop.interpolation1 ?? 'bilinear') === 'bilinear'"
                                             @click="emit('setInterpolation', { layer: 'overlay', mode: 'bilinear' })">
                                    <v-list-item-title>Bilinear</v-list-item-title>
                                </v-list-item>
                                <v-list-item :active="prop.interpolation1 === 'nearest'"
                                             @click="emit('setInterpolation', { layer: 'overlay', mode: 'nearest' })">
                                    <v-list-item-title>Nearest</v-list-item-title>
                                </v-list-item>
                            </v-list>
                        </v-menu>
                    </v-list>
                </v-menu>

                <!-- VR demo 再生ボタン (VR plane のみ表示)。
                     再生中はアイコン変化、もう一度クリックで停止。 -->
                <v-btn v-if="prop.currentPlane === 'vr'"
                       icon variant="text" size="x-small"
                       :class="['mv-tb-btn', { 'is-on': prop.vrDemoRunning }]"
                       @click="emit('toggleVrDemo')">
                    <v-icon :icon="prop.vrDemoRunning ? 'mdi-stop-circle-outline' : 'mdi-movie-play-outline'" size="small" />
                    <v-tooltip activator="parent" location="bottom">
                        {{ prop.vrDemoRunning ? 'Stop demo' : 'Play VR demo (cinematic ~30s)' }}
                    </v-tooltip>
                </v-btn>

                <!-- sMIP / VR レンダリングパラメータ popover。MIP (非 surface) と VR で
                     表示項目が違う: sMIP=threshold+depth、VR=alphaScale。
                     通常 MIP は調整するパラメータがないので非表示。-->
                <v-menu v-if="prop.currentPlane === 'smip' || prop.currentPlane === 'vr'"
                        location="bottom end" :close-on-content-click="false">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-cog-outline" size="small" />
                            <v-tooltip activator="parent" location="bottom">
                                {{ prop.currentPlane === 'smip' ? 'Surface MIP parameters' : 'VR parameters' }}
                            </v-tooltip>
                        </v-btn>
                    </template>
                    <v-card min-width="260" max-width="320">
                        <v-card-text class="pa-3">
                            <!-- sMIP: slider + 数値入力併設 (細かい値を直接打てる) -->
                            <template v-if="prop.currentPlane === 'smip'">
                                <div class="mv-tb-popover-label">Threshold</div>
                                <div class="mv-tb-slider-row">
                                    <v-slider
                                        :model-value="prop.mipThreshold ?? 0.3"
                                        :min="0" :max="20" :step="0.1"
                                        density="compact" hide-details color="primary"
                                        class="mv-tb-slider-grow"
                                        @update:model-value="(v: number | number[]) => emit('setMipParam', { key: 'thresholdSurfaceMip', value: Array.isArray(v) ? v[0] : v })"
                                    />
                                    <input
                                        type="number"
                                        class="mv-tb-num-input"
                                        :value="Number((prop.mipThreshold ?? 0.3).toFixed(2))"
                                        step="0.1" min="0"
                                        @change="(e: Event) => emit('setMipParam', { key: 'thresholdSurfaceMip', value: Number((e.target as HTMLInputElement).value) })"
                                    />
                                </div>
                                <div class="mv-tb-popover-label mt-3">Depth (voxels)</div>
                                <div class="mv-tb-slider-row">
                                    <v-slider
                                        :model-value="prop.mipDepth ?? 3"
                                        :min="1" :max="40" :step="1"
                                        density="compact" hide-details color="primary"
                                        class="mv-tb-slider-grow"
                                        @update:model-value="(v: number | number[]) => emit('setMipParam', { key: 'depthSurfaceMip', value: Array.isArray(v) ? v[0] : v })"
                                    />
                                    <input
                                        type="number"
                                        class="mv-tb-num-input"
                                        :value="Math.round(prop.mipDepth ?? 3)"
                                        step="1" min="1"
                                        @change="(e: Event) => emit('setMipParam', { key: 'depthSurfaceMip', value: Math.round(Number((e.target as HTMLInputElement).value)) })"
                                    />
                                </div>
                            </template>
                            <!-- VR: opacity TF preset + alpha scale slider/数値 (Phase A) -->
                            <template v-else>
                                <div class="mv-tb-popover-label">
                                    Opacity preset
                                    <span v-if="prop.vrTfPresetId === 'custom'" class="mv-tb-tf-custom-tag">custom</span>
                                </div>
                                <select
                                    class="mv-tb-tf-select mb-2"
                                    :value="prop.vrTfPresetId ?? 'ramp'"
                                    @change="(e: Event) => emit('setVrTfPreset', (e.target as HTMLSelectElement).value)"
                                >
                                    <option v-for="p in (prop.vrTfPresets ?? [])" :key="p.id" :value="p.id"
                                            :title="p.description">
                                        {{ p.label }}
                                    </option>
                                    <option v-if="prop.vrTfPresetId === 'custom'" value="custom">Custom</option>
                                </select>

                                <!-- D15: visual TF editor (control points) -->
                                <VrTfEditor
                                    :points="prop.vrTfPoints ?? [{ v: 0, a: 0 }, { v: 1, a: 1 }]"
                                    :width="280"
                                    :height="84"
                                    @update:points="(pts) => emit('setVrTfPoints', pts)"
                                />

                                <div class="mv-tb-popover-label mt-2">Alpha scale (overall × TF)</div>
                                <div class="mv-tb-slider-row">
                                    <v-slider
                                        :model-value="prop.mipAlphaScale ?? 0.06"
                                        :min="0.005" :max="0.5" :step="0.005"
                                        density="compact" hide-details color="primary"
                                        class="mv-tb-slider-grow"
                                        @update:model-value="(v: number | number[]) => emit('setMipParam', { key: 'alphaScale', value: Array.isArray(v) ? v[0] : v })"
                                    />
                                    <input
                                        type="number"
                                        class="mv-tb-num-input"
                                        :value="Number((prop.mipAlphaScale ?? 0.06).toFixed(3))"
                                        step="0.005" min="0.005" max="1"
                                        @change="(e: Event) => emit('setMipParam', { key: 'alphaScale', value: Number((e.target as HTMLInputElement).value) })"
                                    />
                                </div>
                                <div class="text-caption text-disabled mt-2 mb-3">
                                    Preset shapes the value→opacity curve. Alpha scale = overall multiplier.
                                </div>

                                <!-- Phase B: Phong shading (heavy, GPU only). On = surface highlights + depth cues. -->
                                <v-divider class="my-2" />
                                <label class="mv-tb-shading-toggle">
                                    <input type="checkbox"
                                           :checked="!!prop.vrShadingEnabled"
                                           @change="(e: Event) => emit('setVrShading', { key: 'enabled', value: (e.target as HTMLInputElement).checked })"
                                    />
                                    <span>Shading (Phong)</span>
                                    <span class="text-caption text-disabled ml-1">— heavier, GPU only</span>
                                </label>
                                <div v-if="prop.vrShadingEnabled" class="mt-2">
                                    <div class="mv-tb-popover-label">Ambient ({{ (prop.vrShadingAmbient ?? 0.3).toFixed(2) }})</div>
                                    <v-slider :model-value="prop.vrShadingAmbient ?? 0.3" :min="0" :max="1" :step="0.05"
                                              density="compact" hide-details color="primary"
                                              @update:model-value="(v: number | number[]) => emit('setVrShading', { key: 'ambient', value: Array.isArray(v) ? v[0] : v })" />
                                    <div class="mv-tb-popover-label mt-1">Diffuse ({{ (prop.vrShadingDiffuse ?? 0.7).toFixed(2) }})</div>
                                    <v-slider :model-value="prop.vrShadingDiffuse ?? 0.7" :min="0" :max="1" :step="0.05"
                                              density="compact" hide-details color="primary"
                                              @update:model-value="(v: number | number[]) => emit('setVrShading', { key: 'diffuse', value: Array.isArray(v) ? v[0] : v })" />
                                    <div class="mv-tb-popover-label mt-1">Specular ({{ (prop.vrShadingSpecInt ?? 0.4).toFixed(2) }})</div>
                                    <v-slider :model-value="prop.vrShadingSpecInt ?? 0.4" :min="0" :max="1" :step="0.05"
                                              density="compact" hide-details color="primary"
                                              @update:model-value="(v: number | number[]) => emit('setVrShading', { key: 'specularInt', value: Array.isArray(v) ? v[0] : v })" />
                                    <div class="mv-tb-popover-label mt-1">Spec power ({{ Math.round(prop.vrShadingSpecPower ?? 16) }})</div>
                                    <v-slider :model-value="prop.vrShadingSpecPower ?? 16" :min="1" :max="128" :step="1"
                                              density="compact" hide-details color="primary"
                                              @update:model-value="(v: number | number[]) => emit('setVrShading', { key: 'specularPower', value: Array.isArray(v) ? v[0] : v })" />
                                </div>
                            </template>
                        </v-card-text>
                    </v-card>
                </v-menu>

                <!-- Fusion W/L active layer toggle (Fusion box のみ): Window/Level drag が
                     どっち side に効くか明示。CLUT 同様の disambiguation。 -->
                <v-btn
                    v-if="prop.boxKind === 'fusion'"
                    icon variant="text" size="x-small"
                    class="mv-tb-btn mv-tb-wl-layer"
                    @click="emit('setActiveWindowLayer', (prop.activeWindowLayer === 'base') ? 'overlay' : 'base')"
                >
                    <v-icon icon="mdi-contrast-circle" size="small" />
                    <span class="mv-tb-clut-mod" :style="{ background: modalityChipColor((prop.activeWindowLayer === 'base') ? prop.baseModality : prop.overlayModality) }">
                        {{ ((prop.activeWindowLayer === 'base') ? prop.baseModality : prop.overlayModality) || '' }}
                    </span>
                    <v-tooltip activator="parent" location="bottom">
                        W/L drag affects: {{ (prop.activeWindowLayer === 'base') ? prop.baseModality : prop.overlayModality }} (click to switch)
                    </v-tooltip>
                </v-btn>

                <!-- Fusion blend slider (Fusion box のみ表示) -->
                <div v-if="prop.boxKind === 'fusion'" class="mv-tb-blend">
                    <v-icon icon="mdi-circle-multiple-outline" size="x-small" class="mv-tb-blend-icon" />
                    <v-slider
                        :model-value="prop.overlayAlpha ?? 0.5"
                        :min="0" :max="1" :step="0.05"
                        density="compact"
                        hide-details
                        color="primary"
                        track-color="surface-light"
                        class="mv-tb-blend-slider"
                        @update:model-value="(v: number | number[]) => emit('setOverlayAlpha', Array.isArray(v) ? v[0] : v)"
                    />
                    <v-tooltip activator="parent" location="bottom">
                        Overlay {{ Math.round((prop.overlayAlpha ?? 0.5) * 100) }}% / Base {{ 100 - Math.round((prop.overlayAlpha ?? 0.5) * 100) }}%
                    </v-tooltip>
                </div>

                <v-btn icon variant="text" size="x-small" class="mv-tb-btn"
                       @click="emit('resetView')">
                    <v-icon icon="mdi-restart" size="small" />
                    <v-tooltip activator="parent" location="bottom">Reset W/L &amp; view</v-tooltip>
                </v-btn>

                <v-btn v-if="prop.globalSyncOn"
                       icon variant="text" size="x-small"
                       :class="['mv-tb-btn', { 'is-on': prop.syncEnabled, 'is-off': !prop.syncEnabled }]"
                       @click="emit('toggleSync')">
                    <v-icon :icon="prop.syncEnabled ? 'mdi-link-variant' : 'mdi-link-variant-off'" size="small" />
                    <v-tooltip activator="parent" location="bottom">
                        {{ prop.syncEnabled ? 'Sync ON for this box (click to detach)' : 'Sync OFF for this box (click to attach)' }}
                    </v-tooltip>
                </v-btn>

                <v-btn icon variant="text" size="x-small" class="mv-tb-btn"
                       @click="emit('maximize')">
                    <v-icon icon="mdi-arrow-expand" size="small" />
                    <v-tooltip activator="parent" location="bottom">Maximize / Restore</v-tooltip>
                </v-btn>

                <v-menu location="bottom end">
                    <template v-slot:activator="{ props: act }">
                        <v-btn v-bind="act" icon variant="text" size="x-small" class="mv-tb-btn">
                            <v-icon icon="mdi-dots-horizontal" size="small" />
                            <v-tooltip activator="parent" location="bottom">More</v-tooltip>
                        </v-btn>
                    </template>
                    <v-list density="compact">
                        <v-list-item @click="emit('duplicateBox')">
                            <v-list-item-title>Duplicate this box</v-list-item-title>
                            <v-list-item-subtitle>Create another box with the same view</v-list-item-subtitle>
                        </v-list-item>
                        <v-divider />
                        <v-list-item @click="onSavePngLocal">
                            <v-list-item-title>Save PNG</v-list-item-title>
                            <v-list-item-subtitle>Screenshot of this view</v-list-item-subtitle>
                        </v-list-item>
                        <v-list-item @click="emit('saveVolumeNifti')">
                            <v-list-item-title>Save volume as NIfTI</v-list-item-title>
                            <v-list-item-subtitle>PT=SUV / CT=HU + JSON sidecar</v-list-item-subtitle>
                        </v-list-item>
                        <v-list-item @click="emit('toggleOverlay')">
                            <v-list-item-title>Toggle mask overlay</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>

                <v-btn icon variant="text" size="x-small" class="mv-tb-btn mv-tb-close"
                       @click="emit('closeBox')">
                    <v-icon icon="mdi-close" size="small" />
                    <v-tooltip activator="parent" location="bottom">Close this box</v-tooltip>
                </v-btn>
            </span>
        </div>

        <div class="mv-canvas-wrap">
            <canvas ref="cv1" :width="prop.width" :height="prop.height" class="mv-canvas">
            </canvas>
            <div v-if="isEmpty" class="mv-empty-state">
                <v-icon icon="mdi-image-off-outline" size="48" />
                <span>{{ emptyText }}</span>
            </div>
            <!-- Crosshair overlay (segStore.crosshairWorld を screen に project した位置) -->
            <svg
                v-if="prop.crosshairX != null && prop.crosshairY != null"
                class="mv-crosshair"
                :viewBox="`0 0 ${prop.width} ${prop.height}`"
                :width="prop.width"
                :height="prop.height"
                preserveAspectRatio="none"
            >
                <line :x1="prop.crosshairX" y1="0" :x2="prop.crosshairX" :y2="prop.height"
                      stroke="#00D4AA" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.85" />
                <line x1="0" :y1="prop.crosshairY" :x2="prop.width" :y2="prop.crosshairY"
                      stroke="#00D4AA" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.85" />
                <circle :cx="prop.crosshairX" :cy="prop.crosshairY" r="3"
                        stroke="#00D4AA" stroke-width="1" fill="rgba(0,0,0,0.4)" />
            </svg>

            <!-- Cross-reference lines (他 box の slice plane を投影した線) -->
            <svg
                v-if="prop.crossRefLines && prop.crossRefLines.length"
                class="mv-cross-ref"
                :viewBox="`0 0 ${prop.width} ${prop.height}`"
                :width="prop.width"
                :height="prop.height"
                preserveAspectRatio="none"
            >
                <line v-for="(ln, idx) in prop.crossRefLines" :key="'cr'+idx"
                      :x1="ln.x1" :y1="ln.y1" :x2="ln.x2" :y2="ln.y2"
                      stroke="#FFD24A" stroke-width="0.7" stroke-dasharray="6 4" opacity="0.7" />
            </svg>

            <!-- Color scale legend (Volume / Fusion / MIP のみ) -->
            <div v-if="prop.legend" class="mv-clut-legend">
                <span class="mv-clut-min">{{ prop.legend.minLabel }}</span>
                <div class="mv-clut-bar" :style="{ background: prop.legend.gradient }"></div>
                <span class="mv-clut-max">{{ prop.legend.maxLabel }}</span>
            </div>
            <div v-if="prop.legend2" class="mv-clut-legend mv-clut-legend--second">
                <span class="mv-clut-min">{{ prop.legend2.minLabel }}</span>
                <div class="mv-clut-bar" :style="{ background: prop.legend2.gradient }"></div>
                <span class="mv-clut-max">{{ prop.legend2.maxLabel }}</span>
            </div>

            <!-- 4 隅オーバーレイ (patient / exam info) -->
            <div v-if="prop.cornerInfo" class="mv-corner-overlay">
                <div v-if="prop.cornerInfo.tl && prop.cornerInfo.tl.length"
                     class="mv-corner mv-corner-tl">
                    <div v-for="(s, k) in prop.cornerInfo.tl" :key="'tl'+k">{{ s }}</div>
                </div>
                <div v-if="prop.cornerInfo.tr && prop.cornerInfo.tr.length"
                     class="mv-corner mv-corner-tr">
                    <div v-for="(s, k) in prop.cornerInfo.tr" :key="'tr'+k">{{ s }}</div>
                </div>
                <div v-if="prop.cornerInfo.bl && prop.cornerInfo.bl.length"
                     class="mv-corner mv-corner-bl">
                    <div v-for="(s, k) in prop.cornerInfo.bl" :key="'bl'+k">{{ s }}</div>
                </div>
                <div v-if="prop.cornerInfo.br && prop.cornerInfo.br.length"
                     class="mv-corner mv-corner-br"
                     :class="{ 'mv-corner-br--lifted': prop.legend }">
                    <div v-for="(s, k) in prop.cornerInfo.br" :key="'br'+k">{{ s }}</div>
                </div>
            </div>
        </div>
    </div>

</template>

<style scoped>

/* OHIF v3 風: subtle border, accent ring on select, no chunky frame. */
.mv-box {
  display: flex;
  flex-direction: column;
  background: var(--mv-bg, #0F1419);
}

.mv-titlebar {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 5px;
  background: var(--mv-surface-2, #222B36);
  border-bottom: 1px solid var(--mv-border, #2A3441);
  font-size: 10px;
  color: var(--mv-text, #E8EEF2);
  gap: 6px;
  user-select: none;
  flex-shrink: 0;
  transition: border-color 0.15s, background 0.15s;
}
.mv-box.is-selected .mv-titlebar {
  background: linear-gradient(180deg, rgba(0,212,170,0.06) 0%, var(--mv-surface-2, #222B36) 100%);
  border-bottom-color: var(--mv-accent, #00D4AA);
}

/* Modality chip: pill shape, slight inner highlight for depth */
.mv-mod-chip {
  color: #0F1419;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 10px;
  letter-spacing: 0.06em;
  flex-shrink: 0;
  line-height: 1.4;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.18),
    0 1px 1px rgba(0,0,0,0.18);
}
/* Volume / Fusion box では fusion 起点としてドラッグ可能 */
.mv-mod-chip--draggable {
  cursor: grab;
}
.mv-mod-chip--draggable:active {
  cursor: grabbing;
}

.mv-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mv-text-dim, #8FA0B0);
  font-size: 11px;
  font-weight: 500;
}

.mv-titlebar-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.mv-tb-btn {
  width: 20px !important;
  height: 20px !important;
  min-width: 20px !important;
  color: var(--mv-text-muted, #5A6877);
  transition: color 0.12s;
}
.mv-tb-btn:hover {
  color: var(--mv-accent, #00D4AA);
}
.mv-tb-btn.is-on {
  color: var(--mv-accent, #00D4AA);
}
.mv-tb-btn.is-off {
  color: var(--mv-text-muted, #5A6877);
}
.mv-tb-close:hover {
  color: var(--mv-error, #FF5C7A);
}
.mv-tb-popover-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
}
.mv-tb-popover-label {
  color: var(--mv-text-muted);
  font-weight: 500;
}
.mv-tb-popover-value {
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  color: var(--mv-text);
}
.mv-tb-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mv-tb-slider-grow {
  flex: 1 1 auto;
}
.mv-tb-num-input {
  flex: 0 0 64px;
  width: 64px;
  padding: 2px 4px;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  background: var(--mv-surface, #1A2129);
  color: var(--mv-text);
  border: 1px solid var(--mv-border);
  border-radius: 3px;
  text-align: right;
}
.mv-tb-num-input:focus {
  outline: none;
  border-color: var(--mv-accent);
}
.mv-tb-tf-select {
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
  background: var(--mv-surface);
  color: var(--mv-text);
  border: 1px solid var(--mv-border);
  border-radius: 3px;
}
.mv-tb-tf-select:focus { outline: none; border-color: var(--mv-accent); }
.mv-tb-tf-custom-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: rgba(255, 210, 74, 0.15);
  color: #FFD24A;
  border-radius: 8px;
}
.mv-tb-shading-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mv-text);
  cursor: pointer;
}
.mv-tb-shading-toggle input[type="checkbox"] {
  accent-color: var(--mv-accent);
}

/* Fusion blend slider in titlebar */
.mv-tb-blend {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  height: 22px;
  min-width: 0;
}
.mv-tb-blend-icon {
  color: var(--mv-text-muted, #5A6877);
  flex: 0 0 auto;
}
.mv-tb-blend-slider {
  width: 80px !important;
  min-width: 60px;
  flex: 0 0 auto;
}
.mv-tb-blend-slider :deep(.v-slider__container) {
  min-height: 0;
}
.mv-tb-blend-slider :deep(.v-slider-thumb__surface) {
  width: 10px !important;
  height: 10px !important;
}
.mv-tb-blend-slider :deep(.v-slider-track) {
  height: 2px !important;
}

/* Fusion CLUT ボタンに添える modality badge (base/overlay 識別) */
.mv-tb-clut-base, .mv-tb-clut-ovl {
  width: auto !important;
  min-width: 32px !important;
  padding: 0 4px !important;
  gap: 2px;
}
.mv-tb-clut-mod {
  font-size: 8px;
  font-weight: 700;
  color: #0F1419;
  padding: 0 3px;
  border-radius: 2px;
  letter-spacing: 0.04em;
  line-height: 1.3;
}

/* Canvas + empty state overlay container */
.mv-canvas-wrap {
  position: relative;
  display: flex;
  background: #000;
  flex: 1 1 auto;
}
.mv-canvas {
  display: block;
}

/* Crosshair (絶対位置で canvas 上に重ねる、events スルー) */
.mv-crosshair {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
}

/* Cross-reference lines: 他 box の slice plane を黄色の破線で投影 */
.mv-cross-ref {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
}

/* Color scale legend (CLUT bar + min/max labels) */
.mv-clut-legend {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.55);
  padding: 3px 6px;
  border-radius: 3px;
  pointer-events: none;
  user-select: none;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 10px;
  color: #fff;
  letter-spacing: 0.02em;
}
.mv-clut-legend--second {
  bottom: 30px;  /* 1 段目 (CT) の上に積む */
}
.mv-clut-bar {
  width: 100px;
  height: 8px;
  border-radius: 1px;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.mv-clut-min, .mv-clut-max {
  font-feature-settings: 'tnum';
  white-space: nowrap;
  min-width: 32px;
  text-align: center;
}

/* 4 隅 patient/exam info overlay (canvas 上に半透明) */
.mv-corner-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  font-size: 10px;
  line-height: 1.35;
  color: rgba(232, 238, 242, 0.92);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.85), 0 0 1px rgba(0, 0, 0, 0.85);
  letter-spacing: 0.01em;
}
.mv-corner {
  position: absolute;
  padding: 4px 6px;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mv-corner-tl { top: 0; left: 0; text-align: left; }
.mv-corner-tr { top: 0; right: 0; text-align: right; }
.mv-corner-bl { bottom: 0; left: 0; text-align: left; }
.mv-corner-br { bottom: 0; right: 0; text-align: right; }
/* legend が表示されているときは BR を上にずらして衝突回避 */
.mv-corner-br--lifted { bottom: 32px; }

/* Empty state: centered icon + dim caption */
.mv-empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--mv-text-muted, #5A6877);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
  pointer-events: none;
  user-select: none;
}
.mv-empty-state :deep(.v-icon) {
  opacity: 0.35;
}

</style>
