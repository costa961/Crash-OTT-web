#!/bin/bash
# FFmpeg's WMA Pro decoder for the browser module: XMA frames are WMA Pro frames, and crashott-pc's
# XMA decoder (audio/xma.cpp) hands them to FFmpeg. Built from FFmpeg's source with wasi-sdk into
# static libraries (out/ffmpeg/{include,lib}): libavcodec with that one decoder, and libavutil.
# Runs inside the crashott-build image; tools/wasm_runtime.sh links it when it is there.
# FFmpeg is LGPL 2.1+: it is fetched and built on the player's machine, never committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
WASI="${WASI:-/opt/wasi-sdk}"
VERSION="${FFMPEG_VERSION:-7.1.1}"
SRC="$ROOT/out/ffmpeg-src/ffmpeg-$VERSION"
PREFIX="$ROOT/out/ffmpeg"
if [ -f "$PREFIX/lib/libavcodec.a" ] && [ "$(cat "$PREFIX/.version" 2>/dev/null)" = "$VERSION" ]; then
  echo "[ffmpeg] out/ffmpeg is up to date ($VERSION)"; exit 0
fi
mkdir -p "$ROOT/out/ffmpeg-src"
if [ ! -f "$SRC/configure" ]; then
  echo "[ffmpeg] fetching FFmpeg $VERSION"
  curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" | tar -xJ -C "$ROOT/out/ffmpeg-src"
fi
cd "$SRC"
CFLAGS="--target=wasm32-wasip1-threads -pthread -O2 -msimd128 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN"
./configure --prefix="$PREFIX" --enable-cross-compile --target-os=none --arch=wasm32 \
  --cc="$WASI/bin/clang" --cxx="$WASI/bin/clang++" --ar="$WASI/bin/llvm-ar" --ranlib="$WASI/bin/llvm-ranlib" \
  --nm="$WASI/bin/llvm-nm" --strip="$WASI/bin/llvm-strip" --host-cc=clang \
  --extra-cflags="$CFLAGS" --extra-ldflags="--target=wasm32-wasip1-threads -pthread" \
  --enable-static --disable-shared --disable-programs --disable-doc --disable-debug \
  --disable-everything --enable-decoder=wmapro \
  --disable-avformat --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample \
  --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-runtime-cpudetect \
  --disable-iconv --disable-zlib --disable-bzlib --disable-lzma --disable-sdl2 --disable-xlib --disable-vaapi --disable-vdpau \
  > "$ROOT/out/ffmpeg-configure.log" || { tail -20 ffbuild/config.log; exit 1; }
make -j"$(nproc)" > "$ROOT/out/ffmpeg-make.log" 2>&1 || { grep -m 20 -i "error" "$ROOT/out/ffmpeg-make.log"; exit 1; }
make install >/dev/null
echo "$VERSION" > "$PREFIX/.version"
echo "[ffmpeg] $(du -h "$PREFIX/lib/libavcodec.a" | cut -f1) libavcodec.a, $(du -h "$PREFIX/lib/libavutil.a" | cut -f1) libavutil.a in out/ffmpeg"
