#!/bin/sh
# MAIN only, AFTER judge confirms completion. Pass the setup STATE receipt path.
set -eu
STATE=${1:?Pass the absolute STATE printed by setup.sh}
case "$STATE" in /tmp/umami-ai-synthetic.*) ;; *) echo 'Not a fixture path' >&2; exit 1 ;; esac
[ -d "$STATE" ] && [ ! -L "$STATE" ]
[ "$(head -n 1 "$STATE/owner")" = umami-ai-synthetic-r3 ]
[ "$(head -n 1 "$STATE/receipt")" = "$STATE" ]
NAME=umami-ai-synthetic-r3
[ "$(docker inspect --format '{{index .Config.Labels "umami.ai.synthetic"}}' "$NAME")" = "$STATE" ]
[ "$(docker inspect --format '{{.Id}}' "$NAME")" = "$(head -n 1 "$STATE/container.id")" ]
# pg_ctl verifies this data directory's postmaster; never kill a port owner.
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D "$STATE/pgdata" -m fast -w stop
docker rm -f -v "$NAME"
# Deliberately preserve logs and ownership receipt for inspection. Only these synthetic
# data files remain, no listening services. MAIN may remove STATE after reviewing logs.
printf 'Stopped owned fixtures; retained logs/data at %s\n' "$STATE"
