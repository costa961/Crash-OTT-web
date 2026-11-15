// crashott-pc's graphics options (gpu/graphics_options.cpp, MIT) on the WGSL translator's shaders:
// the same three edits of particular game shaders (by microcode hash), driven by the per-draw effect
// constants (xe_effects.effect: x motion blur, y depth of field, z shadow softness; settings.h
// [graphics], from the start page here), plus the lighting remaster's soft shadows (xe_effects.jitter.z).
#include "shader_translator_wgsl.h"

#include "diagnostics.h"

#include <regex>
#include <string>

namespace gpu::wgsl
{
    namespace
    {
        constexpr uint64_t MOTION_BLUR_PS = 0x1577D3C304364818ull;
        constexpr uint64_t DEPTH_OF_FIELD_PS = 0x45775928E9EBD556ull;
        constexpr uint64_t SHADOW_PS = 0xFDF408078EA760BBull;

        bool InsertHelpers(std::string& wgsl, const char* code)
        {
            size_t at = wgsl.find("fn xe_main()");
            if (at == std::string::npos)
                return false;
            wgsl.insert(at, code);
            return true;
        }

        // Every reading of float constant `index` (xe_c[index].swizzle) -> `replacement`.swizzle.
        int ReplaceConstant(std::string& wgsl, int index, const std::string& replacement)
        {
            std::string pattern = "xe_c[" + std::to_string(index) + "].";
            int count = 0;
            for (size_t at = wgsl.find(pattern); at != std::string::npos; at = wgsl.find(pattern, at + replacement.size() + 1))
            {
                wgsl.replace(at, pattern.size() - 1, replacement);
                count++;
            }
            return count;
        }

        // motionblurfp: the velocity maps hold 0.5 + v / 2 (0x80 = still): both are scaled around
        // that value, and Params.zw (the camera blur, c0) by the same factor.
        bool PatchMotionBlur(std::string& wgsl)
        {
            std::regex fetch(R"(let t = (xe_swizzle\(texture\w+\(xe_t([23]),[^;]*;))");
            std::string patched = std::regex_replace(wgsl, fetch, "var t = $1 t = vec4f(xe_mb_velocity(t.xy), t.zw);");
            if (patched == wgsl)
                return false;
            wgsl = std::move(patched);
            if (!ReplaceConstant(wgsl, 0, "xe_mb_params()"))
                return false;
            return InsertHelpers(wgsl, R"(// Graphics option: motion blur intensity (xe_effects.effect.x).
fn xe_mb_velocity(v : vec2f) -> vec2f { let neutral = 128.0 / 255.0; return neutral + (v - neutral) * xe_effects.effect.x; }
fn xe_mb_params() -> vec4f { return vec4f(xe_c[0].xy, xe_c[0].zw * xe_effects.effect.x); }

)");
        }

        // DOF: tap radius = |(blur * 0.5 + 0.5) * MaxRadius.y - MaxRadius.x|: MaxRadius (c5) scaled.
        bool PatchDepthOfField(std::string& wgsl)
        {
            return ReplaceConstant(wgsl, 5, "(xe_c[5] * xe_effects.effect.y)") > 0;
        }

        // shadowshaderfp: 9 taps at uv + c2..c10 (UV offsets) of the stencil (> 0 = in shadow); colour =
        // 1 - sum over the shadowed taps of (1 - r1) * weight (c30..c38). The offsets are scaled; with
        // soft shadows on (xe_effects.jitter.z, settings [lighting] soft_shadows) the same sum over a
        // rotated 16-tap disk 1.35x wider (each tap in shadow if any of its 4 texels is).
        bool PatchShadow(std::string& wgsl)
        {
            int count = 0;
            for (int c = 2; c <= 10; c++)
                count += ReplaceConstant(wgsl, c, "(xe_c[" + std::to_string(c) + "] * xe_effects.effect.z)") > 0;
            if (count != 9)
                return false;
            const std::string entry = "fn xe_main() {\n";
            size_t at = wgsl.find(entry);
            if (at == std::string::npos)
                return false;
            wgsl.insert(at + entry.size(), "    if (xe_effects.jitter.z > 0.5) { xe_soft_shadow(); return; }\n");
            return InsertHelpers(wgsl, R"(// Graphics option: soft shadows (xe_effects.jitter.z).
fn xe_shadow_tap(uv : vec2f, channel : u32) -> f32 {
    var g : vec4f;
    if (channel == 0u) { g = textureGather(0, xe_t0, xe_s0, uv); }
    else if (channel == 1u) { g = textureGather(1, xe_t0, xe_s0, uv); }
    else if (channel == 2u) { g = textureGather(2, xe_t0, xe_s0, uv); }
    else { g = textureGather(3, xe_t0, xe_s0, uv); }
    // As the original's filtered fetch: in shadow if any of the 4 texels is.
    return select(0.0, 1.0, any(g > vec4f(0.0)));
}
fn xe_soft_shadow() {
    let uv = r[0].xy;
    let size = vec2f(textureDimensions(xe_t0));
    let channel = (xe_system.tex_swizzles[0].x >> 6u) & 7u;
    var extent = vec2f(0.0);
    var weight = vec4f(0.0);
    for (var i = 0; i < 9; i++) {
        extent = max(extent, abs(xe_c[2 + i].xy));
        weight += xe_c[30 + i];
    }
    extent *= xe_effects.effect.z * 1.35;
    var shadowed : f32;
    if (channel >= 4u) {
        shadowed = select(0.0, 1.0, channel == 5u);
    } else {
        let pixel = uv * size;
        let angle = 6.2831853 * fract(52.9829189 * fract(dot(floor(pixel), vec2f(0.06711056, 0.00583715))));
        shadowed = 0.0;
        for (var k = 0; k < 16; k++) {
            let radius = sqrt((f32(k) + 0.5) / 16.0);
            let theta = f32(k) * 2.3999632 + angle;
            shadowed += xe_shadow_tap(uv + radius * vec2f(cos(theta), sin(theta)) * extent, channel);
        }
        shadowed /= 16.0;
    }
    xe_oC[0] = xe_c[255].x - shadowed * (xe_c[255].x - r[1]) * weight;
}

)");
        }
    }

    const char* PatchShader(ShaderStage stage, uint64_t hash, std::string& wgsl)
    {
        if (stage != ShaderStage::Pixel)
            return nullptr;
        std::string copy = wgsl;
        bool ok;
        const char* name;
        switch (hash)
        {
        case MOTION_BLUR_PS: name = "motion blur intensity"; ok = PatchMotionBlur(copy); break;
        case DEPTH_OF_FIELD_PS: name = "depth of field intensity"; ok = PatchDepthOfField(copy); break;
        case SHADOW_PS: name = "shadow softness"; ok = PatchShadow(copy); break;
        default: return nullptr;
        }
        if (!ok)
        {
            Log("[gpu] graphics option \"%s\": shader %016llx is not as expected, left unchanged", name, (unsigned long long)hash);
            return nullptr;
        }
        wgsl = std::move(copy);
        return name;
    }
}
