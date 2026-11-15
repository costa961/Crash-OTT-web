// The hardware register windows for WebAssembly: the recompiled code calls PPCMmioStore after every
// 32-bit store into 0x7FC00000-0x7FFFFFFF (patches/XenonRecomp-wasm.patch, PPCStoreU32), in place of
// the page protection the PC build traps them with. The GPU's first page wakes the command processor
// (CP_RB_WPTR); the XMA decoder's kick / lock / clear registers enable, stop and clear its contexts.
#include "kernel/memory.h"

#include <cstdint>

namespace gpu { void OnGuestStore(uint32_t guest); }
namespace xma { void OnGuestStore(uint32_t guest); }

extern "C" void PPCMmioStore(uint32_t address)
{
    if (address >= GPU_MMIO_BEGIN && address < GPU_MMIO_END)
        gpu::OnGuestStore(address);
    else if (address >= XMA_MMIO_BEGIN && address < XMA_MMIO_END)
        xma::OnGuestStore(address);
}
