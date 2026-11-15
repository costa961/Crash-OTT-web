# Build environment for Crash of the Titans web.
#   docker build -t crashott-build docker
#   docker run --rm -v "$PWD:/src" -v "<game folder>:/game:ro" -w /src crashott-build tools/build.sh
#
# - clang/cmake/ninja (native): XenonRecomp, which turns the player's default.xex into C++.
# - wasi-sdk: compiles that C++ and the runtime into the browser module (wasm32 + threads),
#   as GTA San Andreas web's docker image does.
# - SIMDe: header-only x86 intrinsics (SSE..AVX) on top of wasm SIMD128; the generated code
#   uses them for VMX128.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git bash coreutils make python3 \
      clang lld cmake ninja-build && rm -rf /var/lib/apt/lists/*
ARG WASI_VER=34
RUN curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VER}/wasi-sdk-${WASI_VER}.0-x86_64-linux.tar.gz" \
      | tar -xz -C /opt && ln -s /opt/wasi-sdk-${WASI_VER}.0-x86_64-linux /opt/wasi-sdk
ENV WASI=/opt/wasi-sdk
ARG SIMDE_VER=0.8.2
RUN curl -fsSL "https://github.com/simd-everywhere/simde/archive/refs/tags/v${SIMDE_VER}.tar.gz" \
      | tar -xz -C /opt && ln -s /opt/simde-${SIMDE_VER} /opt/simde
ENV SIMDE=/opt/simde
ARG NODE_VER=24.11.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz" \
      | tar -xJ -C /opt && ln -s /opt/node-v${NODE_VER}-linux-x64/bin/node /usr/local/bin/node \
      && ln -s /opt/node-v${NODE_VER}-linux-x64/bin/npm /usr/local/bin/npm
RUN git config --global --add safe.directory '*'
