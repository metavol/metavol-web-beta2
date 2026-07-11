// WGSL compute shader for Fusion MIP (CT base + PET overlay)。
//
// 各 canvas pixel ごとに 1 thread。基本構造は MIP shader と同じだが、2 volume を
// 別々の affine で投影し、それぞれ独立に max を求めて α blend。

export const FUSION_MIP_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims0: vec4<i32>,         // nx0, ny0, nz0, _
  dims1: vec4<i32>,         // nx1, ny1, nz1, _
  outAndMode: vec4<i32>,    // outW, outH, _, _
  p00_0: vec4<f32>,
  v01_0: vec4<f32>,
  v10_0: vec4<f32>,
  p00_1: vec4<f32>,
  v01_1: vec4<f32>,
  v10_1: vec4<f32>,
  rotWcWw: vec4<f32>,       // cosA, sinA, wc0, ww0
  wcWw1Blend: vec4<f32>,    // wc1, ww1, baseW, ovlW
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var vol0Tex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut0: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var vol1Tex: texture_3d<f32>;
@group(0) @binding(5) var<storage, read> clut1: array<vec4<f32>>;

fn lookupClut0(raw: f32) -> vec3<f32> {
  let lo = P.rotWcWw.z - P.rotWcWw.w * 0.5;
  let p = clamp(floor((raw - lo) * (255.0 / P.rotWcWw.w)), 0.0, 255.0);
  return clut0[i32(p)].rgb;
}
fn lookupClut1(raw: f32) -> vec3<f32> {
  let lo = P.wcWw1Blend.x - P.wcWw1Blend.y * 0.5;
  let p = clamp(floor((raw - lo) * (255.0 / P.wcWw1Blend.y)), 0.0, 255.0);
  return clut1[i32(p)].rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cx = i32(gid.x);
  let cy = i32(gid.y);
  if (cx >= P.outAndMode.x || cy >= P.outAndMode.y) { return; }

  let cyf = f32(cy);
  let cxf = f32(cx);
  let cosA = P.rotWcWw.x;
  let sinA = P.rotWcWw.y;

  // ===== base (vol0, MIP) =====
  let vx0 = P.p00_0.x + cyf * P.v01_0.x + cxf * P.v10_0.x;
  let vy0 = P.p00_0.y + cyf * P.v01_0.y + cxf * P.v10_0.y;
  let vz0 = P.p00_0.z + cyf * P.v01_0.z + cxf * P.v10_0.z;
  let ix0 = i32(floor(vx0));
  let iy0 = i32(floor(vy0));
  let iz0 = i32(floor(vz0));

  var baseColor: vec3<f32>;
  let nx0 = P.dims0.x; let ny0 = P.dims0.y; let nz0 = P.dims0.z;
  if (ix0 >= 0 && ix0 < nx0 && iy0 >= 0 && iy0 < ny0 && iz0 >= 0 && iz0 < nz0) {
    let j0 = f32(ix0) - f32(ny0) * 0.5;
    var m: f32 = -1.0e30;
    for (var i: i32 = nx0 - 1; i >= 0; i = i - 1) {
      let i0 = f32(i) - f32(nx0) * 0.5;
      let x = i32(floor(i0 * cosA - j0 * sinA + f32(nx0) * 0.5));
      let y = i32(floor(i0 * sinA + j0 * cosA + f32(ny0) * 0.5));
      if (x < 0 || x >= nx0 || y < 0 || y >= ny0) { continue; }
      let v = textureLoad(vol0Tex, vec3<i32>(x, y, iz0), 0).r;
      m = max(m, v);
    }
    if (m > -1.0e29) { baseColor = lookupClut0(m); } else { baseColor = clut0[0].rgb; }
  } else {
    baseColor = clut0[0].rgb;
  }

  // ===== overlay (vol1, MIP) =====
  let vx1 = P.p00_1.x + cyf * P.v01_1.x + cxf * P.v10_1.x;
  let vy1 = P.p00_1.y + cyf * P.v01_1.y + cxf * P.v10_1.y;
  let vz1 = P.p00_1.z + cyf * P.v01_1.z + cxf * P.v10_1.z;
  let ix1 = i32(floor(vx1));
  let iy1 = i32(floor(vy1));
  let iz1 = i32(floor(vz1));

  var ovlColor: vec3<f32>;
  let nx1 = P.dims1.x; let ny1 = P.dims1.y; let nz1 = P.dims1.z;
  if (ix1 >= 0 && ix1 < nx1 && iy1 >= 0 && iy1 < ny1 && iz1 >= 0 && iz1 < nz1) {
    let j1 = f32(ix1) - f32(ny1) * 0.5;
    var m: f32 = -1.0e30;
    for (var i: i32 = nx1 - 1; i >= 0; i = i - 1) {
      let i0 = f32(i) - f32(nx1) * 0.5;
      let x = i32(floor(i0 * cosA - j1 * sinA + f32(nx1) * 0.5));
      let y = i32(floor(i0 * sinA + j1 * cosA + f32(ny1) * 0.5));
      if (x < 0 || x >= nx1 || y < 0 || y >= ny1) { continue; }
      let v = textureLoad(vol1Tex, vec3<i32>(x, y, iz1), 0).r;
      m = max(m, v);
    }
    if (m > -1.0e29) { ovlColor = lookupClut1(m); } else { ovlColor = clut1[0].rgb; }
  } else {
    ovlColor = clut1[0].rgb;
  }

  let baseW = P.wcWw1Blend.z;
  let ovlW = P.wcWw1Blend.w;
  let rgb = baseColor * baseW + ovlColor * ovlW;
  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(rgb, 1.0));
}
`;
