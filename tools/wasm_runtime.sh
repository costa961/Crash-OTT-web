#!/bin/bash
# Step 3 of the build: the runtime (web/runtime.txt) -> out/web/rt/*.o, then the link with the
# recompiled code (tools/wasm_recomp.sh) -> out/web/crashott.wasm.
# Runs inside the crashott-build image.
#   tools/wasm_runtime.sh            compile what changed + link
#   NOLINK=1 tools/wasm_runtime.sh   compile only (every error shown)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
GEN="$ROOT/out/recomp/generated/ppc"
XU="$ROOT/out/XenonRecomp"
OUT="$ROOT/out/web"
WASI="${WASI:-/opt/wasi-sdk}"; SIMDE="${SIMDE:-/opt/simde}"
J="${J:-$(nproc)}"; OPT="${OPT:--O2}"
mkdir -p "$OUT/rt"

# crashott-pc's runtime, copied with patches/crashott-pc-web.patch applied (the few CRASH_WEB
# changes it needs; the submodule itself stays untouched).
CPC="$OUT/cpc-src/runtime"
rm -rf "$OUT/cpc-src"; mkdir -p "$OUT/cpc-src"
cp -r "$ROOT/third_party/crashott-pc/runtime" "$OUT/cpc-src/"
mkdir -p "$OUT/cpc-src/thirdparty"
cp -r "$ROOT/third_party/crashott-pc/thirdparty/smaa" "$ROOT/third_party/crashott-pc/thirdparty/stb" "$OUT/cpc-src/thirdparty/"
# A repository of its own: inside this one, git apply would skip (silently) every path outside the
# current directory.
(cd "$OUT/cpc-src" && git init -q && git apply --ignore-whitespace "$ROOT/patches/crashott-pc-web.patch") ||
  { echo "patches/crashott-pc-web.patch does not apply to third_party/crashott-pc"; exit 1; }

# Guest layout (docs/ARCHITECTURE.md "Memory model"): guest address == linear memory address. The
# runtime's data, stack and heap stay below RUNTIME_END (runtime/sbrk.c), where the guest never goes.
RUNTIME_END=$((0x40000000))
INITIAL_MB="${INITIAL_MB:-1024}"

TARGET="--target=wasm32-wasip1-threads -pthread"
FEAT="-msimd128 -mbulk-memory -mnontrapping-fptoint -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
DEFS="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
  -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE -DCRASH_WEB=1 -DNOMINMAX"
COMMON="$TARGET $OPT $FEAT $DEFS -include $ROOT/runtime/compat/wasm_compat.h -fno-delete-null-pointer-checks -fno-strict-aliasing -g0"
INC_RT="-I$ROOT/runtime/compat -I$ROOT/runtime -I$CPC -I$GEN -I$SIMDE/simde -I$SIMDE"
# FFmpeg's WMA Pro decoder (tools/ffmpeg_wasm.sh), when built: the XMA decoder then makes sound.
FFMPEG_LIBS=""
if [ -f "$ROOT/out/ffmpeg/lib/libavcodec.a" ]; then
  INC_RT="$INC_RT -DCRASH_HAVE_FFMPEG=1 -I$ROOT/out/ffmpeg/include"
  FFMPEG_LIBS="$ROOT/out/ffmpeg/lib/libavcodec.a $ROOT/out/ffmpeg/lib/libavutil.a"
fi
INC_XU="-I$XU/XenonUtils -I$XU/thirdparty/libmspack/libmspack/mspack -I$XU/thirdparty/tiny-AES-c -I$XU/thirdparty/TinySHA1 -I$SIMDE -DNOMINMAX -w"

compile() { # kind path
  local kind="$1" rel="$2" src flags obj cc
  case "$kind" in
    cpc) src="$CPC/$rel"; flags="$INC_RT" ;;
    web) src="$ROOT/runtime/$rel"; flags="$INC_RT" ;;
    xu)  src="$XU/$rel"; flags="$INC_XU" ;;
  esac
  [ "$rel" = "xex_image/xex_image.cpp" ] && flags="$INC_XU -I$CPC"
  case "$src" in *.c) cc="$WASI/bin/clang -std=c17" ;; *) cc="$WASI/bin/clang++ -std=c++20 -fno-exceptions" ;; esac
  obj="$OUT/rt/${kind}_$(echo "$rel" | tr '/' '_').o"
  local sum; sum="$( (cat "$src" "$ROOT"/runtime/compat/*.h "$GEN"/ppc_config.h "$GEN"/ppc_context.h 2>/dev/null; echo "$cc $COMMON $flags") | sha1sum | cut -c1-40)"
  if [ -z "${NOLINK:-}" ] && [ -f "$obj" ] && [ "$(cat "$obj.sum" 2>/dev/null)" = "$sum" ]; then return 0; fi
  if out=$($cc $COMMON $flags -Wno-unused-label -c -o "$obj" "$src" 2>&1); then
    echo "$sum" > "$obj.sum"
    [ -z "$out" ] || printf "%s\n" "$out" | grep -E "warning:" | head -3
    echo "  ok $rel"
  else
    printf "%s\n" "$out" | grep -E "error:" | head -${ERRS:-8}
    echo "FAILED $rel"; return 1
  fi
}
export -f compile; export ROOT GEN CPC XU OUT WASI COMMON INC_RT INC_XU NOLINK ERRS 2>/dev/null

grep -Ev '^\s*(#|$)' web/runtime.txt | xargs -P "$J" -L 1 bash -c 'compile "$0" "$1"' ; status=$?
[ -n "${NOLINK:-}" ] && exit $status
[ $status -eq 0 ] || { echo "runtime compile failed"; exit 1; }
[ -n "$(ls "$OUT"/obj/*.o 2>/dev/null)" ] || { echo "out/web/obj empty: run tools/wasm_recomp.sh"; exit 1; }

# ---- link ----
# Only the objects of the sources listed now (a source taken out of web/runtime.txt leaves a stale .o).
RT_OBJS="$(grep -Ev '^\s*(#|$)' web/runtime.txt | while read -r kind rel; do echo "$OUT/rt/${kind}_$(echo "$rel" | tr '/' '_').o"; done)"
"$WASI/bin/clang++" $TARGET $OPT $FEAT -o "$OUT/crashott.wasm" "$OUT"/obj/*.o $RT_OBJS \
  -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
  -Wl,--initial-memory=$(( INITIAL_MB * 1048576 )) \
  -Wl,-z,stack-size=$(( 1 * 1048576 )) \
  -Wl,--export=crashott_runtime_end,--export=malloc,--export=free \
  $FFMPEG_LIBS -Wl,--error-limit=0 -lsetjmp -lwasi-emulated-mman -lwasi-emulated-signal \
  -lwasi-emulated-process-clocks -lwasi-emulated-getpid 2>&1 | tee "$OUT/link.log" | grep -v "^$" | head -60
[ -f "$OUT/crashott.wasm" ] && echo "[wasm_runtime] out/web/crashott.wasm $(du -h "$OUT/crashott.wasm" | cut -f1)"
