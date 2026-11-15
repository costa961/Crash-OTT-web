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

Plan: wasm32 linear memory of 4 GB with **guest address == linear address**, as GTA SA web does
(`g_mem == 0`, every guest load/store is one wasm load/store with no extra arithmetic). The guest never
touches `[0, 0x40000000)`, so the runtime's data, heap and stacks live there (`--global-base` low, a cap on
the runtime heap below `0x40000000`). Untouched pages cost no RAM.

Differences from the PC build, which reserves the 4 GB with `VirtualAlloc` and aliases views:
- **No aliasing.** The `0xA` and `0xC` views get disjoint physical ranges from the allocator, so each
  physical page has exactly one CPU view; the GPU maps a physical address back to its view.
- **No MMIO traps.** The PC build write-traps the GPU register page. Here the command processor thread
  polls the ring-buffer write pointer (Atomics.wait on a hook, or a tight poll), and XMA kicks are caught by
  hooking the guest functions that write them.

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
3. **Boot to the first frame headless** — in progress. `tools/run-node.mjs` (from GTA SA web's runner) boots
   the module under Node (`--experimental-wasm-exnref`; Chrome has exnref on by default): the XEX is
   decrypted, the call table filled, the title creates 12 guest threads, switches its loading fibers, reads
   XAM notifications and sign-in state and reaches its first `VdSwap`, where it waits for the GPU (still a
   stub). Linear memory: 3 GB. Next: crashott-pc's `gpu/video_imports.cpp`, `gpu.cpp` and
   `command_processor.cpp` with the ring-buffer write pointer polled instead of trapped, PM4 swaps counted.
4. **WebGPU renderer**: `rhi::Device` on WebGPU, Xenos → WGSL; menus on screen.
5. **Audio, input, saves** (OPFS / IndexedDB).
6. **Performance and polish**, deploy (Caddy + Docker, as GTA SA web).
