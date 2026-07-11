// WGSL compute shader for Fusion VR (CT base + PET overlay, front-to-back composite)。
//
// 設計: per canvas pixel で CT VR と PET VR を**独立に**front-to-back composite し、
//   最後に α blend する。Fusion MIP と同じ「2 つを別々にレンダして blend」モデル。
//   semantics は drawNiftiVR を 2 volume 分やってから baseW/ovlW で混ぜる形。

export const FUSION_VR_SHADER_WGSL = /* wgsl */ `
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
  alphaScales: vec4<f32>,   // alphaScale0, alphaScale1, _, _
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var vol0Tex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut0: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var vol1Tex: texture_3d<f32>;
@group(0) @binding(5) var<storage, read> clut1: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cx = i32(gid.x);
  let cy = i32(gid.y);
  if (cx >= P.outAndMode.x || cy >= P.outAndMode.y) { return; }

  let cyf = f32(cy);
  let cxf = f32(cx);
  let cosA = P.rotWcWw.x;
  let sinA = P.rotWcWw.y;
  let lo0 = P.rotWcWw.z - P.rotWcWw.w * 0.5;
  let lo1 = P.wcWw1Blend.x - P.wcWw1Blend.y * 0.5;
  let baseW = P.wcWw1Blend.z;
  let ovlW = P.wcWw1Blend.w;
  let aScale0 = P.alphaScales.x;
  let aScale1 = P.alphaScales.y;

  // ===== CT VR =====
  let vx0 = P.p00_0.x + cyf * P.v01_0.x + cxf * P.v10_0.x;
  let vy0 = P.p00_0.y + cyf * P.v01_0.y + cxf * P.v10_0.y;
  let vz0 = P.p00_0.z + cyf * P.v01_0.z + cxf * P.v10_0.z;
  let ix0 = i32(floor(vx0));
  let iz0 = i32(floor(vz0));

  var ctR: f32 = 0.0; var ctG: f32 = 0.0; var ctB: f32 = 0.0; var ctA: f32 = 0.0;
  let nx0 = P.dims0.x; let ny0 = P.dims0.y; let nz0 = P.dims0.z;
  if (ix0 >= 0 && ix0 < nx0 && iz0 >= 0 && iz0 < nz0) {
    let j0 = f32(ix0) - f32(ny0) * 0.5;
    for (var i: i32 = 0; i < nx0; i = i + 1) {
      if (ctA > 0.99) { break; }
      let i0 = f32(i) - f32(nx0) * 0.5;
      let x = i32(floor(i0 * cosA - j0 * sinA + f32(nx0) * 0.5));
      let y = i32(floor(i0 * sinA + j0 * cosA + f32(ny0) * 0.5));
      if (x < 0 || x >= nx0 || y < 0 || y >= ny0) { continue; }
      let v = textureLoad(vol0Tex, vec3<i32>(x, y, iz0), 0).r;
      var p = (v - lo0) / P.rotWcWw.w;
      if (p < 0.0) { continue; }
      if (p > 1.0) { p = 1.0; }
      let alpha = p * aScale0;
      if (alpha < 0.002) { continue; }
      let cidx = i32(min(255.0, floor(p * 255.0)));
      let c = clut0[cidx];
      let transmit = 1.0 - ctA;
      ctR = ctR + transmit * alpha * c.r;
      ctG = ctG + transmit * alpha * c.g;
      ctB = ctB + transmit * alpha * c.b;
      ctA = ctA + transmit * alpha;
    }
  }

  // ===== PET VR =====
  let vx1 = P.p00_1.x + cyf * P.v01_1.x + cxf * P.v10_1.x;
  let vy1 = P.p00_1.y + cyf * P.v01_1.y + cxf * P.v10_1.y;
  let vz1 = P.p00_1.z + cyf * P.v01_1.z + cxf * P.v10_1.z;
  let ix1 = i32(floor(vx1));
  let iz1 = i32(floor(vz1));

  var ptR: f32 = 0.0; var ptG: f32 = 0.0; var ptB: f32 = 0.0; var ptA: f32 = 0.0;
  let nx1 = P.dims1.x; let ny1 = P.dims1.y; let nz1 = P.dims1.z;
  if (ix1 >= 0 && ix1 < nx1 && iz1 >= 0 && iz1 < nz1) {
    let j1 = f32(ix1) - f32(ny1) * 0.5;
    for (var i: i32 = 0; i < nx1; i = i + 1) {
      if (ptA > 0.99) { break; }
      let i0 = f32(i) - f32(nx1) * 0.5;
      let x = i32(floor(i0 * cosA - j1 * sinA + f32(nx1) * 0.5));
      let y = i32(floor(i0 * sinA + j1 * cosA + f32(ny1) * 0.5));
      if (x < 0 || x >= nx1 || y < 0 || y >= ny1) { continue; }
      let v = textureLoad(vol1Tex, vec3<i32>(x, y, iz1), 0).r;
      var p = (v - lo1) / P.wcWw1Blend.y;
      if (p < 0.0) { continue; }
      if (p > 1.0) { p = 1.0; }
      let alpha = p * aScale1;
      if (alpha < 0.002) { continue; }
      let cidx = i32(min(255.0, floor(p * 255.0)));
      let c = clut1[cidx];
      let transmit = 1.0 - ptA;
      ptR = ptR + transmit * alpha * c.r;
      ptG = ptG + transmit * alpha * c.g;
      ptB = ptB + transmit * alpha * c.b;
      ptA = ptA + transmit * alpha;
    }
  }

  let r = ctR * baseW + ptR * ovlW;
  let g = ctG * baseW + ptG * ovlW;
  let b = ctB * baseW + ptB * ovlW;
  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(r, g, b, 1.0));
}
`;
