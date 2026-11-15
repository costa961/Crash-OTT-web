// sbrk for the browser build, in place of wasi-libc's.
//
// wasi-libc's malloc (dlmalloc) takes memory from sbrk, and wasi-libc's sbrk grows linear memory at
// its end. Here the end of linear memory belongs to the guest (runtime/memory_wasm.cpp: guest
// address == linear address, 0x40000000 and up), so the runtime's heap (and the thread stacks
// pthread_create takes from it) is a bump region from __heap_base up to RUNTIME_END instead, inside
// the initial memory (tools/wasm_runtime.sh INITIAL_MB, which covers it).
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <unistd.h>

#define RUNTIME_END 0x40000000u
#define WASM_PAGE 0x10000u

extern unsigned char __heap_base;

// The current break, exported for the host (memory use) and memory_wasm.cpp.
uintptr_t crashott_runtime_end;
static _Atomic uintptr_t g_brk;

static int ensure_memory(uintptr_t end)
{
    uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * WASM_PAGE;
    if (end <= have)
        return 1;
    return __builtin_wasm_memory_grow(0, (end - have + WASM_PAGE - 1) / WASM_PAGE) != (size_t)-1;
}

void* sbrk(intptr_t increment)
{
    uintptr_t old = atomic_load(&g_brk);
    for (;;)
    {
        if (old == 0)
        {
            uintptr_t start = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
            if (atomic_compare_exchange_weak(&g_brk, &old, start))
                old = start;
            continue;
        }
        if (increment < 0)
        {
            // dlmalloc trims with a negative sbrk; the region only grows (as wasi-libc's sbrk).
            errno = EINVAL;
            return (void*)-1;
        }
        uintptr_t next = old + (uintptr_t)increment;
        if (next < old || next > RUNTIME_END || !ensure_memory(next))
        {
            errno = ENOMEM;
            return (void*)-1;
        }
        if (atomic_compare_exchange_weak(&g_brk, &old, next))
        {
            crashott_runtime_end = next;
            return (void*)old;
        }
    }
}
