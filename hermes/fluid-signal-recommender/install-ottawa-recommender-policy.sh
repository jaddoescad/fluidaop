#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from __future__ import annotations

import datetime as dt
import os
from pathlib import Path
import py_compile
import shutil
import tempfile

path = Path('/opt/data/agent-hooks/ottawa-tool-policy.py')
source = path.read_text(encoding='utf-8')

constant = 'FLUID_SIGNAL_RECOMMENDER_SCRIPT = "/opt/data/bin/fluid-signal-recommender.mjs"'
function_name = 'def valid_signal_recommender(argv: list[str]) -> bool:'
decision = 'or valid_signal_recommender(argv) or valid_hermes_diagnostic(argv)'

installed = [constant in source, function_name in source, decision in source]
if any(installed) and not all(installed):
    raise SystemExit('refusing to modify a partially installed recommender policy')
if all(installed):
    print('Fluid Signal Recommender policy is already installed.')
    raise SystemExit(0)

constant_anchor = 'FLUID_SIGNAL_TRIAGE_SCRIPT = "/opt/data/bin/fluid-signal-triage.mjs"\n'
function_anchor = '\n\ndef valid_hermes_diagnostic(argv: list[str]) -> bool:\n'
decision_anchor = 'or valid_signal_triage(argv) or valid_hermes_diagnostic(argv)'
if source.count(constant_anchor) != 1:
    raise SystemExit('expected exactly one signal-triage constant anchor')
if source.count(function_anchor) != 1:
    raise SystemExit('expected exactly one Hermes diagnostic function anchor')
if source.count(decision_anchor) != 1:
    raise SystemExit('expected exactly one terminal decision anchor')

validator = r'''

def valid_signal_recommender(argv: list[str]) -> bool:
    if argv[:2] not in (
        ["node", FLUID_SIGNAL_RECOMMENDER_SCRIPT],
        ["/usr/bin/node", FLUID_SIGNAL_RECOMMENDER_SCRIPT],
    ):
        return False
    if len(argv) <= 2:
        return False
    command, rest = argv[2], argv[3:]
    if command == "complete":
        options = parse_pairs(rest, {"--job-id", "--recommendations"}, set())
        if not options or set(options) != {"--job-id", "--recommendations"}:
            return False
        job_id = str(options["--job-id"])
        if not (job_id.isdigit() and 1 <= int(job_id) <= 9_223_372_036_854_775_807):
            return False
        specification = str(options["--recommendations"])
        if specification == "none":
            return True
        items = specification.split(",")
        if not 1 <= len(items) <= 5:
            return False
        allowed_kinds = {"action", "reminder", "automation"}
        allowed_intents = {
            "reply", "follow_up", "schedule", "production", "payment_collection",
            "procurement", "colour_consult", "documentation", "review", "other",
        }
        seen: set[tuple[str, str]] = set()
        for item in items:
            parts = item.split(":")
            if len(parts) != 4:
                return False
            kind, intent, confidence, case_index = parts
            if kind not in allowed_kinds or intent not in allowed_intents:
                return False
            if not CONFIDENCE.fullmatch(confidence):
                return False
            if case_index != "none" and not (
                case_index.isdigit() and 0 <= int(case_index) <= 99
            ):
                return False
            fingerprint = (kind, intent)
            if fingerprint in seen:
                return False
            seen.add(fingerprint)
        return True
    if command == "fail":
        options = parse_pairs(rest, {"--job-id", "--error-code"}, set())
        if not options or set(options) != {"--job-id", "--error-code"}:
            return False
        job_id = str(options["--job-id"])
        return bool(
            job_id.isdigit()
            and 1 <= int(job_id) <= 9_223_372_036_854_775_807
            and options["--error-code"] in {
                "recommendation-failed",
                "context-insufficient",
                "completion-failed",
            }
        )
    return False
'''

updated = source.replace(constant_anchor, constant_anchor + constant + '\n', 1)
updated = updated.replace(function_anchor, validator + function_anchor, 1)
updated = updated.replace(
    decision_anchor,
    'or valid_signal_triage(argv) ' + decision,
    1,
)

if updated.count(constant) != 1 or updated.count(function_name) != 1 or updated.count(decision) != 1:
    raise SystemExit('recommender policy validation failed before write')

stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = path.with_name(f'{path.name}.bak-signal-recommender-{stamp}')
shutil.copy2(path, backup)

handle, temporary_name = tempfile.mkstemp(
    prefix='.ottawa-tool-policy-', suffix='.py', dir=str(path.parent)
)
temporary = Path(temporary_name)
try:
    with os.fdopen(handle, 'w', encoding='utf-8') as stream:
        stream.write(updated)
    os.chmod(temporary, path.stat().st_mode)
    py_compile.compile(str(temporary), doraise=True)
    os.replace(temporary, path)
finally:
    temporary.unlink(missing_ok=True)

print(f'Installed bounded Fluid Signal Recommender policy; backup: {backup}')
PY
