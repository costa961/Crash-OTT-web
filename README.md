# Crash-OTT-web

Crash of the Titans (Xbox 360) in the browser, built from **your own copy** of the game.

> **Status: playable, work in progress.** The game boots, plays its videos, menus and story at its
> original 30 fps in Chrome / Edge, with sound and controls. Some PC-only extras of crashott-pc are off, and
> a few rendering paths are still simplified: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This repository contains no game code and no game assets. You supply your own legally obtained
Xbox 360 disc image; a Docker build turns it into a browser module on your machine. What it produces is
derived from your game: keep it for yourself, never publish it.

It ports [crashott-pc](https://github.com/VitoMiguelF/crashott-pc) (a static recompilation of the
Xbox 360 game for PC, built with [XenonRecomp](https://github.com/hedge-dev/XenonRecomp)) to WebAssembly and
WebGPU.

## Requirements

- The Xbox 360 disc image of Crash of the Titans (the retail `default.xex`; the build checks its SHA-256).
- Docker, Python 3, git.
- To play: a Chromium-based browser with WebGPU.

## Build

```sh
git clone --recursive https://github.com/<you>/Crash-OTT-web
cd Crash-OTT-web

# 1. Your disc image -> game folder (default.xex, *.rcf, shaders/)
python tools/xiso.py extract "Crash of the Titans.iso" ../crashott-game --only "default.xex,*.rcf,shaders/*"

# 2. Build image (wasi-sdk, clang, SIMDe)
docker build -t crashott-build docker

# 3. default.xex -> C++ (out/recomp/generated/ppc, ~60 MB, 20144 functions)
docker run --rm -v "$PWD:/src" -v "$PWD/../crashott-game:/game:ro" -w /src crashott-build bash tools/recomp.sh

# 4. C++ -> wasm objects (out/web/obj)
docker run --rm -v "$PWD:/src" -w /src crashott-build bash tools/wasm_recomp.sh

# 5. Audio decoder (FFmpeg's WMA Pro, built from source; optional: without it the game is silent)
docker run --rm -v "$PWD:/src" -w /src crashott-build bash tools/ffmpeg_wasm.sh

# 5b. Runtime + link -> out/web/crashott.wasm
docker run --rm -v "$PWD:/src" -w /src crashott-build bash tools/wasm_runtime.sh

# Headless boot test under Node (no graphics yet)
docker run --rm -v "$PWD:/src" -v "$PWD/../crashott-game:/game:ro" -w /src crashott-build \
  node --experimental-wasm-exnref tools/run-node.mjs --game /game --timeout 60

# 6. The page
docker run --rm -v "$PWD:/src" -w /src/web crashott-build bash -c "npm install && node build.mjs"

# 7. Play: the local server, then http://localhost:8080 in Chrome or Edge (WebGPU)
docker run --rm -v "$PWD:/src" -v "$PWD/../crashott-game:/game:ro" -w /src -p 127.0.0.1:8080:8080 crashott-build \
  node tools/serve.mjs --game /game --host 0.0.0.0
```

## Playing

On the start page:
- **Language**: the six languages of the disc (the game's own voices and texts).
- **Download game data** (once, about 1.9 GB): the game files the game reads, into the browser's storage, for
  fast loads. Without it the game reads them from the local server.
- **FPS counter**: on/off.
- **Download logs**: the log of the last session and of this one (to report a problem).

Controls: a gamepad (the browser's "standard" mapping, an Xbox layout), or the keyboard as pad 1:

| Pad | Keyboard |
|---|---|
| Left stick | W A S D |
| D-pad | arrows |
| A | Space / Enter |
| B / X / Y | K / J / I |
| LB / RB | U / O |
| LT / RT | Q / E |
| Start / Back | Esc / Tab |
| Right stick | numpad 8 4 5 6 |

Saves stay in the browser (its storage for this site); the first start copies the saves an older build left
on the local server (`out/userdata/content`).

## Legal

The code in this repository is MIT-licensed ([LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
Crash of the Titans and its assets belong to their respective owners. This is an unofficial fan project, not
affiliated with or endorsed by them.
