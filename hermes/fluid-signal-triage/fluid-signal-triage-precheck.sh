#!/bin/sh
set -eu

exec node /opt/data/bin/fluid-signal-triage.mjs claim --limit 5
