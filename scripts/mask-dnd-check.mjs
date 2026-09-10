// d&d (= Load files と同じ loadFiles 経路) でマスク .nii を落としたときの検査。
//
// 見るもの:
//   A) 画像と同格子・整数ラベルの nii → 確認ダイアログが出る
//   B) OK → シリーズは増えず、loadMaskFromNifti に流れて MASK カードが出る (overlay も着色)
//   C) Cancel → 普通の volume としてシリーズが 1 つ増え、マスクは作られない
//   D) sidecar .json を同時に落とすとラベル名が復元される
//
// マスクは実ファイルを配布できないので、wFDG.nii のヘッダから同格子の合成マスクを作る。
// 使い方: node scripts/mask-dnd-check.mjs   (先に npm run dev)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizedNii } from './sampleData.mjs';

const opt=(n,f)=>{const i=process.argv.indexOf(`--${n}`);return i>=0?process.argv[i+1]:f;};
const URL=`http://localhost:${opt('port','3000')}${opt('base','/metavol-web-beta2')}/?dev=spm-normalized`;

let pass=0, fail=0;
const check=(ok,label,detail='')=>{
  console.log(`  ${ok?'PASS':'FAIL'}  ${label}${detail?`  ${detail}`:''}`);
  ok?pass++:fail++;
};

// --- 合成マスクの生成 (wFDG と同じ dims/affine、uint8、3 ラベル) ---
const src = readFileSync(normalizedNii());
const sdv = new DataView(src.buffer, src.byteOffset, src.byteLength);
if (sdv.getInt32(0, true) !== 348) throw new Error('source nii: sizeof_hdr != 348');
const dims = [sdv.getInt16(42,true), sdv.getInt16(44,true), sdv.getInt16(46,true)];
const [nx,ny,nz]=dims;

const hdr = new Uint8Array(352);
const dv = new DataView(hdr.buffer);
dv.setInt32(0,348,true);
dv.setInt16(40,3,true);                          // dim[0]=3
dv.setInt16(42,nx,true); dv.setInt16(44,ny,true); dv.setInt16(46,nz,true);
dv.setInt16(48,1,true); dv.setInt16(50,1,true); dv.setInt16(52,1,true);
dv.setInt16(70,2,true);                          // datatype 2 = UINT8
dv.setInt16(72,8,true);                          // bitpix
for (let b=76; b<108; b+=4) dv.setFloat32(b, sdv.getFloat32(b,true), true);  // pixdim
dv.setFloat32(108,352,true);                     // vox_offset
dv.setFloat32(112,1,true);                       // scl_slope
// qform/sform を元からコピー (252..348 = codes + quaternion + srow)
for (let b=252; b<348; b+=2) dv.setInt16(b, sdv.getInt16(b,true), true);
hdr[344]=0x6e; hdr[345]=0x2b; hdr[346]=0x31; hdr[347]=0x00;   // "n+1"

const vox = new Uint8Array(nx*ny*nz);
// 島 A: 3 ブロックに 1/2/3 を塗る (z 三等分、中央付近のみ)。z 方向に連続なので 1 つの島。
for (let k=0;k<nz;k++) for (let j=30;j<60;j++) for (let i=25;i<55;i++)
  vox[k*nx*ny + j*nx + i] = k<nz/3 ? 1 : (k<2*nz/3 ? 2 : 3);
// 島 B: A から x 方向に 5 voxel 以上離れた小さな立方体 (label 2)。
// island_id の分離と SUVmax 順位付けの検証用。
const B = { i0: 60, i1: 66, j0: 40, j1: 46, k0: 35, k1: 41 };
for (let k=B.k0;k<B.k1;k++) for (let j=B.j0;j<B.j1;j++) for (let i=B.i0;i<B.i1;i++)
  vox[k*nx*ny + j*nx + i] = 2;
const N_A = 30*30*nz, N_B = 6*6*6, N_ALL = N_A + N_B;
const maskNii = new Uint8Array(352 + vox.length);
maskNii.set(hdr,0); maskNii.set(vox,352);

const dir = mkdtempSync(path.join(tmpdir(),'mvmask-'));
const maskPath = path.join(dir,'tumor_mask.nii');
writeFileSync(maskPath, maskNii);
const sidecarPath = path.join(dir,'tumor_mask.json');
writeFileSync(sidecarPath, JSON.stringify({
  labels:[{id:1,name:'Alpha',color:[255,0,0]},{id:2,name:'Beta',color:[0,255,0]},{id:3,name:'Gamma',color:[0,0,255]}],
}));

const b = await chromium.launch({headless:true});
try {
  const openApp = async () => {
    const page = await (await b.newContext({viewport:{width:1500,height:950}})).newPage();
    page.on('pageerror',e=>console.error('[pageerror]',e.message));
    await page.goto(URL,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>!!document.querySelector('#app')?.__vue_app__,null,{timeout:60000});
    await page.waitForTimeout(6000);
    return page;
  };
  const seriesCount = (page)=>page.evaluate(()=>{
    const ss=document.querySelector('#app').__vue_app__._instance.setupState;
    return ss.seriesSummariesView.length;
  });
  const loadViaMenu = async (page, files) => {
    await page.locator('.v-app-bar button').first().click(); await page.waitForTimeout(400);
    // "Load files…" は filechooser を開く (隠し input は遅延生成なので selector では掴めない)
    const fc = page.waitForEvent('filechooser');
    await page.locator('.v-overlay .v-list-item',{hasText:'Load files'}).first().click();
    await (await fc).setFiles(files);
    await page.waitForTimeout(5000);
  };
  const segState = (page)=>page.evaluate(()=>{
    const pinia=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const seg=pinia._s.get('segmentation');
    const m=seg.finalMask; let nz=0; if(m){for(let i=0;i<m.length;i++) if(m[i])nz++;}
    return { maskLabel: seg.maskLabel, nonZero: nz,
             labels: seg.labels.map(l=>({id:l.id,name:l.name})) };
  });

  // --- B) OK 経路 (マスク単体、sidecar なし) ---
  {
    const page = await openApp();
    const before = await seriesCount(page);
    let dialogMsg = null;
    page.on('dialog', d => { dialogMsg = d.message(); d.accept(); });
    await loadViaMenu(page, [maskPath]);
    check(dialogMsg != null, 'マスク drop で確認ダイアログが出る');
    check(dialogMsg != null && /label mask/.test(dialogMsg) && /3 labels/.test(dialogMsg),
          'ダイアログにラベル数と格子一致が書いてある', JSON.stringify((dialogMsg??'').slice(0,70)));
    const after = await seriesCount(page);
    check(after === before, 'OK でシリーズは増えない', `${before} → ${after}`);
    const st = await segState(page);
    check(st.maskLabel === 'tumor_mask.nii', 'MASK カードの出自がファイル名', JSON.stringify(st.maskLabel));
    check(st.nonZero === N_ALL, 'マスクに voxel が入っている', `${st.nonZero} vs ${N_ALL}`);
    check(st.labels.length === 3 && st.labels[0].name === 'Label 1',
          'sidecar 無しではラベル表を id から生成', JSON.stringify(st.labels));
    const card = page.locator('[data-testid="mask-card"]');
    check(await card.count() === 1, 'MASK カードが出る');
    // overlay が実際に描かれているか (store に入っただけでは人には見えない)
    const colored = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 1500));
      const cv = [...document.querySelectorAll('canvas')].filter(c => c.width > 64)[0];
      if (!cv) return -1;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b2 = d[i + 2];
        if (r + g + b2 < 30) continue;
        if (Math.max(r, g, b2) - Math.min(r, g, b2) > 24) n++;
      }
      return n;
    });
    check(colored > 100, '画像に overlay が着色されている', `着色画素 ${colored}`);

    // --- B2) Voxel list export (Persona 1 向け、様式 `island_id label_id x y z value`) ---
    // 右 Inspector の ④ Save → Others → Voxel list を人と同じ操作で押し、
    // 落ちてきた .txt を **Node 側で独立に読んだ wFDG の voxel 値**と突き合わせる。
    await page.evaluate(() => {
      const ss = document.querySelector('#app').__vue_app__._instance.setupState;
      const d = (ss.dicomViewRef.value ?? ss.dicomViewRef).$.setupState;
      d.inspector = true;
    });
    await page.waitForTimeout(1500);
    await page.locator('.mv-save-others').click();
    await page.waitForTimeout(400);
    const dlPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('.v-overlay .v-list-item', { hasText: 'Voxel list' }).first().click();
    const dl = await dlPromise;
    const txtPath = path.join(dir, 'voxels.txt');
    await dl.saveAs(txtPath);
    const txt = readFileSync(txtPath, 'utf-8');
    const allLines = txt.split('\n');
    const metaLines = allLines.filter(l => l.startsWith('#'));
    const headerIdx = allLines.findIndex(l => l === 'island_id label_id x y z value');
    check(headerIdx >= 0, 'ヘッダ行が `island_id label_id x y z value`');
    check(metaLines.some(l => l.startsWith('# grid ')) && metaLines.some(l => l.startsWith('# voxel_mm ')),
          'メタ行に grid / voxel_mm が入る');
    check(metaLines.some(l => /^# islands 2 /.test(l)), 'メタ行に islands 2 (病変数)');
    check(metaLines.filter(l => l.startsWith('# label ')).length === 3,
          'メタ行に使用中ラベルの対応表 (3 行)');
    const data = allLines.slice(headerIdx + 1).filter(l => l.length > 0);
    check(data.length === N_ALL, `データ行数 = マスク voxel 数`, `${data.length} vs ${N_ALL}`);

    // wFDG の voxel を Node で独立に読む (FLOAT32, vox_offset はヘッダから)
    const voxOff = sdv.getFloat32(108, true) || 352;
    const img = new Float32Array(src.buffer.slice(src.byteOffset + voxOff,
                                                  src.byteOffset + voxOff + nx * ny * nz * 4));
    const inB = (x, y, z) => x >= B.i0 && x < B.i1 && y >= B.j0 && y < B.j1 && z >= B.k0 && z < B.k1;
    const inA = (x, y, z) => x >= 25 && x < 55 && y >= 30 && y < 60;
    // 島ごとの SUVmax を独立に計算 (NaN は無視) — island_id の順位検証用
    let maxA = -Infinity, maxB = -Infinity;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const v = img[z * nx * ny + y * nx + x];
      if (!Number.isFinite(v)) continue;
      if (inB(x, y, z)) { if (v > maxB) maxB = v; }
      else if (inA(x, y, z)) { if (v > maxA) maxA = v; }
    }
    const expIslandA = maxA >= maxB ? 1 : 2;
    const expIslandB = 3 - expIslandA;
    let bad = 0, firstBad = '';
    for (const line of data) {
      const t = line.split(' ');
      if (t.length !== 6) { bad++; if (!firstBad) firstBad = `列数 ${t.length}: ${line}`; continue; }
      const [isl, lab, x, y, z] = [Number(t[0]), Number(t[1]), Number(t[2]), Number(t[3]), Number(t[4])];
      const idx = z * nx * ny + y * nx + x;
      // 既知パターン: 島 B は label 2、島 A は k 三等分で 1/2/3
      const expLab = inB(x, y, z) ? 2 : (inA(x, y, z) ? (z < nz / 3 ? 1 : (z < 2 * nz / 3 ? 2 : 3)) : 0);
      const expIsl = inB(x, y, z) ? expIslandB : (inA(x, y, z) ? expIslandA : 0);
      if (lab !== expLab) { bad++; if (!firstBad) firstBad = `label ${lab} != ${expLab} at ${x},${y},${z}`; continue; }
      if (isl !== expIsl) { bad++; if (!firstBad) firstBad = `island ${isl} != ${expIsl} at ${x},${y},${z}`; continue; }
      const expVal = img[idx];
      if (t[5] === 'nan') {
        if (Number.isFinite(expVal)) { bad++; if (!firstBad) firstBad = `nan だが実値 ${expVal}`; }
      } else if (!(Math.abs(Number(t[5]) - expVal) <= 5.1e-7)) {
        bad++; if (!firstBad) firstBad = `value ${t[5]} != ${expVal} at ${x},${y},${z}`;
      }
    }
    check(bad === 0, '全行が独立読みの voxel 値・既知ラベル・既知 island と一致',
          bad ? `不一致 ${bad} 行 (例: ${firstBad})` : `${data.length} 行検証 (SUVmax A=${maxA.toFixed(2)} B=${maxB.toFixed(2)} → 島番号 A=${expIslandA})`);
    await page.close();
  }

  // --- C) Cancel 経路 → 手動 "Use as mask" で救済 ---
  {
    const page = await openApp();
    const before = await seriesCount(page);
    page.on('dialog', d => d.dismiss());
    await loadViaMenu(page, [maskPath]);
    const after = await seriesCount(page);
    check(after === before + 1, 'Cancel で普通の volume としてシリーズ +1', `${before} → ${after}`);
    const st = await segState(page);
    check(st.maskLabel == null, 'Cancel ではマスクを作らない', JSON.stringify(st.maskLabel));

    // 手動経路: シリーズカードの「…」→ Use as mask (Cancel してしまった場合のやり直し)
    const cards = page.locator('.series-card');
    const maskCardIdx = after - 1;   // 追加されたのは末尾
    await cards.nth(maskCardIdx).hover();
    await cards.nth(maskCardIdx).locator('.card-menu-btn').click();
    await page.waitForTimeout(400);
    const item = page.locator('.v-overlay .v-list-item', { hasText: 'Use as mask' });
    check(await item.count() > 0, '「…」メニューに Use as mask がある');
    await item.first().click();
    await page.waitForTimeout(2500);
    const st2 = await segState(page);
    check(st2.maskLabel === 'tumor_mask.nii', 'Use as mask でマスク化される (出自 = ファイル名)',
          JSON.stringify(st2.maskLabel));
    check(st2.nonZero === N_ALL, 'マスクに voxel が入っている', `${st2.nonZero} vs ${N_ALL}`);
    check(await page.locator('[data-testid="mask-card"]').count() === 1, 'MASK カードが出る');
    await page.close();
  }

  // --- D) sidecar .json 同時 drop ---
  {
    const page = await openApp();
    page.on('dialog', d => d.accept());
    await loadViaMenu(page, [maskPath, sidecarPath]);
    const st = await segState(page);
    check(st.labels.length === 3 && st.labels.map(l=>l.name).join(',') === 'Alpha,Beta,Gamma',
          'sidecar のラベル名が復元される', JSON.stringify(st.labels.map(l=>l.name)));
    await page.close();
  }

  console.log(`\n  総合: ${fail===0?'PASS':'FAIL'} (${pass} pass / ${fail} fail)`);
  process.exitCode = fail===0?0:1;
} catch(e){ console.error('failed:', e?.stack??e); process.exitCode=1; }
finally { await b.close(); }
