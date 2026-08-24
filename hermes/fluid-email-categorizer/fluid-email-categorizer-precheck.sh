#!/bin/sh
set -eu

exec node /opt/data/bin/fluid-email-categorizer.mjs claim --limit 5
