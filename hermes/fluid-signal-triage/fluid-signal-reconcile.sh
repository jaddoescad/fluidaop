#!/bin/sh
set -eu

node /opt/data/bin/fluid-signal-triage.mjs reconcile --limit 1000
exec node /opt/data/bin/fluid-quo-maintenance.mjs enrich-contacts
