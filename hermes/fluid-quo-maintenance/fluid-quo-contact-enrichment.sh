#!/bin/sh
set -eu

exec node /opt/data/bin/fluid-quo-maintenance.mjs enrich-contacts
