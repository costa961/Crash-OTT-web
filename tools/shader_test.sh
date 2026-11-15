#!/usr/bin/env bash
# Offline check of the Xenos -> WGSL shader translator (runtime/gpu_web/shader_translator_wgsl.cpp).
#
# Builds tools/shader_test.cpp natively with both translators (crashott-pc's HLSL one and ours),
# translates every captured microcode (out/userdata/ucode/{vs,ps}_<hash>.bin) and the game's own
# shaders (/game/shaders/*.out, when the game folder is mounted) into out/shader_test/<name>.{hlsl,wgsl},
# then validates each .wgsl with naga.
#
#   docker build -t crashott-naga -f docker/naga.Dockerfile docker      # once
#   docker run --rm -v "${PWD}:/src" crashott-naga cp /usr/local/bin/naga /src/out/tools/naga   # once
#   docker run --rm -v "${PWD}:/src" -v "<game folder>:/game:ro" -w /src crashott-build bash tools/shader_test.sh
#
# naga: $NAGA, else `naga` on the PATH, else out/tools/naga.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=out/shader_test
CPC=third_party/crashott-pc/runtime
mkdir -p "$OUT"
rm -f "$OUT"/*.hlsl "$OUT"/*.wgsl "$OUT"/*.naga.txt

echo "== build"
clang++ -std=c++20 -O1 -g -Wall -Wextra -Wno-unused-parameter \
    -I"$CPC" -Iruntime \
    tools/shader_test.cpp runtime/gpu_web/shader_translator_wgsl.cpp runtime/gpu_web/graphics_options_wgsl.cpp \
    "$CPC/gpu/shader_translator.cpp" \
    -o "$OUT/shader_test"

echo "== translate"
GAME_SHADERS=""
[ -d /game/shaders ] && GAME_SHADERS=/game/shaders
"$OUT/shader_test" "$OUT" out/userdata/ucode $GAME_SHADERS

NAGA="${NAGA:-}"
if [ -z "$NAGA" ]; then
    if command -v naga >/dev/null 2>&1; then NAGA=naga
    elif [ -x out/tools/naga ]; then NAGA=out/tools/naga
    else
        echo "naga not found: docker build -t crashott-naga -f docker/naga.Dockerfile docker &&" \
             "docker run --rm -v \"\${PWD}:/src\" crashott-naga cp /usr/local/bin/naga /src/out/tools/naga" >&2
        exit 1
    fi
fi

echo "== validate ($("$NAGA" --version))"
pass=0
fail=0
for f in "$OUT"/*.wgsl; do
    name=$(basename "$f" .wgsl)
    if "$NAGA" "$f" > "$OUT/$name.naga.txt" 2>&1; then
        pass=$((pass + 1))
        rm -f "$OUT/$name.naga.txt"
        echo "PASS $name"
    else
        fail=$((fail + 1))
        echo "FAIL $name (see $OUT/$name.naga.txt)"
        head -n 20 "$OUT/$name.naga.txt" | sed 's/^/    /'
    fi
done
echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
