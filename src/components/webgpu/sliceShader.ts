// WGSL compute shader for Volume MPR slice rendering (drawNiftiSlice 相当)。
//
// 各 canvas pixel ごとに 1 thread:
//   1. screen → base voxel coord (v = p00 + cy*v01 + cx*v10)
//   2. trilinear sample volume @ v → raw
//   3. body mask 有り & v が体外 (=0) なら raw = -1024 (CT 寝台除去)
//   4. WC/WW + CLUT lookup
//   5. overlay 有りなら mask voxel coord (vm = p00m + cy*v01m + cx*v10m) で
//      label id を nearest sample、>0 なら labelClut の色を α blend
//
// trilinear は manual (textureLoad ×8 + lerp)。volume tex は r32float なので
// hardware filtering は使えない。

export const SLICE_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims: vec4<i32>,         // nx, ny, nz, _
  outAndFlags: vec4<i32>,  // outW, outH, hasOverlay, hasBodyMask
  maskDims: vec4<i32>,     // mnx, mny, mnz, _
  p00:  vec4<f32>,
  v01:  vec4<f32>,
  v10:  vec4<f32>,
  p00m: vec4<f32>,
  v01m: vec4<f32>,
  v10m: vec4<f32>,
  rotWC: vec4<f32>,        // _, _, wc, ww
  surf:  vec4<f32>,        // overlayAlpha, labelClutLen, interpolation, _
                           //   interpolation: 0 = nearest, 1 = bilinear (trilinear)
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var maskTex: texture_3d<u32>;
@group(0) @binding(5) var<storage, read> labelClut: array<vec4<f32>>;
@group(0) @binding(6) var bodyMaskTex: texture_3d<u32>;

fn lerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }

fn sampleNearest(p: vec3<f32>) -> f32 {
  let nx = P.dims.x; let ny = P.dims.y; let nz = P.dims.z;
  let x = i32(floor(p.x + 0.5));
  let y = i32(floor(p.y + 0.5));
  let z = i32(floor(p.z + 0.5));
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) {
    return 1.0e30;
  }
  return textureLoad(volumeTex, vec3<i32>(x, y, z), 0).r;
}

fn sampleTrilinear(p: vec3<f32>) -> f32 {
  let nx = P.dims.x; let ny = P.dims.y; let nz = P.dims.z;
  // CPU 実装と同じ: vx<0 || vx>=nx 等で範囲外 → caller が背景色を出す
  // (このシェーダ内では sentinel 値 1e30 を「範囲外」として返し、上位で background 扱い)
  if (p.x < 0.0 || p.y < 0.0 || p.z < 0.0
      || p.x >= f32(nx) || p.y >= f32(ny) || p.z >= f32(nz)) {
    return 1.0e30;
  }
  let i0 = vec3<i32>(floor(p));
  let f = p - vec3<f32>(i0);
  let i1 = vec3<i32>(
    select(i0.x + 1, i0.x, i0.x + 1 >= nx),
    select(i0.y + 1, i0.y, i0.y + 1 >= ny),
    select(i0.z + 1, i0.z, i0.z + 1 >= nz),
  );
  let c000 = textureLoad(volumeTex, vec3<i32>(i0.x, i0.y, i0.z), 0).r;
  let c100 = textureLoad(volumeTex, vec3<i32>(i1.x, i0.y, i0.z), 0).r;
  let c010 = textureLoad(volumeTex, vec3<i32>(i0.x, i1.y, i0.z), 0).r;
  let c110 = textureLoad(volumeTex, vec3<i32>(i1.x, i1.y, i0.z), 0).r;
  let c001 = textureLoad(volumeTex, vec3<i32>(i0.x, i0.y, i1.z), 0).r;
  let c101 = textureLoad(volumeTex, vec3<i32>(i1.x, i0.y, i1.z), 0).r;
  let c011 = textureLoad(volumeTex, vec3<i32>(i0.x, i1.y, i1.z), 0).r;
  let c111 = textureLoad(volumeTex, vec3<i32>(i1.x, i1.y, i1.z), 0).r;
  let c00 = lerp(c000, c100, f.x);
  let c10 = lerp(c010, c110, f.x);
  let c01 = lerp(c001, c101, f.x);
  let c11 = lerp(c011, c111, f.x);
  let c0 = lerp(c00, c10, f.y);
  let c1 = lerp(c01, c11, f.y);
  return lerp(c0, c1, f.z);
}

fn lookupClut(raw: f32) -> vec3<f32> {
  let lo = P.rotWC.z - P.rotWC.w * 0.5;
  let p = clamp(floor((raw - lo) * (255.0 / P.rotWC.w)), 0.0, 255.0);
  return clut[i32(p)].rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cx = i32(gid.x);
  let cy = i32(gid.y);
  let outW = P.outAndFlags.x;
  let outH = P.outAndFlags.y;
  if (cx >= outW || cy >= outH) { return; }

  let cyf = f32(cy);
  let cxf = f32(cx);

  // base voxel coord
  let vx = P.p00.x + cyf * P.v01.x + cxf * P.v10.x;
  let vy = P.p00.y + cyf * P.v01.y + cxf * P.v10.y;
  let vz = P.p00.z + cyf * P.v01.z + cxf * P.v10.z;

  // 補間モード: P.surf.z == 0 → nearest、それ以外 → trilinear
  var raw: f32;
  if (P.surf.z < 0.5) {
    raw = sampleNearest(vec3<f32>(vx, vy, vz));
  } else {
    raw = sampleTrilinear(vec3<f32>(vx, vy, vz));
  }
  let inBounds = raw < 1.0e29;

  // body mask (CT 寝台除去) は voxel-grid なので nearest 固定 (round-to-center)
  if (inBounds && P.outAndFlags.w == 1) {
    let bx = i32(floor(vx + 0.5));
    let by = i32(floor(vy + 0.5));
    let bz = i32(floor(vz + 0.5));
    if (bx >= 0 && bx < P.dims.x && by >= 0 && by < P.dims.y && bz >= 0 && bz < P.dims.z) {
      let bm = textureLoad(bodyMaskTex, vec3<i32>(bx, by, bz), 0).r;
      if (bm == 0u) { raw = -1024.0; }
    }
  }

  var rgb: vec3<f32>;
  if (inBounds) {
    rgb = lookupClut(raw);
  } else {
    rgb = clut[0].rgb;
  }

  // overlay (mask label) — separate affine
  // Voxel center 規約 = 整数座標。floor(x + 0.5) で round-to-nearest-center。
  // PET 側 trilinear と境界が ½ voxel ずれないように。
  if (P.outAndFlags.z == 1) {
    let mvx = P.p00m.x + cyf * P.v01m.x + cxf * P.v10m.x;
    let mvy = P.p00m.y + cyf * P.v01m.y + cxf * P.v10m.y;
    let mvz = P.p00m.z + cyf * P.v01m.z + cxf * P.v10m.z;
    let mx = i32(floor(mvx + 0.5));
    let my = i32(floor(mvy + 0.5));
    let mz = i32(floor(mvz + 0.5));
    if (mx >= 0 && mx < P.maskDims.x && my >= 0 && my < P.maskDims.y && mz >= 0 && mz < P.maskDims.z) {
      let lid = textureLoad(maskTex, vec3<i32>(mx, my, mz), 0).r;
      if (lid > 0u) {
        let len = u32(P.surf.y);
        let safeLen = max(len, 1u);
        let cidx = i32(lid % safeLen);
        let lc = labelClut[cidx].rgb;
        let a = P.surf.x;
        rgb = rgb * (1.0 - a) + lc * a;
      }
    }
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(rgb, 1.0));
}
`;
