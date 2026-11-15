// Included first in every runtime source of the browser build (tools/wasm_runtime.sh -include).
#pragma once

// wasi-libc's <limits.h> defines PAGE_SIZE (the 64 KB wasm page) as a macro, which breaks every
// `PAGE_SIZE` member and constant of the runtime (kernel/page_heap.h). Include it once here and
// drop the macro; later includes of <limits.h> are no-ops.
#include <limits.h>
#undef PAGE_SIZE
