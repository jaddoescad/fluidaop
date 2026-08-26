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

recommender_constant = 'FLUID_SIGNAL_RECOMMENDER_SCRIPT = "/opt/data/bin/fluid-signal-recommender.mjs"'
action_constant = 'FLUID_ACTION_RUNNER_SCRIPT = "/opt/data/bin/fluid-action-runner.mjs"'
recommender_function = 'def valid_signal_recommender(argv: list[str]) -> bool:'
diagnostic_function = '\n\ndef valid_hermes_diagnostic(argv: list[str]) -> bool:\n'
old_decision = 'or valid_signal_recommender(argv) or valid_hermes_diagnostic(argv)'
new_decision = 'or valid_signal_recommender(argv) or valid_action_runner(argv) or valid_hermes_diagnostic(argv)'

if source.count(recommender_constant) != 1:
    raise SystemExit('expected the existing Signal Recommender policy constant exactly once')
if source.count(recommender_function) != 1 or source.count(diagnostic_function) != 1:
    raise SystemExit('expected the existing Signal Recommender policy function exactly once')
if new_decision in source and action_constant in source and '--button-text' in source and '--draft-body' in source:
    print('Fluid Action Library policy is already installed.')
    raise SystemExit(0)
if source.count(old_decision) != 1:
    raise SystemExit('expected the existing terminal decision anchor exactly once')
if action_constant in source:
    raise SystemExit('refusing to modify a partially installed Action Runner policy')

validator = r'''def safe_agent_text(value: object, maximum: int) -> bool:
    text = str(value)
    allowed = set(" .,:;?!()/@&+-")
    return bool(
        1 <= len(text) <= maximum
        and text[0].isalnum()
        and all(character.isalnum() or character in allowed for character in text)
    )


def valid_case_reference(value: object) -> bool:
    text = str(value)
    if text == "none":
        return True
    parts = text.split("-")
    return bool(
        [len(part) for part in parts] == [8, 4, 4, 4, 12]
        and all(character in "0123456789abcdefABCDEF" for part in parts for character in part)
    )


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
        no_recommendation = parse_pairs(rest, {"--job-id", "--recommendations"}, set())
        if no_recommendation and set(no_recommendation) == {"--job-id", "--recommendations"}:
            job_id = str(no_recommendation["--job-id"])
            return bool(
                job_id.isdigit()
                and 1 <= int(job_id) <= 9_223_372_036_854_775_807
                and no_recommendation["--recommendations"] == "none"
            )
        options = parse_pairs(rest, {
            "--job-id", "--action-definition", "--button-text", "--reason",
            "--confidence", "--case-id",
        }, set())
        if not options or set(options) != {
            "--job-id", "--action-definition", "--button-text", "--reason",
            "--confidence", "--case-id",
        }:
            return False
        job_id = str(options["--job-id"])
        return bool(
            job_id.isdigit()
            and 1 <= int(job_id) <= 9_223_372_036_854_775_807
            and options["--action-definition"] == "draft-email-to-customer"
            and safe_agent_text(options["--button-text"], 160)
            and safe_agent_text(options["--reason"], 2000)
            and CONFIDENCE.fullmatch(str(options["--confidence"]))
            and valid_case_reference(options["--case-id"])
        )
    if command == "fail":
        options = parse_pairs(rest, {"--job-id", "--error-code"}, set())
        if not options or set(options) != {"--job-id", "--error-code"}:
            return False
        job_id = str(options["--job-id"])
        return bool(
            job_id.isdigit()
            and 1 <= int(job_id) <= 9_223_372_036_854_775_807
            and options["--error-code"] in {
                "recommendation-failed", "context-insufficient", "completion-failed",
            }
        )
    return False


def valid_action_runner(argv: list[str]) -> bool:
    if argv[:2] not in (
        ["node", FLUID_ACTION_RUNNER_SCRIPT],
        ["/usr/bin/node", FLUID_ACTION_RUNNER_SCRIPT],
    ):
        return False
    if len(argv) <= 2:
        return False
    command, rest = argv[2], argv[3:]
    if command == "complete":
        options = parse_pairs(rest, {"--job-id", "--draft-body"}, set())
        if not options or set(options) != {"--job-id", "--draft-body"}:
            return False
        job_id = str(options["--job-id"])
        return bool(
            job_id.isdigit()
            and 1 <= int(job_id) <= 9_223_372_036_854_775_807
            and safe_agent_text(options["--draft-body"], 4000)
        )
    if command == "fail":
        options = parse_pairs(rest, {"--job-id", "--error-code"}, set())
        if not options or set(options) != {"--job-id", "--error-code"}:
            return False
        job_id = str(options["--job-id"])
        return bool(
            job_id.isdigit()
            and 1 <= int(job_id) <= 9_223_372_036_854_775_807
            and options["--error-code"] in {
                "drafting-failed", "context-insufficient", "completion-failed",
            }
        )
    return False
'''

updated = source.replace(
    recommender_constant + '\n',
    recommender_constant + '\n' + action_constant + '\n',
    1,
)
start = updated.index(recommender_function)
end = updated.index(diagnostic_function, start)
updated = updated[:start] + validator + updated[end:]
updated = updated.replace(old_decision, new_decision, 1)

for marker in ('--button-text', '--draft-body'):
    if marker not in updated:
        raise SystemExit(f'policy validation failed for marker: {marker}')
if updated.count(action_constant) != 1 or updated.count(new_decision) != 1:
    raise SystemExit('policy validation failed for Action Runner wiring')

stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = path.with_name(f'{path.name}.bak-action-library-{stamp}')
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

print(f'Installed bounded Fluid Action Library policy; backup: {backup}')
PY
