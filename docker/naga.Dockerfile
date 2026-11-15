# naga (wgpu's shader translator) as a WGSL validator for tools/shader_test.sh.
#   docker build -t crashott-naga -f docker/naga.Dockerfile docker
#   docker run --rm -v "$PWD:/src" -w /src crashott-naga naga shader.wgsl
FROM rust:1-bookworm AS build
ARG NAGA_VER=27.0.0
RUN cargo install naga-cli --version ${NAGA_VER} --locked

FROM debian:bookworm-slim
COPY --from=build /usr/local/cargo/bin/naga /usr/local/bin/naga
