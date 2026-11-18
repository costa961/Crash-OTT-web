#!/bin/bash
# Optional step of the build: the online co-op's colour table for Crash's skins (out/web/mp_skin_palettes.inc).
# Runs inside the crashott-build image with the game folder at /game:
#   docker run --rm -v "$PWD:/src" -v "<game folder>:/game:ro" -w /src crashott-build bash tools/skin_table.sh
#
# crashott-pc's online code paints each player's Crash in its colour (online/mp_colors.cpp). A player wearing a
# skin (a costume from the save's extras) has palettes of its own: without this table only the normal Crash's
# fur takes the colour, and a skin keeps its look (an orange costume stays orange). crashott-pc's tools read the
# skin packages from default.rcf (tools/assets.py extract -> third_party/crashott-pc/private/assets, ignored by
# git) and write the table (tools/mp_skin_colours.py). tools/wasm_runtime.sh compiles it in when it is there.
# The table is game data: it stays in out/, never in git.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
GAME="${GAME:-/game}"
CPC="$ROOT/third_party/crashott-pc"
[ -f "$GAME/default.rcf" ] || { echo "$GAME/default.rcf not found: mount your extracted game folder at /game"; exit 1; }
mkdir -p "$ROOT/out/web"
python3 "$CPC/tools/assets.py" extract --archive default --game "$GAME"
python3 "$CPC/tools/mp_skin_colours.py" table "$ROOT/out/web/mp_skin_palettes.inc"
echo "[skin_table] out/web/mp_skin_palettes.inc (tools/wasm_runtime.sh compiles it in)"
