// The OS backend of crashott-pc's diagnostics (diagnostics_host.h) for WebAssembly. There are no
// host faults to catch (a trap ends the instance, and the host prints the wasm stack) and no way
// to sample another thread, so most of it is empty.
#include "diagnostics_host.h"

#include <cstdio>
#include <cstdlib>

namespace diag
{
    void DescribeHostAddress(uintptr_t address, char* buffer, size_t size)
    {
        snprintf(buffer, size, "wasm+0x%lX", (unsigned long)address);
    }

    void LogHostBacktrace() {}
    void InstallHostCrashHandlers() {}

    void Terminate(uint32_t code)
    {
        fflush(stdout);
        fflush(stderr);
        _Exit(int(code));
    }

    void* OpenCurrentThread() { return nullptr; }
    void CloseThread(void*) {}
    bool SampleThread(void*, uintptr_t&) { return false; }
}
