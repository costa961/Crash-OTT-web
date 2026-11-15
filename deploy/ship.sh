#!/bin/sh
# To your server over SSH: the image deploy/build.sh made and this folder's compose and Caddy files. The game folder
# goes once, by hand (README.md). .env is never sent: it is made on the server.
#   sh deploy/ship.sh user@server [/srv/crashott]
# The image goes straight from this computer to your server (docker save | ssh | docker load): no registry.
set -eu
[ $# -ge 1 ] || { echo "usage: sh deploy/ship.sh user@server [dir, default /srv/crashott]" >&2; exit 2; }
host=$1 dir=${2:-/srv/crashott}
cd "$(dirname "$0")/.."
ssh "$host" "mkdir -p '$dir/game'"
docker save "${CRASHOTT_IMAGE:-crashott-web:latest}" | gzip | ssh "$host" 'gunzip | docker load'
tar -C deploy -cf - compose.yml compose.shared.yml Caddyfile caddy-entry.sh caddy-site.example .env.example | ssh "$host" "tar -C '$dir' -xf -"
echo "ship.sh: on $host, in $dir: the game folder in game/ and .env (from .env.example) the first time, then  docker compose up -d"
