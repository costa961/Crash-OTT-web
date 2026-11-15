// WGSL for crashott-pc's built-in passes (gpu/xenos_renderer.cpp: RESOLVE_PS, RESOLVE_DEPTH_PACKED_PS,
// DEPTH_ALIAS_PS, PRESENT_PS, FXAA_PS; MIT, VitoMiguelF and contributors), found by the name the
// renderer gives them. Same constant layouts as the HLSL cbuffers. Pass layout: @binding(0) the
// constants, textures from @binding(1), samplers s0/s1 at @binding(9)/@binding(10). The full-screen
// triangle is the vertex stage of every pass.

export const FULLSCREEN_VS = /* wgsl */ `
@vertex fn main(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}`;

const ENCODE_FLOAT24 = /* wgsl */ `
fn encodeFloat24(d : f32) -> u32 {
  var f = bitcast<u32>(clamp(d, 0.0, 1.99999988));
  if (f < 0x38800000u) {
    let shift = min(113u - (f >> 23u), 24u);
    f = (0x800000u | (f & 0x7FFFFFu)) >> shift;
  } else {
    f = f + 0xC8000000u;
  }
  return ((f + 3u + ((f >> 3u) & 1u)) >> 3u) & 0xFFFFFFu;
}`;

const RESOLVE = /* wgsl */ `
struct C { offset : vec2i, scale : f32, flags : u32 }
@group(0) @binding(0) var<uniform> c : C;
@group(0) @binding(1) var source : texture_2d<f32>;
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  var p = vec2i(position.xy) - c.offset;
  if ((c.flags & 4u) != 0u) { p.x = p.x * 2; }
  if ((c.flags & 8u) != 0u) { p.y = p.y * 2; }
  if ((c.flags & 16u) != 0u) { p.y = p.y / 2; }
  var v = textureLoad(source, p, 0);
  if ((c.flags & 1u) != 0u) { v = v.bgra; }
  return v * c.scale;
}`;

const RESOLVE_DEPTH_PACKED = /* wgsl */ `
struct C { offset : vec2i, scale : f32, flags : u32 }
@group(0) @binding(0) var<uniform> c : C;
@group(0) @binding(1) var depth : texture_2d<f32>;
@group(0) @binding(2) var stencil : texture_2d<u32>;
${ENCODE_FLOAT24}
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  var p = vec2i(position.xy) - c.offset;
  if ((c.flags & 4u) != 0u) { p.x = p.x * 2; }
  if ((c.flags & 8u) != 0u) { p.y = p.y * 2; }
  if ((c.flags & 16u) != 0u) { p.y = p.y / 2; }
  let d = textureLoad(depth, p, 0).x;
  var d24 = u32(round(saturate(d) * 16777215.0));
  if ((c.flags & 2u) != 0u) { d24 = encodeFloat24(d); }
  let s = textureLoad(stencil, p, 0).x & 0xFFu;
  return vec4f(f32(s), f32(d24 & 0xFFu), f32((d24 >> 8u) & 0xFFu), f32(d24 >> 16u)) / 255.0;
}`;

/** A draw-layout pixel shader (group 0 binding 0 = the draw's system constants). */
export const DEPTH_ALIAS_PS = /* wgsl */ `
struct XeSystem { ndc_scale : vec4f, ndc_offset : vec4f, flags : vec4u }
@group(0) @binding(0) var<uniform> xe_system : XeSystem;
${ENCODE_FLOAT24}
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let d = position.z;
  var d24 = u32(round(saturate(d) * 16777215.0));
  if ((xe_system.flags.w & 0x100u) != 0u) { d24 = encodeFloat24(d); }
  let s = xe_system.flags.w & 0xFFu;
  return vec4f(f32(s), f32(d24 & 0xFFu), f32((d24 >> 8u) & 0xFFu), f32(d24 >> 16u)) / 255.0;
}`;

const PRESENT = /* wgsl */ `
struct C { uvScale : vec2f, targetSize : vec2f, flags : u32, swizzle : u32, origin : vec2f, gamma : f32, saturation : f32 }
@group(0) @binding(0) var<uniform> c : C;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(9) var linearClamp : sampler;
fn sel(v : vec4f, s : u32) -> f32 {
  if (s >= 4u) { return select(0.0, 1.0, s == 5u); }
  return select(select(select(v.x, v.y, s == 1u), v.z, s == 2u), v.w, s == 3u);
}
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let uv = (position.xy - c.origin) / c.targetSize * c.uvScale;
  let t = textureSampleLevel(source, linearClamp, uv, 0.0);
  if ((c.flags & 2u) != 0u) { return vec4f(0.08, 0.08, 0.10, 1.0); }
  if ((c.flags & 8u) != 0u) { return vec4f(t.rgb, 1.0); }
  if ((c.flags & 4u) != 0u) { return vec4f(saturate(t.r * 64.0), t.a, t.b, 1.0); }
  var v = vec3f(sel(t, c.swizzle & 7u), sel(t, (c.swizzle >> 3u) & 7u), sel(t, (c.swizzle >> 6u) & 7u));
  if ((c.flags & 1u) != 0u) { v = v.bgr; }
  if (c.saturation != 1.0) { v = saturate(mix(vec3f(dot(v, vec3f(0.299, 0.587, 0.114))), v, c.saturation)); }
  if (c.gamma != 1.0) { v = pow(saturate(v), vec3f(1.0 / c.gamma)); }
  return vec4f(v, 1.0);
}`;

const FXAA = /* wgsl */ `
struct C { unused : vec2f, targetSize : vec2f }
@group(0) @binding(0) var<uniform> c : C;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(9) var linearClamp : sampler;
fn luma(v : vec3f) -> f32 { return dot(v, vec3f(0.299, 0.587, 0.114)); }
fn tap(uv : vec2f) -> vec3f { return textureSampleLevel(source, linearClamp, uv, 0.0).rgb; }
@fragment fn main(@builtin(position) position : vec4f) -> @location(0) vec4f {
  let SPAN_MAX = 8.0; let REDUCE_MUL = 1.0 / 8.0; let REDUCE_MIN = 1.0 / 128.0;
  let texel = 1.0 / c.targetSize;
  let uv = position.xy * texel;
  let rgbM = tap(uv);
  let lumaNW = luma(tap(uv + vec2f(-0.5, -0.5) * texel * 2.0));
  let lumaNE = luma(tap(uv + vec2f( 0.5, -0.5) * texel * 2.0));
  let lumaSW = luma(tap(uv + vec2f(-0.5,  0.5) * texel * 2.0));
  let lumaSE = luma(tap(uv + vec2f( 0.5,  0.5) * texel * 2.0));
  let lumaM = luma(rgbM);
  let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  if (lumaMax - lumaMin < max(0.0312, lumaMax * 0.125)) { return vec4f(rgbM, 1.0); }
  var dir = vec2f(-((lumaNW + lumaNE) - (lumaSW + lumaSE)), (lumaNW + lumaSW) - (lumaNE + lumaSE));
  let reduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * REDUCE_MUL), REDUCE_MIN);
  let scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, vec2f(-SPAN_MAX), vec2f(SPAN_MAX)) * texel;
  let rgbA = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let rgbB = rgbA * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  let lumaB = luma(rgbB);
  return vec4f(select(rgbB, rgbA, lumaB < lumaMin || lumaB > lumaMax), 1.0);
}`;

/** Pass pipelines by the renderer's name (PassPipelineDesc::name). */
export const PASS_PS: Record<string, string> = {
  resolve: RESOLVE,
  resolve_depth_packed: RESOLVE_DEPTH_PACKED,
  present: PRESENT,
  fxaa: FXAA,
};

/** Draw-layout shaders the renderer creates from HLSL of its own, by name. */
export const DRAW_PS: Record<string, string> = {
  depth_alias_ps: DEPTH_ALIAS_PS,
};

/** Rectangle clears (WgClear with a rect): the colour comes from the blend constant. */
export const CLEAR_COLOR_PS = /* wgsl */ `
@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }`;
