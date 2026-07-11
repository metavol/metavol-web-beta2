// WGSL compute shader for Fusion MPR slice (drawNiftiSliceFusion 相当)。
//
// CPU 実装:
//   - base (pix0, CT 想定): NEAREST sample at floor(v0)
//   - overlay (pix1, PET 想定): TRILINEAR sample
//   - body mask (CT 寝台除去): pix0 NEAREST 位置で外なら raw = -1024
//   - α blend: dst = baseW * baseColor + ovlW * overlayColor
//   - mask overlay: 別 affine、 nearest sample、blend
//
// 9 bindings:
//   0 uniform / 1 vol0 (f32 base) / 2 clut0 / 3 outTex /
//   4 vol1 (f32 overlay) / 5 clut1 / 6 maskTex (uint) / 7 labelClut /
//   8 bodyMaskTex (uint)

export const FUSION_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims0: vec4<i32>,         // nx0, ny0, nz0, interp0 (0=nearest, 1=bilinear)
  dims1: vec4<i32>,         // nx1, ny1, nz1, interp1
  maskDims: vec4<i32>,      // mnx, mny, mnz, _
  outAndFlags: vec4<i32>,   // outW, outH, hasOverlay, hasBodyMask
  p00_0: vec4<f32>,
  v01_0: vec4<f32>,
  v10_0: vec4<f32>,
  p00_1: vec4<f32>,
  v01_1: vec4<f32>,
  v10_1: vec4<f32>,
  p00m:  vec4<f32>,
  v01m:  vec4<f32>,
  v10m:  vec4<f32>,
  wcww:  vec4<f32>,         // wc0, ww0, wc1, ww1
  blend: vec4<f32>,         // baseW, ovlW, overlayAlpha, labelClutLen
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var vol0Tex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut0: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var vol1Tex: texture_3d<f32>;
@group(0) @binding(5) var<storage, read> clut1: array<vec4<f32>>;
@group(0) @binding(6) var maskTex: texture_3d<u32>;
@group(0) @binding(7) var<storage, read> labelClut: array<vec4<f32>>;
@group(0) @binding(8) var bodyMaskTex: texture_3d<u32>;

fn lerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }

fn sampleNearestVol0(p: vec3<f32>) -> f32 {
  let nx = P.dims0.x; let ny = P.dims0.y; let nz = P.dims0.z;
  let x = i32(floor(p.x + 0.5));
  let y = i32(floor(p.y + 0.5));
  let z = i32(floor(p.z + 0.5));
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) { return 1.0e30; }
  return textureLoad(vol0Tex, vec3<i32>(x, y, z), 0).r;
}

fn sampleTrilinearVol0(p: vec3<f32>) -> f32 {
  let nx = P.dims0.x; let ny = P.dims0.y; let nz = P.dims0.z;
  if (p.x < 0.0 || p.y < 0.0 || p.z < 0.0
      || p.x >= f32(nx) || p.y >= f32(ny) || p.z >= f32(nz)) { return 1.0e30; }
  let i0 = vec3<i32>(floor(p));
  let f = p - vec3<f32>(i0);
  let i1 = vec3<i32>(
    select(i0.x + 1, i0.x, i0.x + 1 >= nx),
    select(i0.y + 1, i0.y, i0.y + 1 >= ny),
    select(i0.z + 1, i0.z, i0.z + 1 >= nz),
  );
  let c000 = textureLoad(vol0Tex, vec3<i32>(i0.x, i0.y, i0.z), 0).r;
  let c100 = textureLoad(vol0Tex, vec3<i32>(i1.x, i0.y, i0.z), 0).r;
  let c010 = textureLoad(vol0Tex, vec3<i32>(i0.x, i1.y, i0.z), 0).r;
  let c110 = textureLoad(vol0Tex, vec3<i32>(i1.x, i1.y, i0.z), 0).r;
  let c001 = textureLoad(vol0Tex, vec3<i32>(i0.x, i0.y, i1.z), 0).r;
  let c101 = textureLoad(vol0Tex, vec3<i32>(i1.x, i0.y, i1.z), 0).r;
  let c011 = textureLoad(vol0Tex, vec3<i32>(i0.x, i1.y, i1.z), 0).r;
  let c111 = textureLoad(vol0Tex, vec3<i32>(i1.x, i1.y, i1.z), 0).r;
  let c00 = lerp(c000, c100, f.x);
  let c10 = lerp(c010, c110, f.x);
  let c01 = lerp(c001, c101, f.x);
  let c11 = lerp(c011, c111, f.x);
  let c0  = lerp(c00, c10, f.y);
  let c1  = lerp(c01, c11, f.y);
  return lerp(c0, c1, f.z);
}

fn sampleNearestVol1(p: vec3<f32>) -> f32 {
  let nx = P.dims1.x; let ny = P.dims1.y; let nz = P.dims1.z;
  let x = i32(floor(p.x + 0.5));
  let y = i32(floor(p.y + 0.5));
  let z = i32(floor(p.z + 0.5));
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) { return 1.0e30; }
  return textureLoad(vol1Tex, vec3<i32>(x, y, z), 0).r;
}

fn sampleTrilinearVol1(p: vec3<f32>) -> f32 {
  let nx = P.dims1.x; let ny = P.dims1.y; let nz = P.dims1.z;
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
  let c000 = textureLoad(vol1Tex, vec3<i32>(i0.x, i0.y, i0.z), 0).r;
  let c100 = textureLoad(vol1Tex, vec3<i32>(i1.x, i0.y, i0.z), 0).r;
  let c010 = textureLoad(vol1Tex, vec3<i32>(i0.x, i1.y, i0.z), 0).r;
  let c110 = textureLoad(vol1Tex, vec3<i32>(i1.x, i1.y, i0.z), 0).r;
  let c001 = textureLoad(vol1Tex, vec3<i32>(i0.x, i0.y, i1.z), 0).r;
  let c101 = textureLoad(vol1Tex, vec3<i32>(i1.x, i0.y, i1.z), 0).r;
  let c011 = textureLoad(vol1Tex, vec3<i32>(i0.x, i1.y, i1.z), 0).r;
  let c111 = textureLoad(vol1Tex, vec3<i32>(i1.x, i1.y, i1.z), 0).r;
  let c00 = lerp(c000, c100, f.x);
  let c10 = lerp(c010, c110, f.x);
  let c01 = lerp(c001, c101, f.x);
  let c11 = lerp(c011, c111, f.x);
  let c0  = lerp(c00, c10, f.y);
  let c1  = lerp(c01, c11, f.y);
  return lerp(c0, c1, f.z);
}

fn lookupClut0(raw: f32) -> vec3<f32> {
  let lo = P.wcww.x - P.wcww.y * 0.5;
  let p = clamp(floor((raw - lo) * (255.0 / P.wcww.y)), 0.0, 255.0);
  return clut0[i32(p)].rgb;
}
fn lookupClut1(raw: f32) -> vec3<f32> {
  let lo = P.wcww.z - P.wcww.w * 0.5;
  let p = clamp(floor((raw - lo) * (255.0 / P.wcww.w)), 0.0, 255.0);
  return clut1[i32(p)].rgb;
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

  // ===== base (pix0): interp0 で nearest / bilinear =====
  let vx0 = P.p00_0.x + cyf * P.v01_0.x + cxf * P.v10_0.x;
  let vy0 = P.p00_0.y + cyf * P.v01_0.y + cxf * P.v10_0.y;
  let vz0 = P.p00_0.z + cyf * P.v01_0.z + cxf * P.v10_0.z;
  var rawBase: f32;
  if (P.dims0.w == 0) {
    rawBase = sampleNearestVol0(vec3<f32>(vx0, vy0, vz0));
  } else {
    rawBase = sampleTrilinearVol0(vec3<f32>(vx0, vy0, vz0));
  }
  var baseColor: vec3<f32>;
  if (rawBase < 1.0e29) {
    var raw = rawBase;
    // CT 寝台除去: bodyMask は voxel-grid なので nearest 固定 (round-to-center)
    if (P.outAndFlags.w == 1) {
      let bx = i32(floor(vx0 + 0.5));
      let by = i32(floor(vy0 + 0.5));
      let bz = i32(floor(vz0 + 0.5));
      if (bx >= 0 && bx < P.dims0.x && by >= 0 && by < P.dims0.y && bz >= 0 && bz < P.dims0.z) {
        let bm = textureLoad(bodyMaskTex, vec3<i32>(bx, by, bz), 0).r;
        if (bm == 0u) { raw = -1024.0; }
      }
    }
    baseColor = lookupClut0(raw);
  } else {
    baseColor = clut0[0].rgb;
  }
  let baseW = P.blend.x;
  let ovlW = P.blend.y;
  var rgb = baseColor * baseW;

  // ===== overlay (pix1): interp1 で nearest / bilinear =====
  let vx1 = P.p00_1.x + cyf * P.v01_1.x + cxf * P.v10_1.x;
  let vy1 = P.p00_1.y + cyf * P.v01_1.y + cxf * P.v10_1.y;
  let vz1 = P.p00_1.z + cyf * P.v01_1.z + cxf * P.v10_1.z;
  var rawPet: f32;
  if (P.dims1.w == 0) {
    rawPet = sampleNearestVol1(vec3<f32>(vx1, vy1, vz1));
  } else {
    rawPet = sampleTrilinearVol1(vec3<f32>(vx1, vy1, vz1));
  }
  var ovlColor: vec3<f32>;
  if (rawPet < 1.0e29) {
    ovlColor = lookupClut1(rawPet);
  } else {
    ovlColor = clut1[0].rgb;
  }
  rgb = rgb + ovlColor * ovlW;

  // ===== mask overlay (label color) =====
  // Voxel center 規約 = 整数座標 (floor + 0.5 で nearest center 選択)
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
        let len = u32(P.blend.w);
        let safeLen = max(len, 1u);
        let cidx = i32(lid % safeLen);
        let lc = labelClut[cidx].rgb;
        let a = P.blend.z;
        rgb = rgb * (1.0 - a) + lc * a;
      }
    }
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(rgb, 1.0));
}
`;
