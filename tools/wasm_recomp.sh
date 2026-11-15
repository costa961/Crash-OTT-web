#!/bin/bash
# Step 2 of the build: out/recomp/generated/ppc/*.cpp -> out/web/obj/ppc_*.o (wasm32, threads, SIMD128).
# Runs inside the crashott-build image after tools/recomp.sh. Incremental: a shard is compiled again
# only when its source, the shared headers or the flags change.
#   J=8 OPT=-O2 tools/wasm_recomp.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
GEN="$ROOT/out/recomp/generated/ppc"
OUT="$ROOT/out/web/obj"
WASI="${WASI:-/opt/wasi-sdk}"; SIMDE="${SIMDE:-/opt/simde}"
J="${J:-$(nproc)}"; OPT="${OPT:--O2}"
[ -f "$GEN/ppc_config.h" ] || { echo "out/recomp/generated/ppc missing: run tools/recomp.sh first"; exit 1; }
mkdir -p "$OUT"

# Same wasm features as GTA SA web (web/build.sh there): threads, SIMD128, bulk memory, wasm EH
# with setjmp/longjmp on top of it (the game uses setjmp/longjmp).
CXXFLAGS="--target=wasm32-wasip1-threads -pthread $OPT -std=c++20 \
  -msimd128 -mbulk-memory -mnontrapping-fptoint -mexception-handling \
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  -fno-delete-null-pointer-checks -fno-strict-aliasing \
  -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE \
  -I$SIMDE/simde -I$SIMDE -I$GEN -Wno-unused-label -Wno-unused-variable"
HDRSUM="$( (cat "$GEN"/ppc_config.h "$GEN"/ppc_context.h "$GEN"/ppc_recomp_shared.h; echo "$CXXFLAGS") | sha1sum | cut -c1-16)"
export CXXFLAGS HDRSUM GEN OUT WASI

start=$(date +%s)
ls -S "$GEN"/*.cpp | xargs -P "$J" -n 1 bash -c '
  src="$1"; obj="$OUT/$(basename "$src" .cpp).o"
  sum="$( (cat "$src"; echo "$HDRSUM") | sha1sum | cut -c1-40)"
  if [ -f "$obj" ] && [ "$(cat "$obj.sum" 2>/dev/null)" = "$sum" ]; then exit 0; fi
  t0=$(date +%s)
  if ! out=$("$WASI/bin/clang++" $CXXFLAGS -c -o "$obj" "$src" 2>&1); then
    printf "%s\n" "$out" | grep -m 10 error >&2; echo "FAILED: $src" >&2; exit 1
  fi
  echo "$sum" > "$obj.sum"
  echo "  $(basename "$src") $(( $(date +%s) - t0 ))s"' bash
echo "[wasm_recomp] $(ls "$OUT"/*.o | wc -l) objects, $(du -sh "$OUT" | cut -f1), $(( $(date +%s) - start ))s"
