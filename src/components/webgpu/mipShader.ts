// WGSL compute shader for MIP rendering with optional mask overlay。
//
// 単一 pass: 各 canvas pixel ごとに 1 thread を起動し、
//   1. screen → slab voxel coord (v0 = p00 + cy*v01 + cx*v10)
//   2. v0.x を MIP image x、v0.z を MIP image y として扱い
//   3. (j=v0.x, k=v0.z) の slab で「rotation 後の x' 軸」に沿って ray-cast → max
//      (overlay 有効なら同じ ray 上で max-label-id も track)
//   4. WC/WW + CLUT lookup → output へ書き込み (overlay 有効なら labelClut 色をブレンド)
//
// 既存 CPU 実装 (ImageBox.vue:454-) の two-pass (precompute → resample) を
// 1 shader に潰した形。canvas pixel 数 (~65k) × volume nx (~144〜512) で
// 9M〜130M textureLoad、WebGPU では数 ms で完了。
//
// Surface MIP モード (isSurface=1): 視線手前から閾値超え voxel を探し、
// その位置から depth voxel 分だけ MIP。CPU 実装と同じセマンティクス。
//
// Mask overlay (hasOverlay=1): mask 3D texture (r16uint) を同じ ray で sample し
// max label id を持つ。最終色 = base * (1-α) + labelColor * α。

export const MIP_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims: vec4<i32>,         // nx, ny, nz, _
  outAndMode: vec4<i32>,   // outW, outH, isSurface, hasOverlay
  p00: vec4<f32>,          // x, y, z, _
  v01: vec4<f32>,
  v10: vec4<f32>,
  rotWC: vec4<f32>,        // cosA, sinA, wc, ww
  surf: vec4<f32>,         // surfThresh, surfDepth, overlayAlpha, labelClutLen
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var maskTex: texture_3d<u32>;
@group(0) @binding(5) var<storage, read> labelClut: array<vec4<f32>>;

fn lookupClut(m: f32) -> vec3<f32> {
  let lo = P.rotWC.z - P.rotWC.w * 0.5;
  let p = clamp((m - lo) * (255.0 / P.rotWC.w), 0.0, 255.0);
  let cidx = i32(p);
  return clut[cidx].rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cx = i32(gid.x);
  let cy = i32(gid.y);
  let outW = P.outAndMode.x;
  let outH = P.outAndMode.y;
  if (cx >= outW || cy >= outH) { return; }

  let nx = P.dims.x;
  let ny = P.dims.y;
  let nz = P.dims.z;
  let isSurface = P.outAndMode.z;
  let hasOverlay = P.outAndMode.w;

  // screen → slab voxel coord
  let cyf = f32(cy);
  let cxf = f32(cx);
  let vx = P.p00.x + cyf * P.v01.x + cxf * P.v10.x;
  let vy = P.p00.y + cyf * P.v01.y + cxf * P.v10.y;
  let vz = P.p00.z + cyf * P.v01.z + cxf * P.v10.z;
  let ix = i32(floor(vx));
  let iy = i32(floor(vy));
  let iz = i32(floor(vz));

  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) {
    let bg = clut[0].rgb;
    textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(bg, 1.0));
    return;
  }

  let j0 = f32(ix) - f32(ny) * 0.5;
  let cosA = P.rotWC.x;
  let sinA = P.rotWC.y;

  var m: f32 = -1.0e30;
  var lid: u32 = 0u;

  if (isSurface == 0) {
    for (var i: i32 = nx - 1; i >= 0; i = i - 1) {
      let i0 = f32(i) - f32(nx) * 0.5;
      let xf = floor(i0 * cosA - j0 * sinA + f32(nx) * 0.5);
      let yf = floor(i0 * sinA + j0 * cosA + f32(ny) * 0.5);
      let x = i32(xf);
      let y = i32(yf);
      if (x < 0 || x >= nx || y < 0 || y >= ny) { continue; }
      let v = textureLoad(volumeTex, vec3<i32>(x, y, iz), 0).r;
      m = max(m, v);
      if (hasOverlay == 1) {
        let mv = textureLoad(maskTex, vec3<i32>(x, y, iz), 0).r;
        if (mv > lid) { lid = mv; }
      }
    }
  } else {
    let dMax = i32(P.surf.y);
    let surfThresh = P.surf.x;
    var hit: bool = false;
    for (var i: i32 = nx - 1; i >= 0; i = i - 1) {
      if (hit) { break; }
      let i0 = f32(i) - f32(nx) * 0.5;
      let x0 = i32(floor(i0 * cosA - j0 * sinA + f32(nx) * 0.5));
      let y0 = i32(floor(i0 * sinA + j0 * cosA + f32(ny) * 0.5));
      if (x0 < 0 || x0 >= nx || y0 < 0 || y0 >= ny) { continue; }
      let vSurf = textureLoad(volumeTex, vec3<i32>(x0, y0, iz), 0).r;
      if (vSurf < surfThresh) { continue; }
      for (var d: i32 = 0; d < dMax; d = d + 1) {
        let id0 = f32(i - d) - f32(nx) * 0.5;
        let x1 = i32(floor(id0 * cosA - j0 * sinA + f32(nx) * 0.5));
        let y1 = i32(floor(id0 * sinA + j0 * cosA + f32(ny) * 0.5));
        if (x1 < 0 || x1 >= nx || y1 < 0 || y1 >= ny) { continue; }
        let a = textureLoad(volumeTex, vec3<i32>(x1, y1, iz), 0).r;
        m = max(m, a);
        if (hasOverlay == 1) {
          let mv = textureLoad(maskTex, vec3<i32>(x1, y1, iz), 0).r;
          if (mv > lid) { lid = mv; }
        }
      }
      hit = true;
    }
  }

  var rgb: vec3<f32>;
  if (m < -1.0e29) {
    rgb = clut[0].rgb;
  } else {
    rgb = lookupClut(m);
  }

  if (hasOverlay == 1 && lid > 0u) {
    let len = u32(P.surf.w);
    let safeLen = max(len, 1u);
    let cidx = i32(lid % safeLen);
    let cc = labelClut[cidx].rgb;
    let a = P.surf.z;
    rgb = rgb * (1.0 - a) + cc * a;
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(rgb, 1.0));
}
`;
