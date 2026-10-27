#!/bin/sh
# Disposable local acceptance only. No application environment or existing services used.
set -eu
PG_BIN=/opt/homebrew/opt/postgresql@16/bin
NAME=umami-ai-synthetic-r3
# Replay may reuse only this exact owned, healthy fixture pair. Any mismatch
# fails closed without stopping, replacing, or connecting to unknown listeners.
if docker container inspect "$NAME" >/dev/null 2>&1; then
  STATE=$(docker inspect --format '{{index .Config.Labels "umami.ai.synthetic"}}' "$NAME")
  case "$STATE" in /tmp/umami-ai-synthetic.*) ;; *) echo 'Unknown fixture state' >&2; exit 1 ;; esac
  [ -d "$STATE" ] && [ ! -L "$STATE" ]
  [ "$(head -n 1 "$STATE/owner")" = "$NAME" ]
  [ "$(head -n 1 "$STATE/receipt")" = "$STATE" ]
  [ "$(docker inspect --format '{{.Id}}' "$NAME")" = "$(head -n 1 "$STATE/container.id")" ]
  [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" = true ]
  [ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$NAME")" = '{"8123/tcp":[{"HostIp":"127.0.0.1","HostPort":"28123"}]}' ]
  PID=$(head -n 1 "$STATE/pgdata/postmaster.pid")
  case "$PID" in ''|*[!0-9]*) echo 'Invalid fixture PID' >&2; exit 1 ;; esac
  [ "$(lsof -nP -t -iTCP:25432 -sTCP:LISTEN)" = "$PID" ]
  "$PG_BIN/pg_ctl" -D "$STATE/pgdata" status
  [ "$("$PG_BIN/psql" -XAt -h 127.0.0.1 -p 25432 -U ai_synthetic -d ai_synthetic -v ON_ERROR_STOP=1 -c 'show data_directory')" = "$STATE/pgdata" ]
  [ "$("$PG_BIN/psql" -XAt -h 127.0.0.1 -p 25432 -U ai_synthetic -d ai_synthetic -v ON_ERROR_STOP=1 -c 'select owner from ai_synthetic_owner')" = "$NAME" ]
  [ "$(curl --max-time 5 --silent --fail --user ai_synthetic:synthetic-only http://127.0.0.1:28123/ping)" = 'Ok.' ]
  printf 'Already running: STATE=%s PG_PID=%s CONTAINER=%s\n' "$STATE" "$PID" "$(head -n 1 "$STATE/container.id")"
  exit 0
fi
for port in 25432 28123; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port busy; inspect shikumi_ports. Never stop an unknown listener." >&2
    exit 1
  fi
done
# mktemp creates a unique owned directory outside the disposable worktree.
STATE=$(mktemp -d /tmp/umami-ai-synthetic.XXXXXXXX)
printf '%s\n' umami-ai-synthetic-r3 > "$STATE/owner"
printf '%s\n' "$STATE" > "$STATE/receipt"
"$PG_BIN/initdb" -D "$STATE/pgdata" -U ai_synthetic --auth-local=trust --auth-host=trust > "$STATE/initdb.log"
cat >> "$STATE/pgdata/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = 25432
unix_socket_directories = '$STATE'
EOF
"$PG_BIN/pg_ctl" -D "$STATE/pgdata" -l "$STATE/postgres.log" -w start
"$PG_BIN/createdb" -h 127.0.0.1 -p 25432 -U ai_synthetic ai_synthetic
# Restrict this synthetic database with an explicit fixture ownership marker.
"$PG_BIN/psql" -h 127.0.0.1 -p 25432 -U ai_synthetic -d ai_synthetic -v ON_ERROR_STOP=1 -c "create table ai_synthetic_owner (owner text); insert into ai_synthetic_owner values ('umami-ai-synthetic-r3');"
docker run -d --name "$NAME" --label "umami.ai.synthetic=$STATE" \
  -p 127.0.0.1:28123:8123 \
  -e CLICKHOUSE_USER=ai_synthetic -e CLICKHOUSE_PASSWORD=synthetic-only \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  clickhouse/clickhouse-server:24.8 > "$STATE/container.id"
i=0
until curl --silent --fail --user ai_synthetic:synthetic-only http://127.0.0.1:28123/ping > /dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "ClickHouse not ready; retained diagnostic state: $STATE" >&2
    exit 1
  fi
  sleep 1
done
printf 'STATE=%s\nPG_PID=%s\nCONTAINER=%s\n' "$STATE" "$(head -n 1 "$STATE/pgdata/postmaster.pid")" "$(head -n 1 "$STATE/container.id")" | tee "$STATE/services.receipt"
echo 'Keep both fixtures running until MAIN confirms judge completion.'
