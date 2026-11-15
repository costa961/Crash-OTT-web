# Crash of the Titans in the browser on your own private server

> **Private servers only.** This folder is for running the game on a server **of your own, for yourself** (and at
> most for a few people who own the game too), behind a login. It is not a way to publish the game.
>
> What the server holds and sends comes from **your** copy of the game: your game files, and the game module
> (`crashott.wasm`), which is code recompiled from the game's executable. So:
> - **keep the login on**, and don't share access with people who don't own the game;
> - **never make the site public** (no open link, no listing, no ads);
> - **never push the server's image to a public registry** (Docker Hub, GHCR...) nor attach it, the game module or
>   any game file to a GitHub release, an issue or a fork. `ship.sh` sends the image straight to your server.
>
> This repository contains none of that and stays that way: everything the game needs is built on your machine.

Two containers (`compose.yml`): the game's server (`Dockerfile`: `tools/serve.mjs` with the page and the game
module) and Caddy in front of it, for HTTPS and the login. Only Caddy is reachable from outside, on ports 80 and 443.
The game's server mounts your game folder read-only and has nothing anyone can write: the saves stay in each
player's browser (Export saves on the start page makes a copy).

**The login:** the browser asks once for a name and a password (Caddy's basic auth). After that a cookie of the
player's own lets them in for a year without asking. The players are in `.env` (`CRASHOTT_USERS`). A new password,
or a new `CRASHOTT_COOKIE_SECRET`, logs that player (or everyone) out at the next `docker compose up -d`. Caddy
refuses to start with the example values (`CHANGE_ME`) still in `.env`. Search engines are told to stay out
(`X-Robots-Tag`), but the login is what keeps the site private.

**What the server needs:**
- Docker with compose.
- A name (DNS record) that points at it: `CRASHOTT_HOST`. The page needs HTTPS (WebGPU and the shared memory work
  only in a secure context), and Caddy gets the certificate from Let's Encrypt on its own.
- Ports 80 and 443 open.
- About 2 GB of disk for the game folder. The players' browsers download the game files from it (about 1.9 GB, once,
  with "Download game data", or as the game reads them).

## Steps

1. **The game module, on your computer:** build it as the main [README](../README.md) says (Build, steps 1-5b):
   `out/web/crashott.wasm`.
2. **The image, on your computer:** `sh deploy/build.sh` (Git Bash on Windows). It builds the page and the image
   `crashott-web:latest`.
3. **To the server:** `sh deploy/ship.sh user@server /srv/crashott`.
   This sends the image (over SSH, no registry) and the compose and Caddy files. Not `.env`, not the game.
4. **The game folder, once:** the folder made by step 1 of the Build (`default.xex`, the `.rcf` files, `shaders/`)
   goes to `/srv/crashott/game`:
   `scp -r "<game folder>/." user@server:/srv/crashott/game/`
   Then make it readable on the server: `chmod -R u=rwX,go=rX /srv/crashott/game`.
5. **.env, on the server, in /srv/crashott:**
   - `cp .env.example .env`
   - Fill in `CRASHOTT_HOST`, the players in `CRASHOTT_USERS` (`name:password`, separated by spaces) and
     `CRASHOTT_COOKIE_SECRET` (`openssl rand -hex 32`).
   - `chmod 600 .env`
6. **Start:** `docker compose up -d && docker compose logs -f`.
   Then open `https://<CRASHOTT_HOST>/` in Chrome or Edge.

**An update:** `sh deploy/build.sh` (after rebuilding the game module, if its sources changed), then
`sh deploy/ship.sh user@server /srv/crashott`, then on the server `docker compose up -d`.

## A server that already has a reverse proxy

If ports 80 and 443 are already taken (another Caddy for other sites), run the game's server alone with
`docker compose -f compose.shared.yml up -d`: it listens on `127.0.0.1:8082` (`CRASHOTT_HTTP_PORT`). Then add
`caddy-site.example` to that Caddy's configuration, with your host name and a password hash, and reload it.
Whatever proxy you use, it must ask for a login: the game's server itself has none.

## Notes

- The page is cross-origin isolated (`Cross-Origin-Opener-Policy` / `-Embedder-Policy`): `tools/serve.mjs` sends
  those headers and Caddy passes them on. A proxy that drops them breaks the game (the start page says what is
  missing).
- The game module and the page travel compressed (zstd / gzip); the game files don't (the page reads them with
  range requests).
- Nothing is logged by the game's server; Caddy keeps its own access log in the container's log (`docker compose
  logs caddy`).
