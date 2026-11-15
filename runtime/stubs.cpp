// Stand-ins for the parts of crashott-pc's runtime the browser build doesn't have yet (renderer,
// audio, input, window...). Each one goes away when its real port arrives (docs/ARCHITECTURE.md).
#include "diagnostics.h"
#include "gpu/renderer.h"
#include "kernel/input.h"

#include <cstdint>

namespace audio { void Init() { Log("[stub] audio::Init"); } }

// gpu/renderer.h: no renderer yet. The command processor still walks every packet; draws and
// swaps are dropped (headless, as GTA SA web without a page).
namespace gpu::renderer
{
    bool Init()
    {
        Log("[stub] gpu::renderer::Init: headless, draws are dropped");
        return false;
    }
    bool IsActive() { return false; }
    int TestShaders(const std::filesystem::path&) { return 0; }
    void LoadShader(ShaderStage, const uint32_t*, uint32_t) {}
    void* LoadShaderHandle(ShaderStage, const uint32_t*, uint32_t) { return nullptr; }
    void BindShader(ShaderStage, void*) {}
    void Draw(const DrawPacket&) {}
    void Swap(uint32_t, uint32_t, uint32_t, const uint32_t*) {}
    void RequestReconfigure() {}
    void LogStats() {}
}

// gpu/window.h: no window; the page's visibility will drive Suspended later.
namespace gpu::window
{
    bool Suspended() { return false; }
    void WaitWhileSuspended() {}
}

// kernel/input.h: the input recorder (kernel/input_record.cpp): no recording, no replay.
namespace input
{
    void NoteGameRead(uint64_t, uint64_t, bool) {}
    int64_t ClockMs() { return 0; }
    RecordStatus Status() { return {}; }
}

// kernel/pc_input.h: the pause asked for when the app goes to the background.
namespace input::pc
{
    void RequestBackgroundPause() {}
    bool BackgroundPausePending() { return false; }
    void CancelBackgroundPause() {}
}
