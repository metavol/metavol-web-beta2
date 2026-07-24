import { ref, type Ref } from 'vue';
import * as THREE from '@/lib/threeMath';
import { readDicomPixels } from '../components/dicomPixels';
import { useSegmentationStore } from '../stores/segmentation';

// DicomView の Voxel inspector (デバッグ機能) を切り出した composable。
// DicomView.vue が肥大化していたため、hover 情報収集・マスク層読み取り・shift+click 編集を分離。
// 挙動は元コードと完全に同一 (純粋なコード移動)。DicomView 側の局所型に依存しないよう、
// series / box は構造的型 (any 寄り) で受け取る。

// worldToVoxel_ / screenToWorldAny の戻り値として使う最小 shape
type Vec3Like = { x: number; y: number; z: number };

export interface DebugInspectorCtx {
  /** App-bar から toggle される voxel inspector の ON/OFF (defineModel ref) */
  debugMode: Ref<boolean>;
  imageBoxInfos: Ref<any[]>;
  imageBoxW: Ref<number | undefined>;
  imageBoxH: Ref<number | undefined>;
  // seriesList は DicomView 側で reassign される let なので、必ず getter 経由で最新を読む
  getSeriesList: () => Array<{ myDicom: any[] | null; volume: any | null }>;
  isDicomSliceImageBoxInfo: (i: number) => boolean;
  isAnyVolumeBox: (i: number) => boolean;
  getCanvasXY: (e: MouseEvent) => [number, number];
  screenToWorldAny: (boxId: number, cx: number, cy: number) => THREE.Vector3 | null;
  worldToVoxel_: (p: THREE.Vector3, volId: number) => Vec3Like;
  findPetSeriesIndex: () => number;
  show: () => void;
}

export function useDebugInspector(ctx: DebugInspectorCtx) {
  const segStore = useSegmentationStore();

  const debugHoverRows = ref<Array<{
    seriesIndex: number; modality: string; description: string;
    i: number; j: number; k: number;
    value: number | null; inBounds: boolean;
  }>>([]);
  // マスク各層 (PET 格子) の値。voxel inspector で「この画素がどのセグメントか / どの層で
  // その値が決まっているか」を可視化して assign 波及などの不具合診断に使う。
  const debugMaskInfo = ref<{
    i: number; j: number; k: number; inBounds: boolean;
    threshold: number | null;              // thresholdMask (閾値由来ラベル)
    manualRaw: number | null;              // manualEdits 生値 (0xFFFF = erase sentinel)
    manualLabel: string;                   // 人間可読の manualEdits
    final: number | null;                  // finalMask (実表示ラベル)
    finalLabel: string;
    component: number | null;              // componentMap の成分 ID (無効なら null)
    componentValid: boolean;
    componentCount: number;
  } | null>(null);
  const debugScreenX = ref(0);
  const debugScreenY = ref(0);
  const debugShow = ref(false);
  // World 座標を inspector に表示するための payload (mm 単位)。
  const debugWorld = ref<{ x: number; y: number; z: number } | null>(null);

  const readDicomSlicePixelAt = (boxId: number, cx: number, cy: number): { value: number | null; col: number; row: number } | null => {
    if (!ctx.isDicomSliceImageBoxInfo(boxId)) return null;
    const info = ctx.imageBoxInfos.value[boxId] as any;
    const seriesList = ctx.getSeriesList();
    const series = seriesList[info.currentSeriesNumber];
    const ds = series?.myDicom?.[info.currentSliceNumber];
    if (!ds) return null;
    const cols = ds.int16('x00280011') ?? 0;
    const rows = ds.int16('x00280010') ?? 0;
    if (!cols || !rows) return null;
    const canvasW = ctx.imageBoxW.value!;
    const canvasH = ctx.imageBoxH.value!;
    const zoom = info.zoom ?? 1;
    // ImageBox.drawImageCvZoom と同じ canvas → 画像 pixel 変換
    const fx = (cx - canvasW / 2) / zoom + cols / 2 + info.centerX;
    const fy = (cy - canvasH / 2) / zoom + rows / 2 + info.centerY;
    const col = Math.floor(fx + 0.5), row = Math.floor(fy + 0.5);
    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      return { value: null, col, row };
    }
    if ((ds.string('x00280004') ?? '').toUpperCase() === 'RGB') {
      return { value: null, col, row };  // RGB は scalar 値ではないので未対応
    }
    const pde = ds.elements?.x7fe00010;
    if (!pde) return { value: null, col, row };
    // pixel data 取得 (BitsAllocated に従って 8/16-bit を読み分け)
    let raw: number;
    try {
      const info = readDicomPixels(ds);
      raw = info.pixels[row * cols + col];
    } catch {
      return { value: null, col, row };
    }
    const intercept = Number(ds.string('x00281052') ?? '0');
    const slope = Number(ds.string('x00281053') ?? '1');
    return { value: raw * slope + intercept, col, row };
  };

  const updateDebugHover = (boxId: number, e: MouseEvent) => {
    if (!ctx.debugMode.value) return;
    // DICOM slice / Volume / Fusion のいずれにも対応する。
    if (!ctx.isAnyVolumeBox(boxId) && !ctx.isDicomSliceImageBoxInfo(boxId)) {
      debugShow.value = false;
      return;
    }
    const [cx, cy] = ctx.getCanvasXY(e);
    const w = ctx.screenToWorldAny(boxId, cx, cy);
    if (!w) { debugShow.value = false; return; }
    debugWorld.value = { x: w.x, y: w.y, z: w.z };
    const rows: typeof debugHoverRows.value = [];
    const seriesList = ctx.getSeriesList();

    // DICOM slice box: その box が表示している現スライスの直接 pixel 値を 1 行追加
    // (volume 未生成の DICOM-only シリーズでも値が見えるように)
    if (ctx.isDicomSliceImageBoxInfo(boxId)) {
      const info = ctx.imageBoxInfos.value[boxId] as any;
      const sIdx = info.currentSeriesNumber;
      const series = seriesList[sIdx];
      const ds = series?.myDicom?.[info.currentSliceNumber];
      // 同じ series の volume 行と重複させないため、その series が **volume を持たない** ときだけ
      // DICOM 直読み行を出す。volume がある場合は volume 行が後段で出る。
      if (ds && !series.volume) {
        const px = readDicomSlicePixelAt(boxId, cx, cy);
        const mod = (ds.string('x00080060') ?? '').toUpperCase();
        const desc = ds.string('x0008103e') ?? `S${sIdx}`;
        rows.push({
          seriesIndex: sIdx,
          modality: mod,
          description: `${desc} (slice ${info.currentSliceNumber + 1})`,
          i: px?.col ?? 0,
          j: px?.row ?? 0,
          k: info.currentSliceNumber,
          value: px?.value ?? null,
          inBounds: !!px && px.value !== null,
        });
      }
    }

    for (let s = 0; s < seriesList.length; s++){
      const v = seriesList[s].volume;
      if (!v) continue;
      const vox = ctx.worldToVoxel_(w, s);
      // Voxel 中心 = 整数座標規約に合わせ floor(x+0.5) で nearest center を取る。
      // (sampleNearest と一致させ、画面で見えるピクセルと inspector の値変化境界を揃える)
      const i = Math.floor(vox.x + 0.5), j = Math.floor(vox.y + 0.5), k = Math.floor(vox.z + 0.5);
      const inBounds = i >= 0 && i < v.nx && j >= 0 && j < v.ny && k >= 0 && k < v.nz;
      const value = inBounds ? v.voxel[k * v.nx * v.ny + j * v.nx + i] : null;
      rows.push({
        seriesIndex: s,
        modality: v.metadata?.modality ?? '-',
        description: v.metadata?.seriesDescription ?? `S${s}`,
        i, j, k, value, inBounds,
      });
    }
    debugHoverRows.value = rows;

    // ===== マスク各層 (PET 格子) の値 =====
    // mask は PET 格子上に保持されるので、world → PET voxel に変換して層ごとに読む。
    // overlay サンプリングと同じ nearest-center (floor(x+0.5)) で index を決める。
    const petIdx = ctx.findPetSeriesIndex();
    const pet = segStore.petVolumeRef;
    if (petIdx >= 0 && pet) {
      const vox = ctx.worldToVoxel_(w, petIdx);
      const mi = Math.floor(vox.x + 0.5), mj = Math.floor(vox.y + 0.5), mk = Math.floor(vox.z + 0.5);
      const inB = mi >= 0 && mi < pet.nx && mj >= 0 && mj < pet.ny && mk >= 0 && mk < pet.nz;
      if (inB) {
        const idx = mk * pet.nx * pet.ny + mj * pet.nx + mi;
        const th = segStore.thresholdMask ? segStore.thresholdMask[idx] : null;
        const meRaw = segStore.manualEdits ? segStore.manualEdits[idx] : null;
        const fin = segStore.finalMask ? segStore.finalMask[idx] : null;
        const comp = (segStore.componentMapValid && segStore.componentMap) ? segStore.componentMap[idx] : null;
        const labelName = (v: number | null): string => {
          if (v == null || v === 0) return '-';
          return segStore.labelById(v)?.name ?? `#${v}`;
        };
        debugMaskInfo.value = {
          i: mi, j: mj, k: mk, inBounds: true,
          threshold: th,
          manualRaw: meRaw,
          manualLabel: meRaw == null ? '-'
            : meRaw === 0xFFFF ? 'erase'
            : meRaw === 0 ? '-'
            : labelName(meRaw),
          final: fin,
          finalLabel: labelName(fin),
          component: comp,
          componentValid: segStore.componentMapValid,
          componentCount: segStore.componentCount,
        };
      } else {
        debugMaskInfo.value = {
          i: mi, j: mj, k: mk, inBounds: false,
          threshold: null, manualRaw: null, manualLabel: '-',
          final: null, finalLabel: '-', component: null,
          componentValid: segStore.componentMapValid, componentCount: segStore.componentCount,
        };
      }
    } else {
      debugMaskInfo.value = null;
    }

    debugScreenX.value = e.clientX;
    debugScreenY.value = e.clientY;
    debugShow.value = true;
  };

  const handleDebugEditClick = (boxId: number, e: MouseEvent) => {
    if (!ctx.debugMode.value) return false;
    if (!e.shiftKey) return false;
    if (!ctx.isAnyVolumeBox(boxId) && !ctx.isDicomSliceImageBoxInfo(boxId)) return false;
    const [cx, cy] = ctx.getCanvasXY(e);
    const w = ctx.screenToWorldAny(boxId, cx, cy);
    if (!w) return false;
    const seriesList = ctx.getSeriesList();

    // 編集対象シリーズを選択（Volume が複数なら一覧から選ばせる）
    const candidates: Array<{ idx: number; v: any; descr: string }> = [];
    for (let s = 0; s < seriesList.length; s++){
      const v = seriesList[s].volume;
      if (!v) continue;
      const vox = ctx.worldToVoxel_(w, s);
      const i = Math.floor(vox.x + 0.5), j = Math.floor(vox.y + 0.5), k = Math.floor(vox.z + 0.5);
      if (i < 0 || i >= v.nx || j < 0 || j >= v.ny || k < 0 || k >= v.nz) continue;
      candidates.push({
        idx: s,
        v,
        descr: `[${s}] ${v.metadata?.modality ?? '-'} ${v.metadata?.seriesDescription ?? ''} → cur=${v.voxel[k*v.nx*v.ny + j*v.nx + i].toFixed(4)} @(${i},${j},${k})`,
      });
    }
    if (candidates.length === 0){
      console.log('[debug edit] no in-bounds volume at this position');
      return true;
    }

    let chosenIdx = candidates[0].idx;
    if (candidates.length > 1){
      const list = candidates.map((c, n) => `${n}: ${c.descr}`).join('\n');
      const resp = prompt(`Edit which series?\n${list}\n\nEnter index (0..${candidates.length-1}):`, '0');
      if (resp == null) return true;
      const n = Number(resp);
      if (!Number.isFinite(n) || n < 0 || n >= candidates.length) return true;
      chosenIdx = candidates[n].idx;
    }

    const target = seriesList[chosenIdx].volume!;
    const vox = ctx.worldToVoxel_(w, chosenIdx);
    const i = Math.floor(vox.x + 0.5), j = Math.floor(vox.y + 0.5), k = Math.floor(vox.z + 0.5);
    const idx = k * target.nx * target.ny + j * target.nx + i;
    const cur = target.voxel[idx];
    const resp = prompt(`Edit voxel value\n  series ${chosenIdx} (${target.metadata?.modality ?? '-'}) at (${i},${j},${k})\n  current: ${cur}\n\nNew value:`, String(cur));
    if (resp == null) return true;
    const newVal = Number(resp);
    if (!Number.isFinite(newVal)){
      console.warn('[debug edit] invalid value:', resp);
      return true;
    }
    target.voxel[idx] = newVal;
    console.log(`[debug edit] series ${chosenIdx} (${i},${j},${k}): ${cur} → ${newVal}`);
    ctx.show();
    return true;
  };

  return {
    debugHoverRows,
    debugMaskInfo,
    debugScreenX,
    debugScreenY,
    debugShow,
    debugWorld,
    readDicomSlicePixelAt,
    updateDebugHover,
    handleDebugEditClick,
  };
}
