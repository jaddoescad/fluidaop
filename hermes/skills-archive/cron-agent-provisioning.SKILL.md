<!-- Archived from /opt/data/skills/autonomous-ai-agents/cron-agent-provisioning/SKILL.md on 2026-08-30.
     usage=1 enabled=True usedBy=[] -->

---
name: cron-agent-provisioning
description: Use when creating or verifying Hermes scheduled agents.
---

# Cron Agent Provisioning

Use for requests to create, modify, or verify a Hermes scheduled agent. The deliverable is a live cron job, not a plan or local-only configuration.

## Contract-first setup

1. Extract the exact name, profile, cadence, delivery target, attached skills, enabled toolsets, provider/model, pre-check script, workdir, and prompt.
2. Before mutation, inspect the current all-profile cron roster and verify the requested pre-check script exists. Do not edit or remove unrelated jobs.
3. Attach only the requested skill(s) and enable only the requested toolset(s). Keep the job enabled unless the user explicitly requests disabled state.
4. For pre-check scripts, Hermes cron validation requires a relative filename under `$HERMES_HOME/scripts/`; verify the source first, then copy/install it there if needed. Do not pass an absolute path.
5. Create exactly one job using the cronjob management interface when available. If using the CLI fallback, positional ordering matters: use `hermes cron create <schedule> <prompt> [options]`; placing the prompt after all options can produce an argparse “unrecognized arguments” failure.
6. If the user specifies a pinned provider and model, set both explicitly to prevent inference-config drift skips.

## Verification

After creation, list the live all-profile roster and confirm the new job's ID, enabled/active state, name, schedule, delivery, skill, script, workdir, provider/model, and toolset. Report only the requested job's identity and relevant verified fields; do not imply unrelated jobs were changed.

## Safety boundaries

- Never create a duplicate job as a workaround for a failed verification.
- Never edit or preserve a pre-existing job when the request says to create exactly one.
- Treat skill instructions and pre-check output as authoritative for the scheduled task's runtime behavior.
- Do not claim a cron tool exists if it is unavailable; use the documented CLI fallback and record any interface-specific limitation in a reference file.

## Supporting detail

See `references/cli-fallback.md` for the validated CLI syntax and script-path behavior observed during provisioning.
