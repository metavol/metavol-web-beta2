// WGSL compute shader for Volume Rendering (front-to-back composite)。
//
// CPU 実装 (ImageBox.vue:618-) を 1 shader に潰した形:
//   1. screen → slab voxel coord
//   2. (j=v0.x, k=v0.z) の slab で「rotation 後の x' 軸」前方から ray march
//   3. 各 sample で WC/WW 正規化 → opacity = p * alphaScale, color = clut[p*255]
//   4. front-to-back composite (Porter-Duff over): dst += transmit * α * src
//   5. early exit (da > 0.99)
//
// CPU 版と同様 ALPHA_SCALE = 0.06 固定。閾値 (alpha < 0.002) も同じ。

export const VR_SHADER_WGSL = /* wgsl */ `
struct Params {
  dims: vec4<i32>,         // nx, ny, nz, maxSteps (ray sample count)
  outAndMode: vec4<i32>,   // outW, outH, shadingEnabled (0/1), _
  p00: vec4<f32>,
  v01: vec4<f32>,
  v10: vec4<f32>,
  vForward: vec4<f32>,     // through-plane voxel-step vector (= camera forward × step size)
  shadeWcWw: vec4<f32>,    // specularIntensity, specularPower, wc, ww
  vrParams: vec4<f32>,     // alphaScale, ambient, diffuse, _
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
// 256-entry opacity LUT。vrTf.buildOpacityLut の出力。 default は (0..1) ramp。
@group(0) @binding(4) var<storage, read> opacityLut: array<f32>;

// 自由回転対応: ray-cast の方向は P.vForward (through-plane voxel-step vector)。
// 旧版は z 軸固定 + (cosA, sinA) で x'-y' 平面内 rotation だったが、自由回転では
// camRight=v10, camUp=v01, camForward=vForward の 3 ベクトルが画面 (cx, cy, depth) → voxel
// を完全に決める。ray は p_start = p00 + cy*v01 + cx*v10、step += vForward。
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
  let maxSteps = P.dims.w;

  let cyf = f32(cy);
  let cxf = f32(cx);
  let px0 = P.p00.x + cyf * P.v01.x + cxf * P.v10.x;
  let py0 = P.p00.y + cyf * P.v01.y + cxf * P.v10.y;
  let pz0 = P.p00.z + cyf * P.v01.z + cxf * P.v10.z;

  let ww = P.shadeWcWw.w;
  let lo = P.shadeWcWw.z - ww * 0.5;
  let alphaScale = P.vrParams.x;
  let shadingEnabled = P.outAndMode.z == 1;
  let ambient = P.vrParams.y;
  let diffuse = P.vrParams.z;
  let specInt = P.shadeWcWw.x;
  let specPower = max(P.shadeWcWw.y, 1.0);
  // 簡易 head-light: L = -vForward (camera から物体への方向の逆 = 視線反対 = カメラ位置への方向)
  let lightDir = normalize(-vec3<f32>(P.vForward.x, P.vForward.y, P.vForward.z));

  var dr: f32 = 0.0;
  var dg: f32 = 0.0;
  var db: f32 = 0.0;
  var da: f32 = 0.0;

  for (var i: i32 = 0; i < maxSteps; i = i + 1) {
    if (da > 0.99) { break; }
    let s = f32(i);
    let px = px0 + s * P.vForward.x;
    let py = py0 + s * P.vForward.y;
    let pz = pz0 + s * P.vForward.z;
    let ix = i32(floor(px));
    let iy = i32(floor(py));
    let iz = i32(floor(pz));
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) { continue; }
    let v = textureLoad(volumeTex, vec3<i32>(ix, iy, iz), 0).r;
    var p = (v - lo) / ww;
    if (p < 0.0) { continue; }
    if (p > 1.0) { p = 1.0; }
    let cidx = i32(min(255.0, floor(p * 255.0)));
    let alpha = opacityLut[cidx] * alphaScale;
    if (alpha < 0.002) { continue; }
    let c = clut[cidx];
    var rgb = vec3<f32>(c.r, c.g, c.b);
    if (shadingEnabled) {
      let xm = max(ix - 1, 0);
      let xp = min(ix + 1, nx - 1);
      let ym = max(iy - 1, 0);
      let yp = min(iy + 1, ny - 1);
      let zm = max(iz - 1, 0);
      let zp = min(iz + 1, nz - 1);
      let gx = textureLoad(volumeTex, vec3<i32>(xp, iy, iz), 0).r - textureLoad(volumeTex, vec3<i32>(xm, iy, iz), 0).r;
      let gy = textureLoad(volumeTex, vec3<i32>(ix, yp, iz), 0).r - textureLoad(volumeTex, vec3<i32>(ix, ym, iz), 0).r;
      let gz = textureLoad(volumeTex, vec3<i32>(ix, iy, zp), 0).r - textureLoad(volumeTex, vec3<i32>(ix, iy, zm), 0).r;
      let g = vec3<f32>(gx, gy, gz);
      let glen = length(g);
      if (glen > 1.0e-6) {
        let n = -g / glen;
        let ndl = max(0.0, dot(n, lightDir));
        let ndh = max(0.0, dot(n, lightDir));
        let spec = pow(ndh, specPower) * specInt;
        let lightI = ambient + diffuse * ndl + spec;
        rgb = rgb * min(lightI, 1.5);
      } else {
        rgb = rgb * ambient;
      }
    }
    let transmit = 1.0 - da;
    dr = dr + transmit * alpha * rgb.r;
    dg = dg + transmit * alpha * rgb.g;
    db = db + transmit * alpha * rgb.b;
    da = da + transmit * alpha;
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(dr, dg, db, 1.0));
}
`;
