#!/usr/bin/env sh
set -eu

exec node /opt/data/bin/fluid-potential-lead-classifier.mjs reconcile --limit 1000
