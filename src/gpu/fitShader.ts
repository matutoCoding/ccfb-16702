/**
 * 拟合 compute 着色器。
 * 数学与 src/core/fit/cpuFit.ts + robustNormal.ts 严格对应:
 *  - 模型系数:c = P_model · I(P 为 CPU 预算的最小二乘投影,k x m)
 *  - 法线:LS 初值 + 4 轮非对称截断 IRLS(镜面正残差加倍惩罚 + 可见性权重)
 */
export const FIT_WGSL = /* wgsl */ `
const MAX_M: u32 = 64u;

struct Params {
  m: u32,
  k: u32,
  coeffCount: u32,
  tilePixels: u32,
  keepCount: u32,
  iterations: u32,
  tileW: u32,
  tileH: u32,
}

@group(0) @binding(0) var<storage, read> samples: array<u32>;
@group(0) @binding(1) var<storage, read> pm: array<f32>;
@group(0) @binding(2) var<storage, read> pn: array<f32>;
@group(0) @binding(3) var<storage, read> gains: array<f32>;
@group(0) @binding(4) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> outCoeff: array<f32>;
@group(0) @binding(6) var<storage, read_write> outNormal: array<f32>;
@group(0) @binding(7) var<uniform> params: Params;

fn srgb_to_linear(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn linear_to_srgb(c: f32) -> f32 {
  let v: f32 = max(c, 0.0);
  if (v <= 0.0031308) { return v * 12.92; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn solve4(Gin: array<f32, 16>, bin: array<f32, 4>) -> array<f32, 4> {
  var M: array<f32, 20>;
  for (var r: u32 = 0u; r < 4u; r = r + 1u) {
    for (var c: u32 = 0u; c < 4u; c = c + 1u) {
      M[r * 5u + c] = Gin[r * 4u + c];
    }
    M[r * 5u + 4u] = bin[r];
  }
  for (var col: u32 = 0u; col < 4u; col = col + 1u) {
    var piv: u32 = col;
    var best: f32 = abs(M[col * 5u + col]);
    for (var r: u32 = col + 1u; r < 4u; r = r + 1u) {
      let v: f32 = abs(M[r * 5u + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-10) { M[col * 5u + col] = M[col * 5u + col] + 1e-6; }
    if (piv != col) {
      for (var c: u32 = 0u; c < 5u; c = c + 1u) {
        let tmp: f32 = M[col * 5u + c];
        M[col * 5u + c] = M[piv * 5u + c];
        M[piv * 5u + c] = tmp;
      }
    }
    let pv: f32 = M[col * 5u + col];
    let pvs: f32 = select(pv, 1e-12, abs(pv) < 1e-12);
    for (var c: u32 = col; c < 5u; c = c + 1u) {
      M[col * 5u + c] = M[col * 5u + c] / pvs;
    }
    for (var r: u32 = 0u; r < 4u; r = r + 1u) {
      if (r == col) { continue; }
      let f: f32 = M[r * 5u + col];
      if (f == 0.0) { continue; }
      for (var c: u32 = col; c < 5u; c = c + 1u) {
        M[r * 5u + c] = M[r * 5u + c] - f * M[col * 5u + c];
      }
    }
  }
  return array<f32, 4>(M[4], M[9], M[14], M[19]);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m: u32 = params.m;
  let k: u32 = params.k;
  let tp: u32 = params.tilePixels;
  if (gid.x >= params.tileW || gid.y >= params.tileH) { return; }
  let p: u32 = gid.y * params.tileW + gid.x;

  // ---- 解码所有灯的线性亮度并累加模型系数 ----
  var yv: array<f32, MAX_M>;
  var cr: array<f32, 9>;
  var cg: array<f32, 9>;
  var cb: array<f32, 9>;

  for (var i: u32 = 0u; i < m; i = i + 1u) {
    let packed: u32 = samples[i * tp + p];
    let rb: f32 = f32(packed & 255u) / 255.0;
    let gb: f32 = f32((packed >> 8u) & 255u) / 255.0;
    let bb: f32 = f32((packed >> 16u) & 255u) / 255.0;
    let gain: f32 = gains[i];
    let r: f32 = srgb_to_linear(rb) * gain;
    let g: f32 = srgb_to_linear(gb) * gain;
    let b: f32 = srgb_to_linear(bb) * gain;
    yv[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 模型系数在 gamma 域拟合(与传统 PTM/外部查看器一致)
    let rg: f32 = linear_to_srgb(r);
    let gg: f32 = linear_to_srgb(g);
    let bg: f32 = linear_to_srgb(b);
    for (var c: u32 = 0u; c < k; c = c + 1u) {
      let wgt: f32 = pm[c * m + i];
      cr[c] = cr[c] + wgt * rg;
      cg[c] = cg[c] + wgt * gg;
      cb[c] = cb[c] + wgt * bg;
    }
  }

  let cc: u32 = params.coeffCount;
  for (var c: u32 = 0u; c < k; c = c + 1u) {
    outCoeff[p * cc + c] = cr[c];
    outCoeff[p * cc + k + c] = cg[c];
    outCoeff[p * cc + 2u * k + c] = cb[c];
  }

  // ---- 稳健法线:LS 初值 ----
  var nc: array<f32, 4>;
  for (var j: u32 = 0u; j < 4u; j = j + 1u) {
    var s: f32 = 0.0;
    for (var i: u32 = 0u; i < m; i = i + 1u) {
      s = s + pn[j * m + i] * yv[i];
    }
    nc[j] = s;
  }

  // ---- 非对称截断 IRLS(与 robustNormal.ts 对应) ----
  for (var it: u32 = 0u; it < params.iterations; it = it + 1u) {
    var scores: array<f32, MAX_M>;
    var sorted: array<f32, MAX_M>;
    for (var i: u32 = 0u; i < m; i = i + 1u) {
      let L: vec4<f32> = lights[i];
      let pred: f32 = nc[0] * L.x + nc[1] * L.y + nc[2] * L.z + nc[3];
      let r: f32 = yv[i] - pred;
      let sc: f32 = select(-r, r * 2.2, r > 0.0);
      scores[i] = sc;
      sorted[i] = sc;
    }
    // 插入排序
    for (var i: u32 = 1u; i < m; i = i + 1u) {
      let v: f32 = sorted[i];
      var j: i32 = i32(i) - 1;
      while (j >= 0 && sorted[u32(j)] > v) {
        sorted[u32(j + 1)] = sorted[u32(j)];
        j = j - 1;
      }
      sorted[u32(j + 1)] = v;
    }
    let thresh: f32 = sorted[params.keepCount - 1u];

    let nLen: f32 = max(length(vec3<f32>(nc[0], nc[1], nc[2])), 1e-6);
    let nx: f32 = nc[0] / nLen;
    let ny: f32 = nc[1] / nLen;
    let nz: f32 = nc[2] / nLen;

    var G: array<f32, 16>;
    var rhs: array<f32, 4>;
    for (var i: u32 = 0u; i < m; i = i + 1u) {
      if (scores[i] > thresh + 1e-12) { continue; }
      let L: vec4<f32> = lights[i];
      let ndl: f32 = nx * L.x + ny * L.y + nz * L.z;
      var w: f32 = 1.0;
      if (ndl < 0.05) { w = max(0.05, (ndl + 0.15) / 0.2); }
      let a0: f32 = L.x;
      let a1: f32 = L.y;
      let a2: f32 = L.z;
      let a3: f32 = 1.0;
      rhs[0] = rhs[0] + w * a0 * yv[i];
      rhs[1] = rhs[1] + w * a1 * yv[i];
      rhs[2] = rhs[2] + w * a2 * yv[i];
      rhs[3] = rhs[3] + w * a3 * yv[i];
      let a = array<f32, 4>(a0, a1, a2, a3);
      for (var r: u32 = 0u; r < 4u; r = r + 1u) {
        for (var c: u32 = 0u; c < 4u; c = c + 1u) {
          G[r * 4u + c] = G[r * 4u + c] + w * a[r] * a[c];
        }
      }
    }
    nc = solve4(G, rhs);
  }

  outNormal[p * 4u] = nc[0];
  outNormal[p * 4u + 1u] = nc[1];
  outNormal[p * 4u + 2u] = nc[2];
  outNormal[p * 4u + 3u] = nc[3];
}
`;
