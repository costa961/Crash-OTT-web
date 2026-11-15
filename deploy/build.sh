#!/bin/sh
# The server's image (Dockerfile), on your computer: the page (web/build.mjs, in the crashott-build image) and then
# the image, with the game module you built (README.md, Build: out/web/crashott.wasm).
#   sh deploy/build.sh
# The image holds code recompiled from your game: it stays private (Dockerfile).
set -eu
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1                    # Git Bash on Windows: the paths below go to docker as they are
src=$(pwd -W 2>/dev/null || pwd)
[ -f out/web/crashott.wasm ] || { echo "build.sh: no out/web/crashott.wasm: build the game module first (README.md, Build)" >&2; exit 1; }
docker run --rm -v "$src:/src" -w /src/web crashott-build sh -c "npm ci --no-audit --no-fund && node build.mjs"
docker build -f deploy/Dockerfile -t "${CRASHOTT_IMAGE:-crashott-web:latest}" .
echo "build.sh: image ${CRASHOTT_IMAGE:-crashott-web:latest} (private: never push it to a public registry)" >&2
