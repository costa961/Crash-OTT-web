// What crashott-pc's renderer (gpu/xenos_renderer.cpp) calls outside the parts the browser build
// has: the PC build's own screens drawn over the game (settings, dev console, cheats, achievements,
// online menu, subtitles, touch controls), the temporal upscalers (DLSS/FSR), the window and the
// input recorder. Each one is "off" here; they go away as their web versions arrive.
// Including the original headers keeps every signature checked by the compiler.
#include "achievements/achievements.h"
#include "dev/cheat_menu.h"
#include "dev/dev_console.h"
#include "gpu/upscaler.h"
#include "gpu/window.h"
#include "kernel/input.h"
#include "online/mp_menu.h"
#include "settings/challenge_counters.h"
#include "settings/direct_boot.h"
#include "settings/pc_frontend.h"
#include "settings/menu_mouse.h"
#include "settings/prompt_icons.h"
#include "settings/quit_game.h"
#include "settings/save_screens.h"
#include "settings/settings.h"
#include "settings/settings_menu.h"
#include "settings/skip_cinematics.h"
#include "settings/touch_controls.h"
#include "settings/ui_text.h"
#include "subtitles/subtitle_draw.h"
#include "subtitles/subtitles.h"
#include "platform/platform.h"

#include <atomic>
#include <cstdlib>

// The PC build's screens over the game: not drawn.
namespace achievements
{
    void Draw(uint32_t, uint32_t) {}
    void WriteMessage(uint32_t) {}  // XUserWriteAchievements (kernel/xmsg_imports.cpp): no achievements yet
}
namespace dev::cheat_menu { void Draw(uint32_t, uint32_t) {} }
namespace dev::console { void Draw(uint32_t, uint32_t) {} }
namespace mp::menu { void Draw(uint32_t, uint32_t) {} }
namespace settings::challenges { void Draw(uint32_t, uint32_t) {} }
namespace settings::save_screens { void Draw(uint32_t, uint32_t) {} }
namespace settings::menu
{
    void Draw(uint32_t, uint32_t) {}
    void SetAvailable(bool) {}
}
namespace cutscenes
{
    void Draw(uint32_t, uint32_t) {}
    bool VideoPlaying() { return false; }
    // (settings/direct_boot.cpp) the cutscene skipper is not ported yet
    void NoteFrontendNode(uint32_t) {}
    void NoteMovie(int) {}
}
namespace touch_controls { void Draw(uint32_t, uint32_t) {} }
namespace subtitles
{
    void Draw(uint32_t, uint32_t) {}
    // The XMA decoder's hooks for the subtitle timing (audio/xma.cpp): no subtitles yet.
    void OnInputBuffer(uint32_t, const uint8_t*, uint32_t, uint32_t, uint64_t) {}
    void OnFrames(uint32_t, uint64_t) {}
}


// Temporal upscalers (DLSS, FSR): none in WebGPU.
namespace gpu::upscaler
{
    void VulkanExtensions(std::vector<std::string>&, std::vector<std::string>&) {}
    void Init(rhi::Device*, settings::Upscaler, const std::wstring&) {}
    void Select(settings::Upscaler) {}
    void Shutdown() {}
    settings::Upscaler Active() { return settings::Upscaler::Off; }
    const std::string& ActiveName()
    {
        static const std::string name = "off";
        return name;
    }
    void Jitter(uint64_t, uint32_t, uint32_t, float& x, float& y) { x = y = 0.0f; }
    bool Evaluate(const Frame&) { return false; }
}

// gpu/window.h: the page's canvas is the window (the size comes from the WebGPU device).
namespace gpu::window
{
    void* Create(uint32_t, uint32_t, const wchar_t*)
    {
        static int canvas;
        return &canvas;
    }
    bool IsFocused() { return true; }
    void GetClientSize(uint32_t& width, uint32_t& height)
    {
        width = 1280;
        height = 720;
    }
    bool ConsumeScreenshotRequest() { return false; }
    uint32_t ConsumeOverlayToggles() { return 0; }
    uint32_t ConsumeMarkRequests() { return 0; }
    uint32_t ConsumeRecordToggles() { return 0; }
    uint32_t ConsumeLightingToggles() { return 0; }
    void SetMode(settings::WindowMode) {}
    settings::WindowMode Mode() { return settings::WindowMode{}; }
}

// kernel/input.h: the input recorder.
namespace input
{
    bool Recording() { return false; }
    const char* ToggleRecording() { return "recording is not available in the browser"; }
    void RecordMark(uint64_t) {}
    bool ConsumeShotRequest() { return false; }
    bool LastPress(Press&) { return false; }
    // The frame number the renderer reports (settings/direct_boot.cpp reads it back for its events).
    std::atomic<uint64_t> g_frame;
    void SetFrame(uint64_t frame) { g_frame = frame; }
    uint64_t Frame() { return g_frame; }
    int64_t GameTick() { return int64_t(g_frame.load()); }
    void NoteEvent(const char*) {}
}
namespace input::menu_mouse { void NoteFrontendPage() {} }

// settings: the PC build's own UI texts, quit flow and HD remaster.
namespace settings
{
    // settings/direct_boot.cpp: never restarted from a settings screen.
    bool Restarted() { return false; }
    // The PC frontend's EXIT GAME exit (settings/pc_frontend.cpp, not ported): direct_boot.cpp uses it
    // only as the fingerprint of the Frontend.bfig whose node numbers it knows (86 there). The data is
    // the retail disc's (tools/recomp.sh checks default.xex), so the same numbers: the expected value.
    int QuitExit() { return 86; }
    UiLanguage UiLanguageOf(const std::string&) { return UiLanguage{}; }
    UiLanguage CurrentUiLanguage() { return UiLanguage{}; }
    const char* Tr(const UiText&, UiLanguage) { return ""; }
    bool QuitRequested() { return false; }
    void FinishQuit() { plat::ExitProcess(0); }
    const std::filesystem::path& HdRemasterDir()
    {
        static const std::filesystem::path none;
        return none;
    }
}
namespace settings::prompts
{
    char32_t IconOfTexture(uint64_t, int*) { return 0; }
    uint32_t Style() { return 0; }
    bool DrawPalettized(char32_t, uint32_t, int, int, const int*, std::vector<uint8_t>&, std::vector<uint32_t>&) { return false; }
    void PublishIconSpots(const std::vector<IconSpot>&) {}
}
