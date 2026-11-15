// WGSL for crashott-pc's SMAA 1x passes (runtime/gpu/smaa.cpp; MIT, VitoMiguelF and contributors),
// a port of SMAA.hlsl (thirdparty/smaa; MIT, Copyright (C) 2013 Jorge Jimenez, Jose I. Echevarria,
// Belen Masia, Fernando Navarro, Diego Gutierrez; SMAA by Jimenez, Echevarria, Sousa, Gutierrez).
// The path smaa.cpp compiles: SMAA_PRESET_HIGH, luma edge detection, no predication, no
// reprojection, subsampleIndices = 0 (SMAA 1x).
//
// Bindings (smaa.cpp's PassPipelineDesc / DrawPass):
//   @binding(0)  cbuffer SmaaConstants { float4 smaa_rt_metrics; } = (1/w, 1/h, w, h)
//   @binding(1..3) t0..t2:  edges   = source colour (rgba8unorm)
//                           weights = edges (rg8unorm), AreaTex (rg8unorm 160x560), SearchTex (r8unorm 64x16)
//                           blend   = source colour, weights (rgba8unorm)
//   @binding(9)  s0 = LinearSampler (linear, clamp), @binding(10) s1 = PointSampler (point, clamp)
// SMAA's vertex shaders (SMAA*VS) only compute texcoord offsets: here they are computed in the
// fragment shader from the pixel position (every pass is drawn at the target's full size, so
// texcoord = position.xy * SMAA_RT_METRICS.xy is what the HLSL VS interpolates). SMAASample (an
// implicit-LOD sample) becomes textureSampleLevel(.., 0): the textures have one level and WGSL
// requires uniform control flow for implicit derivatives.

const COMMON = /* wgsl */ `
struct SmaaConstants { rt : vec4f }
@group(0) @binding(0) var<uniform> c : SmaaConstants;
`;

const EDGES = /* wgsl */ `${COMMON}
@group(0) @binding(1) var colorTex : texture_2d<f32>;
@group(0) @binding(10) var pointSampler : sampler;

const SMAA_THRESHOLD = 0.1;
const SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR = 2.0;

fn lumaAt(uv : vec2f) -> f32 {
  return dot(textureSampleLevel(colorTex, pointSampler, uv, 0.0).rgb, vec3f(0.2126, 0.7152, 0.0722));
}

// SMAAEdgeDetectionVS + SMAALumaEdgeDetectionPS
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let texcoord = position.xy * c.rt.xy;
  let offset0 = c.rt.xyxy * vec4f(-1.0, 0.0, 0.0, -1.0) + texcoord.xyxy;
  let offset1 = c.rt.xyxy * vec4f( 1.0, 0.0, 0.0,  1.0) + texcoord.xyxy;
  let offset2 = c.rt.xyxy * vec4f(-2.0, 0.0, 0.0, -2.0) + texcoord.xyxy;

  let threshold = vec2f(SMAA_THRESHOLD, SMAA_THRESHOLD);
  let L = lumaAt(texcoord);
  let Lleft = lumaAt(offset0.xy);
  let Ltop = lumaAt(offset0.zw);
  let deltaXY = abs(L - vec2f(Lleft, Ltop));
  var edges = step(threshold, deltaXY);
  if (dot(edges, vec2f(1.0, 1.0)) == 0.0) { discard; }

  let Lright = lumaAt(offset1.xy);
  let Lbottom = lumaAt(offset1.zw);
  var maxDelta = max(deltaXY, abs(L - vec2f(Lright, Lbottom)));
  let Lleftleft = lumaAt(offset2.xy);
  let Ltoptop = lumaAt(offset2.zw);
  maxDelta = max(maxDelta, abs(vec2f(Lleft, Ltop) - vec2f(Lleftleft, Ltoptop)));
  let finalDelta = max(maxDelta.x, maxDelta.y);
  edges = edges * step(vec2f(finalDelta), SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR * deltaXY);
  return vec4f(edges, 0.0, 0.0);
}`;

const WEIGHTS = /* wgsl */ `${COMMON}
@group(0) @binding(1) var edgesTex : texture_2d<f32>;
@group(0) @binding(2) var areaTex : texture_2d<f32>;
@group(0) @binding(3) var searchTex : texture_2d<f32>;
@group(0) @binding(9) var linearSampler : sampler;

const SMAA_MAX_SEARCH_STEPS = 16.0;
const SMAA_MAX_SEARCH_STEPS_DIAG = 8.0;
const SMAA_CORNER_ROUNDING_NORM = 0.25;
const SMAA_AREATEX_MAX_DISTANCE = 16.0;
const SMAA_AREATEX_MAX_DISTANCE_DIAG = 20.0;
const SMAA_AREATEX_PIXEL_SIZE = vec2f(1.0 / 160.0, 1.0 / 560.0);
const SMAA_AREATEX_SUBTEX_SIZE = 1.0 / 7.0;
const SMAA_SEARCHTEX_SIZE = vec2f(66.0, 33.0);
const SMAA_SEARCHTEX_PACKED_SIZE = vec2f(64.0, 16.0);

fn edgesAt(uv : vec2f) -> vec2f { return textureSampleLevel(edgesTex, linearSampler, uv, 0.0).rg; }

fn decodeDiag2(e : vec2f) -> vec2f {
  var r = e;
  r.x = r.x * abs(5.0 * r.x - 5.0 * 0.75);
  return round(r);
}
fn decodeDiag4(e : vec4f) -> vec4f {
  var r = e;
  let rb = r.xz * abs(5.0 * r.xz - 5.0 * 0.75);
  r.x = rb.x; r.z = rb.y;
  return round(r);
}

// SMAASearchDiag1 / SMAASearchDiag2: xy = coord.zw, zw = the last edges read ('out e').
fn searchDiag1(texcoord : vec2f, dir : vec2f) -> vec4f {
  var coord = vec4f(texcoord, -1.0, 1.0);
  let t = vec3f(c.rt.xy, 1.0);
  var e = vec2f(0.0);
  while (coord.z < SMAA_MAX_SEARCH_STEPS_DIAG - 1.0 && coord.w > 0.9) {
    let xyz = t * vec3f(dir, 1.0) + coord.xyz;
    coord = vec4f(xyz, coord.w);
    e = edgesAt(coord.xy);
    coord.w = dot(e, vec2f(0.5, 0.5));
  }
  return vec4f(coord.zw, e);
}
fn searchDiag2(texcoord : vec2f, dir : vec2f) -> vec4f {
  var coord = vec4f(texcoord, -1.0, 1.0);
  coord.x += 0.25 * c.rt.x;
  let t = vec3f(c.rt.xy, 1.0);
  var e = vec2f(0.0);
  while (coord.z < SMAA_MAX_SEARCH_STEPS_DIAG - 1.0 && coord.w > 0.9) {
    let xyz = t * vec3f(dir, 1.0) + coord.xyz;
    coord = vec4f(xyz, coord.w);
    e = decodeDiag2(edgesAt(coord.xy));
    coord.w = dot(e, vec2f(0.5, 0.5));
  }
  return vec4f(coord.zw, e);
}

fn areaDiag(dist : vec2f, e : vec2f, offset : f32) -> vec2f {
  var texcoord = vec2f(SMAA_AREATEX_MAX_DISTANCE_DIAG) * e + dist;
  texcoord = SMAA_AREATEX_PIXEL_SIZE * texcoord + 0.5 * SMAA_AREATEX_PIXEL_SIZE;
  texcoord.x += 0.5;
  texcoord.y += SMAA_AREATEX_SUBTEX_SIZE * offset;
  return textureSampleLevel(areaTex, linearSampler, texcoord, 0.0).rg;
}

fn calculateDiagWeights(texcoord : vec2f, e : vec2f, subsampleIndices : vec4f) -> vec2f {
  var weights = vec2f(0.0);
  var d = vec4f(0.0);
  if (e.x > 0.0) {
    let s = searchDiag1(texcoord, vec2f(-1.0, 1.0));
    d.x = s.x + f32(s.w > 0.9); d.z = s.y;
  } else {
    d.x = 0.0; d.z = 0.0;
  }
  let s1 = searchDiag1(texcoord, vec2f(1.0, -1.0));
  d.y = s1.x; d.w = s1.y;
  if (d.x + d.y > 2.0) {
    let coords = vec4f(-d.x + 0.25, d.x, d.y, -d.y - 0.25) * c.rt.xyxy + texcoord.xyxy;
    var cv = vec4f(textureSampleLevel(edgesTex, linearSampler, coords.xy, 0.0, vec2i(-1, 0)).rg,
                   textureSampleLevel(edgesTex, linearSampler, coords.zw, 0.0, vec2i( 1, 0)).rg);
    cv = decodeDiag4(cv).yxwz;
    var cc = vec2f(2.0, 2.0) * cv.xz + cv.yw;
    cc = select(cc, vec2f(0.0), d.zw >= vec2f(0.9));
    weights += areaDiag(d.xy, cc, subsampleIndices.z);
  }

  let s2 = searchDiag2(texcoord, vec2f(-1.0, -1.0));
  d.x = s2.x; d.z = s2.y;
  if (textureSampleLevel(edgesTex, linearSampler, texcoord, 0.0, vec2i(1, 0)).r > 0.0) {
    let s3 = searchDiag2(texcoord, vec2f(1.0, 1.0));
    d.y = s3.x + f32(s3.w > 0.9); d.w = s3.y;
  } else {
    d.y = 0.0; d.w = 0.0;
  }
  if (d.x + d.y > 2.0) {
    let coords = vec4f(-d.x, -d.x, d.y, d.y) * c.rt.xyxy + texcoord.xyxy;
    let cv = vec4f(textureSampleLevel(edgesTex, linearSampler, coords.xy, 0.0, vec2i(-1,  0)).g,
                   textureSampleLevel(edgesTex, linearSampler, coords.xy, 0.0, vec2i( 0, -1)).r,
                   textureSampleLevel(edgesTex, linearSampler, coords.zw, 0.0, vec2i( 1,  0)).gr);
    var cc = vec2f(2.0, 2.0) * cv.xz + cv.yw;
    cc = select(cc, vec2f(0.0), d.zw >= vec2f(0.9));
    weights += areaDiag(d.xy, cc, subsampleIndices.w).yx;
  }
  return weights;
}

fn searchLength(e : vec2f, offset : f32) -> f32 {
  var scale = SMAA_SEARCHTEX_SIZE * vec2f(0.5, -1.0);
  var bias = SMAA_SEARCHTEX_SIZE * vec2f(offset, 1.0);
  scale += vec2f(-1.0, 1.0);
  bias += vec2f(0.5, -0.5);
  scale *= 1.0 / SMAA_SEARCHTEX_PACKED_SIZE;
  bias *= 1.0 / SMAA_SEARCHTEX_PACKED_SIZE;
  return textureSampleLevel(searchTex, linearSampler, scale * e + bias, 0.0).r;
}

fn searchXLeft(start : vec2f, end : f32) -> f32 {
  var texcoord = start;
  var e = vec2f(0.0, 1.0);
  while (texcoord.x > end && e.y > 0.8281 && e.x == 0.0) {
    e = edgesAt(texcoord);
    texcoord = -vec2f(2.0, 0.0) * c.rt.xy + texcoord;
  }
  let offset = -(255.0 / 127.0) * searchLength(e, 0.0) + 3.25;
  return c.rt.x * offset + texcoord.x;
}
fn searchXRight(start : vec2f, end : f32) -> f32 {
  var texcoord = start;
  var e = vec2f(0.0, 1.0);
  while (texcoord.x < end && e.y > 0.8281 && e.x == 0.0) {
    e = edgesAt(texcoord);
    texcoord = vec2f(2.0, 0.0) * c.rt.xy + texcoord;
  }
  let offset = -(255.0 / 127.0) * searchLength(e, 0.5) + 3.25;
  return -c.rt.x * offset + texcoord.x;
}
fn searchYUp(start : vec2f, end : f32) -> f32 {
  var texcoord = start;
  var e = vec2f(1.0, 0.0);
  while (texcoord.y > end && e.x > 0.8281 && e.y == 0.0) {
    e = edgesAt(texcoord);
    texcoord = -vec2f(0.0, 2.0) * c.rt.xy + texcoord;
  }
  let offset = -(255.0 / 127.0) * searchLength(e.yx, 0.0) + 3.25;
  return c.rt.y * offset + texcoord.y;
}
fn searchYDown(start : vec2f, end : f32) -> f32 {
  var texcoord = start;
  var e = vec2f(1.0, 0.0);
  while (texcoord.y < end && e.x > 0.8281 && e.y == 0.0) {
    e = edgesAt(texcoord);
    texcoord = vec2f(0.0, 2.0) * c.rt.xy + texcoord;
  }
  let offset = -(255.0 / 127.0) * searchLength(e.yx, 0.5) + 3.25;
  return -c.rt.y * offset + texcoord.y;
}

fn area(dist : vec2f, e1 : f32, e2 : f32, offset : f32) -> vec2f {
  var texcoord = vec2f(SMAA_AREATEX_MAX_DISTANCE) * round(4.0 * vec2f(e1, e2)) + dist;
  texcoord = SMAA_AREATEX_PIXEL_SIZE * texcoord + 0.5 * SMAA_AREATEX_PIXEL_SIZE;
  texcoord.y = SMAA_AREATEX_SUBTEX_SIZE * offset + texcoord.y;
  return textureSampleLevel(areaTex, linearSampler, texcoord, 0.0).rg;
}

fn horizontalCorner(weights : vec2f, texcoord : vec4f, d : vec2f) -> vec2f {
  let leftRight = step(d.xy, d.yx);
  var rounding = (1.0 - SMAA_CORNER_ROUNDING_NORM) * leftRight;
  rounding /= leftRight.x + leftRight.y;
  var factor = vec2f(1.0, 1.0);
  factor.x -= rounding.x * textureSampleLevel(edgesTex, linearSampler, texcoord.xy, 0.0, vec2i(0,  1)).r;
  factor.x -= rounding.y * textureSampleLevel(edgesTex, linearSampler, texcoord.zw, 0.0, vec2i(1,  1)).r;
  factor.y -= rounding.x * textureSampleLevel(edgesTex, linearSampler, texcoord.xy, 0.0, vec2i(0, -2)).r;
  factor.y -= rounding.y * textureSampleLevel(edgesTex, linearSampler, texcoord.zw, 0.0, vec2i(1, -2)).r;
  return weights * saturate(factor);
}
fn verticalCorner(weights : vec2f, texcoord : vec4f, d : vec2f) -> vec2f {
  let leftRight = step(d.xy, d.yx);
  var rounding = (1.0 - SMAA_CORNER_ROUNDING_NORM) * leftRight;
  rounding /= leftRight.x + leftRight.y;
  var factor = vec2f(1.0, 1.0);
  factor.x -= rounding.x * textureSampleLevel(edgesTex, linearSampler, texcoord.xy, 0.0, vec2i( 1, 0)).g;
  factor.x -= rounding.y * textureSampleLevel(edgesTex, linearSampler, texcoord.zw, 0.0, vec2i( 1, 1)).g;
  factor.y -= rounding.x * textureSampleLevel(edgesTex, linearSampler, texcoord.xy, 0.0, vec2i(-2, 0)).g;
  factor.y -= rounding.y * textureSampleLevel(edgesTex, linearSampler, texcoord.zw, 0.0, vec2i(-2, 1)).g;
  return weights * saturate(factor);
}

// SMAABlendingWeightCalculationVS + SMAABlendingWeightCalculationPS (subsampleIndices = 0: SMAA 1x)
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let texcoord = position.xy * c.rt.xy;
  let pixcoord = texcoord * c.rt.zw;
  let offset0 = c.rt.xyxy * vec4f(-0.25, -0.125, 1.25, -0.125) + texcoord.xyxy;
  let offset1 = c.rt.xyxy * vec4f(-0.125, -0.25, -0.125, 1.25) + texcoord.xyxy;
  let offset2 = c.rt.xxyy * (vec4f(-2.0, 2.0, -2.0, 2.0) * SMAA_MAX_SEARCH_STEPS) + vec4f(offset0.xz, offset1.yw);
  let subsampleIndices = vec4f(0.0);

  var weights = vec4f(0.0);
  var e = edgesAt(texcoord);
  if (e.y > 0.0) { // edge at north
    let diag = calculateDiagWeights(texcoord, e, subsampleIndices);
    weights.x = diag.x; weights.y = diag.y;
    if (weights.x == -weights.y) { // weights.r + weights.g == 0.0
      var coords : vec3f;
      coords.x = searchXLeft(offset0.xy, offset2.x);
      coords.y = offset1.y; // texcoord.y - 0.25 * SMAA_RT_METRICS.y (@CROSSING_OFFSET)
      var d : vec2f;
      d.x = coords.x;
      let e1 = edgesAt(coords.xy).r;
      coords.z = searchXRight(offset0.zw, offset2.y);
      d.y = coords.z;
      d = abs(round(c.rt.zz * d - pixcoord.xx));
      let sqrt_d = sqrt(d);
      let e2 = textureSampleLevel(edgesTex, linearSampler, coords.zy, 0.0, vec2i(1, 0)).r;
      var w = area(sqrt_d, e1, e2, subsampleIndices.y);
      coords.y = texcoord.y;
      w = horizontalCorner(w, coords.xyzy, d);
      weights.x = w.x; weights.y = w.y;
    } else {
      e.x = 0.0; // skip vertical processing
    }
  }
  if (e.x > 0.0) { // edge at west
    var coords : vec3f;
    coords.y = searchYUp(offset1.xy, offset2.z);
    coords.x = offset0.x; // texcoord.x - 0.25 * SMAA_RT_METRICS.x
    var d : vec2f;
    d.x = coords.y;
    let e1 = edgesAt(coords.xy).g;
    coords.z = searchYDown(offset1.zw, offset2.w);
    d.y = coords.z;
    d = abs(round(c.rt.ww * d - pixcoord.yy));
    let sqrt_d = sqrt(d);
    let e2 = textureSampleLevel(edgesTex, linearSampler, coords.xz, 0.0, vec2i(0, 1)).g;
    var w = area(sqrt_d, e1, e2, subsampleIndices.x);
    coords.x = texcoord.x;
    w = verticalCorner(w, coords.xyxz, d);
    weights.z = w.x; weights.w = w.y;
  }
  return weights;
}`;

const BLEND = /* wgsl */ `${COMMON}
@group(0) @binding(1) var colorTex : texture_2d<f32>;
@group(0) @binding(2) var blendTex : texture_2d<f32>;
@group(0) @binding(9) var linearSampler : sampler;

// SMAANeighborhoodBlendingVS + SMAANeighborhoodBlendingPS
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let texcoord = position.xy * c.rt.xy;
  let offset = c.rt.xyxy * vec4f(1.0, 0.0, 0.0, 1.0) + texcoord.xyxy;
  var a : vec4f;
  a.x = textureSampleLevel(blendTex, linearSampler, offset.xy, 0.0).a; // right
  a.y = textureSampleLevel(blendTex, linearSampler, offset.zw, 0.0).g; // top
  let bl = textureSampleLevel(blendTex, linearSampler, texcoord, 0.0).xz; // bottom / left
  a.w = bl.x; a.z = bl.y;
  if (dot(a, vec4f(1.0)) < 1e-5) {
    return textureSampleLevel(colorTex, linearSampler, texcoord, 0.0);
  }
  let h = max(a.x, a.z) > max(a.y, a.w); // max(horizontal) > max(vertical)
  let blendingOffset = select(vec4f(0.0, a.y, 0.0, a.w), vec4f(a.x, 0.0, a.z, 0.0), h);
  var blendingWeight = select(a.yw, a.xz, h);
  blendingWeight /= dot(blendingWeight, vec2f(1.0, 1.0));
  let blendingCoord = blendingOffset * vec4f(c.rt.xy, -c.rt.xy) + texcoord.xyxy;
  var color = blendingWeight.x * textureSampleLevel(colorTex, linearSampler, blendingCoord.xy, 0.0);
  color += blendingWeight.y * textureSampleLevel(colorTex, linearSampler, blendingCoord.zw, 0.0);
  return color;
}`;

/** The three passes by the names smaa.cpp gives them ("smaa_" + the pass define). */
export const SMAA_PASS_PS: Record<string, string> = {
  smaa_SMAA_PASS_EDGES: EDGES,
  smaa_SMAA_PASS_WEIGHTS: WEIGHTS,
  smaa_SMAA_PASS_BLEND: BLEND,
};
