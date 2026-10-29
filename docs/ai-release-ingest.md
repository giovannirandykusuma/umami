# Immutable release: required geo and ingestion gate

Do not accept a release based only on heartbeat, seeded analytics, or model turns.
Only MAIN deploys; these commands operate locally and never contact production.

## Build and pin

```sh
docker build -t umami-release:geo-ingest .
IMAGE=$(docker image inspect --format '{{.Id}}' umami-release:geo-ingest)
RELEASE_SMOKE_IMAGE="$IMAGE" RELEASE_SMOKE_INGEST_ONLY=1 \
  node scripts/ai/release-smoke/assistant-live.mjs
```

Require exit 0 and JSON `status: passed` with `ingestion.statuses: [200,200]`,
`persistedPageviews: 1`, `persistedEvents: 1`, and `geolocatedRows: 2`.
Retain the JSON with the immutable image ID. Deploy that same image only after
fresh review and other required release gates. No provider credentials or model
calls are needed for this ingestion gate. The ordinary assistant smoke also runs
this gate before any model turns. The separately owned `analytics-live.mjs` is
not modified here; its results do not substitute for this mandatory command.

The runner starts disposable Postgres and app containers on a unique network,
binds only loopback, creates its own invented user/sites, and submits an unseeded
pageview and uniquely named event to `/api/send`. It requires HTTP 200 on both
requests and queries actual `website_event` rows joined to `session`, scoped to
the synthetic site and unique URL. Public payload IP `8.8.8.8` forces mmdb lookup
rather than trusting provider location headers. A missing geolocation also fails.
Default cleanup removes containers, network, and temporary env file; do not set
`KEEP=1` for release automation. No production database or endpoint is involved.

## Asset contract

`build:docker` already invokes `build:geo`. Docker no longer exposes the
`SKIP_BUILD_GEO` build argument and performs an explicit post-build `--check`.
The geo builder waits for download/extraction and file completion, validates the
MaxMind database type and a real public-IP lookup, then atomically renames the
asset. Failed download, corrupt/missing database, or missing archive entry exits
nonzero. Neither a skip environment flag nor an old asset masks download failure.
A skip flag can only reuse an already valid local asset.

`.dockerignore` excludes host `geo/`; the builder downloads its own asset. The
runner explicitly copies `/app/geo` from the validated builder, readable by
`nextjs`. `getLocation` uses `process.cwd()/geo/GeoLite2-City.mmdb` (or an explicit
`GEOLITE_DB_PATH` override); it still throws for a missing database. No lookup
fallback, runtime behavior, or API permissions were weakened. `start-docker.sh`
continues to migrate the database then exec the server, without downloading geo.

## Offline regression

With project dependencies installed and a canonical real GeoLite2-City database:

```sh
GEO_TEST_DB=/absolute/path/to/GeoLite2-City.mmdb \
  node --test scripts/ai/release-smoke/geo-ingest.test.mjs
node scripts/build-geo.js --check /absolute/path/to/GeoLite2-City.mmdb
git diff --check
```

Tests cover missing/corrupt assets, skip failure, real database validation, both
raw and tar.gz downloads via local HTTP, Docker inclusion, HTTP failure, and HTTP
200 without persisted pageview/event/geolocation. They perform no external
network calls. The narrow test uses Node's test runner, not the repository's
Vitest include pattern.

## Verification boundary

Offline tests do not prove a newly built image works. The immutable build and
synthetic HTTP+DB smoke above remain mandatory before acceptance. Existing local
images built without geo are not valid release candidates; hot-copying an asset
into a running container is not an immutable-release proof. This change does not
perform a rebuild, deployment, production call, or paid model evaluation.
