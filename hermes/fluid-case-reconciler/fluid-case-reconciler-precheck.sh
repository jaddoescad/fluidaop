#!/usr/bin/env bash
set -euo pipefail

exec node /opt/data/bin/fluid-case-reconciler.mjs claim --limit 3
