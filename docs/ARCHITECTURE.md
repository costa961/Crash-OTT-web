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
4. **WebGPU renderer** — done (see Known gaps). crashott-pc's renderer (`xenos_renderer.cpp`, texture decode,
   resolves, EDRAM targets) runs unchanged on a recorder `rhi::Device` (`runtime/gpu_web/rhi_webgpu.cpp`,
   contract `webgpu_proto.h`): every call is a record in a command ring in shared memory, resources are
   numbered on the game side, and the upload ring (vertex data, indices, constants, texture levels) is
   mirrored into one GPU buffer per batch. The page replays it (`web/src/gpu/executor.ts`) on the main
   thread, one batch boundary at a time per animation frame (the canvas texture is only valid in its task).
   Draw shaders come from the WGSL translator (`runtime/gpu_web/shader_translator_wgsl.cpp`, a fork of
   crashott-pc's; 61/61 shaders of the corpus validate with naga: `tools/shader_test.sh`); the built-in
   passes (resolve, packed depth resolve, depth alias, present, FXAA) are WGSL ports in `web/src/gpu/passes.ts`.
   No geometry shaders: the renderer's own rectangle-list expansion (its Mali path). Not done yet: depth /
   stencil views sampled by draws, SMAA, the lighting remaster, the overlay, viewports outside their target.
   Headless check: `tools/shot.mjs` in GTA SA web's browser image, server and Chrome in one container
   (`?offscreen=1`: SwiftShader can't allocate a canvas swap chain there, frames are read back to a 2D canvas).
5. **Audio, input, saves, data** — done.
   - Audio: crashott-pc's XAudio / XMA imports, XMA decoder and mixer. The decoder's FFmpeg (WMA Pro only) is
     built from source for wasm (`tools/ffmpeg_wasm.sh`) and linked statically (`runtime/ffmpeg_wasm.cpp`).
     The mixer's frames go into a ring in shared memory that an AudioWorklet plays (`runtime/audio_device_web.cpp`,
     `web/src/audio-worklet.ts`). The XMA kick / lock / clear registers are write-1 registers the PC build
     traps: here every 32-bit guest store into `0x7FC00000-0x7FFFFFFF` calls `PPCMmioStore` after it lands
     (`patches/XenonRecomp-wasm.patch`, `runtime/mmio_wasm.cpp`), which also wakes the GPU command processor.
   - XMP (the Xbox music player) messages: crashott-pc's `xmsg_imports.cpp` (the title waits for their answers
     while it loads).
   - Input: the XAM input imports read four pads from a block the page writes once per frame
     (`runtime/input_wasm.cpp`, `web/src/input.ts`: Gamepad API, keyboard as pad 1, rumble). The same file answers
     the region, language and XConfig settings; the language is the start page's (`CRASHOTT_LANGUAGE`).
   - Game data: the start page downloads the files the game reads into OPFS (`web/src/host/download-worker.ts`,
     `gamecache.ts`); the game-thread workers open them with read-only sync access handles (`fs.ts`).
   - Saves (`/userdata`): OPFS through an I/O worker (`web/src/host/io-worker.ts`); the game's file calls are
     synchronous, so each game-thread worker posts its request and waits on a reply word (`Atomics.wait`).
   - Texture write watch off (`CRASH_TEXTURE_WATCH=0`): it relies on page protection, which WebAssembly lacks;
     the renderer hashes textures instead (CPU-updated textures: the Bink videos, dynamic UI).
6. **Performance** — 30 fps in game (the original rate). The fix that mattered: the WebGPU device's pipeline cache
   hashed `DrawPipelineKey` with its padding, which the renderer's copies leave undefined, so every draw made a
   new pipeline; keys are normalized now (`Normalized` in `rhi_webgpu.cpp`).

## Known gaps

- Stencil views sampled by draws: the null texture (depth views are copied to `r32float`); no draw of the menus,
  the videos or the first level samples one (the executor logs "a draw samples a ... texture" when one does).
- The cutscene skipper's own prompt (crashott-pc's `skip_cinematics.cpp`) is drawn with the PC build's menu art,
  not ported; the page draws one instead (`#skip`, `web/src/input.ts`), from `cutscenes::SkipPossible` (written into
  the input block by `runtime/input_wasm.cpp`) and the hold time of the skip buttons.
- Skip intro videos (`CRASH_SKIP_INTROS`): crashott-pc's direct boot checks the frontend data through the PC
  frontend's EXIT GAME exit, which the browser build doesn't add; `settings::QuitExit` answers the retail value.
- Graphics options: crashott-pc's motion blur, depth of field and shadow softness patches are ported to the WGSL
  shaders (`runtime/gpu_web/graphics_options_wgsl.cpp`, validated by `tools/shader_test.sh`), set from the start page
  (`CRASHOTT_MOTION_BLUR` / `_DEPTH_OF_FIELD` / `_SHADOW_SOFTNESS`, `runtime/main_wasm.cpp`). Not ported: the soft
  shadows of the lighting remaster, and the lighting remaster and overlay passes themselves.
- SMAA (`CRASHOTT_AA=smaa`): crashott-pc's three passes in WGSL (`web/src/gpu/smaa.ts`, SMAA 1x, preset high).
- Firefox and Safari: untested (WebGPU, wasm exception handling with exnref).
- Linear memory grows to 3 GB, because the title allocates all 512 MB of physical memory at `0xA0000000` and up
  (guest address == linear address). That is commit charge, not RAM: pages the game never touches stay zero pages.
  Lowering it means folding the physical views lower for every runtime access too (`g_memory.Translate` and the
  `base + guest` of crashott-pc's code), not only the recompiled code's: not done, for a gain of ~0.5 GB of commit.
- Deploy on a server (Caddy + Docker, as GTA SA web): to do.

## CI

`.github/workflows/ci.yml` checks what needs no game data: the page type-checks and builds, this project's patches
apply to the pinned XenonRecomp and crashott-pc, the WGSL translator's output validates with naga on the synthetic
shaders the harness assembles, and the Python tools compile.
