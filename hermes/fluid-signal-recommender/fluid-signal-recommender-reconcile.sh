#!/usr/bin/env bash
set -euo pipefail

exec node /opt/data/bin/fluid-signal-recommender.mjs reconcile --limit 1000
