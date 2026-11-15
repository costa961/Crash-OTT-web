// crashott-pc's graphics options (gpu/graphics_options.cpp, MIT) on the WGSL translator's shaders:
// the same three edits of particular game shaders (by microcode hash), driven by the per-draw effect
// constants (xe_effects.effect: x motion blur, y depth of field, z shadow softness; settings.h
// [graphics], from the start page here). Left out: the soft shadows of the lighting remaster
// (xe_jitter.z), which the browser build doesn't have.
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

        // shadowshaderfp: the 9 UV offsets of the stencil PCF (c2..c10) scaled.
        bool PatchShadow(std::string& wgsl)
        {
            int count = 0;
            for (int c = 2; c <= 10; c++)
                count += ReplaceConstant(wgsl, c, "(xe_c[" + std::to_string(c) + "] * xe_effects.effect.z)") > 0;
            return count == 9;
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
