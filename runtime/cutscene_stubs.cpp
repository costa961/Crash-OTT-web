// What crashott-pc's cutscene skipper (settings/skip_cinematics.cpp) calls outside the browser build:
// - its prompt is drawn with the PC build's menu art (settings/menu_art.cpp, not ported): not drawn
//   here (Ready says no), the hold to skip works without it;
// - the PC keyboard and mouse (kernel/pc_input.cpp): here the keyboard reaches the game as pad 1
//   (web/src/input.ts: Esc START, Space / Enter A, K B), which the skipper reads like any pad;
// - online sessions (online/), touch controls and subtitles: none in the browser.
// Including the original headers keeps every signature checked by the compiler.
#include "kernel/pc_input.h"
#include "online/mp.h"
#include "online/mp_lobby.h"
#include "settings/menu_art.h"
#include "settings/touch_controls.h"
#include "subtitles/subtitles.h"

namespace settings::menu_art
{
    bool Ready(int) { return false; }
    float TextWidth(FontId, const std::u32string&, float, float) { return 0.0f; }
    float DrawGameText(Canvas&, FontId, const std::u32string&, float, float, float, const TextStyle&, float) { return 0.0f; }
    float DrawIcon(Canvas&, char32_t, float, float, float, float, bool) { return 0.0f; }
    float IconWidth(char32_t, float) { return 0.0f; }
    std::u32string Utf32(const std::string& utf8) { return std::u32string(utf8.begin(), utf8.end()); }
    // the prompt's canvas: nothing is drawn (Ready is false), so nothing is kept
    void Canvas::Reset(int, int) {}
    void Canvas::Fill(int, int, int, int, Color) {}
    void Canvas::Blit(const Image&, int, int, Color, int) {}
    void Canvas::Export(std::vector<uint32_t>& out) const { out.clear(); }
}

namespace input::pc
{
    bool KeyHeld(uint32_t) { return false; }
    bool AnyKeyboardKeyHeld() { return false; }
    Device PromptDevice() { return Device::Xbox; }
    bool CursorInClient(float&, float&) { return false; }
    uint32_t CursorMoves() { return 0; }
    uint32_t LeftClicks() { return 0; }
    bool LeftHeld() { return false; }
}

namespace touch_controls { bool Enabled() { return false; } }

namespace subtitles { void EndCutscenes() {} }

namespace mp
{
    void CinematicDone() {}
}
namespace mp::lobby
{
    void HostSkippedCutscene(uint32_t) {}
    bool TakeCutsceneSkip(uint32_t) { return false; }
    bool IsClient() { return false; }
}
