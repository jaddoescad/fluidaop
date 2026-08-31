---
name: automation-creator
description: Create, change, deploy, or retire Fluid agents, scheduled scripts, queue workers, and automatic Supabase processes using the mandatory Hermes automation protocol.
---

# Fluid Automation Creator

Build one visible, operable automation rather than disconnected scheduler,
queue, database, and UI pieces.

## Classify the work

- Use a Hermes **agent** only when model reasoning is necessary.
- Use a Hermes **script schedule** for deterministic polling, repair,
  reconciliation, synchronization, or cleanup.
- Use Supabase Edge Functions for bounded server APIs and webhooks.
- Use database triggers only to maintain integrity or enqueue idempotent work.
- A runtime skill contains instructions; it never schedules itself.

Hermes is Fluid's only scheduler. Do not add host crontab, application timers,
Supabase cron, or an unregistered recurring webhook workaround.

## Register before activating

Read [the automation protocol](references/protocol.md), then add or update the
entry in `hermes/automations.json`. Every definition needs one stable
`automationKey`; an agent's database `agent_key` must match it exactly.

An agent contract must declare its supported subjects. Fluid currently
supports `signal`; a schedule that is not connected to a business record uses
an empty subject list.

Do not enable a queue producer until the owning Hermes definition exists and
its Fluid presentation contract verifies. Do not describe local runtime files
as a deployed agent.

## Build the complete lifecycle

For agents:

1. Create a narrowly scoped runtime skill and deterministic pre-check.
2. Use leases, bounded batches, idempotency, retry backoff, and terminal
   failure states.
3. Use `runtime-correlation.mjs` to capture the exact profile, cron job,
   durable execution, and session from Hermes-owned runtime state. Never ask
   the model to provide runtime identity, and never join by nearest timestamp.
4. Atomically store the business result, `agent_run`, Signal link, runtime
   correlation, and terminal queue state.
5. Generate contract v2 with `automationKey` and supported subjects, then
   verify it against the live Hermes definition.

After Hermes assigns the job ID, use the bounded helper. Repeat `--subject`
only for supported subject types and omit it for scripts:

```bash
/opt/hermes/.venv/bin/python3 /opt/data/bin/fluid-automation-contract.py create \
  --job-id JOB_ID \
  --automation-key AUTOMATION_KEY \
  --subject signal \
  --display-name "DISPLAY NAME" \
  --summary "ONE-LINE PURPOSE" \
  --step "BOUNDED STEP"
/opt/hermes/.venv/bin/python3 /opt/data/bin/fluid-automation-contract.py verify \
  --job-id JOB_ID
```

Install schema and server interfaces before enabling a producer. Install the
worker and permissions before enabling the schedule. Regenerate the contract
after any prompt, skill, script, or execution-mode change.

For scripts, create a no-agent Hermes job with bounded output and an explicit
success, no-work, and failure outcome. Scripts appear in Schedules and
Activity, not Agents.

Retirement is one change set: disable producers, settle pending work, remove
the Hermes schedule and active skill, revoke secrets and permissions, mark the
registry definition retired, and preserve historical Activity as retired.

## Verify

Run:

```bash
node hermes/automation-creator/scripts/validate-automations.mjs
```

Then verify the affected worker, database contracts, Edge Function, live
Hermes roster, definition-bound presentation contract, Schedules entry,
Activity execution, Signal link, retries, and retirement behavior. A missing
consumer is a visible orphaned queue, never an ordinary queued state.
