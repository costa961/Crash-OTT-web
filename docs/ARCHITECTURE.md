# Architecture

Crash of the Titans (Xbox 360) in the browser, built from the player's own disc.

## Distribution model

The repository holds tools and runtime code only. Everything derived from the game (the recompiled code,
the browser module, extracted files) is produced on the player's machine by a Docker build and stays there
or on the player's own server (as GTA San Andreas web does). Nothing derived from the game is ever committed
or published.

```
player's ISO ──tools/xiso.py──▶ game folder (default.xex, *.rcf, shaders/)
                                   │
                    tools/recomp.sh (XenonRecomp + crashott-pc config)
                                   ▼
                     out/recomp/generated/ppc/*.cpp   (~60 MB C++)
                                   │
                    tools/build.sh (wasi-sdk, SIMDe, web runtime)
                                   ▼
                          out/web/crashott.wasm  + page (web/)
                                   │
              served locally or by the player's server, with the game folder
```

## Building blocks

| Layer | Source | Web work |
|---|---|---|
| PPC → C++ | XenonRecomp + `third_party/crashott-pc/config`, `patches` | none: same output as crashott-pc |
| C++ → wasm | wasi-sdk, `wasm32-wasip1-threads` | memory model, SIMD, setjmp/EH (below) |
| Kernel HLE (threads, sync, memory, files, XAM) | `crashott-pc/runtime/kernel`, `fs` | Win32/SDL → wasi threads, Atomics; fibers |
| GPU (PM4, Xenos state, EDRAM, textures) | `crashott-pc/runtime/gpu/xenos_renderer.cpp` (API-agnostic, `rhi.h`) | new `rhi::Device` on WebGPU; shader translator backend Xenos → WGSL |
| Audio (XMA) | `crashott-pc/runtime/audio` (FFmpeg WMA Pro) | FFmpeg's decoder built for wasm, or WebCodecs; AudioWorklet output |
| Input | `crashott-pc/runtime/kernel/xinput_*` | Gamepad API + keyboard, from GTA SA web |
| Page, loader, saves, deploy | GTA San Andreas web `web/`, `deploy/` | adapt |

## Memory model

The Xbox 360 guest uses 32-bit addresses (crashott-pc `docs/internals/recompiler-and-runtime.md`):

| Guest range | Use |
|---|---|
| `0x40000000-0x7FC00000` | virtual heap |
| `0x7FC80000` | GPU registers (MMIO) |
| `0x7FEA0000` | XMA registers (MMIO) |
| `0x82000000-…` | the XEX image |
| `0xA0000000-0xBFFFFFFF` | physical memory, 64 KB pages |
| `0xC0000000-0xDFFFFFFF` | physical memory, 16 MB pages (an alias of the same 512 MB on the console) |

wasm32 linear memory up to 4 GB with **guest address == linear address**, as GTA SA web does (`base` is
address 0). The guest never touches `[0, 0x40000000)`, so the runtime's data, heap and stacks live there.
Linear memory grows as the guest heaps are committed (`runtime/memory_wasm.cpp`); the boot reaches 3 GB
(`0xC0000000`, the top of the physical heap). On Windows the browser commits what it grows (commit charge,
not RAM: untouched pages stay zero pages).

Differences from the PC build, which reserves the 4 GB with `VirtualAlloc` and aliases views:
- **Folded physical views.** The title's D3D reads physical memory through the `0xC0000000` view as well
  as `0xA0000000` (e.g. `memcpy` from `0xCAE21000` of what was allocated at `0xAAE21000`), and linear memory
  can't map a page twice. `patches/XenonRecomp-wasm.patch` makes `base` an empty `PPCBase` on wasm whose
  `operator+` folds `0xC0000000-0xDFFFFFFF` onto `0xA0000000` (`PPCGuestToHost`): it covers the
  `PPC_LOAD/STORE` macros and the ~1,500 direct `base + ea` the recompiler emits (vector loads/stores,
  reservations, setjmp), costs a shift, a compare and a select per access, and nothing in the calling
  convention (the wasm C++ ABI passes no empty struct). The `0xE0000000` view stays unmapped, as on PC.
- **No MMIO traps.** The PC build write-traps the GPU register page. Here the guest's stores land in the
  register window like any other (`patches/crashott-pc-web.patch`: `gpu::ReadRegister/WriteRegister` use
  the window memory for the first page too), and the command processor polls `CP_RB_WPTR` every 2 ms, as
  it already did on PC as a fallback. XMA kicks: to do (hook the guest functions that write them).

crashott-pc's runtime is compiled from a copy (`out/web/cpc-src`) with `patches/crashott-pc-web.patch`
applied; the submodule stays untouched.

The runtime's heap stays below `0x40000000` through `runtime/sbrk.c`: wasi-libc's own sbrk grows memory
at its end, which here belongs to the guest.

## Threads, fibers, exceptions

- Guest threads → wasi threads (Web Workers sharing the memory); the page needs cross-origin isolation
  (COOP/COEP), as GTA SA web already serves. `ExitThread` longjmps back to the thread's entry (wasi-libc
  has no `pthread_exit`, as in GTA SA web).
- XAPI fibers (`SwitchToFiber`, used by the loader) → one thread per fiber that runs only while it holds
  the baton (a futex gate). A resumed fiber sets `__tls_base` to the thread-local block of the thread that
  resumed it, so the runtime's `thread_local`s (current guest thread, current fiber) behave as on Windows,
  where a fiber shares its thread's. Only one thread of a chain runs at a time.
- setjmp/longjmp → wasm exception handling (`-mexception-handling`, `-wasm-enable-sjlj`, exnref).

## Milestones

1. **Bring your own disc** — done: `tools/xiso.py`, `tools/recomp.sh`, Docker image.
2. **The recompiled code compiles to wasm** — done: `tools/wasm_recomp.sh` compiles all 80 shards
   (wasi-sdk 34, SIMDe 0.8.2, `-O2`) in 36 s into 21 MB of objects, after `patches/XenonRecomp-wasm.patch`
   (FPSCR and `__rdtsc` for wasm; `simde__m128`/`simde__m128i` are the same `v128_t` there, so
   `CRRegister::setFromMask` picks the movemask from its `imm`). A trial link leaves 156 undefined symbols:
   the 152 kernel/XAM imports (`__imp__Ke*`, `Ex*`, `Xam*`, … — crashott-pc `runtime/kernel`) plus
   `__c_longjmp` and a few helpers.
2b. **The module links with the kernel** — done: `tools/wasm_runtime.sh` builds `web/runtime.txt` (crashott-pc's
   kernel, file system, XEX loader and XenonUtils unchanged, plus `runtime/`: `platform_wasm.cpp`,
   `memory_wasm.cpp`, `sbrk.c`, `diagnostics_wasm.cpp`, `main_wasm.cpp`, `stubs.cpp`) into a 23 MB
   `out/web/crashott.wasm`. Built with `-fno-exceptions` (wasi-sdk's libc++ has none; the runtime throws none).
3. **Boot to the first frame headless** — done. `tools/run-node.mjs` (from GTA SA web's runner) boots the
   module under Node (`--experimental-wasm-exnref`; Chrome has exnref on by default) with crashott-pc's GPU
   front end (`gpu.cpp`, `command_processor.cpp`, `video_imports.cpp`, the D3D hooks) and a null renderer
   (`runtime/stubs.cpp`): in 120 s the title runs 3,660 frames at its 30 fps (2 vblanks per swap), every
   swap packet executed by the command processor, ~10,000 interrupts delivered, and opens the Bink shaders
   for its intro movies.
4. **WebGPU renderer**: `rhi::Device` on WebGPU, Xenos → WGSL; menus on screen.
5. **Audio, input, saves** (OPFS / IndexedDB).
6. **Performance and polish**, deploy (Caddy + Docker, as GTA SA web).
