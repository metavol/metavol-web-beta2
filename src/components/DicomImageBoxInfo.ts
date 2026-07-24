// 2024/5/4
// modified 2024/5/19
//
// homework 6/9: which is better, type vs. interface?
//
//

import * as THREE from '@/lib/threeMath';
import * as Volume from './Volume';

// MIP / VR box の mip 既定値。同一リテラルが各所 (レイアウト setup / plane 切替 / VR demo)
// に散在していたため集約。isSurface のみ呼び出し側で切り替える (smip 用)。
// 毎回新しいオブジェクトを返す (box ごとに mutable なので共有オブジェクト不可)。
export const makeMipState = (isSurface = false) => ({
    mipAngle: 0,
    isSurface,
    thresholdSurfaceMip: 0.3,
    depthSurfaceMip: 3,
});

export type ImageBoxInfoBase = {
    currentSeriesNumber: number,
    myWC: number | null,
    myWW: number | null,
    description: string,
}

export type Interpolation = 'nearest' | 'bilinear';

// Raw 1-frame DICOM viewer box (no MPR, no Volume reconstruction).
// Counterpart of VolumeImageBoxInfo (3D 再構成スライス) / FusedVolumeImageBoxInfo (CT+PET 重畳)。
export type DicomSliceImageBoxInfo = ImageBoxInfoBase &  {
    currentSliceNumber: number,
    imageNumberOfDicomTag: number | null,
    centerX:number,
    centerY:number
    zoom: number | null,
    // Sampling 補間モード。default 'bilinear' (滑らか)。'nearest' で voxel 境界くっきり。
    interpolation?: Interpolation,
}

export type VolumeImageBoxInfo = ImageBoxInfoBase & {
    centerInWorld:THREE.Vector3,
    vecx: THREE.Vector3,
    vecy: THREE.Vector3,
    vecz: THREE.Vector3,
    clut: number,
    isMip: boolean,
    mip: {
        mipAngle: number,
        isSurface: boolean,
        thresholdSurfaceMip: number,
        depthSurfaceMip: number,
        // VR opacity ramp の倍率 (default 0.06)。alphaScale ↑ で不透明、↓ で透けやすい。
        // VR にも MIP にも mip オブジェクトを共用してるのでここに置く。
        alphaScale?: number,
        // VR opacity transfer function (control points 配列)。null/undefined の場合は ramp。
        // 詳細は src/components/vrTf.ts。
        vrOpacityTF?: { v: number; a: number }[],
        vrOpacityPresetId?: string,
        // VR Phong shading (Phase B)。enabled=false で旧 ramp 描画と一致。
        vrShading?: {
            enabled: boolean,
            ambient: number,        // 0..1
            diffuse: number,        // 0..1
            specularInt: number,    // 0..1
            specularPower: number,  // 1..128
        },
    } | null,
    // Volume Rendering (front-to-back composite)。MIP/sMIP と排他: isVr=true のとき isMip=false
    isVr?: boolean,
    // Sampling 補間モード (slice/MPR 用)。default 'bilinear'。MIP/VR には影響しない。
    interpolation?: Interpolation,
    // タイルグリッドで縦に何行ぶん占有するか (default 1)。2 にすると CSS grid-row span 2 +
    // canvas を 2 行ぶんの高さにして「1 列まるごと」の背高 box を作れる (PET MIP 用)。
    rowSpan?: number,
}

export type FusedVolumeImageBoxInfo = VolumeImageBoxInfo & {
    currentSeriesNumber1: number,
    clut1: number,
    myWC1: number | null,
    myWW1: number | null,
    // overlay 側のブレンド比 (0..1)。省略時は 0.5 (50/50)。titlebar slider で更新。
    overlayAlpha?: number,
    // 左ボタンドラッグ Window/Level 操作の対象レイヤ。'base' or 'overlay'。
    // 既定は 'overlay' (PT を調整したいケースが多いため)。titlebar の small toggle で切替。
    activeWindowLayer?: 'base' | 'overlay',
    // base (CT) / overlay (PT) それぞれの補間モード。VolumeImageBoxInfo.interpolation
    // は base と同義に揃える。
    interpolation1?: Interpolation,
}

export const defaultInfo = (i: number) => {
    return {
        currentSeriesNumber: i,
        currentSliceNumber:0,
        imageNumberOfDicomTag: null,
        description: "",
        myWC:null,
        myWW:null,
        centerX:0,
        centerY:0,
        zoom:null,
        clut:0,
    };
    // centerの意味は、画面上のcanvasの中心（canvasが800x800なら(400,400)）が、DICOMファイル上に対応する画素の座標（一般的には256,256）からのオフセットである。
}

export const pushVolume = (seriesList: any, volume: any) => {

    seriesList.push({
        volume,
        myDicom: null,
    });

    const n = seriesList.length-1;
    const d = seriesList[n].volume!;

    const p0 = Volume.voxelToWorld(new THREE.Vector3(0,0,0),volume);
    const p1 = Volume.voxelToWorld(new THREE.Vector3(volume.nx, volume.ny, volume.nz),volume);
    p0.add(p1).divideScalar(2); // 中点

    const c = {
        clut: 0,
        myWC: 3,
        myWW: 6,
        description: "phantom",
        currentSeriesNumber: n,
        centerInWorld: p0,
        vecx: d.vectorX.clone().multiplyScalar(1),
        vecy: d.vectorY.clone().multiplyScalar(1),
        vecz: d.vectorZ.clone().multiplyScalar(1),
        isMip: false,
        mip: null,
    };

    return c;
}

