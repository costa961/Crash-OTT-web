# Third-party components

| Component | Use | License |
|---|---|---|
| [crashott-pc](https://github.com/VitoMiguelF/crashott-pc) (VitoMiguelF and contributors) | git submodule `third_party/crashott-pc`: XenonRecomp config and patch, runtime sources ported to the web | MIT |
| [XenonRecomp](https://github.com/hedge-dev/XenonRecomp) (hedge-dev) | fetched at build time: Xbox 360 PowerPC → C++ static recompiler | MIT |
| [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) | build image: clang/wasm-ld for the browser module | Apache-2.0 WITH LLVM-exception |
| [SIMDe](https://github.com/simd-everywhere/simde) | build image: x86 SIMD intrinsics on wasm SIMD128 | MIT |

The components crashott-pc itself lists in its `THIRD_PARTY_NOTICES.md` apply to the parts of it this
project uses.

Crash of the Titans, its code and its assets are not included and are not covered by any license in this
repository.
