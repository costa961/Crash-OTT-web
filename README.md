# Crash-OTT-web

Crash of the Titans (Xbox 360) in the browser, built from **your own copy** of the game.

> **Status: early work in progress, not playable yet.** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> for the plan and milestones.

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

# 5. Runtime + link -> out/web/crashott.wasm
docker run --rm -v "$PWD:/src" -w /src crashott-build bash tools/wasm_runtime.sh

# Headless boot test under Node (no graphics yet)
docker run --rm -v "$PWD:/src" -v "$PWD/../crashott-game:/game:ro" -w /src crashott-build \
  node --experimental-wasm-exnref tools/run-node.mjs --game /game --timeout 60
```

The page (WebGPU, audio, input) comes with the next milestones.

## Legal

The code in this repository is MIT-licensed ([LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
Crash of the Titans and its assets belong to their respective owners. This is an unofficial fan project, not
affiliated with or endorsed by them.
