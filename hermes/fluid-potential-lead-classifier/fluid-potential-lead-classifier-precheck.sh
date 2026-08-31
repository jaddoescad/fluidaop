#!/usr/bin/env sh
set -eu

exec node /opt/data/bin/fluid-potential-lead-classifier.mjs claim --limit 5
