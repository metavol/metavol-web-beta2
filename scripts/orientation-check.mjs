// **表示の向きが解剖学的に正しいか**を、アトラスのラベルを使って判定する。
//
// 「前後が逆に見える」は主観になりがちなので、**前頭極と後頭極の world 座標**を実際に取り、
// 画面の下方向ベクトル (box の vecy) に射影して機械的に決める。
// 放射線科の慣行 (axial): 画面上=前, 画面右=患者の左。
//
// 使い方: node scripts/orientation-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';
const opt=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:f;};
const URL=`http://localhost:${opt('port','3000')}${opt('base','/metavol-web-beta2')}/`;
const IMG=opt('img',null)?path.resolve(opt('img')):normalizedNii();
const ATLAS=path.resolve('sample-data/spm-atlas/labels_Neuromorphometrics.nii');

const b=await chromium.launch({headless:true});
try{
 const page=await(await b.newContext()).newPage();
 page.on('pageerror',e=>console.error('[pageerror]',e.message));
 await page.goto(URL,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>!!document.querySelector('#app')?.__vue_app__,null,{timeout:60000});
 await page.waitForTimeout(1200);
 // 実際の読み込み経路を踏む
 await page.locator('.v-app-bar button').first().click(); await page.waitForTimeout(400);
 await page.locator('.v-overlay .v-list-item',{hasText:'Load files'}).first().click(); await page.waitForTimeout(300);
 await page.setInputFiles('input[accept*=".dcm"]',[IMG]);
 await page.waitForTimeout(7000);

 const out=await page.evaluate(async (atlasUrl)=>{
   const app=document.querySelector('#app').__vue_app__;
   const ss=app._instance.setupState;
   const d=(ss.dicomViewRef.value??ss.dicomViewRef).$.setupState;
   const T=await import('/metavol-web-beta2/src/components/voi/voiTemplate.ts');
   const bytes=new Uint8Array(await (await fetch('/samples/spm-atlas/labels_Neuromorphometrics.nii')).arrayBuffer());
   const atl=T.parseNiftiLabelVolume(bytes.buffer,'atlas');

   // アトラスの或るラベル群の world 重心 (アプリの world = LPS)
   const centroid=(ids)=>{
     const set=new Set(ids); let n=0,cx=0,cy=0,cz=0;
     const {nx,ny,nz,voxel:v,imagePosition:p,vectorX:a,vectorY:bb,vectorZ:c}=atl;
     for(let k=0;k<nz;k++)for(let j=0;j<ny;j++){const base=k*nx*ny+j*nx;
       for(let i=0;i<nx;i++){ if(!set.has(v[base+i]))continue; n++;
         cx+=p.x+a.x*i+bb.x*j+c.x*k; cy+=p.y+a.y*i+bb.y*j+c.y*k; cz+=p.z+a.z*i+bb.z*j+c.z*k; }}
     return n?{n,x:cx/n,y:cy/n,z:cz/n}:null;
   };
   const frontal=centroid([120,121]);   // Right/Left FRP frontal pole
   const occip  =centroid([156,157]);   // Right/Left OCP occipital pole
   const rightH =centroid([47]);        // Right Hippocampus
   const leftH  =centroid([48]);        // Left Hippocampus

   const info=d.imageBoxInfos[0];
   const vol=d.seriesList[info.currentSeriesNumber].volume;
   const nrm=(v)=>{const L=Math.hypot(v.x,v.y,v.z)||1;return{x:v.x/L,y:v.y/L,z:v.z/L};};
   const dot=(u,v)=>u.x*v.x+u.y*v.y+u.z*v.z;
   const sub=(p,q)=>({x:p.x-q.x,y:p.y-q.y,z:p.z-q.z});

   // 参考: 解剖学的に組んだ場合の断面ベクトル
   const pv = d.planeVectorsWorld ? d.planeVectorsWorld(vol,'axi') : null;

   const rep=(vecx,vecy)=>({
     vecx:[+vecx.x.toFixed(2),+vecx.y.toFixed(2),+vecx.z.toFixed(2)],
     vecy:[+vecy.x.toFixed(2),+vecy.y.toFixed(2),+vecy.z.toFixed(2)],
     // 画面下方向に対する「前頭極 - 後頭極」の射影。正なら前頭極が下 = 前後逆
     frontalBelowOccipital: +dot(sub(frontal,occip),nrm(vecy)).toFixed(1),
     // 画面右方向に対する「左海馬 - 右海馬」の射影。正なら患者左が画面右 = 放射線科慣行
     patientLeftOnScreenRight: +dot(sub(leftH,rightH),nrm(vecx)).toFixed(1),
   });

   return {
     dims:[vol.nx,vol.ny,vol.nz],
     volVecY:[+vol.vectorY.x.toFixed(2),+vol.vectorY.y.toFixed(2),+vol.vectorY.z.toFixed(2)],
     frontal:{y:+frontal.y.toFixed(1),n:frontal.n},
     occip:{y:+occip.y.toFixed(1),n:occip.n},
     box: rep(info.vecx,info.vecy),
     anatomical: pv ? rep(pv.vecx,pv.vecy) : null,
   };
 }, ATLAS);

 console.log(`\n画像 ${out.dims.join('x')}   volume の vectorY (LPS) = ${JSON.stringify(out.volVecY)}`);
 console.log(`アトラスの world y (LPS, +y=後方):  前頭極 ${out.frontal.y}   後頭極 ${out.occip.y}`);
 console.log(`  → 前頭極の方が y が小さい = 前方。基準として妥当: ${out.frontal.y < out.occip.y ? 'OK' : '**NG**'}`);
 const judge=(r,label)=>{
   const flipped = r.frontalBelowOccipital > 0;
   const lr = r.patientLeftOnScreenRight > 0;
   console.log(`\n[${label}]  vecx=${JSON.stringify(r.vecx)}  vecy=${JSON.stringify(r.vecy)}`);
   console.log(`   前後: 「前頭極−後頭極」を画面下へ射影 = ${r.frontalBelowOccipital} mm`
     + `  → 前頭極は画面の${flipped?'**下**  ← 前後が逆':'上  (正しい)'}`);
   console.log(`   左右: 「左海馬−右海馬」を画面右へ射影 = ${r.patientLeftOnScreenRight} mm`
     + `  → 患者の左は画面の${lr?'右 (放射線科慣行どおり)':'**左**  ← 左右が逆'}`);
 };
 judge(out.box,'いま表示されている box (promoteBoxToVolume)');
 if(out.anatomical) judge(out.anatomical,'planeVectorsWorld(axi) で組んだ場合');
}catch(e){console.error('failed:',e?.stack??e);process.exitCode=1;}
finally{await b.close();}
