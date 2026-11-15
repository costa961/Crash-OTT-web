#!/bin/bash
# Step 1 of the build: the player's default.xex -> C++ (out/recomp/generated/ppc).
# Runs inside the crashott-build image (docker/Dockerfile) with the game folder at /game:
#   docker run --rm -v "$PWD:/src" -v "<game folder>:/game:ro" -w /src crashott-build tools/recomp.sh
#
# XenonRecomp is fetched at the commit crashott-pc pins, with crashott-pc's patch and its
# config (config/Crash.toml: entry point, helpers, jump tables, explicit functions), all taken
# from the third_party/crashott-pc submodule. The generated code is derived from the player's
# own game: it stays in out/ and is never committed or published.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
GAME="${GAME:-/game}"
CPC="$ROOT/third_party/crashott-pc"
OUT="$ROOT/out/recomp"
XENON="$ROOT/out/XenonRecomp"
XENON_URL="https://github.com/hedge-dev/XenonRecomp.git"
# tr: a Windows checkout of the submodule may have CRLF line ends
XENON_COMMIT="$(tr -d '\r' < "$CPC/tools/setup.py" | sed -n 's/^XENON_COMMIT = "\(.*\)"/\1/p')"
XEX_SHA256="$(tr -d '\r' < "$CPC/tools/setup.py" | sed -n 's/^XEX_SHA256 = "\(.*\)"/\1/p')"

[ -f "$CPC/config/Crash.toml" ] || { echo "third_party/crashott-pc is empty: git submodule update --init"; exit 1; }
[ -f "$GAME/default.xex" ] || { echo "$GAME/default.xex not found: mount your extracted game folder at /game"; exit 1; }
sum="$(sha256sum "$GAME/default.xex" | cut -d' ' -f1)"
if [ "$sum" != "$XEX_SHA256" ]; then
  echo "default.xex is not the retail Xbox 360 one this port is for (sha256 $sum, expected $XEX_SHA256)"; exit 1
fi
echo "[recomp] default.xex ok"

# ---- XenonRecomp at the pinned commit + crashott-pc's patch ----
if [ ! -d "$XENON/.git" ]; then
  git clone -q "$XENON_URL" "$XENON"
fi
# Then this project's patch: the WebAssembly branches of ppc_context.h (FPSCR, __rdtsc, setFromMask).
patch_sum="$(cat "$CPC/patches/XenonRecomp.patch" "$ROOT/patches/XenonRecomp-wasm.patch" | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$XENON/.patched" 2>/dev/null)" != "$XENON_COMMIT $patch_sum" ]; then
  git -C "$XENON" checkout -q -f "$XENON_COMMIT"
  git -C "$XENON" clean -qfdx -e build
  git -C "$XENON" submodule update -q --init --recursive
  git -C "$XENON" apply --whitespace=nowarn "$CPC/patches/XenonRecomp.patch"
  git -C "$XENON" apply --whitespace=nowarn "$ROOT/patches/XenonRecomp-wasm.patch"
  echo "$XENON_COMMIT $patch_sum" > "$XENON/.patched"
  echo "[recomp] XenonRecomp ${XENON_COMMIT:0:10} + crashott-pc patch + wasm patch"
fi
cmake -S "$XENON" -B "$XENON/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_CXX_FLAGS="-include cstdlib -Wno-unused-result" -DCMAKE_C_FLAGS="-Wno-format" -Wno-deprecated >/dev/null
cmake --build "$XENON/build" --target XenonRecomp

# ---- run it with crashott-pc's config ----
# Crash.toml's paths are relative to it: ../private/default.xex and ../generated/ppc.
mkdir -p "$OUT/config" "$OUT/private"
cp "$CPC/config/Crash.toml" "$CPC/config/Crash_switch_tables.toml" "$OUT/config/"
ln -sf "$GAME/default.xex" "$OUT/private/default.xex"
stamp="$(cat "$OUT/config/"*.toml "$XENON/.patched" | sha256sum | cut -c1-40) $sum"
if [ "$(cat "$OUT/generated/ppc/.stamp" 2>/dev/null)" = "$stamp" ]; then
  echo "[recomp] out/recomp/generated/ppc is up to date"; exit 0
fi
rm -rf "$OUT/generated/ppc"; mkdir -p "$OUT/generated/ppc"
(cd "$OUT" && "$XENON/build/XenonRecomp/XenonRecomp" config/Crash.toml "$XENON/XenonUtils/ppc_context.h" 2>&1 |
  grep -Ev "ERROR: __(save|rest)vmx_[0-9]+ address is unspecified" || true)
ls "$OUT/generated/ppc"/ppc_recomp.*.cpp >/dev/null
echo "$stamp" > "$OUT/generated/ppc/.stamp"
echo "[recomp] $(ls "$OUT/generated/ppc" | wc -l) files in out/recomp/generated/ppc"
