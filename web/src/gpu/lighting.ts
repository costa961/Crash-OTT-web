// WGSL for crashott-pc's lighting remaster (runtime/gpu/lighting.cpp, LIGHTING_HLSL; MIT, VitoMiguelF
// and contributors) and the motion vector passes it reads (runtime/gpu/xenos_renderer.cpp, MOTION_PS
// and the CRASH_GPU_SHOW_MOTION debug view MOTION_VIEW_PS). The gather pass is the visibility
// bitmask of Therrien, Levesque and Gilet 2023, "Screen Space Indirect Lighting with Visibility
// Bitmask", as in lighting.cpp. Same math and constant layouts as the HLSL.
//
// Bindings (lighting.cpp CreatePipeline / Draw): @binding(0) the 128-byte cbuffer below, t0..t6 at
// @binding(1..7), s1 = linear clamp at @binding(10). Every pass is drawn by the shared full-screen
// triangle (passes.ts FULLSCREEN_VS); the HLSL vertex stage is the same triangle.
// Differences from the HLSL, none of which changes a result:
//   - the point-clamp samples (s0) of the temporal pass are textureLoads of the texel point sampling
//     picks (floor(uv * size), clamped): its view z history is r32float, which a filtering sampler
//     can't read under layout 'auto' without float32-filterable;
//   - each module declares only the textures its pass reads (layout 'auto' drops unused bindings).
// The scene depth these passes read is the renderer's R32_FLOAT depth resolve (a colour texture), so
// textureLoad on a texture_2d<f32> is what HLSL's Load is.

const COMMON = /* wgsl */ `
struct Constants {
  proj : vec4f,          // view -> clip: P00, P02, P11, P12
  projZ : vec4f,         // P22, P23, P32, P33
  depthParams : vec4f,   // window depth = ndc z * x + y; z: far fade start; w: sky (view z beyond it)
  sizes : vec4f,         // AO target width, height; scene width, height
  aoParams : vec4f,      // radius, thickness, AO strength, indirect light intensity
  lightView : vec4f,     // contact shadow ray direction (view space), strength
  shadowParams : vec4f,  // ray length, thickness, far fade end, unused
  control : vec4u,       // x: flags, y: frame, z: slices, w: steps per side
}
@group(0) @binding(0) var<uniform> cb : Constants;

const FLAG_AO = 1u;
const FLAG_IL = 2u;
const FLAG_SHADOW = 4u;
const FLAG_TEMPORAL = 8u;
const FLAG_HALF = 16u;
const FLAG_SHOW_AO = 32u;
const FLAG_SHOW_IL = 64u;
const FLAG_SHOW_SHADOW = 128u;
const FLAG_HISTORY = 256u;
const FLAG_VERTICAL = 512u;
const FLAG_SPLIT = 1024u;

const PI = 3.14159265;

fn has(flag : u32) -> bool { return (cb.control.x & flag) != 0u; }

// View z of a window depth; 0 for the sky / cleared depth and beyond the sky distance.
fn ViewZ(d : f32) -> f32 {
  let ndcZ = (d - cb.depthParams.y) / cb.depthParams.x;
  let z = (cb.projZ.y - ndcZ * cb.projZ.w) / (ndcZ * cb.projZ.z - cb.projZ.x);
  return select(0.0, z, z > 0.0 && z < cb.depthParams.w);
}

fn ViewPos(uv : vec2f, z : f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let w = cb.projZ.z * z + cb.projZ.w;
  return vec3f((ndc.x * w - cb.proj.y * z) / cb.proj.x, (ndc.y * w - cb.proj.w * z) / cb.proj.z, z);
}

fn ProjectUV(v : vec3f) -> vec2f {
  let w = cb.projZ.z * v.z + cb.projZ.w;
  let ndc = vec2f(cb.proj.x * v.x + cb.proj.y * v.z, cb.proj.z * v.y + cb.proj.w * v.z) / w;
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn Scale() -> f32 { return select(1.0, 2.0, has(FLAG_HALF)); }

// Scene uv of the scene pixel an AO texel stands for (its top-left one at half resolution).
fn RepUV(ap : vec2i) -> vec2f { return (vec2f(ap) * Scale() + 0.5) / cb.sizes.zw; }

// Interleaved gradient noise (Jimenez 2014), shifted every frame when accumulating.
fn Ign(p0 : vec2f, frame : u32) -> f32 {
  let p = p0 + 5.588238 * f32(frame & 63u);
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn FastAcos(x : f32) -> f32 {
  let ax = min(abs(x), 1.0);
  var r = ((-0.0187293 * ax + 0.0742610) * ax - 0.2121144) * ax + 1.5707288;
  r *= sqrt(1.0 - ax);
  return select(PI - r, r, x >= 0.0);
}

// Bits of the 32 sectors of [0, 1] covered by [a, b].
fn SectorBits(a0 : f32, b0 : f32) -> u32 {
  let a = saturate(a0);
  let b = saturate(b0);
  let start = min(u32(a * 32.0), 31u);
  let count = u32(ceil((b - a) * 32.0));
  if (count == 0u) { return 0u; }
  var bits = 0xFFFFFFFFu;
  if (count < 32u) { bits = (1u << count) - 1u; }
  return bits << start;
}

fn FarFade(z : f32) -> f32 { return 1.0 - smoothstep(cb.depthParams.z, cb.shadowParams.z, z); }
`;

// t0: scene depth. -> view z, view normal (from the depth of the neighbours on the flatter side).
const PREP = /* wgsl */ `${COMMON}
@group(0) @binding(1) var t0 : texture_2d<f32>;

fn LoadZ(p0 : vec2i) -> f32 {
  let p = clamp(p0, vec2i(0, 0), vec2i(cb.sizes.zw) - vec2i(1));
  return ViewZ(textureLoad(t0, p, 0).x);
}
fn PosAt(p : vec2i, z : f32) -> vec3f { return ViewPos((vec2f(p) + 0.5) / cb.sizes.zw, z); }
fn Healable(a : f32, b : f32, z : f32) -> bool {
  let nearest = max(a, b);
  return a > 0.0 && b > 0.0 && abs(a - b) < 0.02 * nearest + 0.03 && (z <= 0.0 || z - nearest > 0.003 * z + 0.01);
}
// Cracks between meshes (1-2 pixels where what is behind, or the sky, shows through) would be deep
// trenches for the AO: take the depth of the sides.
fn HealedZ(p : vec2i) -> f32 {
  let z = LoadZ(p);
  for (var axis = 0; axis < 2; axis++) {
    let d = select(vec2i(0, 1), vec2i(1, 0), axis == 0);
    let a1 = LoadZ(p - d);
    let b1 = LoadZ(p + d);
    let a2 = LoadZ(p - 2 * d);
    let b2 = LoadZ(p + 2 * d);
    // pairs (a1, b1), (a1, b2), (a2, b1), in that order
    if (Healable(a1, b1, z)) { return 0.5 * (a1 + b1); }
    if (Healable(a1, b2, z)) { return 0.5 * (a1 + b2); }
    if (Healable(a2, b1, z)) { return 0.5 * (a2 + b1); }
  }
  return z;
}
struct Out { @location(0) z : f32, @location(1) n : vec4f }
@fragment fn main(@builtin(position) position : vec4f) -> Out {
  let p = vec2i(position.xy) * i32(Scale());
  var o : Out;
  let z = HealedZ(p);
  o.z = z;
  o.n = vec4f(0.0);
  if (z <= 0.0) { return o; }
  let c = PosAt(p, z);
  let zr = LoadZ(p + vec2i(1, 0));
  let zl = LoadZ(p - vec2i(1, 0));
  let zd = LoadZ(p + vec2i(0, 1));
  let zu = LoadZ(p - vec2i(0, 1));
  let right = zr > 0.0 && (zl <= 0.0 || abs(zr - z) < abs(zl - z));
  let down = zd > 0.0 && (zu <= 0.0 || abs(zd - z) < abs(zu - z));
  var dx = vec3f(1.0, 0.0, 0.0);
  if (right) { dx = PosAt(p + vec2i(1, 0), zr) - c; } else if (zl > 0.0) { dx = c - PosAt(p - vec2i(1, 0), zl); }
  var dy = vec3f(0.0, -1.0, 0.0);
  if (down) { dy = PosAt(p + vec2i(0, 1), zd) - c; } else if (zu > 0.0) { dy = c - PosAt(p - vec2i(0, 1), zu); }
  var n = cross(dx, dy);
  if (dot(n, n) > 1e-20) { n = normalize(n); } else { n = -normalize(c); }
  if (dot(n, c) > 0.0) { n = -n; }
  o.n = vec4f(n, 1.0);
  return o;
}`;

// t0: view z, t1: normal (AO resolution), t2: scene colour, t3: scene depth.
// -> (indirect light rgb, visibility), contact shadow visibility.
const GATHER = /* wgsl */ `${COMMON}
@group(0) @binding(1) var t0 : texture_2d<f32>;
@group(0) @binding(2) var t1 : texture_2d<f32>;
@group(0) @binding(3) var t2 : texture_2d<f32>;
@group(0) @binding(4) var t3 : texture_2d<f32>;
@group(0) @binding(10) var linearClamp : sampler;

struct Out { @location(0) a : vec4f, @location(1) s : f32 }
@fragment fn main(@builtin(position) position : vec4f) -> Out {
  var o : Out;
  o.a = vec4f(0.0, 0.0, 0.0, 1.0);
  o.s = 1.0;
  let ap = vec2i(position.xy);
  let z = textureLoad(t0, ap, 0).x;
  if (z <= 0.0) { return o; }
  let N = textureLoad(t1, ap, 0).xyz;
  let P = ViewPos(RepUV(ap), z);
  let V = normalize(-P);
  let fade = FarFade(z);
  if (fade <= 0.0) { return o; }
  let frame = select(0u, cb.control.y, has(FLAG_TEMPORAL));
  let noiseSlice = Ign(vec2f(ap), frame);
  let noiseStep = Ign(vec2f(ap) + vec2f(19.0, 47.0), frame);

  let w = cb.projZ.z * z + cb.projZ.w;
  let pixelsPerUnit = cb.proj.z * 0.5 * cb.sizes.y / w;
  let radius = cb.aoParams.x;
  let radiusPx = min(radius * pixelsPerUnit, 0.2 * cb.sizes.y);
  if ((cb.control.x & (FLAG_AO | FLAG_IL)) != 0u && radiusPx >= 2.0) {
    var indirect = vec3f(0.0);
    var visibility = 0.0;
    let slices = cb.control.z;
    let steps = cb.control.w;
    for (var s = 0u; s < slices; s++) {
      let phi = (f32(s) + noiseSlice) * PI / f32(slices);
      let omega = vec2f(cos(phi), sin(phi));
      let direction = vec3f(omega.x, -omega.y, 0.0);
      let ortho = direction - dot(direction, V) * V;
      let axis = cross(direction, V);
      let projN = N - axis * dot(N, axis) / max(dot(axis, axis), 1e-8);
      let cosN = saturate(dot(projN, V) / max(length(projN), 1e-5));
      let n = select(-1.0, 1.0, dot(ortho, projN) >= 0.0) * FastAcos(cosN);
      var mask = 0u;
      for (var side = 0u; side < 2u; side++) {
        let sgn = select(-1.0, 1.0, side == 0u);
        for (var k = 0u; k < steps; k++) {
          let t = (f32(k) + fract(noiseStep + 0.5 * f32(side))) / f32(steps);
          let offset = max(t * t * radiusPx, f32(k) + 1.0);
          let sp = vec2i(floor(vec2f(ap) + 0.5 + sgn * omega * offset));
          if (any(sp < vec2i(0)) || any(sp >= vec2i(cb.sizes.xy))) { break; }
          let sz = textureLoad(t0, sp, 0).x;
          if (sz <= 0.0) { continue; }
          let delta = ViewPos(RepUV(sp), sz) - P;
          let len = length(delta);
          if (len < 1e-5 || len > 2.0 * radius) { continue; }
          // Small steps (terrain seams, decals) barely above the surface: no occluders.
          if (dot(delta, N) < 0.07 + 0.004 * z) { continue; }
          let L = delta / len;
          let front = FastAcos(dot(L, V));
          let back = FastAcos(dot(normalize(delta - V * cb.aoParams.y), V));
          let a0 = select(-back, front, sgn > 0.0);
          let a1 = select(-front, back, sgn > 0.0);
          var bits = SectorBits((a0 - n) / PI + 0.5, (a1 - n) / PI + 0.5);
          // Farther than the radius: occludes less, fading out at twice the radius.
          if (len > radius) {
            bits &= select(0x55555555u, 0xFFFFFFFFu, u32(saturate(2.0 - len / radius) * 32.0) >= 16u);
          }
          if (has(FLAG_IL)) {
            let fresh = bits & ~mask;
            if (fresh != 0u) {
              let Ns = textureLoad(t1, sp, 0).xyz;
              let emit = saturate(dot(Ns, -L) * 0.75 + 0.25);
              let color = textureSampleLevel(t2, linearClamp, (vec2f(sp) + 0.5) / cb.sizes.xy, 0.0).rgb;
              indirect += f32(countOneBits(fresh)) * (1.0 / 32.0) * color * emit * saturate(dot(N, L));
            }
          }
          mask |= bits;
        }
      }
      visibility += 1.0 - f32(countOneBits(mask)) * (1.0 / 32.0);
    }
    visibility /= f32(slices);
    indirect /= f32(slices);
    o.a = vec4f(indirect * fade, mix(1.0, visibility, fade));
  }

  // Contact shadows: a short march upwards (lightView) in the full resolution depth.
  if (has(FLAG_SHADOW) && cb.lightView.w > 0.0) {
    let Ld = cb.lightView.xyz;
    let ndl = dot(N, Ld);
    if (ndl > 0.0) {
      let origin = P + N * (0.003 * z + 0.01);
      let noise = Ign(vec2f(ap) + vec2f(71.0, 13.0), frame);
      var occlusion = 0.0;
      const STEPS = 16u;
      for (var i = 0u; i < STEPS; i++) {
        let t = (f32(i) + noise) / f32(STEPS);
        let dist = t * t * cb.shadowParams.x;
        let Q = origin + Ld * dist;
        if (Q.z <= 0.05) { break; }
        let quv = ProjectUV(Q);
        if (any(quv <= vec2f(0.0)) || any(quv >= vec2f(1.0))) { break; }
        let sz = ViewZ(textureLoad(t3, vec2i(quv * cb.sizes.zw), 0).x);
        if (sz <= 0.0) { continue; }
        let dz = Q.z - sz;
        if (dz > 0.003 * Q.z + 0.01 && dz < cb.shadowParams.y) {
          occlusion = 1.0 - t * t;
          break;
        }
      }
      o.s = 1.0 - occlusion * cb.lightView.w * smoothstep(0.0, 0.3, ndl) * fade;
    }
  }
  return o;
}`;

// t0, t1: this frame's gather; t2, t3, t4: history (a, s, view z); t5: motion (scene uv offset to
// last frame); t6: view z.
const TEMPORAL = /* wgsl */ `${COMMON}
@group(0) @binding(1) var t0 : texture_2d<f32>;
@group(0) @binding(2) var t1 : texture_2d<f32>;
@group(0) @binding(3) var t2 : texture_2d<f32>;
@group(0) @binding(4) var t3 : texture_2d<f32>;
@group(0) @binding(5) var t4 : texture_2d<f32>;
@group(0) @binding(6) var t5 : texture_2d<f32>;
@group(0) @binding(7) var t6 : texture_2d<f32>;
@group(0) @binding(10) var linearClamp : sampler;

// SampleLevel(pointClamp, uv, 0): the texel nearest filtering picks, clamped to the edge.
fn PointClamp(t : texture_2d<f32>, uv : vec2f) -> vec4f {
  let size = vec2i(textureDimensions(t, 0));
  return textureLoad(t, clamp(vec2i(floor(uv * vec2f(size))), vec2i(0), size - vec2i(1)), 0);
}

struct Out { @location(0) a : vec4f, @location(1) s : f32, @location(2) z : f32 }
@fragment fn main(@builtin(position) position : vec4f) -> Out {
  let ap = vec2i(position.xy);
  var o : Out;
  o.a = textureLoad(t0, ap, 0);
  o.s = textureLoad(t1, ap, 0).x;
  let z = textureLoad(t6, ap, 0).x;
  o.z = z;
  if (!has(FLAG_HISTORY) || z <= 0.0) { return o; }
  let uv = RepUV(ap);
  let previous = uv + PointClamp(t5, uv).xy;
  if (any(previous <= vec2f(0.0)) || any(previous >= vec2f(1.0))) { return o; }
  // The AO texture's uv of that scene point (its texels stand for their top-left scene pixel).
  let aoUV = previous + (Scale() - 1.0) * 0.5 / cb.sizes.zw;
  let hz = PointClamp(t4, aoUV).x;
  if (hz <= 0.0 || abs(hz - z) > 0.04 * z + 0.02) { return o; }
  let ha = textureSampleLevel(t2, linearClamp, aoUV, 0.0);
  let hs = textureSampleLevel(t3, linearClamp, aoUV, 0.0).x;
  const blendWeight = 0.12;
  o.a = mix(ha, o.a, blendWeight);
  o.s = mix(hs, o.s, blendWeight);
  return o;
}`;

// t0, t1: input (a, s); t2: view z; t3: normal. Horizontal or vertical (FLAG_VERTICAL).
const BLUR = /* wgsl */ `${COMMON}
@group(0) @binding(1) var t0 : texture_2d<f32>;
@group(0) @binding(2) var t1 : texture_2d<f32>;
@group(0) @binding(3) var t2 : texture_2d<f32>;
@group(0) @binding(4) var t3 : texture_2d<f32>;

struct Out { @location(0) a : vec4f, @location(1) s : f32 }
@fragment fn main(@builtin(position) position : vec4f) -> Out {
  let ap = vec2i(position.xy);
  var o : Out;
  o.a = textureLoad(t0, ap, 0);
  o.s = textureLoad(t1, ap, 0).x;
  let z = textureLoad(t2, ap, 0).x;
  if (z <= 0.0) { return o; }
  let n = textureLoad(t3, ap, 0).xyz;
  let direction = select(vec2i(1, 0), vec2i(0, 1), has(FLAG_VERTICAL));
  var sumA = o.a;
  var sumS = o.s;
  var total = 1.0;
  for (var i = -4; i <= 4; i++) {
    if (i == 0) { continue; }
    let q = ap + direction * i;
    if (any(q < vec2i(0)) || any(q >= vec2i(cb.sizes.xy))) { continue; }
    let zq = textureLoad(t2, q, 0).x;
    if (zq <= 0.0) { continue; }
    let nq = textureLoad(t3, q, 0).xyz;
    let weight = exp(-f32(i * i) / 12.0) * saturate(1.0 - abs(zq - z) / (0.02 * z + 0.01)) * pow(saturate(dot(n, nq)), 8.0);
    sumA += textureLoad(t0, q, 0) * weight;
    sumS += textureLoad(t1, q, 0).x * weight;
    total += weight;
  }
  o.a = sumA / total;
  o.s = sumS / total;
  return o;
}`;

// t0: scene colour (copy), t1: scene depth, t2, t3: filtered (a, s), t4: AO view z.
const COMPOSITE = /* wgsl */ `${COMMON}
@group(0) @binding(1) var t0 : texture_2d<f32>;
@group(0) @binding(2) var t1 : texture_2d<f32>;
@group(0) @binding(3) var t2 : texture_2d<f32>;
@group(0) @binding(4) var t3 : texture_2d<f32>;
@group(0) @binding(5) var t4 : texture_2d<f32>;

@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy);
  let c = textureLoad(t0, p, 0);
  // Before / after: the left half keeps the original (a thin line marks the split).
  if (has(FLAG_SPLIT)) {
    let halfWidth = i32(cb.sizes.z) / 2;
    if (p.x < halfWidth - 1) { return c; }
    if (p.x <= halfWidth) { return vec4f(1.0, 1.0, 1.0, c.a); }
  }
  let z = ViewZ(textureLoad(t1, p, 0).x);
  let show = (cb.control.x & (FLAG_SHOW_AO | FLAG_SHOW_IL | FLAG_SHOW_SHADOW)) != 0u;
  if (z <= 0.0) {
    if (show) { return vec4f(1.0, 1.0, 1.0, c.a) * select(1.0, 0.0, has(FLAG_SHOW_IL)); }
    return c;
  }
  var a : vec4f;
  var s : f32;
  if (has(FLAG_HALF)) {
    // Bilateral upsampling: the four AO texels around, bilinear weights times depth similarity.
    let f = vec2f(p) * 0.5;
    let base = vec2i(floor(f));
    let fr = f - vec2f(base);
    a = vec4f(0.0);
    s = 0.0;
    var total = 0.0;
    for (var j = 0; j < 4; j++) {
      let o = vec2i(j & 1, j >> 1u);
      let q = min(base + o, vec2i(cb.sizes.xy) - vec2i(1));
      let zq = textureLoad(t4, q, 0).x;
      let bilinear = select(1.0 - fr.x, fr.x, o.x != 0) * select(1.0 - fr.y, fr.y, o.y != 0);
      let weight = (bilinear + 1e-3) * select(1e-3, 1.0 / (abs(zq - z) / z + 0.01), zq > 0.0);
      a += textureLoad(t2, q, 0) * weight;
      s += textureLoad(t3, q, 0).x * weight;
      total += weight;
    }
    a /= total;
    s /= total;
  } else {
    a = textureLoad(t2, p, 0);
    s = textureLoad(t3, p, 0).x;
  }
  var ao = 1.0;
  if (has(FLAG_AO)) {
    ao = mix(1.0, a.a, cb.aoParams.z);
    // Bright pixels (emissive, highlights, the sun on a wall) keep most of their light.
    let bright = smoothstep(0.75, 1.0, max(c.r, max(c.g, c.b)));
    ao = mix(ao, 1.0, 0.6 * bright);
  }
  let indirect = select(vec3f(0.0), a.rgb * cb.aoParams.w, has(FLAG_IL));
  if (has(FLAG_SHOW_AO)) { return vec4f(vec3f(ao), c.a); }
  if (has(FLAG_SHOW_IL)) { return vec4f(indirect, c.a); }
  if (has(FLAG_SHOW_SHADOW)) { return vec4f(vec3f(s), c.a); }
  // Never darker than this fraction of the original (gaps under walls or props, where AO and the
  // contact shadow add up, would otherwise turn into black lines).
  let darkening = max(ao * s, 0.5);
  return vec4f(c.rgb * (darkening + indirect), c.a);
}`;

// xenos_renderer.cpp MOTION_PS: scene uv offset to last frame. The game's velocity map where it
// wrote one (alpha 1), else the camera's reprojection of the depth. The HLSL matrices are
// row_major and used as mul(M, v): the same 16 floats read as a WGSL (column-major) mat4x4f are
// M transposed, so M v is v * m.
const MOTION_VECTORS = /* wgsl */ `
struct MotionConstants {
  inverseViewProj : mat4x4f,   // this frame, without the jitter
  previousViewProj : mat4x4f,  // last frame
  renderSize : vec2f,          // pixels of the scene region
  zScale : f32,                // window depth = ndc z * zScale + zOffset
  zOffset : f32,
  velocityScale : f32,         // K
  flags : u32,                 // 1: velocity map, 2: camera matrices
}
@group(0) @binding(0) var<uniform> cb : MotionConstants;
@group(0) @binding(1) var depthTex : texture_2d<f32>;
@group(0) @binding(2) var velocityTex : texture_2d<f32>;

@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec2f {
  let p = vec2i(position.xy);
  let uv = position.xy / cb.renderSize;
  if ((cb.flags & 1u) != 0u) {
    // Resolved with red/blue swapped: x in blue, y in green.
    let v = textureLoad(velocityTex, p, 0);
    if (v.a > 0.5) {
      let d = (vec2f(v.b, v.g) - 0.5) / cb.velocityScale;
      return vec2f(-d.x, d.y) * 0.5;
    }
  }
  if ((cb.flags & 2u) == 0u) { return vec2f(0.0); }
  let depth = textureLoad(depthTex, p, 0).x;
  let clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, (depth - cb.zOffset) / cb.zScale, 1.0);
  var world = clip * cb.inverseViewProj;
  world /= world.w;
  let previous = world * cb.previousViewProj;
  let previousNdc = previous.xy / previous.w;
  return vec2f(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5) - uv;
}`;

// xenos_renderer.cpp MOTION_VIEW_PS (CRASH_GPU_SHOW_MOTION=<scale>): red/green = 0.5 + x/y * scale,
// blue = 1 where the game's velocity map wrote the vector.
const MOTION_VIEW = /* wgsl */ `
struct ViewConstants { scale : f32, unused0 : f32, unused1 : f32, unused2 : f32 }
@group(0) @binding(0) var<uniform> cb : ViewConstants;
@group(0) @binding(1) var motion : texture_2d<f32>;
@group(0) @binding(2) var velocityTex : texture_2d<f32>;

@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy);
  let m = textureLoad(motion, p, 0).xy;
  return vec4f(0.5 + m * cb.scale, select(0.0, 1.0, textureLoad(velocityTex, p, 0).a > 0.5), 1.0);
}`;

/** The lighting remaster's passes ("lighting_" + pass, lighting.cpp CreatePipeline) and the motion
 *  vector passes (xenos_renderer.cpp CreateTemporalPipeline), by PassPipelineDesc::name. */
export const LIGHTING_PASS_PS: Record<string, string> = {
  lighting_PREP: PREP,
  lighting_GATHER: GATHER,
  lighting_TEMPORAL: TEMPORAL,
  lighting_BLUR: BLUR,
  lighting_COMPOSITE: COMPOSITE,
  motion_vectors: MOTION_VECTORS,
  motion_view: MOTION_VIEW,
};
