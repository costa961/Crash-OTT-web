// Controllers for the browser build: the XAM input imports read up to four pads from a block the page
// writes (web/src/input.ts: the Gamepad API, and the keyboard as pad 0), in place of crashott-pc's
// kernel/xam_input_imports.cpp and its PC input stack (XInput, HID, SDL, slots, the PC menus). The
// system settings that file also answers (region, language, XConfig) are here too, with the same
// values as crashott-pc's defaults (English, all regions).
//
// The block (WebInput, registered with the host through crashott.input_register): a sequence word
// the page makes odd while it writes and even when done, four WebPad entries, then the page's
// visibility (nonzero while the page is hidden: the game is held, gpu/window.h Suspended), then whether
// a cutscene or an intro video can be skipped (written here, for the page's "hold to skip" prompt), then
// the graphics options the page's in-game panel changed: "NAME=value" lines (main_wasm.cpp
// ApplyGraphicsOptions), applied at the next XamInputGetState when their sequence number changes.
#include "kernel/kernel.h"
#include "online/mp.h"
#include "settings/direct_boot.h"
#include "settings/skip_cinematics.h"

#include <atomic>
#include <functional>
#include <string>
#include <utility>
#include <vector>
#include <cstdlib>
#include <algorithm>
#include <cstring>

void ApplyGraphicsOptions(const std::function<const char*(const char*)>& get, bool live);  // main_wasm.cpp

__attribute__((import_module("crashott"), import_name("input_register"))) extern "C" void crashott_input_register(uint32_t block);

namespace
{
    constexpr uint32_t ERROR_DEVICE_NOT_CONNECTED_ = 0x48F;

    struct WebPad
    {
        uint32_t connected;
        uint16_t buttons;   // XINPUT_GAMEPAD_* bits
        uint8_t leftTrigger, rightTrigger;
        int16_t thumbLX, thumbLY, thumbRX, thumbRY;
        uint16_t vibrationLeft, vibrationRight;  // written by the game (XamInputSetState), read by the page
    };
    static_assert(sizeof(WebPad) == 20);

    struct WebInput
    {
        uint32_t magic;     // 'WINP'
        uint32_t sequence;  // odd while the page writes
        WebPad pads[4];
        uint32_t hidden;    // the page is hidden (another tab, minimized)
        uint32_t skippable; // written here: a cutscene or an intro video can be skipped (the page's prompt)
        uint32_t optionsSequence;  // the page adds 1 once it has written options / optionsLength
        uint32_t optionsLength;
        char options[1024];        // "NAME=value" lines, the start page's names (CRASHOTT_AA=smaa...)
    };

    // The game's languages: XConfig language and country (Dutch is chosen by the country), as
    // crashott-pc's settings.cpp; the page picks one (CRASHOTT_LANGUAGE, web/src/main.ts).
    struct Language { const char* id; uint32_t xconfig; uint8_t country; };
    constexpr Language LANGUAGES[] = { { "english", 1, 103 }, { "french", 4, 34 }, { "german", 3, 24 },
                                       { "spanish", 5, 31 }, { "italian", 6, 50 }, { "dutch", 1, 74 } };
    const Language& CurrentLanguage()
    {
        static const Language* language = [] {
            const char* id = getenv("CRASHOTT_LANGUAGE");
            for (const Language& l : LANGUAGES)
                if (id && !strcmp(id, l.id))
                    return &l;
            return &LANGUAGES[0];
        }();
        return *language;
    }

    WebInput g_input{ 0x504E4957u, 0, {}, 0, 0, 0, 0, {} };
    uint32_t g_optionsSeen;

    // The options the page's panel changed, once per new sequence number.
    void ApplyPageOptions()
    {
        uint32_t sequence = __atomic_load_n(&g_input.optionsSequence, __ATOMIC_ACQUIRE);
        if (sequence == g_optionsSeen)
            return;
        g_optionsSeen = sequence;
        uint32_t length = std::min<uint32_t>(__atomic_load_n(&g_input.optionsLength, __ATOMIC_ACQUIRE), sizeof(g_input.options));
        std::string text(g_input.options, length);
        std::vector<std::pair<std::string, std::string>> options;
        size_t at = 0;
        while (at < text.size())
        {
            size_t end = text.find('\n', at);
            if (end == std::string::npos)
                end = text.size();
            std::string line = text.substr(at, end - at);
            size_t equals = line.find('=');
            if (equals != std::string::npos)
                options.emplace_back(line.substr(0, equals), line.substr(equals + 1));
            at = end + 1;
        }
        ApplyGraphicsOptions([&](const char* name) -> const char* {
            for (const auto& [key, value] : options)
                if (key == name)
                    return value.c_str();
            return nullptr;
        }, true);
    }
    std::atomic<bool> g_registered;
    uint32_t g_packet[4];
    WebPad g_last[4];

    void Register()
    {
        bool expected = false;
        if (g_registered.compare_exchange_strong(expected, true))
            crashott_input_register(uint32_t(reinterpret_cast<uintptr_t>(&g_input)));
    }

    // A consistent copy of pad `user` (the page never holds the block for long).
    bool ReadPad(uint32_t user, WebPad& pad)
    {
        Register();
        for (int attempt = 0; attempt < 64; attempt++)
        {
            uint32_t before = __atomic_load_n(&g_input.sequence, __ATOMIC_ACQUIRE);
            if (before & 1)
                continue;
            memcpy(&pad, &g_input.pads[user], sizeof(pad));
            if (__atomic_load_n(&g_input.sequence, __ATOMIC_ACQUIRE) == before)
                return pad.connected != 0;
        }
        return false;
    }
}

// The page is hidden: gpu.cpp's HoldWhileSuspended holds the game between two frames (stubs.cpp).
bool WebPageHidden()
{
    Register();
    return __atomic_load_n(&g_input.hidden, __ATOMIC_ACQUIRE) != 0;
}

// Controller `user` as the game sees it: the page's pad, and online (crashott-pc's online code, mp.h) the pad of
// the remote player that controller plays (it replaces whatever is there).
static bool ReadController(uint32_t user, WebPad& pad)
{
    bool connected = ReadPad(user, pad);
    if (!connected)
        pad = {};
    if (user != 0)
    {
        XINPUT_GAMEPAD gamepad{ pad.buttons, pad.leftTrigger, pad.rightTrigger, pad.thumbLX, pad.thumbLY, pad.thumbRX, pad.thumbRY };
        if (mp::RemotePad(user, &gamepad))
        {
            pad.buttons = gamepad.wButtons;
            pad.leftTrigger = gamepad.bLeftTrigger, pad.rightTrigger = gamepad.bRightTrigger;
            pad.thumbLX = gamepad.sThumbLX, pad.thumbLY = gamepad.sThumbLY, pad.thumbRX = gamepad.sThumbRX, pad.thumbRY = gamepad.sThumbRY;
            pad.connected = 1;
            connected = true;
        }
    }
    return connected;
}

// u32 XamInputGetCapabilities(u32 UserIndex, u32 Flags, XINPUT_CAPABILITIES* Caps)
PPC_FUNC(__imp__XamInputGetCapabilities)
{
    KERNEL_IMPORT_ENTER(XamInputGetCapabilities);
    uint32_t user = ctx.r3.u32 == 0xFF ? 0 : ctx.r3.u32;
    uint32_t caps = ctx.r5.u32;
    WebPad pad;
    if (user >= 4 || !ReadController(user, pad))
    {
        ctx.r3.u64 = ERROR_DEVICE_NOT_CONNECTED_;
        return;
    }
    if (caps)
    {
        memset(base + caps, 0, 20);
        PPC_STORE_U8(caps + 0, 1);           // XINPUT_DEVTYPE_GAMEPAD
        PPC_STORE_U8(caps + 1, 1);           // XINPUT_DEVSUBTYPE_GAMEPAD
        PPC_STORE_U16(caps + 4, 0xF3FF);     // all buttons
        PPC_STORE_U8(caps + 6, 0xFF);        // triggers
        PPC_STORE_U8(caps + 7, 0xFF);
        PPC_STORE_U16(caps + 8, 0xFFC0);     // thumbsticks
        PPC_STORE_U16(caps + 10, 0xFFC0);
        PPC_STORE_U16(caps + 12, 0xFFC0);
        PPC_STORE_U16(caps + 14, 0xFFC0);
        PPC_STORE_U16(caps + 16, 0xFF);      // vibration
        PPC_STORE_U16(caps + 18, 0xFF);
    }
    ctx.r3.u64 = 0;
}

// u32 XamInputGetState(u32 UserIndex, u32 Flags, XINPUT_STATE* State)
PPC_FUNC(__imp__XamInputGetState)
{
    KERNEL_IMPORT_ENTER(XamInputGetState);
    uint32_t user = ctx.r3.u32 == 0xFF ? 0 : ctx.r3.u32;
    uint32_t statePtr = ctx.r5.u32;
    WebPad pad;
    if (user >= 4 || !ReadController(user, pad))
    {
        ctx.r3.u64 = ERROR_DEVICE_NOT_CONNECTED_;
        return;
    }
    if (user == 0)
    {
        // The direct boot (CRASH_SKIP_INTROS) presses START on the title screen for player 1.
        pad.buttons |= boot::Buttons();
        // Holding B / START / A skips a cutscene or an intro video; those buttons are hidden from the
        // game meanwhile (crashott-pc's settings/skip_cinematics.cpp, as its XamInputGetState does).
        XINPUT_GAMEPAD gamepad{ pad.buttons, pad.leftTrigger, pad.rightTrigger, pad.thumbLX, pad.thumbLY, pad.thumbRX, pad.thumbRY };
        cutscenes::FilterGameInput(gamepad, true);
        // Online: player 1's pad to the other players (it may hold the stick back: CRASH_MP_LEASH).
        mp::LocalPad(&gamepad, true);
        pad.buttons = gamepad.wButtons;
        pad.thumbLX = gamepad.sThumbLX, pad.thumbLY = gamepad.sThumbLY;
        __atomic_store_n(&g_input.skippable, cutscenes::SkipPossible() ? 1u : 0u, __ATOMIC_RELEASE);
        ApplyPageOptions();
    }
    // The packet number changes with the state, as XInput's does.
    if (memcmp(&pad.buttons, &g_last[user].buttons, 12) != 0)
    {
        g_packet[user]++;
        g_last[user] = pad;
    }
    if (statePtr)
    {
        PPC_STORE_U32(statePtr + 0, g_packet[user]);
        PPC_STORE_U16(statePtr + 4, pad.buttons);
        PPC_STORE_U8(statePtr + 6, pad.leftTrigger);
        PPC_STORE_U8(statePtr + 7, pad.rightTrigger);
        PPC_STORE_U16(statePtr + 8, uint16_t(pad.thumbLX));
        PPC_STORE_U16(statePtr + 10, uint16_t(pad.thumbLY));
        PPC_STORE_U16(statePtr + 12, uint16_t(pad.thumbRX));
        PPC_STORE_U16(statePtr + 14, uint16_t(pad.thumbRY));
    }
    ctx.r3.u64 = 0;
}

// u32 XamInputSetState(u32 UserIndex, u32 Flags, XINPUT_VIBRATION* Vibration): the page rumbles the pad.
PPC_FUNC(__imp__XamInputSetState)
{
    KERNEL_IMPORT_ENTER(XamInputSetState);
    uint32_t user = ctx.r3.u32 == 0xFF ? 0 : ctx.r3.u32;
    uint32_t vibrationPtr = ctx.r5.u32;
    WebPad pad;
    if (user >= 4 || !ReadPad(user, pad))
    {
        ctx.r3.u64 = ERROR_DEVICE_NOT_CONNECTED_;
        return;
    }
    if (vibrationPtr)
    {
        __atomic_store_n(&g_input.pads[user].vibrationLeft, PPC_LOAD_U16(vibrationPtr), __ATOMIC_RELAXED);
        __atomic_store_n(&g_input.pads[user].vibrationRight, PPC_LOAD_U16(vibrationPtr + 2), __ATOMIC_RELAXED);
    }
    ctx.r3.u64 = 0;
}

// u32 XGetGameRegion(): all regions, as in Xenia and crashott-pc.
PPC_FUNC(__imp__XGetGameRegion)
{
    KERNEL_IMPORT_ENTER(XGetGameRegion);
    ctx.r3.u64 = 0xFFFF;
}

// u32 XGetLanguage(): the language the page picked.
PPC_FUNC(__imp__XGetLanguage)
{
    KERNEL_IMPORT_ENTER(XGetLanguage);
    ctx.r3.u64 = CurrentLanguage().xconfig;
}

// NTSTATUS ExGetXConfigSetting(u16 Category, u16 Setting, void* Buffer, u16 BufferSize, u16* RequiredSize)
// User category values as crashott-pc's (from Xenia's xboxkrnl_xconfig.cc), with the page's language.
PPC_FUNC(__imp__ExGetXConfigSetting)
{
    KERNEL_IMPORT_ENTER(ExGetXConfigSetting);
    uint32_t category = ctx.r3.u32 & 0xFFFF, setting = ctx.r4.u32 & 0xFFFF;
    uint32_t buffer = ctx.r5.u32, bufferSize = ctx.r6.u32 & 0xFFFF, requiredPtr = ctx.r7.u32;
    uint8_t value[4] = {};
    uint32_t size = 0;
    if (category == 3)
    {
        switch (setting)
        {
        case 0x0009: size = 4; value[3] = uint8_t(CurrentLanguage().xconfig); break;  // language
        case 0x000A: size = 4; value[1] = 0x04; break;   // video flags: widescreen (0x00040000)
        case 0x000B: size = 4; break;                    // audio flags
        case 0x000C: size = 4; value[3] = 0x40; break;   // retail flags
        case 0x000E: size = 1; value[0] = CurrentLanguage().country; break;     // country
        case 0x000F: size = 1; value[0] = 0; break;      // parental control
        default: break;
        }
    }
    uint32_t status = 0;
    if (!size)
        status = 0xC0000034;  // STATUS_OBJECT_NAME_NOT_FOUND
    else if (buffer)
    {
        if (bufferSize < size)
            status = 0xC0000023;  // STATUS_BUFFER_TOO_SMALL
        else
            memcpy(base + buffer, value, size);
    }
    if (requiredPtr)
        PPC_STORE_U16(requiredPtr, uint16_t(size));
    KERNEL_LOG("[kernel] ExGetXConfigSetting(%u, 0x%X, size %u) lr=0x%08X -> 0x%08X", category, setting, bufferSize, GuestLR(ctx), status);
    ctx.r3.u64 = status;
}
