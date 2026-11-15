#pragma once

// Xenos shader microcode -> WGSL, for the WebGPU renderer. A fork of crashott-pc's HLSL translator
// (third_party/crashott-pc/runtime/gpu/shader_translator.cpp, MIT license), whose instruction
// formats and ALU/fetch semantics follow Xenia's ucode.h and shader_interpreter.cc (BSD license).
// Same translation as gpu::TranslateShader at 1x render scale with CRASH_SHADER_DERIVATIVES=gradients
// (no implicit derivatives: WGSL's uniformity analysis rejects them in the translated control flow).
//
// Bindings (the WGSL counterpart of shader_translator.h's register layout):
//   @group(0) @binding(0)  var<uniform> xe_system : XeSystem       (HLSL cbuffer xe_system, same layout)
//   @group(0) @binding(1)  var<uniform> xe_c : array<vec4f, 256>   (vertex shader float constants)
//   @group(0) @binding(2)  var<uniform> xe_c : array<vec4f, 256>   (pixel shader float constants)
//   @group(0) @binding(3)  var<uniform> xe_effects : XeEffects     (effect, jitter, hud, hud_target)
//   @group(0) @binding(4)  var<storage, read> xe_vertex_data : array<u32>  (vertex shaders only)
//   @group(1) @binding(N)      var xe_tN : texture_2d<f32>   (texture fetch constant N)
//   @group(1) @binding(32 + N) var xe_sN : sampler
// Vertex output / fragment input: @builtin(position) position + @location(0..15) i0..i15.
// Entry points are named "main".

#include "gpu/shader_translator.h"

namespace gpu::wgsl
{
    // Same result as gpu::TranslateShader, but TranslatedShader::hlsl holds WGSL source.
    TranslatedShader TranslateShader(ShaderStage stage, const uint32_t* ucode, uint32_t dwordCount);
}
