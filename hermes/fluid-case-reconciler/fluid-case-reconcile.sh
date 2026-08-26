#!/usr/bin/env bash
set -euo pipefail

node /opt/data/bin/fluid-case-reconciler.mjs reconcile --limit 1000
