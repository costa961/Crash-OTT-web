// Stand-ins for the parts of crashott-pc's runtime the browser build doesn't have yet (GPU, audio,
// input, settings...). Each one goes away when its real port arrives (docs/ARCHITECTURE.md).
#include "diagnostics.h"

#include <cstdint>

namespace gpu { void Init() { Log("[stub] gpu::Init"); } }
namespace audio { void Init() { Log("[stub] audio::Init"); } }

// kernel/input.h: the input recorder's note of each game file read (kernel/input_record.cpp).
namespace input { void NoteGameRead(uint64_t, uint64_t, bool) {} }
