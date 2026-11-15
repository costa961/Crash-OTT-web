// Guest memory for WebAssembly, in place of third_party/crashott-pc/runtime/kernel/memory.cpp
// (same interface, kernel/memory.h).
//
// Guest address == linear memory address (base 0), as GTA San Andreas web does: every guest load
// and store of the recompiled code is one wasm load/store. The runtime's own data, stacks and heap
// stay below RUNTIME_END (runtime/sbrk.c); the guest uses 0x40000000 and up:
//   0x40000000-0x7F000000  virtual heap        0x7F000000-0x7FC00000  runtime's guest heap (stacks, PCRs)
//   0x7FC80000             GPU registers       0x7FEA0000             XMA registers
//   0x82000000-...         XEX image + the indirect call table
//   0xA0000000-0xC0000000  physical heap (every physical allocation is made in this view)
//
// Linear memory only grows: Commit grows it to cover what is committed, and the pages it adds read
// as zeros. Nothing aliases: an address in the console's 0xC0000000 view is folded onto 0xA0000000
// by the allocator (memory_imports.cpp, CanonicalPhysical), and the recompiled code is never given
// such an address by this runtime.

#include "kernel/memory.h"
#include "diagnostics.h"

#include <mutex>

Memory g_memory;

extern "C" uintptr_t crashott_runtime_end; // runtime/sbrk.c

namespace
{
    constexpr uint32_t WASM_PAGE = 0x10000;

    std::mutex g_growMutex;
    std::mutex g_heapMutex;
    uint32_t g_heapTop = KERNEL_HEAP_BEGIN;

    uint64_t MemoryBytes()
    {
        return uint64_t(__builtin_wasm_memory_size(0)) * WASM_PAGE;
    }

    bool EnsureMemory(uint64_t end)
    {
        if (end <= MemoryBytes())
            return true;
        std::lock_guard lock(g_growMutex);
        uint64_t have = MemoryBytes();
        if (end <= have)
            return true;
        // Grow in 16 MB steps: fewer grows (each one makes every worker refresh its views).
        constexpr uint64_t STEP = 16ull << 20;
        uint64_t want = (end + STEP - 1) & ~(STEP - 1);
        if (want > 0x100000000ull)
            want = 0x100000000ull;
        size_t pages = size_t((want - have) / WASM_PAGE);
        if (__builtin_wasm_memory_grow(0, pages) == size_t(-1))
        {
            Log("[memory] could not grow linear memory from 0x%llX to 0x%llX bytes",
                (unsigned long long)have, (unsigned long long)want);
            return false;
        }
        return true;
    }
}

bool Memory::Init()
{
    base = nullptr; // guest address == linear address
    if (crashott_runtime_end > 0x40000000u)
    {
        Log("[memory] the runtime's memory ends at 0x%lX, inside the guest's range", (unsigned long)crashott_runtime_end);
        return false;
    }
    // The image and its call table are committed by the XEX loader; nothing else up front.
    return true;
}

bool Memory::Commit(uint32_t guest, size_t size)
{
    return EnsureMemory(uint64_t(guest) + size);
}

bool Memory::IsPhysicalView(uint32_t guest) const
{
    // The physical heap: page_heap.cpp zeroes its recommitted pages itself (no host decommit).
    return guest >= PHYSICAL_VIEW_A && guest < PHYSICAL_VIEW_C;
}

bool Memory::IsInGuestRange(const void* host) const
{
    return reinterpret_cast<uintptr_t>(host) >= 0x40000000u;
}

uint32_t GuestAlloc(size_t size, size_t align, size_t guardSize)
{
    std::lock_guard lock(g_heapMutex);

    uint32_t guest = uint32_t((g_heapTop + guardSize + align - 1) & ~(align - 1));
    if (guest + size > KERNEL_HEAP_END)
        Fatal("GuestAlloc: kernel heap exhausted (0x%zX bytes requested)", size);

    if (!g_memory.Commit(guest, size))
        Fatal("GuestAlloc: could not grow memory to guest 0x%08X", guest);

    g_heapTop = uint32_t(guest + size);
    return guest;
}
