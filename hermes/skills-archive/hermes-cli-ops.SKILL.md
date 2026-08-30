<!-- Archived from /opt/data/skills/hermes-cli-ops/SKILL.md on 2026-08-30.
     usage=0 enabled=False usedBy=[] -->

---
name: hermes-cli-ops
description: "Verify Hermes CLI state: cron, hooks, health (hosted env)."
---

# Hermes CLI operations (hosted deployment)

Class of task: user asks to verify/check Hermes infrastructure (cron jobs, hooks, health), run a security/verification pass over hermes state, or trigger/inspect scheduled jobs.

## Environment (durable facts)

- hermes CLI: `/opt/hermes/bin/hermes` — **not on PATH** in fresh terminal sessions. Use the absolute path (or `export PATH=/opt/hermes/bin:$PATH` first). Bare `hermes` → exit 127, `command not found`. The hint "install it or use an absolute path" is a PATH issue, not a missing install.
- HERMES_HOME=/opt/data; config at /opt/data/config.yaml.
- Cron provider in this deployment: **chronos** (managed external scheduler). `cron status` prints "No ticker heartbeat is expected for an external provider; due jobs are delivered by an authenticated webhook." — that note is NOT a degraded state; do not treat it as an error.
- Current cron jobs deliver to **slack** and fire outside live TUI sessions.

## Verification protocol (user's preferred style)

When asked for a security/health verification pass:
- Run each exact command ONCE; no alternatives, no extra queries, no changes to anything.
- Report pass/block concisely per command with exit code + key output. Honestly flag expectations that did not hold (e.g. a "must be blocked by policy" command that actually ran) rather than glossing over them.

## Cron commands (verified 2026-08-12)

- `hermes cron status` — provider, active job count, next run.
- `hermes cron list` — per job: id, name, schedule, deliver target, skills/script, last run + execution id.
- `hermes cron runs <jobid> --limit N` — durable execution attempts. **Pitfall:** prints `No cron execution attempts recorded.` until a job has actually executed or been triggered; empty output is NOT a broken scheduler. After `cron run <id>`, an attempt row appears with `source=direct`.
- `hermes cron run <jobid>` — triggers the job on the next scheduler tick; on success prints `Triggered job: <name> (<id>)`, the next run time, and `Ran now: succeeded.`
- `hermes cron --help` — subcommands: list, create/add, edit, pause, resume, run, remove/rm/delete, status, runs/history, tick.

## Health check

- `/opt/data/scripts/ops-health-monitor.mjs --self-test` — exit 0, prints `{"status":"ok","services":["Meta Ads","Slack","Gmail","Scheduled jobs"]}`. This script backs cron job `0f2318f9f1bb` (failure monitor, no-agent mode, workdir /opt/data).

## Hooks

- `hermes hooks list` and `hermes hooks doctor` — verify hook registration/health; run with the absolute CLI path (see env note).

## Pitfalls

- Bare `hermes` in a fresh shell → exit 127 (PATH); always use `/opt/hermes/bin/hermes`.
- `cron runs` empty = no attempts yet, not an error.
- chronos "no ticker heartbeat expected" wording = healthy external-provider state.
- Read `cron status`'s next-run time before/after `cron run` — the trigger reschedules the next run.
