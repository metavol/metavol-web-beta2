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
  shade: vec4<f32>,        // shadeMode(0=off,1=on), ambient, specular, depthCue
  aspect: vec4<f32>,       // voxel pitch x, y, z, minRun (連続ヒット要求数)
  outAndMode2: vec4<i32>,  // hasBodyMask, _, _, _
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> clut: array<vec4<f32>>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var maskTex: texture_3d<u32>;
@group(0) @binding(5) var<storage, read> labelClut: array<vec4<f32>>;
// CT 寝台除去用 body mask (0=体外, 1=体内)。hasBodyMask=0 のときは参照しない。
@group(0) @binding(6) var bodyMaskTex: texture_3d<u32>;

// 体外なら「無い」ものとして扱う値。CT の空気より十分低くしておけば
// 表面判定にも MIP にも引っかからない。
fn maskedSample(x: i32, y: i32, z: i32) -> f32 {
  let v = textureLoad(volumeTex, vec3<i32>(x, y, z), 0).r;
  if (P.outAndMode2.x == 1) {
    if (textureLoad(bodyMaskTex, vec3<i32>(x, y, z), 0).r == 0u) { return -1.0e30; }
  }
  return v;
}

fn lookupClut(m: f32) -> vec3<f32> {
  let lo = P.rotWC.z - P.rotWC.w * 0.5;
  let p = clamp((m - lo) * (255.0 / P.rotWC.w), 0.0, 255.0);
  let cidx = i32(p);
  return clut[cidx].rgb;
}

fn sampleAt(x: i32, y: i32, z: i32) -> f32 {
  let nx = P.dims.x; let ny = P.dims.y; let nz = P.dims.z;
  let cx = clamp(x, 0, nx - 1);
  let cy = clamp(y, 0, ny - 1);
  let cz = clamp(z, 0, nz - 1);
  return textureLoad(volumeTex, vec3<i32>(cx, cy, cz), 0).r;
}

// 3x3x3 の箱平均。閾値付近のノイズで法線が暴れるのを抑える。
fn smoothAt(x: i32, y: i32, z: i32) -> f32 {
  var s: f32 = 0.0;
  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        s = s + sampleAt(x + dx, y + dy, z + dz);
      }
    }
  }
  return s / 27.0;
}

// float 座標での三線形サンプル。表面位置をサブボクセルで求めるのに使う。
fn sampleTrilinear(p: vec3<f32>) -> f32 {
  let x0 = floor(p.x); let y0 = floor(p.y); let z0 = floor(p.z);
  let fx = p.x - x0;   let fy = p.y - y0;   let fz = p.z - z0;
  let i0 = i32(x0); let j0 = i32(y0); let k0 = i32(z0);
  let c000 = sampleAt(i0,   j0,   k0);
  let c100 = sampleAt(i0+1, j0,   k0);
  let c010 = sampleAt(i0,   j0+1, k0);
  let c110 = sampleAt(i0+1, j0+1, k0);
  let c001 = sampleAt(i0,   j0,   k0+1);
  let c101 = sampleAt(i0+1, j0,   k0+1);
  let c011 = sampleAt(i0,   j0+1, k0+1);
  let c111 = sampleAt(i0+1, j0+1, k0+1);
  let c00 = mix(c000, c100, fx);
  let c10 = mix(c010, c110, fx);
  let c01 = mix(c001, c101, fx);
  let c11 = mix(c011, c111, fx);
  return mix(mix(c00, c10, fy), mix(c01, c11, fy), fz);
}

// **サブボクセル位置での勾配。**
//
// 整数 voxel で取ると法線が階段状になり、輪郭と陰影に voxel 単位のジャギーが残る。
// ただし「3x3x3 平均 × 三線形 8 タップ」を中心差分 6 方向でやると
// 1 画素あたり 1300 テクスチャ読みになり実用にならない (実測: 描画が 30 秒を超えた)。
//
// 三線形補間そのものが近傍 8 点の加重平均 = 弱い平滑化になっているので、
// **別途の箱平均は掛けず、三線形サンプルの中心差分だけ**にする。
// 差分幅を 1.0 voxel より広げる (1.5) ことで、ノイズに対する頑健さを補う。
// これで 1 画素あたり 6×8 = 48 読み。
fn gradientAtF(p: vec3<f32>) -> vec3<f32> {
  let h = 1.5;
  let gx = (sampleTrilinear(p + vec3<f32>(h,0.0,0.0)) - sampleTrilinear(p - vec3<f32>(h,0.0,0.0))) / max(P.aspect.x, 1e-6);
  let gy = (sampleTrilinear(p + vec3<f32>(0.0,h,0.0)) - sampleTrilinear(p - vec3<f32>(0.0,h,0.0))) / max(P.aspect.y, 1e-6);
  let gz = (sampleTrilinear(p + vec3<f32>(0.0,0.0,h)) - sampleTrilinear(p - vec3<f32>(0.0,0.0,h))) / max(P.aspect.z, 1e-6);
  return vec3<f32>(gx, gy, gz);
}

// 中心差分で勾配 (= 表面の法線方向) を求める。
// **voxel pitch で割ること**: kitty は 0.117×0.117×0.5mm と z だけ 4 倍粗いので、
// 添字空間のままだと法線が z 方向に潰れて陰影が横縞になる。
// 差分は平滑化済みの値で取る。生値だと薄い殻の表面で法線がばらつき、
// 陰影が砂嵐のようになる (実測: kitty の顔の帯が横縞に割れた)。
fn gradientAt(x: i32, y: i32, z: i32) -> vec3<f32> {
  let gx = (smoothAt(x + 1, y, z) - smoothAt(x - 1, y, z)) / max(P.aspect.x, 1e-6);
  let gy = (smoothAt(x, y + 1, z) - smoothAt(x, y - 1, z)) / max(P.aspect.y, 1e-6);
  let gz = (smoothAt(x, y, z + 1) - smoothAt(x, y, z - 1)) / max(P.aspect.z, 1e-6);
  return vec3<f32>(gx, gy, gz);
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
  // 表面に当たった voxel (陰影計算用)。hitI < 0 は「当たらなかった」。
  var hitX: i32 = 0;
  var hitY: i32 = 0;
  var hitI: i32 = -1;
  // サブボクセル精度の当たり位置 (voxel 座標)。陰影はこちらで計算する。
  var hitP: vec3<f32> = vec3<f32>(0.0, 0.0, 0.0);

  if (isSurface == 0) {
    for (var i: i32 = nx - 1; i >= 0; i = i - 1) {
      let i0 = f32(i) - f32(nx) * 0.5;
      let xf = floor(i0 * cosA - j0 * sinA + f32(nx) * 0.5);
      let yf = floor(i0 * sinA + j0 * cosA + f32(ny) * 0.5);
      let x = i32(xf);
      let y = i32(yf);
      if (x < 0 || x >= nx || y < 0 || y >= ny) { continue; }
      let v = maskedSample(x, y, iz);
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
      let vSurf = maskedSample(x0, y0, iz);
      if (vSurf < surfThresh) { continue; }
      // **単発の閾値超えは採らない。** 体表が空気と 100HU 程度しか離れていないデータでは
      // ノイズ 1 voxel でヒット位置が跳ね、陰影が砂嵐になる (実測: kitty)。
      // 視線方向に minRun 個続けて閾値を超えて初めて「表面」とみなす。
      let minRun = i32(P.aspect.w);
      var run: i32 = 1;
      for (var q: i32 = 1; q < minRun; q = q + 1) {
        let iq = f32(i - q) - f32(nx) * 0.5;
        let xq = i32(floor(iq * cosA - j0 * sinA + f32(nx) * 0.5));
        let yq = i32(floor(iq * sinA + j0 * cosA + f32(ny) * 0.5));
        if (xq < 0 || xq >= nx || yq < 0 || yq >= ny) { break; }
        if (maskedSample(xq, yq, iz) < surfThresh) { break; }
        run = run + 1;
      }
      if (run < minRun) { continue; }
      hitX = x0; hitY = y0; hitI = i;
      // **等値面の交点をサブボクセルで求める。**
      // 1 つ手前 (視点側) のサンプルは閾値未満なので、その間を線形補間すれば
      // 面の位置が voxel 未満の精度で決まる。整数位置のままだと輪郭と陰影に
      // voxel 単位の階段が残る。
      let ip = f32(i + 1) - f32(nx) * 0.5;
      let xp = ip * cosA - j0 * sinA + f32(nx) * 0.5;
      let yp = ip * sinA + j0 * cosA + f32(ny) * 0.5;
      let prevV = sampleTrilinear(vec3<f32>(xp, yp, f32(iz)));
      let curP  = vec3<f32>(i0 * cosA - j0 * sinA + f32(nx) * 0.5,
                            i0 * sinA + j0 * cosA + f32(ny) * 0.5,
                            f32(iz));
      var t: f32 = 0.0;
      let denom = vSurf - prevV;
      if (abs(denom) > 1e-6) { t = clamp((surfThresh - prevV) / denom, 0.0, 1.0); }
      hitP = mix(vec3<f32>(xp, yp, f32(iz)), curP, t);
      // depth = 0 なら「当たった面そのもの」を描く純粋な表面投影。
      // depth > 0 なら従来どおり、そこから奥へ dMax voxel 分の MIP。
      if (dMax <= 0) {
        m = vSurf;
        if (hasOverlay == 1) { lid = textureLoad(maskTex, vec3<i32>(x0, y0, iz), 0).r; }
      } else {
        for (var d: i32 = 0; d < dMax; d = d + 1) {
          let id0 = f32(i - d) - f32(nx) * 0.5;
          let x1 = i32(floor(id0 * cosA - j0 * sinA + f32(nx) * 0.5));
          let y1 = i32(floor(id0 * sinA + j0 * cosA + f32(ny) * 0.5));
          if (x1 < 0 || x1 >= nx || y1 < 0 || y1 >= ny) { continue; }
          let a = maskedSample(x1, y1, iz);
          m = max(m, a);
          if (hasOverlay == 1) {
            let mv = textureLoad(maskTex, vec3<i32>(x1, y1, iz), 0).r;
            if (mv > lid) { lid = mv; }
          }
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

  // ===== 表面陰影 (shaded surface projection) =====
  //
  // 閾値で拾った面を CLUT の値だけで塗ると平板に見える。**形が見えるのは陰影のおかげ**なので、
  // 当たった位置の勾配を法線として Phong で陰影を付ける。
  // albedo は CLUT の明るい側 (clut[230]) を材質色として使う。生値を albedo にすると、
  // kitty のように体表が -900HU 付近だと窓の下端に張り付いて真っ黒になってしまう。
  if (isSurface == 1 && P.shade.x > 0.5 && hitI >= 0) {
    let grad = gradientAtF(hitP);
    let glen = length(grad);
    // 視線方向 (面から視点へ向かう向き)。ray は i を減らす向きに進むので +(cosA, sinA, 0)。
    let viewDir = normalize(vec3<f32>(cosA, sinA, 0.0));
    var shadeVal: f32 = 1.0;
    if (glen > 1e-8) {
      // 内部ほど高値なので勾配は内向き。外向き法線はその逆。
      let n = -grad / glen;
      let diff = max(dot(n, viewDir), 0.0);
      let amb = P.shade.y;
      let spec = P.shade.z * pow(diff, 24.0);
      shadeVal = amb + (1.0 - amb) * diff + spec;
    }
    // 奥ほど暗く落として奥行きを出す
    let depthN = clamp(f32(nx - 1 - hitI) / max(f32(nx), 1.0), 0.0, 1.0);
    shadeVal = shadeVal * (1.0 - P.shade.w * depthN);
    let albedo = clut[230].rgb;
    rgb = clamp(albedo * shadeVal, vec3<f32>(0.0), vec3<f32>(1.0));
  }

  if (hasOverlay == 1 && lid > 0u) {
    let len = u32(P.surf.w);
    let safeLen = max(len, 1u);
    let cidx = i32(lid % safeLen);
    let cc = labelClut[cidx].rgb;
    let a = P.surf.z * labelClut[cidx].a;  // .a = per-label visibility (0=hidden)
    rgb = rgb * (1.0 - a) + cc * a;
  }

  textureStore(outTex, vec2<i32>(cx, cy), vec4<f32>(rgb, 1.0));
}
`;
