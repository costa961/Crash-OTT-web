// Entry point of the browser module, in place of crashott-pc's runtime/main.cpp: the same boot
// order (guest memory, XEX image, call table, file system, guest process, GPU and audio, the
// title's entry point on a guest thread) without the PC launcher's options, settings screens,
// online, Discord and dev tools.
//
// The host (web/) runs it in a worker with the WASI preopens:
//   /game       the game folder (default.xex, *.rcf, shaders/), read-only
//   /userdata   saves and caches (the page keeps them in the browser's storage)
// Arguments: [--game <dir>] [--userdata <dir>] [--mods <dir>]

#include "cpu/guest_thread.h"
#include "diagnostics.h"
#include "fs/vfs.h"
#include "kernel/memory.h"
#include "kernel/xex_loader.h"
#include "paths.h"
#include "settings/settings.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <system_error>

extern "C" void crashott_set_args(int argc, char** argv); // platform_wasm.cpp

namespace gpu { void Init(); }
namespace audio { void Init(); }

namespace
{
    std::filesystem::path g_game = "/game";
    std::filesystem::path g_userData = "/userdata";
    std::filesystem::path g_mods = "/userdata/mods";
    std::filesystem::path g_languages = "/userdata/languages";
    std::filesystem::path g_data = "/userdata/data";
    std::filesystem::path g_xex;
    std::filesystem::path g_image;
    std::filesystem::path g_exeDir = "/crashott";
}

// paths.h, for the runtime files that ask (crashott-pc's paths.cpp pulls in the settings).
namespace paths
{
    bool Init(int, char**, bool) { return true; }
    const std::filesystem::path& ExeDir() { return g_exeDir; }
    const std::filesystem::path& Game() { return g_game; }
    const std::filesystem::path& Mods() { return g_mods; }
    const std::filesystem::path& UserData() { return g_userData; }
    const std::filesystem::path& Languages() { return g_languages; }
    const std::filesystem::path& Data() { return g_data; }
    const std::filesystem::path& Xex() { return g_xex; }
    const std::filesystem::path& Image() { return g_image; }
    bool GameChosenNow() { return false; }
    bool IsGameFolder(const std::filesystem::path& folder) { return std::filesystem::is_regular_file(folder / "default.xex"); }
    std::filesystem::path PickGameFolder(void*) { return {}; }
}

int main(int argc, char** argv)
{
    crashott_set_args(argc, argv);
    for (int i = 1; i + 1 < argc; i++)
    {
        if (!strcmp(argv[i], "--game"))
            g_game = argv[++i];
        else if (!strcmp(argv[i], "--userdata"))
            g_userData = argv[++i];
        else if (!strcmp(argv[i], "--mods"))
            g_mods = argv[++i];
    }
    g_xex = g_game / "default.xex";
    std::error_code ignored;
    std::filesystem::create_directories(g_userData, ignored);
    std::filesystem::create_directories(g_mods, ignored);

    if (!g_memory.Init())
        return 1;
    InstallCrashHandler();

    XexModule module;
    if (!LoadXex(g_xex, g_image, module))
        return 1;
    InitFunctionTable();
    vfs::Init(vfs::Config{ g_game, g_mods, g_userData });
    StartWatchdog();

    // The start page's graphics options (crashott-pc's settings.h [graphics]): anti-aliasing and the
    // three shader options in % (runtime/gpu_web/graphics_options_wgsl.cpp).
    {
        settings::Values values = settings::Get();
        if (const char* aa = getenv("CRASHOTT_AA"))
            values.antiAliasing = !strcmp(aa, "smaa") ? settings::AntiAliasing::Smaa
                                  : !strcmp(aa, "fxaa") ? settings::AntiAliasing::Fxaa : settings::AntiAliasing::Off;
        auto percent = [](const char* name, int& field) {
            if (const char* text = getenv(name))
                field = std::clamp(atoi(text), 0, 200);
        };
        percent("CRASHOTT_MOTION_BLUR", values.motionBlur);
        percent("CRASHOTT_DEPTH_OF_FIELD", values.depthOfField);
        percent("CRASHOTT_SHADOW_SOFTNESS", values.shadowSoftness);
        settings::Set(values);
        Log("[main] graphics: anti-aliasing %s, motion blur %d%%, depth of field %d%%, shadow softness %d%%",
            values.antiAliasing == settings::AntiAliasing::Smaa ? "SMAA" : values.antiAliasing == settings::AntiAliasing::Fxaa ? "FXAA" : "off",
            values.motionBlur, values.depthOfField, values.shadowSoftness);
    }

    // No page protection in WebAssembly: crashott-pc's texture write watch (gpu/texture_watch.h) would
    // never see the game write a texture again, and textures the CPU updates (the Bink videos' frames,
    // dynamic UI textures) would stay at their first version. The renderer hashes them instead.
    setenv("CRASH_TEXTURE_WATCH", "0", 0);

    uint32_t stackSize = module.defaultStackSize ? module.defaultStackSize : 0x40000;
    InitGuestProcess(stackSize);
    gpu::Init();
    audio::Init();
    uint32_t result = RunGuestThread(module.entryPoint, stackSize);

    Log("[thread] guest entry point returned, r3=0x%08X", result);
    PrintImportSummary();
    return 0;
}
