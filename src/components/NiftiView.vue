<script setup lang="ts">

import { ref, watch} from 'vue';
import * as nifti from 'nifti-reader-js';
import axios from 'axios';
import sidebar from './Sidebar.vue';
import imagebox from './ImageBox.vue';
import {solve} from './linalg.ts';
import {rainbow} from './Clut.ts';
import * as THREE from 'three';
import { getAllFilesRecursive } from './DragAndDropUtil.ts';
import { ImageBoxInfo, defaultInfo } from './NiftiImageBoxInfo.ts';

const props = defineProps(["receivedNiftiData"]);
const emit = defineEmits<{NiftiDataSent: [buf: ArrayBuffer]}>();


const mousePos = ref(new THREE.Vector2());

const imageBoxWH = ref([500,700]);
const imb = ref<InstanceType<typeof imagebox>[]>();
const tileXY = ref([2,1]);
const selectedImageBoxId = ref(0);
const syncImageBox = ref(false);
const showImageBoxInfo = ref(false);
const isRotating = ref(false);
const isSurfaceMIP = ref(false);


const changeSlice = (i: number, size: number) => {
  const a = imageBoxInfos.value[i];
  if (a.isMip){
    a.mipAngle += 15*size;
  }else{
    a.centerInWorld.addScaledVector(a.vecz, size); // 他言語だったらクラスメソッドだが・・・
  }
}

const setMyWCWW = (i:number, wc:number, ww: number) => {
  imageBoxInfos.value[i].myWC= wc;
  imageBoxInfos.value[i].myWW= ww;
}

const getMyWCWW = (i:number) => {
  return [imageBoxInfos.value[i].myWC, imageBoxInfos.value[i].myWW];
}

const presetSelected = (e: string) => {
  const id = selectedImageBoxId.value;
  if (e === "Lung") setMyWCWW(id,-700,1500);
  if (e === "Bone") setMyWCWW(id,200,2000);
  if (e === "Brain") setMyWCWW(id,40,80);
  if (e === "Reset") setMyWCWW(id,100,200);
  show();
};

let leftButtonFunction = "None"

interface nii {
  header: nifti.NIFTI1,
  pixelData: Float32Array
}

let niis: nii[];


const imageBoxInfos = ref<ImageBoxInfo[]>([]);

const initializeNiftiListsImagesBoxInfos = () => {
  niis = [];

  const d0 = defaultInfo();

  const d1 = defaultInfo();

  d1.vecx= new THREE.Vector3(-1, 0, 0);
  d1.vecy= new THREE.Vector3(0, 0, -1);
  d1.vecz= new THREE.Vector3(0, 1, 0);
  d1.isMip= true;
  d1.mipAngle= 0;

  imageBoxInfos.value = [d0,d1];
};
initializeNiftiListsImagesBoxInfos();


const isEnter = ref(false);
const leftButtonFunctionChanged = (e: any) => { leftButtonFunction = e; }

setInterval(()=>{
  if (isRotating.value){
    for (let i = 0; i<imageBoxInfos.value.length; i++){
      const a = imageBoxInfos.value[i];
      if (a.isMip){
        a.mipAngle += 5;
        showImage(i);
      }
    }
  }
}, 50);

const dragEnter = () => { isEnter.value = true; }
const dragLeave = () => { isEnter.value = false; }
const dropFile = async (e: DragEvent) => {
  const files = await getAllFilesRecursive(e);
  // loadFiles(files);
  loadFromLocal(files[0]);
  isEnter.value = false;
}

const doOneOrAll = (id: number, action: (i:number) => void ) => {
  if (syncImageBox.value){
    for (let i=0; i<imb.value!.length; i++){
      action(i);
    }
  }else{
    action(id);
  }
}

const mouseMove = (e: MouseEvent) => {

  const id = (e.currentTarget! as any).getAttribute("imageBoxId"); // anyじゃないほうがいいよ
  
  mousePos.value.x = e.offsetX;
  mousePos.value.y = e.offsetY;

  if (leftButtonFunction == "window") {
    if (e.buttons == 1) {
      doOneOrAll(id, (i:number) => {
        const a = imageBoxInfos.value[i];
        a.myWC += e.movementY;
        a.myWW += e.movementX;
        showImage(i);
      });
    }
  }

  if (leftButtonFunction == "page") {
    if (e.buttons == 1) {
      doOneOrAll(id, (i:number) => {
        changeSlice(i, e.movementY);
        showImage(i);
      });
    }
  }

  if (leftButtonFunction == "zoom") {
    if (e.buttons == 1) {
      let r = Math.pow(1.02, e.movementY);
      doOneOrAll(id, (i:number) => {
        const a = imageBoxInfos.value[i];
        a.vecx.multiplyScalar(r);
        a.vecy.multiplyScalar(r);
        showImage(i);
      });
    }
  }

  if (leftButtonFunction == "pan") {
    if (e.buttons == 1) {
      doOneOrAll(id, (i:number) => {
        const a = imageBoxInfos.value[i];
        a.centerInWorld.x -= (e.movementX * a.vecx.x + e.movementY * a.vecy.x);
        a.centerInWorld.y -= (e.movementX * a.vecx.y + e.movementY * a.vecy.y);
        a.centerInWorld.z -= (e.movementX * a.vecx.z + e.movementY * a.vecy.z);
        showImage(i);
      });
    }
  }
}

const wheel = (e: WheelEvent) => {
  const id = (e.currentTarget! as any).getAttribute("imageBoxId"); // anyじゃないほうがいいよ
  doOneOrAll(id, (i:number) => {
    const change = e.deltaY > 0 ? 1 : -1;
    changeSlice(id, change);
    showImage(i);
  });
}

const getIdOfEventOccured = (e:MouseEvent | WheelEvent) => Number((e.currentTarget! as any).getAttribute("imageBoxId"));; // anyじゃないほうがいいよ

const clicked = (e:MouseEvent) => {
  const id = getIdOfEventOccured(e);
  selectedImageBoxId.value = id;
}

watch(() => props.receivedNiftiData, (a)=>{
  loadNii(a);
  initialSetup();
  show();

});

const loadNii = (arraybuffer: ArrayBuffer) => {

  if (nifti.isCompressed(arraybuffer)){
    arraybuffer = nifti.decompress(arraybuffer);
  }

  if (nifti.isNIFTI(arraybuffer)) {
    const hdr = nifti.readHeader(arraybuffer) as nifti.NIFTI1;
    const px: ArrayBuffer = nifti.readImage(hdr, arraybuffer);

    if (hdr["numBitsPerVoxel"] == 32) {
      const px0 = new Float32Array(px);
      niis.push({ header: hdr, pixelData: px0 });
    } else if (hdr["numBitsPerVoxel"] == 64) {
      const px1 = new Float64Array(px);
      niis.push({ header: hdr, pixelData: new Float32Array(px1) });
    } else {
      const px1 = new Int16Array(px);
      niis.push({ header: hdr, pixelData: new Float32Array(px1) });
    }
  }
}

const initialSetup = () => {

  // niftiの座標系
  //  +x = Right  +y = Anterior  +z = Superior.
  // https://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1.h
  // つまり、右にいくほどx座標が増え、前にいくほどy座標が増え、上にいくほどz座標が増える。

  const dim = niis[0]['header']['dims'];
  const p0 = voxelToWorld(new THREE.Vector3(0,0,0),0);
  const p1 = voxelToWorld(new THREE.Vector3(dim[1],dim[2],dim[3]),0);
  p0.add(p1).divideScalar(2);  //[(p0[0]+p1[0])/2,(p0[1]+p1[1])/2,(p0[2]+p1[2])/2]
  const a = imageBoxInfos.value[0];
  a.centerInWorld.x = p0.x;
  a.centerInWorld.y = p0.y;
  a.centerInWorld.z = p0.z;

  const af = niis[0]['header']['affine'];
  a.vecx.fromArray(af[0]);// afは長さ4であるが、最初の3つのみがTHREE.Vector3に使われる
  if (a.vecx.x>0){
    a.vecx.multiplyScalar(-1);
  }
  
  a.vecy.fromArray(af[1]);
  if (a.vecy.y>0){
    a.vecy.multiplyScalar(-1);
  }

  a.vecz.fromArray(af[2]);//.multiplyScalar(-1);
  if (a.vecz.z>0){
    a.vecz.multiplyScalar(-1);
  }

  a.clut = 1;
  a.myWC=3;
  a.myWW=6;

  const b = imageBoxInfos.value[1]; // mip
  b.centerInWorld.x = p0.x;
  b.centerInWorld.y = p0.y;
  b.centerInWorld.z = p0.z;
  b.vecx = a.vecx.clone();
  b.vecy = a.vecz.clone();
  b.vecz = a.vecy.clone();

  b.vecx.normalize().multiplyScalar(1.7);
  b.vecy.normalize().multiplyScalar(1.7);
  b.vecz.normalize().multiplyScalar(1.7);
  b.clut = 1;
  b.myWC=3;
  b.myWW=6;

}


const loadFromLocal = (file: File, autoShow = true) => {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      if (reader.result !== null) {
        const arraybuffer = reader.result as ArrayBuffer;
        loadNii(arraybuffer);

        if (autoShow) {
          initialSetup();
          show();
        }
      }
    }
    catch (ex) {
      console.log('Error in nifti parsing', ex);
    }
  }
  reader.readAsArrayBuffer(file);
}

const openSample = async () => {

  const urlList = ["https://metavol.github.io/metavol-web/pp95jh2xgt/1.nii",
    "https://metavol.github.io/metavol-web/pp95jh2xgt/1_seg.nii"]

  for (let i = 0; i < urlList.length; i++) {
    await loadFromUrl(urlList[i]);
  }

  show();
};

const loadFromUrl = (url: string) => {
  axios.get(url, { responseType: "arraybuffer" })
    .then(function (response) {
      const ab = new ArrayBuffer(response.data);
      loadNii(ab);
    });
};

const cluts = [
  [...Array(256).keys()].map((d) => {return [d,d,d]}),
  [...Array(256).keys()].map((d) => {return [255-d,255-d,255-d]}),
  rainbow(),
];

const show = () => {
  if (imb.value![0] == null) return;
  if (imb.value![1] == null) return;
  if (niis.length == 0) return;
  for (let i=0; i<imageBoxInfos.value.length; i++){
    showImage(i);
  }
}

const showImage = (i: number) => {
  const info = imageBoxInfos.value[i];
  const j = info.currentNiftiNumber;
  const nii = niis[j];
  const hdr = nii['header'];
  const pixelData0 = nii['pixelData'];
  const nx = hdr['dims'][1];
  const ny = hdr['dims'][2];
  const nz = hdr['dims'][3];
  const p00 = worldToVoxel(screenToWorld(i,0,0),j);
  const v01 = worldToVoxel(screenToWorld(i,0,1),j).sub(p00);
  const v10 = worldToVoxel(screenToWorld(i,1,0),j).sub(p00);
  // const wc = imageBoxInfos.value![i].myWC;
  // const ww = imageBoxInfos.value![i].myWW;
  const [wc,ww] = getMyWCWW(i);
  const clut = cluts[imageBoxInfos.value![i].clut];

  if (!imageBoxInfos.value[i].isMip){
    imb.value![i].drawNiftiSlice(pixelData0,nx,ny,nz, wc, ww, p00,v01,v10,clut);
  }else{

    const angle = imageBoxInfos.value[i].mipAngle;
    imb.value![i].drawNiftiMip(pixelData0,nx,ny,nz, wc, ww, p00,v01,v10,
      angle, info.thresholdSurfaceMip, info.depthSurfaceMip, clut, isSurfaceMIP.value);
  }
}


const screenToWorld = (imageBoxNumber: number, x: number, y:number) => {
  const world = new THREE.Vector3(0,0,0);
  const a = imageBoxInfos.value[imageBoxNumber];
  world.add(a.centerInWorld).addScaledVector(a.vecx,x-imageBoxWH.value[0]/2).addScaledVector(a.vecy,y-imageBoxWH.value[1]/2);
  return world;
}

// const screenToWorld_ = (p: THREE.Vector2) => {
//   return screenToWorld(0, p.x,p.y);
// }

const voxelToWorld = (p: THREE.Vector3, vol_id:number) => {
  const af = niis[vol_id].header['affine'];
  const worldx = af[0][3] + p.x * af[0][0] + p.y * af[0][1] + p.z * af[0][2];
  const worldy = af[1][3] + p.x * af[1][0] + p.y * af[1][1] + p.z * af[1][2];
  const worldz = af[2][3] + p.x * af[2][0] + p.y * af[2][1] + p.z * af[2][2];
  return new THREE.Vector3(worldx,worldy,worldz);
}

const worldToVoxel = (p: THREE.Vector3, vol_id:number) => {
  const af = niis[vol_id].header['affine'];
  const right = [p.x-af[0][3], p.y-af[1][3], p.z-af[2][3]];
  const left = [af[0].slice(0,3),af[1].slice(0,3), af[2].slice(0,3)]
  const ans = solve(left, right)
  return new THREE.Vector3(ans[0],ans[1],ans[2]);
}

const changeSuv = (a:number,b:number) => {

  for (let i=0; i<imageBoxInfos.value.length; i++){
    setMyWCWW(i, (a+b)/2, b-a);
  }
  show();
}

</script>

<template>

  <div style="display: flex; flex-flow: row;">

    <div style="display: flex; flex-flow: column;">

      <sidebar @fileLoaded="loadFromLocal"
        @openSample="openSample"
        @leftButtonFunctionChanged="leftButtonFunctionChanged"
        @presetSelected="presetSelected" 
        sortVisible="0"></sidebar>

    <button @click="changeSuv(0,3)">SUV 0-3</button>
    <button @click="changeSuv(0,6)">SUV 0-6</button>

    </div>

    <div :class="['wrapper', {redborder: isEnter}]">
      
      <div v-for="i in tileXY[0] * tileXY[1]" >
        <imagebox ref="imb"
          :imageBoxId="i-1"
          :width="imageBoxWH[0]"
          :height="imageBoxWH[1]"
          @wheel.prevent="wheel"
          @mousemove="mouseMove"
          @dragenter="dragEnter"
          @dragleave="dragLeave"
          @dropover.prevent @drop.prevent="dropFile"
          @click="clicked"
          :selected="i-1 === selectedImageBoxId">
          </imagebox>


          <p v-if="showImageBoxInfo"> {{ imageBoxInfos[i-1] }}</p>
      </div>
    </div>
  </div>
  <div style="display: flex; flex-flow: row;">

  <!-- <button @click="changeMipTimer">Rotate</button> -->
  <div>
    <input type="checkbox" id="rotate_checkbox" v-model="isRotating" />
    <label for="rotate_checkbox">Rotate</label>
  </div>

  <div>
    <input type="checkbox" id="surfacemip_checkbox" v-model="isSurfaceMIP" />
    <label for="surfacemip_checkbox">Surface</label>
  </div>

  <div>
    <input type="checkbox" id="sync_checkbox" v-model="syncImageBox" />
    <label for="sync_checkbox">Sync</label>
  </div>

  <div>
    <input type="checkbox" id="showImageBoxInfo_checkbox" v-model="showImageBoxInfo" />
    <label for="showImageBoxInfo_checkbox">Show info</label>
  </div>
</div>


<!--
  <div style="border: red;">
    <p>current mouse position</p>
    <p>{{ mousePos }}</p>
    <p>{{ screenToWorld_(mousePos) }}</p>
    <p>{{ niis.length > 0 ? niis[0].header : "none" }}</p>
    <p>{{ imageBoxInfos.length > 0 ? imageBoxInfos : "none" }}</p>
  </div>

-->


  <!-- <p>{{ props.volumeData == null }} これがないとwatchが発動しない？そうでもない</p> -->

  <!-- <p>{{ dicom_file_dic_summary() }}</p> -->

</template>

<style scoped>
.wrapper {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}
.redborder{
  border: solid red;
}
</style>
