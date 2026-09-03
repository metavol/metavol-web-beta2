// NIfTI-1 のヘッダを **ライブラリを介さず** 直接読んで出す。
// SPM の出力やアトラスがどんな幾何・datatype・scaling を持つかを、推測でなく実測で押さえるため。
//
// 使い方: node scripts/nifti-header-dump.mjs <file.nii> [file2.nii ...]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'fflate';

const DT = { 2: 'UINT8', 4: 'INT16', 8: 'INT32', 16: 'FLOAT32', 64: 'FLOAT64',
             256: 'INT8', 512: 'UINT16', 768: 'UINT32', 1024: 'INT64' };
const XFORM = { 0: 'UNKNOWN', 1: 'SCANNER_ANAT', 2: 'ALIGNED_ANAT', 3: 'TALAIRACH', 4: 'MNI_152' };

const readNii = (path) => {
  let buf = readFileSync(path);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = Buffer.from(gunzipSync(new Uint8Array(buf)));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sizeofHdr = dv.getInt32(0, true);
  const little = sizeofHdr === 348;
  if (!little && dv.getInt32(0, false) !== 348) throw new Error('sizeof_hdr が 348 でない');
  const LE = little;
  const i16 = o => dv.getInt16(o, LE), f32 = o => dv.getFloat32(o, LE);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };

  const ndim = i16(40);
  const dims = [i16(42), i16(44), i16(46)];
  const datatype = i16(70);
  const srow = [];
  for (let r = 0; r < 3; r++) { const row = []; for (let c = 0; c < 4; c++) row.push(f32(280 + r * 16 + c * 4)); srow.push(row); }
  return {
    file: path, bytes: buf.byteLength, endian: LE ? 'little' : 'big',
    ndim, dims, datatype, datatypeName: DT[datatype] ?? `?(${datatype})`,
    bitpix: i16(72),
    pixDims: [f32(76), f32(80), f32(84), f32(88)],
    sclSlope: f32(112), sclInter: f32(116),
    calMin: f32(124), calMax: f32(120),
    voxOffset: f32(108),
    qformCode: i16(252), sformCode: i16(254),
    quatern: [f32(256), f32(260), f32(264)],
    qoffset: [f32(268), f32(272), f32(276)],
    srow,
    descrip: str(148, 80), intentName: str(328, 16),
    magic: str(344, 4),
    buf, dv, LE,
  };
};

// voxel 値の分布 (ラベルかどうか / scaling 適用前後) を軽く見る
const scanValues = (h) => {
  const n = h.dims[0] * h.dims[1] * h.dims[2];
  const off = h.voxOffset || 352;
  const g = (i) => {
    switch (h.datatype) {
      case 2: return h.dv.getUint8(off + i);
      case 4: return h.dv.getInt16(off + i * 2, h.LE);
      case 8: return h.dv.getInt32(off + i * 4, h.LE);
      case 16: return h.dv.getFloat32(off + i * 4, h.LE);
      case 64: return h.dv.getFloat64(off + i * 8, h.LE);
      case 256: return h.dv.getInt8(off + i);
      case 512: return h.dv.getUint16(off + i * 2, h.LE);
      default: return NaN;
    }
  };
  let min = Infinity, max = -Infinity, nonZero = 0, allInt = true;
  const distinct = new Set();
  const stride = Math.max(1, Math.floor(n / 400000));
  for (let i = 0; i < n; i += stride) {
    const v = g(i);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v; if (v > max) max = v;
    if (v !== 0) nonZero++;
    if (!Number.isInteger(v)) allInt = false;
    if (distinct.size <= 400) distinct.add(v);
  }
  return { min, max, nonZeroFrac: nonZero / Math.ceil(n / stride), allInt,
           distinctCount: distinct.size > 400 ? '>400' : distinct.size,
           sampledEvery: stride };
};

const fmt = a => '[' + a.map(v => (typeof v === 'number' ? +v.toFixed(4) : v)).join(', ') + ']';

for (const path of process.argv.slice(2)) {
  const h = readNii(path);
  const v = scanValues(h);
  const ext = h.dims.map((d, i) => +(d * h.pixDims[i + 1]).toFixed(1));
  console.log(`\n=== ${path}`);
  console.log(`  bytes ${h.bytes}  magic "${h.magic.trim()}"  endian ${h.endian}`);
  console.log(`  dims ${fmt(h.dims)}  (ndim ${h.ndim})   datatype ${h.datatypeName} (${h.datatype}) bitpix ${h.bitpix}`);
  console.log(`  pixdim ${fmt(h.pixDims)}  → 全長 ${fmt(ext)} mm`);
  console.log(`  **scl_slope ${h.sclSlope}  scl_inter ${h.sclInter}**  ` +
              `${(h.sclSlope !== 0 && h.sclSlope !== 1) || h.sclInter !== 0 ? '← scaling あり。適用しないと値が狂う' : '(scaling なし)'}`);
  console.log(`  qform_code ${h.qformCode} (${XFORM[h.qformCode] ?? '?'})   sform_code ${h.sformCode} (${XFORM[h.sformCode] ?? '?'})`);
  console.log(`  qoffset ${fmt(h.qoffset)}`);
  console.log(`  srow_x ${fmt(h.srow[0])}`);
  console.log(`  srow_y ${fmt(h.srow[1])}`);
  console.log(`  srow_z ${fmt(h.srow[2])}`);
  // world bounding box (sform の 8 隅)
  const S = h.srow;
  const corner = (i, j, k) => [0, 1, 2].map(r => S[r][0] * i + S[r][1] * j + S[r][2] * k + S[r][3]);
  const cs = [];
  for (const i of [0, h.dims[0] - 1]) for (const j of [0, h.dims[1] - 1]) for (const k of [0, h.dims[2] - 1]) cs.push(corner(i, j, k));
  const bb = [0, 1, 2].map(r => [Math.min(...cs.map(c => c[r])), Math.max(...cs.map(c => c[r]))]);
  console.log(`  world bbox (RAS)  x ${fmt(bb[0])}  y ${fmt(bb[1])}  z ${fmt(bb[2])}`);
  console.log(`  descrip "${h.descrip}"   intent_name "${h.intentName}"`);
  console.log(`  値: min ${v.min} max ${v.max}  非ゼロ率 ${(v.nonZeroFrac * 100).toFixed(1)}%  ` +
              `整数のみ ${v.allInt}  異なる値の数 ${v.distinctCount} (${v.sampledEvery} voxel おきに標本)`);
  if ((h.sclSlope !== 0 && h.sclSlope !== 1) || h.sclInter !== 0) {
    const s = h.sclSlope === 0 ? 1 : h.sclSlope;
    console.log(`  → scaling 適用後の値域: ${(v.min * s + h.sclInter).toFixed(4)} 〜 ${(v.max * s + h.sclInter).toFixed(4)}`);
  }
}
