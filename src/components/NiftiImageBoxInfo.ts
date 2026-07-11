// 2024/5/4
import * as THREE from 'three';

export interface ImageBoxInfo {
    currentNiftiNumber: number,
    seriesDescription: string,
    myWC: number,
    myWW: number,
    centerInWorld:THREE.Vector3,
    vecx: THREE.Vector3,
    vecy: THREE.Vector3,
    vecz: THREE.Vector3,
    isMip: boolean,
    mipAngle: number,
    clut: number,
    thresholdSurfaceMip: number,
    depthSurfaceMip: number
}

export const defaultInfo = () => {
    return {
        currentNiftiNumber: 0,
        seriesDescription: "",
        myWC:100,
        myWW:200,
        centerInWorld: new THREE.Vector3(0,0,0),
        vecx: new THREE.Vector3(-1, 0, 0),
        vecy: new THREE.Vector3(0, -1, 0),
        vecz: new THREE.Vector3(0, 0, -1),
        isMip: false,
        mipAngle: 0,
        clut: 0,
        thresholdSurfaceMip: 0.3,
        depthSurfaceMip: 3,
        };
    // centerの意味は、画面上のcanvasの中心（canvasが800x800なら(400,400)）が、DICOMファイル上に対応する画素の座標（一般的には256,256）からのオフセットである。
}
