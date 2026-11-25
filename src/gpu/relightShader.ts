/**
 * 重光照渲染 WGSL。
 * 系数以量化 u8 打包在 array<u32> 中(空间布局 pw*ph*K),
 * 反量化 scale/bias 按 tile 索引;法线 RGBA8 同样打包。
 * 基函数必须与 src/core/math/basis.ts 完全一致。
 */
export const RELIGHT_WGSL = /* wgsl */ `
struct Uniforms {
  width: u32,
  height: u32,
  pw: u32,
  ph: u32,
  K: u32,
  tilesX: u32,
  tileSize: u32,
  terms: u32,
  mode: u32,        // 0 lit 1 spec 2 normal 3 multi 4 relief 5 depth
  depthW: u32,
  depthH: u32,
  hasDepth: u32,
  brightness: f32,
  specStrength: f32,
  shininess: f32,
  lineStrength: f32,
  light0: vec4<f32>,
  light1: vec4<f32>,
  light2: vec4<f32>,
  light3: vec4<f32>,
  tint: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> coeffWords: array<u32>;
@group(0) @binding(1) var<storage, read> normalWords: array<u32>;
@group(0) @binding(2) var<storage, read> tileScale: array<f32>;
@group(0) @binding(3) var<storage, read> tileBias: array<f32>;
@group(0) @binding(4) var<uniform> u: Uniforms;
@group(0) @binding(5) var depthTex: texture_2d<f32>;
@group(0) @binding(6) var depthSamp: sampler;

fn coeffByteAt(byteOffset: u32) -> f32 {
  let w: u32 = coeffWords[byteOffset >> 2u];
  let sh: u32 = (byteOffset & 3u) * 8u;
  return f32((w >> sh) & 255u);
}

fn normalByteAt(byteOffset: u32) -> f32 {
  let w: u32 = normalWords[byteOffset >> 2u];
  let sh: u32 = (byteOffset & 3u) * 8u;
  return f32((w >> sh) & 255u) / 255.0;
}

fn coeffAtPixel(ix: u32, iy: u32, c: u32) -> f32 {
  let bo: u32 = (iy * u.pw + ix) * u.K + c;
  let b: f32 = coeffByteAt(bo);
  let tx: u32 = ix / u.tileSize;
  let ty: u32 = iy / u.tileSize;
  let tile: u32 = ty * u.tilesX + tx;
  let idx: u32 = tile * u.K + c;
  return b * tileScale[idx] + tileBias[idx];
}

fn normalAtPixel(ix: u32, iy: u32) -> vec3<f32> {
  let bo: u32 = (iy * u.pw + ix) * 4u;
  let r: f32 = normalByteAt(bo);
  let g: f32 = normalByteAt(bo + 1u);
  let b: f32 = normalByteAt(bo + 2u);
  return normalize(vec3<f32>(r * 2.0 - 1.0, g * 2.0 - 1.0, b * 2.0 - 1.0));
}

fn basisWeights(l: vec3<f32>) -> array<f32, 9> {
  if (u.terms == 6u) {
    let uu: f32 = l.x;
    let vv: f32 = l.y;
    return array<f32, 9>(uu * uu, vv * vv, uu * vv, uu, vv, 1.0, 0.0, 0.0, 0.0);
  }
  // HSH 二阶 9 基(Relight 标准笛卡尔形式)
  let lz: f32 = clamp(l.z, 0.0, 1.0);
  let sz: f32 = sqrt(lz / (1.0 + lz));
  let k0: f32 = 0.39894228;        // 1/sqrt(2pi)
  let k1: f32 = 1.3819766;         // sqrt(6/pi)
  let k2: f32 = 0.6909883;         // sqrt(3/(2pi))
  let k4: f32 = 3.0901936;         // sqrt(30/pi)
  let k6: f32 = 0.89206206;        // sqrt(5/(2pi))
  let lx: f32 = l.x;
  let ly: f32 = l.y;
  let z: f32 = lz;
  return array<f32, 9>(
    k0,
    k1 * lx * sz,
    k2 * (2.0 * z - 1.0),
    k1 * ly * sz,
    -k4 * (lx * lx - ly * ly) * z / (1.0 + z),
    k4 * lx * (2.0 * z - 1.0) * sz,
    k6 * (6.0 * z * z - 6.0 * z + 1.0),
    k4 * ly * (2.0 * z - 1.0) * sz,
    -2.0 * k4 * lx * ly * z / (1.0 + z)
  );
}

fn evalColor(ix: u32, iy: u32, light: vec3<f32>) -> vec3<f32> {
  let w: array<f32, 9> = basisWeights(light);
  var r: f32 = 0.0;
  var g: f32 = 0.0;
  var b: f32 = 0.0;
  let k: u32 = u.terms;
  for (var t: u32 = 0u; t < k; t = t + 1u) {
    r = r + coeffAtPixel(ix, iy, t) * w[t];
    g = g + coeffAtPixel(ix, iy, k + t) * w[t];
    b = b + coeffAtPixel(ix, iy, 2u * k + t) * w[t];
  }
  return vec3<f32>(r, g, b);
}

struct Out { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> }

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> Out {
  var p: vec2<f32>;
  if (vi == 0u) { p = vec2<f32>(-1.0, -1.0); }
  else if (vi == 1u) { p = vec2<f32>(3.0, -1.0); }
  else { p = vec2<f32>(-1.0, 3.0); }
  var o: Out;
  o.pos = vec4<f32>(p, 0.0, 1.0);
  o.color = vec4<f32>(0.0);
  return o;
}

fn depthAt(ix: u32, iy: u32) -> f32 {
  if (u.hasDepth == 0u) { return 0.5; }
  let du: f32 = (f32(ix) + 0.5) / f32(u.width);
  let dv: f32 = (f32(iy) + 0.5) / f32(u.height);
  return textureSampleLevel(depthTex, depthSamp, vec2<f32>(du, dv), 0.0).r;
}

@fragment
fn fsMain(in: Out) -> @location(0) vec4<f32> {
  let ix: u32 = u32(in.pos.x);
  let iy: u32 = u32(in.pos.y);
  if (ix >= u.width || iy >= u.height) { discard; }

  let n: vec3<f32> = normalAtPixel(ix, iy);
  let L: vec3<f32> = normalize(u.light0.xyz);
  let V: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
  let H: vec3<f32> = normalize(L + V);

  var col: vec3<f32>;

  if (u.mode == 2u) {
    // 法线可视化
    col = n * 0.5 + 0.5;
    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }

  if (u.mode == 3u) {
    // 多光源合成(最多 4 盏,light*.w 为强度)
    var sum: vec3<f32> = vec3<f32>(0.0);
    sum = sum + evalColor(ix, iy, normalize(u.light0.xyz)) * u.light0.w;
    sum = sum + evalColor(ix, iy, normalize(u.light1.xyz)) * u.light1.w;
    sum = sum + evalColor(ix, iy, normalize(u.light2.xyz)) * u.light2.w;
    sum = sum + evalColor(ix, iy, normalize(u.light3.xyz)) * u.light3.w;
    // 多次求值会重复累计常数/环境项,做合成衰减避免过曝
    col = sum * u.brightness * 0.42;
    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }

  if (u.mode == 4u) {
    // 浮雕线稿:Sobel 法线不连续性 + 深度淡彩
    let nL: vec3<f32> = normalAtPixel(max(ix, 1u) - 1u, iy);
    let nR: vec3<f32> = normalAtPixel(min(ix + 1u, u.width - 1u), iy);
    let nU: vec3<f32> = normalAtPixel(ix, max(iy, 1u) - 1u);
    let nD: vec3<f32> = normalAtPixel(ix, min(iy + 1u, u.height - 1u));
    let gx: vec3<f32> = nR - nL;
    let gy: vec3<f32> = nD - nU;
    let edge: f32 = clamp(length(gx) + length(gy), 0.0, 2.0);
    let ink: f32 = smoothstep(0.25, 0.9, edge * u.lineStrength);
    let d: f32 = depthAt(ix, iy);
    // 纸张底色 + 深度暖渍
    var paper: vec3<f32> = vec3<f32>(0.91, 0.885, 0.82);
    let wash: vec3<f32> = mix(vec3<f32>(0.78, 0.62, 0.38), vec3<f32>(0.45, 0.28, 0.16), d);
    paper = mix(paper, wash, clamp((d - 0.5) * 0.5, 0.0, 0.35));
    col = mix(paper, vec3<f32>(0.12, 0.09, 0.06), ink);
    return vec4<f32>(col, 1.0);
  }

  if (u.mode == 5u) {
    // 刻痕深浅颜色(深度色带:浅金 -> 铜 -> 深褐)
    let d: f32 = depthAt(ix, iy);
    let c1: vec3<f32> = vec3<f32>(0.83, 0.70, 0.45);
    let c2: vec3<f32> = vec3<f32>(0.62, 0.38, 0.18);
    let c3: vec3<f32> = vec3<f32>(0.20, 0.10, 0.05);
    var ramp: vec3<f32> = mix(c1, c2, smoothstep(0.15, 0.55, d));
    ramp = mix(ramp, c3, smoothstep(0.55, 0.95, d));
    // 叠加 35% 重光照以保留立体细节
    let lit: vec3<f32> = clamp(evalColor(ix, iy, L) * u.brightness, vec3<f32>(0.0), vec3<f32>(1.0));
    col = mix(ramp, lit, 0.32);
    return vec4<f32>(col, 1.0);
  }

  // 0 lit / 1 specular enhancement
  var base: vec3<f32> = evalColor(ix, iy, L);
  if (u.mode == 1u) {
    let diff: f32 = max(dot(n, L), 0.0);
    let spec: f32 = pow(max(dot(n, H), 0.0), u.shininess) * u.specStrength;
    let rim: f32 = pow(1.0 - max(n.z, 0.0), 3.0) * 0.15;
    // 压一点环境底色,用法线漫反射强化刻痕
    let luma: f32 = dot(base, vec3<f32>(0.2126, 0.7152, 0.0722));
    let enhanced: vec3<f32> = base * (0.45 + 0.55 * diff) + vec3<f32>(spec) + vec3<f32>(rim);
    col = mix(enhanced, vec3<f32>(luma) * (0.5 + 0.8 * diff) + vec3<f32>(spec), 0.25);
  } else {
    col = base * u.brightness;
  }
  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
