#!/bin/sh
# Synthetic analyst app fixture. Local disposable PostgreSQL only (scripts/ai/synthetic-engines).
# Creates/migrates a dedicated, receipt-owned schema; never touches `public` or any other schema.
set -eu
PG_BIN=/opt/homebrew/opt/postgresql@16/bin
SCHEMA=analyst_fixture
OWNER=umami-analyst-fixture-r1
URL="postgresql://ai_synthetic@127.0.0.1:25432/ai_synthetic?schema=$SCHEMA"
psql() { "$PG_BIN/psql" -XAt -h 127.0.0.1 -p 25432 -U ai_synthetic -d ai_synthetic -v ON_ERROR_STOP=1 "$@"; }
# Refuse anything except the owned synthetic engine (its marker proves the database identity).
[ "$(psql -c 'select owner from public.ai_synthetic_owner')" = umami-ai-synthetic-r3 ] || {
  echo 'Not the synthetic engine; refusing' >&2
  exit 1
}
exists=$(psql -c "select count(*) from pg_namespace where nspname = '$SCHEMA'")
if [ "$exists" = 1 ]; then
  # The receipt is the schema comment (a marker table would block `migrate deploy`).
  [ "$(psql -c "select obj_description('$SCHEMA'::regnamespace)")" = "$OWNER" ] || {
    echo "Schema $SCHEMA exists without this fixture's receipt; refusing" >&2
    exit 1
  }
else
  psql -c "create schema $SCHEMA; comment on schema $SCHEMA is '$OWNER';"
fi
DATABASE_URL="$URL" node_modules/.bin/prisma migrate deploy >/dev/null
psql -f scripts/ai/analyst-fixture/seed.sql >/dev/null
printf 'FIXTURE_DATABASE_URL=%s\n' "$URL"
