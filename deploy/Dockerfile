# The server's image: tools/serve.mjs with the page (web/dist) and the game module (out/web/crashott.wasm).
#
# PRIVATE: crashott.wasm is recompiled from YOUR copy of the game, so this image contains code derived from
# the game. Keep it on your own machines and your own private server. Never push it to a public registry
# (Docker Hub, GHCR...) and never attach it to a release.
#
# No game files: compose.yml mounts your game folder. deploy/build.sh builds the page and then this image.
#   docker build -f deploy/Dockerfile -t crashott-web .        (from the repository's root)
FROM node:24-alpine
WORKDIR /app
COPY tools/serve.mjs tools/
COPY web/dist web/dist
COPY out/web/crashott.wasm out/web/
USER node
EXPOSE 8080
# /game: your game folder (default.xex, *.rcf, shaders/), read-only. No /fs/userdata: the saves stay in each
# player's browser, and the players can write nothing on the server.
CMD ["node", "tools/serve.mjs", "--game", "/game", "--no-userdata", "--host", "0.0.0.0", "--port", "8080"]
