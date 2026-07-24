import { type Ref } from 'vue';
import { TF_PRESETS } from '../components/vrTf';
import { type SerializedViewState, type SerializedBoxState } from '../components/viewStateUrl';
import { useSegmentationStore, type RectROI } from '../stores/segmentation';

// DicomView の「View state URL / Snapshot file (session save/load)」機能を切り出した composable。
// 挙動は元コードと完全に同一 (純粋なコード移動)。voxel データは含めず、view 状態と
// (有効なら) PET segmentation 状態・矩形 ROI を 1 ファイルにまとめる。
// rectRoiToJson / importRectRoisFromJson は rect ROI export とも共有されるため DicomView に残し、
// ここには getter/関数として渡される。

type BoxPlane = 'axi' | 'cor' | 'sag' | 'mip' | 'smip' | 'vr';

// 矩形 ROI 1 件の JSON 表現 (snapshot / ROI export 共通)。voxel 座標。
export interface RectRoiJson {
  id: number;
  label: string | null;
  seriesIndex: number;
  seriesUID: string | null;
  topLeft: { x: number; y: number; z: number };
  bottomRight: { x: number; y: number; z: number };
}

interface MetavolSnapshotFile {
  schema: 'metavol-snapshot';
  v: 1;
  ts: number;
  view: SerializedViewState;
  segmentation: {
    seriesUID: string;
    seriesDescription?: string;
    dims: [number, number, number];
    threshold: number;
    thresholdUnit: 'SUV' | 'CNTS';
    labels: Array<{ id: number; name: string; color: [number, number, number] }>;
    currentLabelId: number;
    sphere: { centerWorld: [number, number, number]; radiusMm: number } | null;
    finalMask_b64?: string;
    thresholdMask_b64?: string;
    manualEdits_b64?: string;
  } | null;
  // 矩形 ROI は PET volume 非依存 (DX 1 枚画像でも置ける) ため top-level に持つ。
  rectRois?: RectRoiJson[];
}

export interface SnapshotIoCtx {
  tileN: Ref<number | undefined>;
  imageBoxInfos: Ref<any[]>;
  syncImageBox: Ref<boolean | undefined>;
  isDicomSliceImageBoxInfo: (i: number) => boolean;
  isFusedImageBoxInfo: (i: number) => boolean;
  isAnyVolumeBox: (i: number) => boolean;
  getBoxCurrentPlane: (i: number) => BoxPlane | null;
  setPlaneOnBox: (i: number, plane: BoxPlane) => void;
  show: () => void;
  rectRoiToJson: (r: RectROI) => RectRoiJson;
  importRectRoisFromJson: (arr: unknown) => number;
}

export function useSnapshotIo(ctx: SnapshotIoCtx) {
  const segStore = useSegmentationStore();

  // ===== View state URL (B9: ?state=...) =====
  // 現在の layout を SerializedViewState に圧縮 → URL 用 base64 を返す。
  // 「Copy share URL」ボタン経由で呼ばれる想定。
  const serializeCurrentViewState = (): SerializedViewState => {
    const bs: SerializedBoxState[] = [];
    for (let i = 0; i < (ctx.tileN.value ?? 0); i++) {
      const info = ctx.imageBoxInfos.value[i] as any;
      if (!info) continue;
      const isDicom = ctx.isDicomSliceImageBoxInfo(i);
      const isFusion = ctx.isFusedImageBoxInfo(i);
      const isMip = !isDicom && info.isMip;
      const k = isDicom ? 'd' : isFusion ? 'f' : isMip ? 'm' : 'v';
      const b: SerializedBoxState = {
        k,
        s: info.currentSeriesNumber ?? 0,
        wc: info.myWC ?? undefined,
        ww: info.myWW ?? undefined,
        c: info.clut,
      };
      if (!isDicom) b.p = ctx.getBoxCurrentPlane(i) ?? undefined;
      if (info.interpolation) b.in = info.interpolation === 'nearest' ? 'n' : 'b';
      if (isFusion) {
        b.s1 = info.currentSeriesNumber1;
        b.wc1 = info.myWC1 ?? undefined;
        b.ww1 = info.myWW1 ?? undefined;
        b.c1 = info.clut1;
        b.oa = info.overlayAlpha;
        if (info.interpolation1) b.in1 = info.interpolation1 === 'nearest' ? 'n' : 'b';
      }
      if (info.mip) {
        if (info.mip.mipAngle) b.mipAngle = info.mip.mipAngle;
        if (info.mip.thresholdSurfaceMip != null) b.surfThresh = info.mip.thresholdSurfaceMip;
        if (info.mip.depthSurfaceMip != null) b.surfDepth = info.mip.depthSurfaceMip;
        if (info.mip.alphaScale != null) b.alphaScale = info.mip.alphaScale;
        if (info.mip.vrOpacityPresetId) b.vrPreset = info.mip.vrOpacityPresetId;
      }
      bs.push(b);
    }
    return { v: 1, t: ctx.tileN.value ?? 0, sync: !!ctx.syncImageBox.value, bs };
  };

  // ===== Snapshot file (B-replacement-of-share-URL) =====
  const ab2b64 = (buf: ArrayBuffer | undefined): string | undefined => {
    if (!buf) return undefined;
    const u8 = new Uint8Array(buf);
    // chunked btoa to avoid stack overflow on large buffers
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)) as number[]);
    }
    return btoa(s);
  };
  const b642ab = (s: string | undefined): ArrayBuffer | undefined => {
    if (!s) return undefined;
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  };

  const buildSnapshotJson = (): string => {
    const view = serializeCurrentViewState();
    const segPayload = segStore.serializeForPersistence();
    let segmentation: MetavolSnapshotFile['segmentation'] = null;
    if (segPayload) {
      segmentation = {
        seriesUID: segPayload.seriesUID,
        seriesDescription: segPayload.seriesDescription,
        dims: segPayload.dims,
        threshold: segPayload.threshold,
        thresholdUnit: segPayload.thresholdUnit,
        labels: segPayload.labels.map(l => ({ id: l.id, name: l.name, color: [l.color[0], l.color[1], l.color[2]] as [number, number, number] })),
        currentLabelId: segPayload.currentLabelId,
        sphere: segPayload.sphere,
        finalMask_b64: ab2b64(segPayload.finalMask),
        thresholdMask_b64: ab2b64(segPayload.thresholdMask),
        manualEdits_b64: ab2b64(segPayload.manualEdits),
      };
    }
    const file: MetavolSnapshotFile = {
      schema: 'metavol-snapshot',
      v: 1,
      ts: Date.now(),
      view,
      segmentation,
      // 矩形 ROI は PET 非依存なので segmentation とは別に保存
      rectRois: segStore.rectRois.map(ctx.rectRoiToJson),
    };
    return JSON.stringify(file);
  };

  // 結果: { ok, info: '...applied summary...' } / { ok: false, reason }
  const applySnapshotJson = (jsonText: string): { ok: true; info: string } | { ok: false; reason: string } => {
    let parsed: any;
    try { parsed = JSON.parse(jsonText); } catch (e) {
      return { ok: false, reason: 'Invalid JSON: ' + ((e as Error)?.message ?? e) };
    }
    if (!parsed || parsed.schema !== 'metavol-snapshot') {
      return { ok: false, reason: 'Not a metavol-snapshot file.' };
    }
    if (parsed.v !== 1) {
      return { ok: false, reason: `Unsupported snapshot version: ${parsed.v}` };
    }
    const view = parsed.view as SerializedViewState | undefined;
    if (!view || !Array.isArray(view.bs)) {
      return { ok: false, reason: 'Snapshot has no view state.' };
    }
    // 注意: voxel data は含まれていないので、対応する image が seriesList に
    // 既にロードされている前提。currentSeriesNumber が範囲外のときは applyViewState
    // 内で defensive にスキップされる (info.currentSeriesNumber を直接代入するだけ)。
    applyViewState(view);

    let segMsg = '';
    if (parsed.segmentation) {
      const s = parsed.segmentation;
      const r = segStore.restoreFromPersistence({
        thresholdMask: b642ab(s.thresholdMask_b64),
        manualEdits: b642ab(s.manualEdits_b64),
        finalMask: b642ab(s.finalMask_b64),
        dims: s.dims,
        threshold: s.threshold,
        thresholdUnit: s.thresholdUnit,
        labels: s.labels,
        currentLabelId: s.currentLabelId,
        sphere: s.sphere,
        savedAt: parsed.ts,
      });
      if (r.ok) segMsg = ' + segmentation';
      else segMsg = ` (segmentation skipped: ${r.reason})`;
    }

    // 矩形 ROI の復元 (top-level、segmentation 非依存)
    let rectMsg = '';
    if (Array.isArray(parsed.rectRois)) {
      segStore.clearRectRois();
      const nr = ctx.importRectRoisFromJson(parsed.rectRois);
      if (nr > 0) rectMsg = ` + ${nr} rect ROI(s)`;
    }

    ctx.show();
    return { ok: true, info: `${view.t} box(es) restored${segMsg}${rectMsg}` };
  };

  // File として download / 受け取り。
  const downloadSnapshotFile = () => {
    const json = buildSnapshotJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.href = url;
    a.download = `metavol-snapshot_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const loadSnapshotFile = async (file: File): Promise<{ ok: true; info: string } | { ok: false; reason: string }> => {
    try {
      const text = await file.text();
      return applySnapshotJson(text);
    } catch (e) {
      return { ok: false, reason: 'Read failed: ' + ((e as Error)?.message ?? e) };
    }
  };

  const applyViewState = (state: SerializedViewState) => {
    if (!state || state.bs.length === 0) return;
    // tileN を合わせる
    const newTileN = Math.min(state.t, state.bs.length);
    for (let i = 0; i < newTileN; i++) {
      const sb = state.bs[i];
      const info = ctx.imageBoxInfos.value[i] as any;
      if (!info) continue;
      if (sb.s != null) info.currentSeriesNumber = sb.s;
      if (sb.wc != null) info.myWC = sb.wc;
      if (sb.ww != null) info.myWW = sb.ww;
      if (sb.c != null) info.clut = sb.c;
      if (sb.in) info.interpolation = sb.in === 'n' ? 'nearest' : 'bilinear';
      // Fusion 化が必要な場合 (clut1 を持つ box への変換) は MVP では未対応 — 保存元と同 layout 前提
      if (sb.s1 != null) info.currentSeriesNumber1 = sb.s1;
      if (sb.wc1 != null) info.myWC1 = sb.wc1;
      if (sb.ww1 != null) info.myWW1 = sb.ww1;
      if (sb.c1 != null) info.clut1 = sb.c1;
      if (sb.oa != null) info.overlayAlpha = sb.oa;
      if (sb.in1) info.interpolation1 = sb.in1 === 'n' ? 'nearest' : 'bilinear';
      // plane 切替
      if (sb.p && ctx.isAnyVolumeBox(i)) {
        ctx.setPlaneOnBox(i, sb.p as any);
      }
      // MIP/VR params
      if (info.mip) {
        if (sb.mipAngle != null) info.mip.mipAngle = sb.mipAngle;
        if (sb.surfThresh != null) info.mip.thresholdSurfaceMip = sb.surfThresh;
        if (sb.surfDepth != null) info.mip.depthSurfaceMip = sb.surfDepth;
        if (sb.alphaScale != null) info.mip.alphaScale = sb.alphaScale;
        if (sb.vrPreset) {
          info.mip.vrOpacityPresetId = sb.vrPreset;
          const preset = TF_PRESETS.find(pp => pp.id === sb.vrPreset);
          if (preset) info.mip.vrOpacityTF = preset.tf.map(p => ({ ...p }));
        }
      }
    }
    if (state.sync != null) ctx.syncImageBox.value = state.sync;
    ctx.show();
    console.log(`[state] applied view state: ${newTileN} boxes`);
  };

  return {
    serializeCurrentViewState,
    buildSnapshotJson,
    applySnapshotJson,
    downloadSnapshotFile,
    loadSnapshotFile,
    applyViewState,
  };
}
