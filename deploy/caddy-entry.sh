#!/bin/sh
# Caddy's start in compose.yml: the players who may play, from .env, into /etc/caddy/users.caddy, then Caddy.
#   CRASHOTT_USERS="name:password name:password"     (names: letters, digits, _ . -; passwords without spaces)
#   CRASHOTT_COOKIE_SECRET=<random>                   (openssl rand -hex 32)
# Each player gets a name and a password (Caddy's basic auth, asked once) and then a cookie of their own for a
# year, so the browser is not asked again. The cookie's key comes from the secret, the name and the password: it
# outlives a restart, and changing a password (or the secret) logs that player (or everyone) out.
set -euf
: "${CRASHOTT_HOST:?set CRASHOTT_HOST in .env}"
: "${CRASHOTT_USERS:?set CRASHOTT_USERS in .env (name:password name:password)}"
: "${CRASHOTT_COOKIE_SECRET:?set CRASHOTT_COOKIE_SECRET in .env (openssl rand -hex 32)}"
case "$CRASHOTT_COOKIE_SECRET" in CHANGE_ME|"") echo "caddy-entry.sh: set CRASHOTT_COOKIE_SECRET (openssl rand -hex 32)" >&2; exit 2 ;; esac
hashes="" keys="" alts=""
for pair in $CRASHOTT_USERS; do
  name=${pair%%:*} pass=${pair#*:}
  case "$name" in *[!A-Za-z0-9_.-]*|"") echo "caddy-entry.sh: '$name': letters, digits, _ . - only" >&2; exit 2 ;; esac
  [ "$pass" != "$pair" ] && [ -n "$pass" ] || { echo "caddy-entry.sh: '$name': no password (name:password)" >&2; exit 2; }
  [ "$pass" != CHANGE_ME ] || { echo "caddy-entry.sh: '$name': still the example password (CHANGE_ME)" >&2; exit 2; }
  hash=$(caddy hash-password --plaintext "$pass")
  key=$(printf '%s\n%s\n%s' "$CRASHOTT_COOKIE_SECRET" "$name" "$pass" | sha256sum | cut -c1-40)
  hashes="$hashes		$name $hash
"
  keys="$keys		$name $key
"
  alts="$alts${alts:+|}$key"
done
cat > /etc/caddy/users.caddy <<EOF
# made by caddy-entry.sh: the players' passwords (hashed) and the keys their cookies keep
@member header_regexp member Cookie (?:^|;\s*)crashott_member=(?:$alts)(?:;|\$)
handle @member {
	import game
}
handle {
	route {
		basic_auth {
$hashes		}
		map {http.auth.user.id} {crashott_member_key} {
$keys		}
		header Set-Cookie "crashott_member={crashott_member_key}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax"
		import game
	}
}
EOF
echo "caddy-entry.sh: $(echo "$CRASHOTT_USERS" | wc -w) players for $CRASHOTT_HOST" >&2
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
