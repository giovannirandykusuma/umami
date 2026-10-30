#!/bin/sh
# Builds the local restricted verifier image used by the docker launcher. Local Docker only.
set -eu
docker build -f deploy/analyst-verifier/Dockerfile.verifier -t umami-analyst-verifier:local .
