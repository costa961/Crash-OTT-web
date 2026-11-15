// The browser build has no x86 intrinsics: SSE2 through SIMDe on wasm SIMD128, with the native
// names (_mm_*, __m128i) the runtime's code uses (xenos_renderer.cpp).
#pragma once
#ifndef SIMDE_ENABLE_NATIVE_ALIASES
#define SIMDE_ENABLE_NATIVE_ALIASES
#endif
#include <x86/sse2.h>
