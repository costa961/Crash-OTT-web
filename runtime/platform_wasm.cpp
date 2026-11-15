// plat:: (third_party/crashott-pc/runtime/platform/platform.h) for WebAssembly: wasi-libc with
// wasi threads, in a Web Worker (or Node's worker_threads) of the page's host (web/).
//
// What differs from the POSIX build:
// - Guest memory is the module's linear memory itself (runtime/memory_wasm.cpp): no reservation,
//   no views, no protection and no faults. The virtual memory and fault functions are no-ops that
//   report success.
// - Fibers are threads. A fiber's thread runs only while it holds the baton: SwitchToFiber hands
//   it to the target and waits for it to come back. On Windows a fiber shares its thread's
//   thread_local variables (the runtime's current guest thread, current fiber...), so a resumed
//   fiber here takes the thread-local block of the thread that resumed it (the __tls_base global).
//   Only one thread of a chain runs at a time, so they never use the block at once.
// - No dynamic libraries, no processes, no dialogs.

#include "platform/platform.h"
#include "diagnostics.h"

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <csetjmp>
#include <pthread.h>
#include <sched.h>
#include <strings.h>
#include <unistd.h>

extern "C" void crashott_set_args(int argc, char** argv);

namespace
{
    std::vector<std::string> g_args;

    std::atomic<uint32_t> g_nextThreadId{ 1 };
    thread_local uint32_t t_threadId;

    // A one-shot or reusable gate on a futex word (memory.atomic.wait32/notify, through
    // __builtin_wasm_memory_atomic_wait32): 0 closed, 1 open.
    struct Gate
    {
        std::atomic<int32_t> open{ 0 };

        void Open()
        {
            open.store(1, std::memory_order_release);
            __builtin_wasm_memory_atomic_notify(reinterpret_cast<int32_t*>(&open), 1);
        }

        void WaitAndClose()
        {
            while (open.exchange(0, std::memory_order_acquire) == 0)
                __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int32_t*>(&open), 0, -1);
        }
    };

    struct WasmThread
    {
        pthread_t thread{};
        plat::ThreadEntry entry{};
        void* param{};
        Gate start;
        std::atomic<uint32_t> suspendCount{};
        uint32_t id{};
        uint32_t exitCode{};
    };

    // wasi-libc has no pthread_exit: ExitThread jumps back to the thread's entry (as GTA SA web's
    // runtime/web/thread_exit.c), which then returns normally.
    thread_local jmp_buf* t_exitJump;
    thread_local uint32_t t_exitCode;

    void* ThreadMain(void* p)
    {
        auto* t = static_cast<WasmThread*>(p);
        t_threadId = t->id;
        t->start.WaitAndClose();
        jmp_buf exitJump;
        if (setjmp(exitJump))
        {
            t->exitCode = t_exitCode;
            return nullptr;
        }
        t_exitJump = &exitJump;
        t->exitCode = t->entry(t->param);
        return nullptr;
    }

    // ---- fibers ----
    // __tls_base: the start of this thread's thread-local block (wasm-ld's per-instance global).
    __asm__(".globaltype __tls_base, i32\n");

    void* GetTlsBase()
    {
        return __builtin_wasm_tls_base();
    }

    void SetTlsBase(void* base)
    {
        __asm__ volatile("local.get %0\n\tglobal.set __tls_base" : : "r"(base));
    }

    struct WasmFiber
    {
        Gate baton;
        void* resumerTls{};   // set by whoever hands this fiber the baton
        void* ownTls{};       // the fiber thread's own block, for its exit
        void (*entry)(void*){};
        void* param{};
        pthread_t thread{};
        bool hasThread{};
        std::atomic<bool> deleted{};
    };

    thread_local WasmFiber* t_currentFiber;

    void* FiberThreadMain(void* p)
    {
        auto* fiber = static_cast<WasmFiber*>(p);
        fiber->ownTls = GetTlsBase();
        fiber->baton.WaitAndClose();
        if (fiber->deleted.load())
            return nullptr;
        SetTlsBase(fiber->resumerTls);
        t_currentFiber = fiber;
        fiber->entry(fiber->param);
        Fatal("[fiber] a fiber's entry returned");
    }
}

extern "C" void crashott_set_args(int argc, char** argv)
{
    g_args.assign(argv + (argc > 0 ? 1 : 0), argv + argc);
}

namespace plat
{
    // ---- Time ----
    uint64_t PerfCounter()
    {
        timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        return uint64_t(ts.tv_sec) * 1000000000ull + uint64_t(ts.tv_nsec);
    }
    uint64_t PerfFrequency() { return 1000000000ull; }
    uint64_t TickCountMs() { return PerfCounter() / 1000000ull; }
    uint64_t SystemTimeFileTime()
    {
        timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        // 1601-01-01 to 1970-01-01 in 100 ns units
        return uint64_t(ts.tv_sec) * 10000000ull + uint64_t(ts.tv_nsec) / 100 + 116444736000000000ull;
    }
    void SleepMs(uint32_t milliseconds)
    {
        timespec ts{ time_t(milliseconds / 1000), long(milliseconds % 1000) * 1000000L };
        while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
    }
    void YieldThread() { sched_yield(); }
    void RaiseTimerResolution() {}

    TimerWait* CreateTimerWait() { return nullptr; } // callers use a condition variable (POSIX path)
    void WaitTimer(TimerWait*, int64_t) {}
    void WakeTimer(TimerWait*) {}

    // ---- Threads ----
    ThreadHandle CreateThread(ThreadEntry entry, void* param, size_t stackSize, bool suspended, uint32_t* threadId)
    {
        auto* t = new WasmThread;
        t->entry = entry;
        t->param = param;
        t->id = g_nextThreadId.fetch_add(1);
        t->suspendCount = suspended ? 1 : 0;
        // The shadow stack lives in the runtime's part of linear memory (below 0x40000000): guest
        // threads ask for 64 MB (one host frame per guest call), most of it for the native stack,
        // which the engine provides. Address-taken locals are what lands here.
        if (stackSize == 0 || stackSize > 4u * 1024 * 1024)
            stackSize = 4u * 1024 * 1024;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, stackSize);
        int err = pthread_create(&t->thread, &attr, ThreadMain, t);
        pthread_attr_destroy(&attr);
        if (err)
        {
            errno = err;
            delete t;
            return nullptr;
        }
        if (threadId)
            *threadId = t->id;
        if (!suspended)
            t->start.Open();
        return t;
    }

    uint32_t ResumeThread(ThreadHandle thread)
    {
        auto* t = static_cast<WasmThread*>(thread);
        uint32_t previous = t->suspendCount.load();
        if (previous > 0 && t->suspendCount.fetch_sub(1) == 1)
            t->start.Open();
        return previous;
    }

    void JoinThread(ThreadHandle thread)
    {
        pthread_join(static_cast<WasmThread*>(thread)->thread, nullptr);
    }

    void ExitThread(uint32_t exitCode)
    {
        if (!t_exitJump)
            Fatal("ExitThread(%u) on a thread not made by plat::CreateThread", exitCode);
        t_exitCode = exitCode;
        longjmp(*t_exitJump, 1);
    }

    void SetThreadPriority(ThreadHandle, ThreadPriority) {}
    void SetCurrentThreadPriority(ThreadPriority) {}
    void SetCurrentThreadName(const char*) {}

    uint32_t CurrentThreadId()
    {
        if (!t_threadId)
            t_threadId = g_nextThreadId.fetch_add(1);
        return t_threadId;
    }

    // ---- Fibers ----
    FiberHandle CurrentThreadFiber()
    {
        if (!t_currentFiber)
            t_currentFiber = new WasmFiber(); // the thread itself: no thread of its own to start
        return t_currentFiber;
    }

    FiberHandle CreateFiber(size_t stackSize, void (*entry)(void* param), void* param)
    {
        auto* fiber = new WasmFiber();
        fiber->entry = entry;
        fiber->param = param;
        if (stackSize == 0 || stackSize > 4u * 1024 * 1024)
            stackSize = 4u * 1024 * 1024;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, stackSize);
        int err = pthread_create(&fiber->thread, &attr, FiberThreadMain, fiber);
        pthread_attr_destroy(&attr);
        if (err)
        {
            errno = err;
            delete fiber;
            return nullptr;
        }
        fiber->hasThread = true;
        return fiber;
    }

    void SwitchToFiber(FiberHandle handle)
    {
        auto* from = static_cast<WasmFiber*>(CurrentThreadFiber());
        auto* to = static_cast<WasmFiber*>(handle);
        if (from == to)
            return;
        void* tls = GetTlsBase();
        to->resumerTls = tls;
        t_currentFiber = to; // in the shared block: what the target sees as its current fiber
        to->baton.Open();
        from->baton.WaitAndClose();
        // Back: whoever handed the baton back shares this chain's thread-local block.
        SetTlsBase(from->resumerTls);
        t_currentFiber = from;
    }

    void DeleteFiber(FiberHandle handle)
    {
        auto* fiber = static_cast<WasmFiber*>(handle);
        if (!fiber->hasThread)
            return;
        // A fiber that never ran is still waiting for its first baton: let its thread end.
        // One that ran is parked inside SwitchToFiber and stays there (its thread is leaked).
        fiber->deleted.store(true);
        fiber->baton.Open();
    }

    // ---- Virtual memory: the linear memory is the guest memory (memory_wasm.cpp) ----
    uint8_t* ReserveMemory(size_t, uintptr_t) { return nullptr; }
    uint8_t* ReserveMemoryWithViews(size_t, uintptr_t, size_t, const size_t*, size_t) { return nullptr; }
    bool CommitMemory(void*, size_t) { return true; }
    bool DecommitMemory(void* address, size_t size)
    {
        // The next commit must read zeros. Linear memory past its current end is zero already (and
        // not addressable yet): clear only the part that exists.
        uint64_t begin = reinterpret_cast<uintptr_t>(address);
        uint64_t end = begin + size;
        uint64_t have = uint64_t(__builtin_wasm_memory_size(0)) * 0x10000;
        if (end > have)
            end = have;
        if (begin < end)
            memset(address, 0, size_t(end - begin));
        return true;
    }
    bool ProtectMemory(void*, size_t, PageAccess) { return true; }
    size_t HostPageSize() { return 0x1000; }
    MemoryRegion QueryMemory(const void* address)
    {
        MemoryRegion region;
        region.base = const_cast<void*>(address);
        region.size = 0x1000;
        region.state = PageState::Committed;
        region.readable = true;
        return region;
    }

    // ---- Faults: there are none in WebAssembly (a bad access traps the whole instance) ----
    uint64_t FaultInfo::InstructionPointer() const { return 0; }
    void FaultInfo::SetInstructionPointer(uint64_t) {}
    uint64_t FaultInfo::Register(unsigned) const { return 0; }
    void FaultInfo::RequestSingleStep() {}
    bool FaultInfo::DecodeStore(uint64_t&, uint32_t&) const { return false; }
    void AddFaultHandler(FaultHandler) {}
    void SetUnhandledFaultHandler(FaultHandler) {}

    // ---- Dynamic libraries: none ----
    void* OpenLibrary(const std::filesystem::path&)
    {
        errno = ENOSYS;
        return nullptr;
    }
    void* FindSymbol(void*, const char*) { return nullptr; }
    void CloseLibrary(void*) {}
    std::string LastErrorText() { return strerror(errno); }
    std::string LibraryFileVersion(const std::filesystem::path&) { return {}; }

    // ---- Process ----
    std::filesystem::path ExecutablePath() { return "/crashott/crashott.wasm"; }
    uint32_t CurrentProcessId() { return 1; }
    std::vector<std::string> CommandLineArguments() { return g_args; }
    uint32_t StartSelf(const std::vector<std::string>&) { return 0; }
    bool WaitForProcessExit(uint32_t, uint32_t) { return true; }
    void SetEnvironment(const char* name, const char* value)
    {
        if (value)
            setenv(name, value, 1);
        else
            unsetenv(name);
    }
    bool DisablePowerThrottling() { return true; }
    void ExitProcess(uint32_t exitCode) { exit(int(exitCode)); }

    // ---- Dialogs: to the log (the page shows it) ----
    void ShowMessageBox(const char* title, const char* text, MessageKind kind, void*)
    {
        fprintf(stderr, "[%s] %s: %s\n", kind == MessageKind::Error ? "error" : kind == MessageKind::Warning ? "warning" : "info",
                title, text);
    }
    std::filesystem::path PickFolder(const char*, void*) { return {}; }

    bool DesktopDisplayMode(int& width, int& height, int& refreshHz)
    {
        width = 1280;
        height = 720;
        refreshHz = 60;
        return false;
    }

    int CompareNoCase(const char* a, const char* b) { return strcasecmp(a, b); }
}
