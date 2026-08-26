#!/bin/sh
set -eu
exec node /opt/data/bin/fluid-action-runner.mjs claim --limit 5
