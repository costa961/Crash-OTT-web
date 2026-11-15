// Stand-ins for the parts of crashott-pc's runtime the browser build doesn't have yet (renderer,
// audio, input, window...). Each one goes away when its real port arrives (docs/ARCHITECTURE.md).
#include "diagnostics.h"
#include "gpu/renderer.h"
#include "kernel/input.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <system_error>
#include <unordered_set>


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
