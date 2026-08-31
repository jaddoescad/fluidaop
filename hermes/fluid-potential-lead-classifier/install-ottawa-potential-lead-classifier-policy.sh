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

constant = 'FLUID_POTENTIAL_LEAD_CLASSIFIER_SCRIPT = "/opt/data/bin/fluid-potential-lead-classifier.mjs"'
function_name = 'def valid_potential_lead_classifier(argv: list[str]) -> bool:'
decision = 'or valid_potential_lead_classifier(argv) or valid_hermes_diagnostic(argv)'

installed = [constant in source, function_name in source, decision in source]
if any(installed) and not all(installed):
    raise SystemExit('refusing to modify a partially installed Potential Lead classifier policy')
if all(installed):
    print('Potential Lead Classifier — inbound email, text, call → Potential Leads policy is already installed.')
    raise SystemExit(0)

function_anchor = '\n\ndef valid_hermes_diagnostic(argv: list[str]) -> bool:\n'
decision_anchor = 'or valid_hermes_diagnostic(argv)'
if source.count(function_anchor) != 1:
    raise SystemExit('expected exactly one Hermes diagnostic function anchor')
if source.count(decision_anchor) != 1:
    raise SystemExit('expected exactly one terminal decision anchor')

validator = r'''

FLUID_POTENTIAL_LEAD_CLASSIFIER_SCRIPT = "/opt/data/bin/fluid-potential-lead-classifier.mjs"


def valid_potential_lead_classifier(argv: list[str]) -> bool:
    if argv[:2] not in (
        ["node", FLUID_POTENTIAL_LEAD_CLASSIFIER_SCRIPT],
        ["/usr/bin/node", FLUID_POTENTIAL_LEAD_CLASSIFIER_SCRIPT],
    ):
        return False
    if len(argv) <= 2:
        return False

    def valid_job_id(value: object) -> bool:
        text = str(value)
        return text.isdigit() and 1 <= int(text) <= 9_223_372_036_854_775_807

    def valid_confidence(value: object) -> bool:
        try:
            number = float(str(value))
        except (TypeError, ValueError):
            return False
        return 0 <= number <= 1

    def safe_summary(value: object) -> bool:
        text = str(value)
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;?!()/@&+-")
        return bool(1 <= len(text) <= 240 and text == text.strip() and all(character in allowed for character in text))

    command, rest = argv[2], argv[3:]
    if command == "inspect":
        options = parse_pairs(rest, {"--job-id"}, set())
        return bool(options and set(options) == {"--job-id"} and valid_job_id(options["--job-id"]))
    if command == "complete":
        base = {"--job-id", "--verdict", "--confidence", "--lead-kind"}
        required = base | {"--summary"}
        options = parse_pairs(rest, required, set())
        if not options:
            required = base
            options = parse_pairs(rest, required, set())
        if not options or set(options) != required:
            return False
        verdict = str(options["--verdict"])
        kinds = {"quote-request", "service-question", "booking", "missed-call", "voicemail", "other"}
        return bool(
            valid_job_id(options["--job-id"])
            and verdict in {"lead", "not-lead"}
            and valid_confidence(options["--confidence"])
            and options["--lead-kind"] in kinds
            and (verdict != "lead" or "--summary" in options)
            and ("--summary" not in options or safe_summary(options["--summary"]))
        )
    if command == "fail":
        options = parse_pairs(rest, {"--job-id", "--error-code"}, set())
        return bool(
            options
            and set(options) == {"--job-id", "--error-code"}
            and valid_job_id(options["--job-id"])
            and options["--error-code"] in {
                "classification-failed", "context-insufficient",
                "inspection-failed", "completion-failed",
            }
        )
    return False
'''

updated = source.replace(function_anchor, validator + function_anchor, 1)
updated = updated.replace(decision_anchor, decision, 1)

if updated.count(constant) != 1 or updated.count(function_name) != 1 or updated.count(decision) != 1:
    raise SystemExit('Potential Lead classifier policy validation failed before write')

stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = path.with_name(f'{path.name}.bak-potential-lead-classifier-{stamp}')
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

print(f'Installed bounded Potential Lead Classifier — inbound email, text, call → Potential Leads policy; backup: {backup}')
PY
