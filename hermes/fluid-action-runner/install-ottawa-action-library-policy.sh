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

legacy_constant = 'FLUID_SIGNAL_RECOMMENDER_SCRIPT = "/opt/data/bin/fluid-signal-recommender.mjs"'
action_constant = 'FLUID_ACTION_RUNNER_SCRIPT = "/opt/data/bin/fluid-action-runner.mjs"'
diagnostic_function = '\n\ndef valid_hermes_diagnostic(argv: list[str]) -> bool:\n'

if source.count(diagnostic_function) != 1:
    raise SystemExit('expected the Hermes diagnostic policy anchor exactly once')

validator = r'''def safe_agent_text(value: object, maximum: int) -> bool:
    text = str(value)
    allowed = set(" .,:;?!()/@&+-")
    return bool(
        1 <= len(text) <= maximum
        and text[0].isalnum()
        and all(character.isalnum() or character in allowed for character in text)
    )


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

# Replace the old combined recommendation/drafting validator as one unit. This
# also upgrades a policy that contains only one of the two former validators.
updated = source.replace(legacy_constant + '\n', '').replace(action_constant + '\n', '')
end = updated.index(diagnostic_function)
starts = [
    updated.find('def safe_agent_text(value: object, maximum: int) -> bool:'),
    updated.find('def valid_signal_recommender(argv: list[str]) -> bool:'),
    updated.find('def valid_action_runner(argv: list[str]) -> bool:'),
]
starts = [position for position in starts if 0 <= position < end]
start = min(starts) if starts else end + 2
updated = (
    updated[:start].rstrip()
    + '\n\n'
    + action_constant
    + '\n\n'
    + validator.rstrip()
    + updated[end:]
)

decision = 'or valid_action_runner(argv) or valid_hermes_diagnostic(argv)'
legacy_decisions = (
    'or valid_signal_recommender(argv) or valid_action_runner(argv) or valid_hermes_diagnostic(argv)',
    'or valid_action_runner(argv) or valid_signal_recommender(argv) or valid_hermes_diagnostic(argv)',
    'or valid_signal_recommender(argv) or valid_hermes_diagnostic(argv)',
)
for legacy in legacy_decisions:
    updated = updated.replace(legacy, decision)
if decision not in updated:
    updated = updated.replace('or valid_hermes_diagnostic(argv)', decision, 1)

if updated.count(action_constant) != 1 or updated.count(decision) != 1:
    raise SystemExit('policy validation failed for Action Runner wiring')
if 'valid_signal_recommender' in updated or legacy_constant in updated:
    raise SystemExit('policy validation failed to remove the retired worker')
if '--draft-body' not in updated:
    raise SystemExit('policy validation failed for Action Runner commands')
if updated == source:
    print('Fluid Action Library policy is already installed.')
    raise SystemExit(0)

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
